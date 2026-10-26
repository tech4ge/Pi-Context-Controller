/**
 * Fault tracking for pruning (see docs/PRUNING_DESIGN.md §12.2).
 *
 * A "fault" is the round-trip the protection model exists to avoid: the agent
 * re-runs a tool with identical arguments and receives *identical content* to
 * something already evicted. Faults are detected by matching the tool name and
 * normalized path of new results against evicted records, then comparing a
 * content hash: identical = fault (the eviction was wrong — pin the path);
 * different = the file changed (the eviction was correct — unpin).
 *
 * This is the demand-paging paper's fault-driven pinning (arXiv 2603.09023):
 * one fault per path and that path stays resident for the session. Fault
 * counts are first-class metrics so churn can never masquerade as savings.
 *
 * State is reconstructable across processes: context_edit entries persist in
 * the session tree with their original targets, so buildFaultState() rebuilds
 * records from the branch; pins from prior processes are seeded from the
 * JSONL log's prune_fault events by the extension.
 */

import { createHash } from "node:crypto";
import { buildCallMap, type PruneCandidate, type PruneEntry } from "./prune.ts";

/** A record of one evicted entry, keyed for fault matching. */
export interface PrunedRecord {
	/** The context_edit targetId. */
	targetId: string;
	toolName: string;
	/** Match key: normalized path, or tool+label for pathless (bash) results. */
	key: string;
	/** Hash of the result content at eviction time. */
	contentHash: string;
}

export interface FaultState {
	/** Match key -> record (latest eviction per key wins). */
	records: Map<string, PrunedRecord>;
	/** Match key -> pin state. */
	pins: Map<string, { faults: number; pinned: boolean }>;
	faultCount: number;
	/** Estimated tokens re-read due to faults (the honest-cost side of the ledger). */
	faultReReadTokens: number;
}

export interface FaultEvent {
	key: string;
	toolName: string;
	kind: "fault" | "content-changed";
	/** Estimated size of the re-read result (fault cost). */
	sizeTokens: number;
}

export function createFaultState(): FaultState {
	return { records: new Map(), pins: new Map(), faultCount: 0, faultReReadTokens: 0 };
}

/** Stable, short hash of a result's content. */
export function hashContent(content: unknown): string {
	return createHash("sha256").update(JSON.stringify(content) ?? "").digest("hex").slice(0, 16);
}

/** The match key for a result: normalized path when it has one, else tool+label. */
export function faultKey(toolName: string, path: string | undefined, label: string): string {
	return path ?? `tool:${toolName}:${label}`;
}

function entryById(branch: PruneEntry[]): Map<string, PruneEntry> {
	const byId = new Map<string, PruneEntry>();
	for (const entry of branch) byId.set(entry.id, entry);
	return byId;
}

/** Record evicted entries at prune-apply time, hashing their original content. */
export function registerPruned(state: FaultState, branch: PruneEntry[], candidates: PruneCandidate[]): void {
	const byId = entryById(branch);
	for (const candidate of candidates) {
		const entry = byId.get(candidate.entryId);
		if (!entry?.message) continue;
		const key = faultKey(candidate.toolName, candidate.path, candidate.label);
		state.records.set(key, {
			targetId: candidate.entryId,
			toolName: candidate.toolName,
			key,
			contentHash: hashContent(entry.message.content),
		});
	}
}

/**
 * Rebuild fault state from a session branch: every context_edit on the branch
 * is a past eviction whose original entry (still in the tree) can be hashed.
 * `cwd` normalizes paths from tool arguments.
 */
export function buildFaultState(branch: PruneEntry[], cwd?: string): FaultState {
	const state = createFaultState();
	const byId = entryById(branch);
	const calls = buildCallMap(branch, cwd);

	const evicted: PruneCandidate[] = [];
	for (const entry of branch) {
		if (entry.type !== "context_edit" || typeof entry.targetId !== "string") continue;
		const target = byId.get(entry.targetId);
		if (!target?.message) continue;
		const message = target.message;
		const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
		const toolName = message.toolName ?? call?.name ?? "unknown";
		const label = toolName === "bash" && typeof call?.args?.command === "string" ? `bash "${call.args.command}"` : toolName;
		evicted.push({
			entryId: target.id,
			toolName,
			label,
			path: call?.path,
			sizeTokens: 0,
			ageCalls: 0,
			ageMinutes: null,
			reasons: [],
		});
	}
	registerPruned(state, branch, evicted);
	return state;
}

/** Seed pins from prior-process fault events (from the JSONL log). */
export function seedPins(state: FaultState, keys: string[]): void {
	for (const key of keys) {
		const pin = state.pins.get(key) ?? { faults: 0, pinned: false };
		pin.pinned = true;
		pin.faults += 1;
		state.pins.set(key, pin);
	}
}

/** Pinned match keys — pass as PruneOptions.pinnedPaths to exclude from candidates. */
export function pinnedKeys(state: FaultState): Set<string> {
	const keys = new Set<string>();
	for (const [key, pin] of state.pins) {
		if (pin.pinned) keys.add(key);
	}
	return keys;
}

/**
 * Scan entries that appeared since the last scan for faults: results whose
 * (toolName, key) match an evicted record. Identical content hash => fault
 * (pin); different => the file changed (unpin, refresh hash). Returns the
 * events and mutates state; `estimateTokens` sizes faulted re-reads.
 */
export function scanForFaults(
	state: FaultState,
	branch: PruneEntry[],
	fromIndex: number,
	estimateTokens: (message: NonNullable<PruneEntry["message"]>) => number,
	cwd?: string,
): { events: FaultEvent[]; nextIndex: number } {
	const calls = buildCallMap(branch.slice(fromIndex), cwd);
	const events: FaultEvent[] = [];

	for (let i = fromIndex; i < branch.length; i++) {
		const message = branch[i].message;
		if (message?.role !== "toolResult") continue;

		const call = message.toolCallId ? calls.get(message.toolCallId) : undefined;
		const toolName = message.toolName ?? call?.name ?? "";
		const label = toolName === "bash" && typeof call?.args?.command === "string" ? `bash "${call.args.command}"` : toolName;
		const key = faultKey(toolName, call?.path, label);

		const record = state.records.get(key);
		const pin = state.pins.get(key);
		if (!record) continue;

		const hash = hashContent(message.content);
		if (hash === record.contentHash) {
			// Fault: the agent re-fetched exactly what was evicted.
			const existing = pin ?? { faults: 0, pinned: false };
			existing.faults += 1;
			existing.pinned = true;
			state.pins.set(key, existing);
			state.faultCount += 1;
			const sizeTokens = estimateTokens(message);
			state.faultReReadTokens += sizeTokens;
			events.push({ key, toolName, kind: "fault", sizeTokens });
		} else {
			// Content changed: the eviction was correct; unpin (false-pin guard).
			if (pin?.pinned) {
				events.push({ key, toolName, kind: "content-changed", sizeTokens: 0 });
			}
			state.pins.set(key, { faults: pin?.faults ?? 0, pinned: false });
			state.records.delete(key); // the old content is gone; stop matching it
		}
	}

	return { events, nextIndex: branch.length };
}
