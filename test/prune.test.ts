import { describe, it, expect } from "vitest";
import {
	buildTombstone,
	computePruneCandidates,
	renderCandidateReport,
	resolvePruneSelection,
	type PruneEntry,
} from "@/prune";

/** ---- fixture helpers: structural session entries (subset of pi's shapes) ---- */

interface CallSpec {
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

let counter = 0;
const uid = (prefix: string) => `${prefix}-${++counter}`;

function userEntry(): PruneEntry {
	return { type: "message", id: uid("u"), message: { role: "user", content: "hi" } };
}

function assistantEntry(calls: CallSpec[]): PruneEntry {
	return {
		type: "message",
		id: uid("a"),
		message: {
			role: "assistant",
			content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments ?? {} })),
		},
	};
}

function resultEntry(callId: string, toolName: string): PruneEntry {
	return {
		type: "message",
		id: uid("r"),
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: "result content" }],
		},
	};
}

/** A turn: user message, assistant with tool calls, then the tool results. */
function turn(call: { spec: CallSpec; resultToolName?: string }): PruneEntry[] {
	const resultToolName = call.resultToolName ?? call.spec.name;
	return [userEntry(), assistantEntry([call.spec]), resultEntry(call.spec.id, resultToolName)];
}

/** Token estimates keyed by the toolCallId of the result message. */
const SIZES: Record<string, number> = {
	"call-old-1": 5000,
	"call-old-2": 5000,
	"call-bash": 3000,
	"call-edited": 800,
	"call-edit": 100,
	"call-web": 9000,
	"call-recent": 6000,
	"call-small": 100,
	"call-grep": 900,
};

const estimate = (message: NonNullable<PruneEntry["message"]>): number =>
	SIZES[message.toolCallId ?? ""] ?? 100;

const OPTIONS = { protectTurns: 3, minTokens: 400 };

/**
 * Branch layout (10 user messages, protectTurns 3 → age must be >= 3):
 *   turn 1: read src/old.ts        (r-old-1, 5000 tok, age 9) — superseded by later read
 *   turn 2: read src/old.ts again  (r-old-2, 5000 tok, age 8) — latest read
 *   turn 2: bash "npm test"         (r-bash,   3000 tok, age 7)
 *   turn 3: read src/edited.ts      (r-edited, 800 tok, age 6) — file edited after
 *   turn 3: edit src/edited.ts      (r-edit,   100 tok, age 5)        — below min
 *   turn 4: web_search              (r-web,    9000 tok, age 4) — non-filesystem tool
 *   turn 6: read src/recent.ts      (r-recent, 6000 tok, age 1) — protected by turns
 *   turn 7: read src/small.ts        (r-small,  100 tok, age 0) — below min
 */
function baseBranch(): PruneEntry[] {
	return [
		...turn({ spec: { id: "call-old-1", name: "read", arguments: { path: "src/old.ts" } } }),
		...turn({ spec: { id: "call-old-2", name: "read", arguments: { path: "src/old.ts" } } }),
		userEntry(), // turn 2 continues: second tool call in the same turn
		assistantEntry([{ id: "call-bash", name: "bash", arguments: { command: "npm test" } }]),
		resultEntry("call-bash", "bash"),
		...turn({ spec: { id: "call-edited", name: "read", arguments: { path: "src/edited.ts" } } }),
		userEntry(),
		assistantEntry([{ id: "call-edit", name: "edit", arguments: { path: "src/edited.ts" } }]),
		resultEntry("call-edit", "edit"),
		...turn({ spec: { id: "call-web", name: "web_search", arguments: { query: "stuff" } }, resultToolName: "web_search" }),
		userEntry(),
		userEntry(),
		...turn({ spec: { id: "call-recent", name: "read", arguments: { path: "src/recent.ts" } } }),
		...turn({ spec: { id: "call-small", name: "read", arguments: { path: "src/small.ts" } } }),
	];
}

/** entry ids of the results, in fixture order. */
function resultIds(branch: PruneEntry[]): Record<string, string> {
	const byCall: Record<string, string> = {};
	for (const entry of branch) {
		if (entry.message?.role === "toolResult" && entry.message.toolCallId) {
			byCall[entry.message.toolCallId] = entry.id;
		}
	}
	return byCall;
}

describe("computePruneCandidates", () => {
	it("computes size-ranked candidates with reasons", () => {
		const branch = baseBranch();
		const candidates = computePruneCandidates(branch, OPTIONS, estimate);
		const ids = resultIds(branch);

		const byId = new Map(candidates.map((c) => [c.entryId, c]));
		expect(candidates.map((c) => c.entryId)).toEqual([
			ids["call-old-1"],
			ids["call-old-2"],
			ids["call-bash"],
			ids["call-edited"],
		]);

		expect(byId.get(ids["call-old-1"])!.reasons).toContain("superseded by later read");
		expect(byId.get(ids["call-old-2"])!.reasons).toContain("file untouched since read");
		expect(byId.get(ids["call-bash"])!.reasons).toContain("command output");
		expect(byId.get(ids["call-edited"])!.reasons).toContain("file edited since read — content on disk differs");
		expect(byId.get(ids["call-edited"])!.ageTurns).toBe(6);
	});

	it("protects recent turns, small results, and non-filesystem tools", () => {
		const branch = baseBranch();
		const candidates = computePruneCandidates(branch, OPTIONS, estimate);
		const ids = resultIds(branch);
		const candidateIds = new Set(candidates.map((c) => c.entryId));
		expect(candidateIds).not.toContain(ids["call-recent"]); // age 1 < 3
		expect(candidateIds).not.toContain(ids["call-small"]); // 100 < 400 tokens
		expect(candidateIds).not.toContain(ids["call-web"]); // web_search not prunable
		expect(candidateIds).not.toContain(ids["call-edit"]); // edit result below min
	});

	it("never proposes an already-edited entry", () => {
		const branch = baseBranch();
		const ids = resultIds(branch);
		branch.push({ type: "context_edit", id: uid("ce"), targetId: ids["call-bash"] });
		const candidates = computePruneCandidates(branch, OPTIONS, estimate);
		expect(candidates.map((c) => c.entryId)).not.toContain(ids["call-bash"]);
	});

	it("ignores entries before the last compaction", () => {
		const branch = baseBranch();
		const early = resultIds(branch);
		// Compaction after turn 2: only later entries are live.
		const compactionIndex = branch.findIndex((e) => e.message?.role === "toolResult" && e.message.toolCallId === "call-bash");
		branch.splice(compactionIndex + 1, 0, { type: "compaction", id: uid("cmp") });
		const candidates = computePruneCandidates(branch, OPTIONS, estimate);
		const ids = resultIds(branch);
		const candidateIds = candidates.map((c) => c.entryId);
		expect(candidateIds).not.toContain(early["call-old-1"]);
		expect(candidateIds).not.toContain(early["call-old-2"]);
		expect(candidateIds).not.toContain(early["call-bash"]); // before the compaction too
		expect(candidateIds).toContain(ids["call-edited"]); // after the compaction, still a candidate
	});

	it("respects minTokens and protectTurns as hard guardrails", () => {
		const branch = baseBranch();
		const strict = computePruneCandidates(branch, { protectTurns: 9, minTokens: 4000 }, estimate);
		// age >= 9 only (turn 1) and size >= 4000: only r-old-1
		expect(strict.map((c) => c.entryId)).toHaveLength(1);
	});
});

describe("resolvePruneSelection", () => {
	it("selects by entryIds and rejects unknown ids with a reason", () => {
		const branch = baseBranch();
		const candidates = computePruneCandidates(branch, OPTIONS, estimate);
		const ids = resultIds(branch);
		const { selected, rejected } = resolvePruneSelection(candidates, {
			entryIds: [ids["call-old-1"], "bogus-id"],
		});
		expect(selected.map((c) => c.entryId)).toEqual([ids["call-old-1"]]);
		expect(rejected).toEqual([
			{ entryId: "bogus-id", reason: expect.stringContaining("not in the current candidate report") },
		]);
	});

	it("selects by file path, keeping the latest read when keepLatest", () => {
		const branch = baseBranch();
		const candidates = computePruneCandidates(branch, OPTIONS, estimate);
		const ids = resultIds(branch);
		const { selected } = resolvePruneSelection(candidates, {
			files: [{ path: "src/old.ts", keepLatest: true }],
		});
		// the older read is selected; the newest read (age 5, the smallest) is kept
		expect(selected.map((c) => c.entryId)).toEqual([ids["call-old-1"]]);
	});

	it("selects all candidates with allCandidates", () => {
		const branch = baseBranch();
		const candidates = computePruneCandidates(branch, OPTIONS, estimate);
		const { selected } = resolvePruneSelection(candidates, { allCandidates: true });
		expect(selected).toHaveLength(candidates.length);
	});
});

describe("rendering", () => {
	it("renders an empty report with protection summary", () => {
		const text = renderCandidateReport([], OPTIONS, 100000);
		expect(text).toContain("No prune candidates right now");
		expect(text).toContain("last 3 turns");
	});

	it("renders the candidate report with reclaimable totals", () => {
		const branch = baseBranch();
		const candidates = computePruneCandidates(branch, OPTIONS, estimate);
		const text = renderCandidateReport(candidates, OPTIONS, 100000);
		expect(text).toContain("Prune candidates (size-ranked)");
		expect(text).toContain("~13,800 tokens"); // 5000 + 5000 + 3000 + 800
		expect(text).toContain("superseded by later read");
	});

	it("renders a tombstone with label, size, age, and re-fetch instruction", () => {
		const branch = baseBranch();
		const candidates = computePruneCandidates(branch, OPTIONS, estimate);
		const tombstone = buildTombstone(candidates[0]);
		expect(tombstone).toContain("[pruned by context-controller:");
		expect(tombstone).toContain("read src/old.ts");
		expect(tombstone).toContain("~5,000 tokens");
		expect(tombstone).toContain("re-run the tool");
	});
});
