import { describe, it, expect } from "vitest";
import {
	buildFaultState,
	createFaultState,
	faultKey,
	hashContent,
	pinnedKeys,
	registerPruned,
	scanForFaults,
	seedPins,
	type FaultState,
} from "@/faults";
import type { PruneCandidate, PruneEntry } from "@/prune";

const CWD = "/proj";
const estimate = (message: NonNullable<PruneEntry["message"]>): number => 900;

/** A branch containing: assistant(read x.ts) -> result -> [context_edit on that result]. */
function branchWithEviction(content: string, editTargetId = "r-x"): PruneEntry[] {
	return [
		{
			type: "message",
			id: "a-1",
			timestamp: "2026-10-26T10:00:00.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-x", name: "read", arguments: { path: "x.ts" } }],
			},
		},
		{
			type: "message",
			id: editTargetId,
			timestamp: "2026-10-26T10:00:01.000Z",
			message: { role: "toolResult", toolCallId: "call-x", toolName: "read", content: [{ type: "text", text: content }] },
		},
		{ type: "context_edit", id: "ce-1", targetId: editTargetId },
	];
}

/** Append a fresh re-read of x.ts with the given content; returns the entry count before the append. */
function appendReRead(branch: PruneEntry[], content: string): number {
	const before = branch.length;
	branch.push(
		{
			type: "message",
			id: `a-${branch.length}`,
			timestamp: "2026-10-26T10:05:00.000Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "call-x2", name: "read", arguments: { path: "x.ts" } }],
			},
		},
		{
			type: "message",
			id: `r-${branch.length + 1}`,
			timestamp: "2026-10-26T10:05:01.000Z",
			message: { role: "toolResult", toolCallId: "call-x2", toolName: "read", content: [{ type: "text", text: content }] },
		},
	);
	return before;
}

const candidateFor = (entryId: string): PruneCandidate => ({
	entryId,
	toolName: "read",
	label: "read x.ts",
	path: `${CWD}/x.ts`,
	sizeTokens: 900,
	ageCalls: 20,
	ageMinutes: 20,
	reasons: [],
});

describe("fault tracking", () => {
	it("registerPruned records the content hash of the original entry", () => {
		const state = createFaultState();
		const branch = branchWithEviction("original content");
		// The original entry is still in the tree; registerPruned must find it by id.
		registerPruned(state, branch, [candidateFor("r-x")]);
		const key = faultKey("read", `${CWD}/x.ts`, "read x.ts");
		expect(state.records.get(key)?.contentHash).toBe(hashContent([{ type: "text", text: "original content" }]));
	});

	it("a re-read with IDENTICAL content is a fault: logged, pinned, costed", () => {
		const branch = branchWithEviction("original content");
		const state = createFaultState();
		registerPruned(state, branch, [candidateFor("r-x")]);
		const from = appendReRead(branch, "original content"); // identical

		const { events } = scanForFaults(state, branch, from, estimate, CWD);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("fault");
		expect(events[0].sizeTokens).toBe(900);
		expect(state.faultCount).toBe(1);
		expect(state.faultReReadTokens).toBe(900);
		expect(pinnedKeys(state).has(faultKey("read", `${CWD}/x.ts`, "read x.ts"))).toBe(true);
	});

	it("a re-read with CHANGED content unpins and stops matching the old record", () => {
		const branch = branchWithEviction("original content");
		const state = createFaultState();
		registerPruned(state, branch, [candidateFor("r-x")]);
		const key = faultKey("read", `${CWD}/x.ts`, "read x.ts");
		state.pins.set(key, { faults: 1, pinned: true }); // pre-pinned from a prior fault

		const from = appendReRead(branch, "CHANGED content");
		const { events } = scanForFaults(state, branch, from, estimate, CWD);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("content-changed");
		expect(pinnedKeys(state).size).toBe(0);
		expect(state.records.has(key)).toBe(false); // old record dropped
	});

	it("buildFaultState reconstructs records from a session branch (cross-process)", () => {
		const state = buildFaultState(branchWithEviction("original content"), CWD);
		const key = faultKey("read", `${CWD}/x.ts`, "read x.ts");
		expect(state.records.get(key)?.contentHash).toBe(hashContent([{ type: "text", text: "original content" }]));
		expect(state.records.get(key)?.targetId).toBe("r-x");
	});

	it("seedPins restores pins from prior-process fault events", () => {
		const state = buildFaultState(branchWithEviction("original content"), CWD);
		const key = faultKey("read", `${CWD}/x.ts`, "read x.ts");
		seedPins(state, [key]);
		expect(pinnedKeys(state).has(key)).toBe(true);
	});

	it("bash results are keyed by tool+command, and identical re-runs fault", () => {
		const branch: PruneEntry[] = [
			{
				type: "message",
				id: "a-1",
				timestamp: "2026-10-26T10:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-b1", name: "bash", arguments: { command: "npm test" } }],
				},
			},
			{
				type: "message",
				id: "r-b1",
				timestamp: "2026-10-26T10:00:01.000Z",
				message: { role: "toolResult", toolCallId: "call-b1", toolName: "bash", content: [{ type: "text", text: "all passing" }] },
			},
			{ type: "context_edit", id: "ce-b1", targetId: "r-b1" },
		];
		const state = buildFaultState(branch, CWD);
		const before = branch.length;
		branch.push(
			{
				type: "message",
				id: "a-2",
				timestamp: "2026-10-26T10:05:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-b2", name: "bash", arguments: { command: "npm test" } }],
				},
			},
			{
				type: "message",
				id: "r-b2",
				timestamp: "2026-10-26T10:05:01.000Z",
				message: { role: "toolResult", toolCallId: "call-b2", toolName: "bash", content: [{ type: "text", text: "all passing" }] },
			},
		);
		const { events } = scanForFaults(state, branch, before, estimate, CWD);
		expect(events).toHaveLength(1);
		expect(events[0].kind).toBe("fault");
		expect(events[0].toolName).toBe("bash");
	});

	it("unrelated tool calls never fault", () => {
		const branch = branchWithEviction("original content");
		const state = buildFaultState(branch, CWD);
		const before = branch.length;
		branch.push(
			{
				type: "message",
				id: "a-9",
				timestamp: "2026-10-26T10:06:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-y", name: "read", arguments: { path: "other.ts" } }],
				},
			},
			{
				type: "message",
				id: "r-9",
				timestamp: "2026-10-26T10:06:01.000Z",
				message: { role: "toolResult", toolCallId: "call-y", toolName: "read", content: [{ type: "text", text: "original content" }] },
			},
		);
		const { events } = scanForFaults(state, branch, before, estimate, CWD);
		expect(events).toHaveLength(0);
		expect(state.faultCount).toBe(0);
	});
});
