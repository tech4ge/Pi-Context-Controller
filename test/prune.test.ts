import { describe, it, expect } from "vitest";
import {
	buildTombstone,
	computePruneCandidates,
	EDITED_SINCE_READ_REASON,
	normalizePath,
	renderCandidateReport,
	resolvePruneSelection,
	type PruneEntry,
} from "@/prune";

/**
 * Fixture: a branch of tool calls/results with controlled sizes and paths.
 *
 * Prunable results in order (sizes via SIZES, keyed by toolCallId):
 *   a1: read a.ts (5000)          age 31 — superseded by a2
 *   a2: read a.ts (5000)          age 30 — untouched since
 *   live2: read ./live2.ts (900)  age 29 — live via tail grep of live2.ts (normalized)
 *   c: read c.ts (900)            age 28 — pinned
 *   dir: read src/deep/file.ts (900) age 27 — live via tail grep of /proj/src (ancestor)
 *   livetsup: read live.ts (900)  age 26 — superseded by the later live.ts read (bypasses liveness)
 *   b: bash "npm test" (3000)     age 25 — command output
 *   bt: read b.ts (800)           age 24 — edited after by be
 *   live: read live.ts (6000)     age 23 — in the token-tail
 *   g1: grep live2.ts (100)       age 22 — tail touch of live2.ts
 *   g2: grep /proj/src (100)      age 21 — tail touch of the src/ directory
 *   filler-1..22: read filler-N.ts (100 each) — below minTokens
 *
 * The web_search result (9000) is not prunable and does not enter the tail walk.
 * With protectTailTokens=5000, the tail covers `live` and everything newer.
 */

interface CallSpec {
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
}

const SIZES: Record<string, number> = {
	"call-a1": 5000,
	"call-a2": 5000,
	"call-live2": 900,
	"call-c": 900,
	"call-dir": 900,
	"call-livetsup": 900,
	"call-b": 3000,
	"call-bt": 800,
	"call-be": 100,
	"call-web": 9000,
	"call-live": 6000,
	"call-g1": 100,
	"call-g2": 100,
};

for (let i = 1; i <= 22; i++) SIZES[`call-f${i}`] = 100;

const CWD = "/proj";

const estimate = (message: NonNullable<PruneEntry["message"]>): number =>
	SIZES[message.toolCallId ?? ""] ?? 100;

function buildBranch(): PruneEntry[] {
	const branch: PruneEntry[] = [];
	let clock = Date.parse("2026-10-26T10:00:00Z");

	function assistant(calls: CallSpec[]) {
		branch.push({
			type: "message",
			id: `a-${branch.length}`,
			timestamp: new Date(clock).toISOString(),
			message: {
				role: "assistant",
				content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: c.arguments ?? {} })),
			},
		});
	}

	function result(callId: string, toolName: string, id: string) {
		branch.push({
			type: "message",
			id,
			timestamp: new Date(clock).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: callId,
				toolName,
				content: [{ type: "text", text: `content of ${callId}` }],
			},
		});
	}

	function step(spec: CallSpec, resultId: string, toolName?: string) {
		clock += 60000;
		assistant([spec]);
		result(spec.id, toolName ?? spec.name, resultId);
	}

	step({ id: "call-a1", name: "read", arguments: { path: "a.ts" } }, "r-a1");
	step({ id: "call-a2", name: "read", arguments: { path: "a.ts" } }, "r-a2");
	step({ id: "call-live2", name: "read", arguments: { path: "./live2.ts" } }, "r-live2");
	step({ id: "call-c", name: "read", arguments: { path: "c.ts" } }, "r-c");
	step({ id: "call-dir", name: "read", arguments: { path: "src/deep/file.ts" } }, "r-dir");
	step({ id: "call-livetsup", name: "read", arguments: { path: "live.ts" } }, "r-livetsup");
	step({ id: "call-b", name: "bash", arguments: { command: "npm test" } }, "r-b");
	step({ id: "call-bt", name: "read", arguments: { path: "b.ts" } }, "r-bt");
	step({ id: "call-be", name: "edit", arguments: { path: "b.ts" } }, "r-be");
	step({ id: "call-web", name: "web_search", arguments: { query: "x" } }, "r-web", "web_search");
	step({ id: "call-live", name: "read", arguments: { path: "live.ts" } }, "r-live");
	step({ id: "call-g1", name: "grep", arguments: { path: "live2.ts", pattern: "x" } }, "r-g1");
	step({ id: "call-g2", name: "grep", arguments: { path: "/proj/src", pattern: "y" } }, "r-g2");
	for (let i = 1; i <= 22; i++) {
		step({ id: `call-f${i}`, name: "read", arguments: { path: `filler-${i}.ts` } }, `r-f${i}`);
	}
	return branch;
}

const OPTIONS = {
	protectTailTokens: 5000,
	minCallAge: 15,
	minTokens: 400,
	cwd: CWD,
};

describe("computePruneCandidates (working-set protection)", () => {
	it("offers exactly the expected candidates, size-ranked, with correct ages", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		expect(candidates.map((c) => c.entryId)).toEqual(["r-a1", "r-a2", "r-b", "r-c", "r-livetsup", "r-bt"]);
		expect(candidates[0].ageCalls).toBe(32);
		expect(candidates[0].ageMinutes).toBe(34);
	});

	it("marks superseded, untouched, command output, and edited-since-read reasons", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		const byId = new Map(candidates.map((c) => [c.entryId, c]));
		expect(byId.get("r-a1")!.reasons).toContain("superseded by later read");
		expect(byId.get("r-a2")!.reasons).toContain("file untouched since read");
		expect(byId.get("r-b")!.reasons).toContain("command output");
		expect(byId.get("r-bt")!.reasons).toContain(EDITED_SINCE_READ_REASON);
	});

	it("protects entries inside the token-tail regardless of age", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		expect(candidates.map((c) => c.entryId)).not.toContain("r-live"); // 6000 tokens, in tail
	});

	it("protects live-by-reference paths: exact match with alias normalization, and directory descendants", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		const ids = candidates.map((c) => c.entryId);
		expect(ids).not.toContain("r-live2"); // ./live2.ts read, live2.ts grep in tail
		expect(ids).not.toContain("r-dir"); // src/deep/file.ts read, /proj/src grep in tail
	});

	it("lets superseded reads bypass liveness (a newer copy exists in context)", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		expect(candidates.map((c) => c.entryId)).toContain("r-livetsup"); // live.ts is live, but superseded
	});

	it("excludes pinned paths entirely", () => {
		const candidates = computePruneCandidates(buildBranch(), { ...OPTIONS, pinnedPaths: new Set([normalizePath("c.ts", CWD)]) }, estimate);
		expect(candidates.map((c) => c.entryId)).not.toContain("r-c");
	});

	it("enforces the logical-time maturity floor (minCallAge)", () => {
		const candidates = computePruneCandidates(buildBranch(), { ...OPTIONS, minCallAge: 26 }, estimate);
		// r-bt (age 25) drops out; everything older stays
		expect(candidates.map((c) => c.entryId)).toEqual(["r-a1", "r-a2", "r-b", "r-c", "r-livetsup"]);
	})

	it("a huge tail protects everything; a tiny tail exposes more", () => {
		const all = computePruneCandidates(buildBranch(), { ...OPTIONS, protectTailTokens: 9_999_999 }, estimate);
		expect(all).toHaveLength(0);
		const tinyTail = computePruneCandidates(buildBranch(), { ...OPTIONS, protectTailTokens: 500 }, estimate);
		expect(tinyTail.length).toBeGreaterThan(5);
	});

	it("ignores entries before the last compaction and never re-proposes edited targets", () => {
		const branch = buildBranch();
		// Compaction after the web_search result: live/g1/g2/fillers stay live-region.
		const webIndex = branch.findIndex((e) => e.id === "r-web");
		branch.splice(webIndex + 1, 0, { type: "compaction", id: "cmp-1" });
		let candidates = computePruneCandidates(branch, OPTIONS, estimate);
		expect(candidates.map((c) => c.entryId)).toEqual([]); // everything before is dead region; rest is in tail/too young... see below

		// Edited target: prune r-a2, then it is never proposed again.
		const branch2 = buildBranch();
		branch2.push({ type: "context_edit", id: "ce-1", targetId: "r-a2" });
		candidates = computePruneCandidates(branch2, OPTIONS, estimate);
		expect(candidates.map((c) => c.entryId)).not.toContain("r-a2");
	});

	it("normalizePath resolves relative paths and aliases to one canonical form", () => {
		expect(normalizePath("./src/x.ts", CWD)).toBe(normalizePath("src/x.ts", CWD));
		expect(normalizePath("src/../src/x.ts", CWD)).toBe(normalizePath("src/x.ts", CWD));
		expect(normalizePath("/proj/src/x.ts", "/other")).toBe("/proj/src/x.ts");
	});
});

describe("resolvePruneSelection", () => {
	it("selects by entryIds and rejects unknown ids", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		const { selected, rejected } = resolvePruneSelection(candidates, { entryIds: ["r-a1", "bogus"] });
		expect(selected.map((c) => c.entryId)).toEqual(["r-a1"]);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason).toContain("not in the current candidate report");
	});

	it("selects by file path (normalized), keeping the latest read when keepLatest", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		const { selected } = resolvePruneSelection(candidates, { files: [{ path: "a.ts", keepLatest: true }] }, { cwd: CWD });
		// r-a1 is the older read of a.ts; r-a2 is kept as the latest
		expect(selected.map((c) => c.entryId)).toEqual(["r-a1"]);
	});

	it("caps selections per pass, keeping the largest first", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		const { selected, cappedOut } = resolvePruneSelection(candidates, { allCandidates: true }, { maxPerPass: 3, cwd: CWD });
		expect(selected.map((c) => c.entryId)).toEqual(["r-a1", "r-a2", "r-b"]);
		expect(cappedOut).toBe(3);
	});
});

describe("rendering", () => {
	it("renders the report with call ages, minutes, and the protection summary", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		const text = renderCandidateReport(candidates, { ...OPTIONS, maxPerPass: 12 }, 400000);
		expect(text).toContain("Prune candidates (size-ranked)");
		expect(text).toContain("~15,600 tokens"); // 5000+5000+3000+900+900+800
		expect(text).toContain("32 calls old (34m)");
		expect(text).toContain("Max 12 entries per pass");
	});

	it("renders an empty report with the protection summary", () => {
		const text = renderCandidateReport([], OPTIONS, 400000);
		expect(text).toContain("No prune candidates right now");
		expect(text).toContain("younger than 15 calls");
	});

	it("tombstones carry the edited-since-read warning only when the file changed after the read", () => {
		const candidates = computePruneCandidates(buildBranch(), OPTIONS, estimate);
		const byId = new Map(candidates.map((c) => [c.entryId, c]));
		expect(buildTombstone(byId.get("r-bt")!)).toContain("a re-read returns the CURRENT content");
		expect(buildTombstone(byId.get("r-a1")!)).not.toContain("CURRENT content");
		expect(buildTombstone(byId.get("r-a1")!)).toContain("[pruned by context-controller:");
	});
});
