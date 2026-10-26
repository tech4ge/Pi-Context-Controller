/**
 * Prune candidate computation — pure functions over structural session shapes,
 * unit-testable without a live pi session (same discipline as status.ts).
 *
 * Two-tier decision model (see docs/PRUNING_DESIGN.md §4):
 *   Tier 1 (here, deterministic): walk the branch, join tool results to their
 *   calls, estimate sizes, and apply hard guardrails (protected turns, minimum
 *   size, filesystem-backed tools only, never an entry twice).
 *   Tier 2 (the agent, semantic): review the report and select what is actually
 *   stale. Selections are resolved against the current candidate set.
 */

/** Minimal structural view of a session message entry (subset of pi's SessionEntry). */
export interface PruneEntry {
	type: string;
	id: string;
	/** Present on context_edit entries: the entry whose context contribution was edited. */
	targetId?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
}

export interface PruneOptions {
	/** Results from the last N turns are never prunable. */
	protectTurns: number;
	/** Results below this estimated size are not worth an edit. */
	minTokens: number;
}

export interface PruneCandidate {
	/** SessionEntry.id of the toolResult entry — the context_edit targetId. */
	entryId: string;
	toolName: string;
	/** Human-readable description, e.g. `read src/foo.ts` or `bash "npm test"`. */
	label: string;
	/** File path for path-taking tools (undefined for bash etc.). */
	path?: string;
	sizeTokens: number;
	ageTurns: number;
	/** Why this is a candidate: "superseded by later read", "file untouched since", "stale output", "old command output". */
	reasons: string[];
}

export interface PruneSelectionParams {
	listOnly?: boolean;
	entryIds?: string[];
	files?: { path: string; keepLatest?: boolean }[];
	allCandidates?: boolean;
}

export interface PruneSelection {
	selected: PruneCandidate[];
	/** Ids requested but rejected, with reasons (stale report, protected, etc.). */
	rejected: { entryId: string; reason: string }[];
}

/** Tools whose results are filesystem-backed and cheap to re-fetch exactly. */
const PRUNABLE_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
/** Tools that mutate a file — a read older than one of these is stale, not accurate. */
const WRITE_TOOLS = new Set(["edit", "write"]);
const PATH_PARAMS = ["file_path", "path", "filePath"] as const;
const LABEL_LENGTH = 80;

function callPathArg(name: string, args: Record<string, unknown> | undefined): string | undefined {
	for (const key of PATH_PARAMS) {
		const value = args?.[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function callLabel(name: string, args: Record<string, unknown> | undefined): string {
	if (name === "bash") {
		const command = typeof args?.command === "string" ? args.command : "";
		const oneLine = command.split("\n", 1)[0] ?? "";
		return `bash "${oneLine.length > LABEL_LENGTH ? `${oneLine.slice(0, LABEL_LENGTH)}…` : oneLine}"`;
	}
	const path = callPathArg(name, args);
	if (path) {
		const shown = path.length > LABEL_LENGTH ? `${path.slice(0, LABEL_LENGTH)}…` : path;
		return `${name} ${shown}`;
	}
	if (name === "grep" && typeof args?.pattern === "string") return `grep "${args.pattern.slice(0, LABEL_LENGTH)}"`;
	if (name === "find" && typeof args?.pattern === "string") return `find "${args.pattern.slice(0, LABEL_LENGTH)}"`;
	return name;
}

/**
 * Compute prune candidates from the active branch.
 *
 * `estimateTokens` is injected (pi's own estimator over AgentMessages) so this
 * stays pure; tests pass a stub.
 */
export function computePruneCandidates(
	branch: PruneEntry[],
	options: PruneOptions,
	estimateTokens: (message: NonNullable<PruneEntry["message"]>) => number,
): PruneCandidate[] {
	// Live region: entries after the last compaction on the branch.
	let lastCompactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			lastCompactionIndex = i;
			break;
		}
	}
	const live = branch.slice(lastCompactionIndex + 1);

	// Already-edited entries (context_edit anywhere in the branch) are never proposed twice.
	const editedIds = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "context_edit" && typeof entry.targetId === "string") {
			editedIds.add(entry.targetId);
		}
	}

	// Join data: toolCallId -> { name, args, orderIndex } from assistant toolCall blocks.
	const calls = new Map<string, { name: string; args: Record<string, unknown> | undefined; index: number }>();
	live.forEach((entry, index) => {
		const message = entry.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (
				typeof block === "object" &&
				block !== null &&
				(block as { type?: string }).type === "toolCall"
			) {
				const call = block as { id?: string; name?: string; arguments?: Record<string, unknown> };
				if (typeof call.id === "string" && typeof call.name === "string") {
					calls.set(call.id, { name: call.name, args: call.arguments, index });
				}
			}
		}
	});

	// Turn structure: a turn ends at each user message boundary. Age of an entry
	// = number of user messages that appear after it in the live region.
	const totalUserTurns = live.filter((e) => e.message?.role === "user").length;
	const userBefore = new Array<number>(live.length).fill(0);
	let usersSoFar = 0;
	live.forEach((entry, index) => {
		if (entry.message?.role === "user") usersSoFar++;
		userBefore[index] = usersSoFar;
	});

	// First pass: collect tool results with join info.
	interface ResultInfo {
		entryId: string;
		index: number;
		toolName: string;
		label: string;
		path?: string;
		sizeTokens: number;
		ageTurns: number;
		isError: boolean;
	}
	const results: ResultInfo[] = [];

	live.forEach((entry, index) => {
		const message = entry.message;
		if (message?.role !== "toolResult") return;

		const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
		const name = message.toolName ?? call?.name ?? "";
		if (!PRUNABLE_TOOLS.has(name)) return;

		if (editedIds.has(entry.id)) return;

		const args = call?.args;
		const path = name === "read" || name === "grep" || name === "find" || name === "ls"
			? callPathArg(name, args)
			: undefined;

		results.push({
			entryId: entry.id,
			index,
			toolName: name,
			label: callLabel(name, args),
			path,
			sizeTokens: estimateTokens(message),
			ageTurns: totalUserTurns - userBefore[index],
			isError: message.isError === true,
		});
	});

	// Second pass: reasons per candidate.
	const candidates: PruneCandidate[] = [];
	for (const result of results) {
		if (result.sizeTokens < options.minTokens) continue;
		if (result.ageTurns < options.protectTurns) continue;

		const reasons: string[] = [];

		if (result.path) {
			// Superseded: a later read of the same path exists.
			const supersededBy = results.find(
				(r) => r !== result && r.path === result.path && r.index > result.index && r.toolName === "read",
			);
			if (supersededBy) reasons.push("superseded by later read");

			// Stale: a write-class tool touched the path after this read.
			let writtenAfter = false;
			for (const call of calls.values()) {
				if (!WRITE_TOOLS.has(call.name)) continue;
				if (callPathArg(call.name, call.args) !== result.path) continue;
				if (call.index > result.index) {
					writtenAfter = true;
					break;
				}
			}
			if (writtenAfter) {
				reasons.push("file edited since read — content on disk differs");
			} else if (!supersededBy) {
				reasons.push("file untouched since read");
			}
		} else if (result.toolName === "bash") {
			reasons.push("command output");
		}

		candidates.push({
			entryId: result.entryId,
			toolName: result.toolName,
			label: result.label,
			path: result.path,
			sizeTokens: result.sizeTokens,
			ageTurns: result.ageTurns,
			reasons,
		});
	}

	// Largest first — biggest reclaim per edit.
	candidates.sort((a, b) => b.sizeTokens - a.sizeTokens);
	return candidates;
}

/** Resolve a selection against the current candidate set. Unknown or protected ids are rejected with a reason. */
export function resolvePruneSelection(
	candidates: PruneCandidate[],
	params: PruneSelectionParams,
): PruneSelection {
	const byId = new Map(candidates.map((c) => [c.entryId, c]));
	const selected: PruneCandidate[] = [];
	const rejected: { entryId: string; reason: string }[] = [];

	if (params.allCandidates) return { selected: [...candidates], rejected: [] };

	if (params.entryIds) {
		for (const id of params.entryIds) {
			const candidate = byId.get(id);
			if (candidate) {
				if (!selected.includes(candidate)) selected.push(candidate);
			} else {
				rejected.push({
					entryId: id,
					reason: "not in the current candidate report — the report may be stale; re-run prune_context with no arguments for a fresh one",
				});
			}
		}
	}

	if (params.files) {
		for (const file of params.files) {
			const matches = candidates.filter((c) => c.path === file.path);
			if (matches.length === 0) {
				rejected.push({ entryId: file.path, reason: "no candidates match this path" });
				continue;
			}
			let keep = matches;
			if (file.keepLatest) {
				// The newest read of a path is the one with the smallest age.
				const newest = matches.reduce((a, b) => (a.ageTurns <= b.ageTurns ? a : b));
				keep = matches.filter((c) => c !== newest);
			}
			for (const candidate of keep) {
				if (!selected.includes(candidate)) selected.push(candidate);
			}
		}
	}

	return { selected, rejected };
}

/** Render the candidate report (the tool's read-only output). */
export function renderCandidateReport(
	candidates: PruneCandidate[],
	options: PruneOptions,
	totalTokens: number | null,
): string {
	if (candidates.length === 0) {
		return [
			"No prune candidates right now.",
			"",
			`Protected: last ${options.protectTurns} turns, all user/assistant messages, non-filesystem tool results, entries < ${options.minTokens} tokens.`,
			"Candidates appear as large, old tool results accumulate (superseded reads, stale command output).",
		].join("\n");
	}

	const reclaimable = candidates.reduce((sum, c) => sum + c.sizeTokens, 0);
	const lines: string[] = [];
	lines.push(
		`Prune candidates (size-ranked) — reclaimable ~${reclaimable.toLocaleString()} tokens${totalTokens ? ` (${((reclaimable / totalTokens) * 100).toFixed(1)}% of context)` : ""}:`,
	);
	for (const c of candidates) {
		lines.push(
			`  ${c.entryId}: ${c.label} — ~${c.sizeTokens.toLocaleString()} tok — ${c.ageTurns} turns old — ${c.reasons.join("; ") || "large and old"}`,
		);
	}
	lines.push("");
	lines.push(
		`Protected: last ${options.protectTurns} turns, all user/assistant messages, non-filesystem tool results, entries < ${options.minTokens} tokens.`,
	);
	lines.push("Pruning replaces these results with tombstones; re-run the tool if you need the content again. It runs at the end of your current run.");
	return lines.join("\n");
}

/** Tombstone replacement content for a pruned entry. */
export function buildTombstone(candidate: PruneCandidate): string {
	return `[pruned by context-controller: ${candidate.label} (~${candidate.sizeTokens.toLocaleString()} tokens, ${candidate.ageTurns} turns ago). Content evicted from context — re-run the tool if you need it again.]`;
}
