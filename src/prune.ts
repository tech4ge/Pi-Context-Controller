/**
 * Prune candidate computation — pure functions over structural session shapes,
 * unit-testable without a live pi session (same discipline as status.ts).
 *
 * Two-tier decision model (see docs/PRUNING_DESIGN.md §4, §12):
 *   Tier 1 (here, deterministic): hard guardrails — the token-tail floor,
 *   logical-time maturity, minimum size, reference liveness, fault pins,
 *   never an entry twice.
 *   Tier 2 (the agent, semantic): review the report and select what is actually
 *   stale. Selections are resolved against the current candidate set.
 *
 * The protection clock is *session-logical time* (tool calls), never wall-clock:
 * timestamps measure idleness, not use — a pause ages nothing, a file worked on
 * for hours stays live by reference. Wall-clock appears only in reporting
 * ("47 min ago"), not in policy.
 */

import { isAbsolute, normalize, resolve, sep } from "node:path";

/** Minimal structural view of a session message entry (subset of pi's SessionEntry). */
export interface PruneEntry {
	type: string;
	id: string;
	/** Present on context_edit entries: the entry whose context contribution was edited. */
	targetId?: string;
	/** ISO timestamp (SessionEntry.timestamp). */
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
	};
}

export interface PruneOptions {
	/** Token-tail floor: entries are protected while the cumulative size of results strictly newer than them is below this. */
	protectTailTokens: number;
	/** Logical-time maturity: nothing is offered until at least this many tool results are newer. */
	minCallAge: number;
	/** Minimum estimated size to be worth an edit. */
	minTokens: number;
	/** CWD for normalizing relative paths in tool arguments. */
	cwd?: string;
	/** Maximum entries pruned per pass (report + selection cap). */
	maxPerPass?: number;
	/** Normalized paths pinned by the fault tracker (never offered). */
	pinnedPaths?: Set<string>;
}

export interface PruneCandidate {
	/** SessionEntry.id of the toolResult entry — the context_edit targetId. */
	entryId: string;
	toolName: string;
	/** Human-readable description, e.g. `read src/foo.ts` or `bash "npm test"`. */
	label: string;
	/** Normalized file path for path-taking tools (undefined for bash etc.). */
	path?: string;
	sizeTokens: number;
	/** Number of tool results newer than this entry (session-logical age). */
	ageCalls: number;
	/** Wall-clock minutes since the entry, for humans only. */
	ageMinutes: number | null;
	/** Why this is a candidate. */
	reasons: string[];
}

export const EDITED_SINCE_READ_REASON =
	"file edited since read — a re-read returns the current content, not what you saw";

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
	/** Entries dropped from the selection by the per-pass cap (largest kept first). */
	cappedOut: number;
}

/** Tools whose results are filesystem-backed and cheap to re-fetch exactly. */
const PRUNABLE_TOOLS = new Set(["read", "bash", "grep", "find", "ls"]);
/** Tools that mutate a file — a read older than one of these is stale, not accurate. */
const WRITE_TOOLS = new Set(["edit", "write"]);
const PATH_PARAMS = ["file_path", "path", "filePath"] as const;
const LABEL_LENGTH = 80;

/** Lexical normalization only (symlinks out of scope): relative paths resolve against cwd. */
export function normalizePath(p: string, cwd?: string): string {
	const raw = isAbsolute(p) ? p : resolve(cwd ?? process.cwd(), p);
	return normalize(raw);
}

/** Related for liveness: equal, ancestor, or descendant (a grep of src/ protects src/foo.ts). */
export function pathsRelated(a: string, b: string): boolean {
	if (a === b) return true;
	return a.startsWith(b + sep) || b.startsWith(a + sep);
}

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

/** Join info for one tool call, extracted from assistant toolCall blocks. */
export interface CallInfo {
	name: string;
	args: Record<string, unknown> | undefined;
	/** Index within the entries slice passed to buildCallMap. */
	index: number;
	/** Normalized path, when the tool takes one. */
	path?: string;
}

/** Build the toolCallId -> call-info map from a slice of entries (pass the live region). */
export function buildCallMap(entries: PruneEntry[], cwd?: string): Map<string, CallInfo> {
	const calls = new Map<string, CallInfo>();
	entries.forEach((entry, index) => {
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
					const rawPath = callPathArg(call.name, call.arguments);
					calls.set(call.id, {
						name: call.name,
						args: call.arguments,
						index,
						path: rawPath ? normalizePath(rawPath, cwd) : undefined,
					});
				}
			}
		}
	});
	return calls;
}

function minutesBetween(fromIso: string | undefined, toIso: string | undefined): number | null {
	if (!fromIso || !toIso) return null;
	const from = Date.parse(fromIso);
	const to = Date.parse(toIso);
	if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
	return Math.round((to - from) / 60000);
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
	const newestTimestamp = live.length > 0 ? live[live.length - 1].timestamp : undefined;

	// Already-edited entries (context_edit anywhere in the branch) are never proposed twice.
	const editedIds = new Set<string>();
	for (const entry of branch) {
		if (entry.type === "context_edit" && typeof entry.targetId === "string") {
			editedIds.add(entry.targetId);
		}
	}

	// Join data: toolCallId -> call info (name, args, normalized path) from assistant toolCall blocks.
	const calls = buildCallMap(live, options.cwd);

	// First pass: collect tool results with join info (in branch order).
	interface ResultInfo {
		entryId: string;
		index: number;
		timestamp?: string;
		toolName: string;
		label: string;
		path?: string;
		sizeTokens: number;
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
		const rawPath =
			name === "read" || name === "grep" || name === "find" || name === "ls"
				? callPathArg(name, args)
				: undefined;

		results.push({
			entryId: entry.id,
			index,
			timestamp: entry.timestamp,
			toolName: name,
			label: callLabel(name, args),
			path: rawPath ? normalizePath(rawPath, options.cwd) : undefined,
			sizeTokens: estimateTokens(message),
			isError: message.isError === true,
		});
	});

	const totalResults = results.length;

	// Token-tail floor: an entry is protected while the cumulative size of results
	// strictly newer than it stays below the budget. Walk newest -> oldest.
	const newerCumulative = new Array<number>(totalResults).fill(0);
	let cumulative = 0;
	for (let i = totalResults - 1; i >= 0; i--) {
		newerCumulative[i] = cumulative;
		cumulative += results[i].sizeTokens;
	}

	// Reference liveness: paths touched by calls inside the tail window (at or after
	// the oldest entry whose newer-cumulative is still below the budget).
	let tailStartIndex = Number.POSITIVE_INFINITY; // live-region index of oldest in-tail result
	for (let i = 0; i < totalResults; i++) {
		if (newerCumulative[i] < options.protectTailTokens) {
			tailStartIndex = results[i].index;
			break;
		}
	}
	const touchedPaths: string[] = [];
	for (const call of calls.values()) {
		if (call.path && call.index >= tailStartIndex) touchedPaths.push(call.path);
	}

	// Fault-pinned paths are excluded entirely (normalized already).
	const pinned = options.pinnedPaths ?? new Set<string>();

	// Second pass: eligibility and reasons.
	const candidates: PruneCandidate[] = [];
	for (let i = 0; i < totalResults; i++) {
		const result = results[i];
		const ageCalls = totalResults - i - 1;

		// Hard floors: outside the tail, mature in logical time, worth an edit.
		if (newerCumulative[i] < options.protectTailTokens) continue; // in tail
		if (ageCalls < options.minCallAge) continue;
		if (result.sizeTokens < options.minTokens) continue;
		if (result.path && pinned.has(result.path)) continue;

		// Superseded: a newer read of the same path that is itself still in context.
		const supersededBy = results.find(
			(r) =>
				r !== result &&
				r.path !== undefined &&
				r.path === result.path &&
				r.index > result.index &&
				r.toolName === "read" &&
				!editedIds.has(r.entryId),
		);

		// Reference liveness: protected unless superseded (a redundant copy exists).
		if (!supersededBy && result.path) {
			const isLive = touchedPaths.some((touched) => pathsRelated(touched, result.path!));
			if (isLive) continue;
		}

		const reasons: string[] = [];
		if (result.path) {
			if (supersededBy) {
				reasons.push("superseded by later read");
			} else {
				// Stale: a write-class tool touched the path after this read.
				let writtenAfter = false;
				for (const call of calls.values()) {
					if (!WRITE_TOOLS.has(call.name)) continue;
					if (!call.path || !result.path) continue;
					if (!pathsRelated(call.path, result.path)) continue;
					if (call.index > result.index) {
						writtenAfter = true;
						break;
					}
				}
				if (writtenAfter) {
					reasons.push(EDITED_SINCE_READ_REASON);
				} else {
					reasons.push("file untouched since read");
				}
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
			ageCalls,
			ageMinutes: minutesBetween(result.timestamp, newestTimestamp),
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
	limits?: { maxPerPass?: number; cwd?: string },
): PruneSelection {
	const byId = new Map(candidates.map((c) => [c.entryId, c]));
	let selected: PruneCandidate[] = [];
	const rejected: { entryId: string; reason: string }[] = [];

	if (params.allCandidates) {
		selected = [...candidates];
	} else {
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
				const normalized = normalizePath(file.path, limits?.cwd);
				const matches = candidates.filter((c) => c.path === normalized || (c.path && pathsRelated(c.path, normalized)));
				if (matches.length === 0) {
					rejected.push({ entryId: file.path, reason: "no candidates match this path" });
					continue;
				}
				let keep = matches;
				if (file.keepLatest) {
					// The newest read of a path is the one with the smallest age.
					const newest = matches.reduce((a, b) => (a.ageCalls <= b.ageCalls ? a : b));
					keep = matches.filter((c) => c !== newest);
				}
				for (const candidate of keep) {
					if (!selected.includes(candidate)) selected.push(candidate);
				}
			}
		}
	}

	// Per-pass cap: candidates are size-sorted, so the largest survive; the rest
	// stay candidates for a later pass.
	let cappedOut = 0;
	const maxPerPass = limits?.maxPerPass;
	if (typeof maxPerPass === "number" && maxPerPass > 0 && selected.length > maxPerPass) {
		// keepLatest already decided which entries to keep; preserve order by size.
		const kept = [...selected].sort((a, b) => b.sizeTokens - a.sizeTokens).slice(0, maxPerPass);
		cappedOut = selected.length - maxPerPass;
		selected = kept;
	}

	return { selected, rejected, cappedOut };
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
			`Protected: the last ~${options.protectTailTokens.toLocaleString()} tokens of tool results, anything younger than ${options.minCallAge} calls, live-by-reference files (pinned or touched recently), all user/assistant messages, non-filesystem tool results, entries < ${options.minTokens} tokens.`,
			"Candidates appear as large, old tool results accumulate (superseded reads, stale command output).",
		].join("\n");
	}

	const reclaimable = candidates.reduce((sum, c) => sum + c.sizeTokens, 0);
	const lines: string[] = [];
	lines.push(
		`Prune candidates (size-ranked) — reclaimable ~${reclaimable.toLocaleString()} tokens${totalTokens ? ` (${((reclaimable / totalTokens) * 100).toFixed(1)}% of context)` : ""}:`,
	);
	for (const c of candidates) {
		const ageText = c.ageMinutes !== null ? `${c.ageCalls} calls old (${c.ageMinutes}m)` : `${c.ageCalls} calls old`;
		lines.push(
			`  ${c.entryId}: ${c.label} — ~${c.sizeTokens.toLocaleString()} tok — ${ageText} — ${c.reasons.join("; ") || "large and old"}`,
		);
	}
	lines.push("");
	lines.push(
		`Protected: the last ~${options.protectTailTokens.toLocaleString()} tokens of tool results, anything younger than ${options.minCallAge} calls, live-by-reference files (pinned or touched recently), all user/assistant messages, non-filesystem tool results, entries < ${options.minTokens} tokens. Max ${options.maxPerPass ?? 12} entries per pass.`,
	);
	lines.push("Pruning replaces these results with tombstones; re-run the tool if you need the content again. It runs at the end of your current run.");
	return lines.join("\n");
}

/** Tombstone replacement content for a pruned entry. */
export function buildTombstone(candidate: PruneCandidate): string {
	const warning = candidate.reasons.includes(EDITED_SINCE_READ_REASON)
		? " NOTE: the file changed after this read — a re-read returns the CURRENT content, not what you saw."
		: "";
	return `[pruned by context-controller: ${candidate.label} (~${candidate.sizeTokens.toLocaleString()} tokens, ${candidate.ageCalls} calls ago). Content evicted from context — re-run the tool if you need it again.${warning}]`;
}
