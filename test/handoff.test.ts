import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildHandoffUserMessage,
	clearPendingHandoff,
	getHandoffMessages,
	readPendingHandoff,
	resolveGeneratorModel,
	writePendingHandoff,
	type HandoffEntry,
} from "../src/handoff.ts";

function messageEntry(id: string, role: string, extra: Partial<HandoffEntry["message"]> = {}): HandoffEntry {
	return { type: "message", id, message: { role, ...extra } };
}

function compactionEntry(id: string, firstKeptEntryId?: string): HandoffEntry {
	return { type: "compaction", id, summary: "summarized earlier work", tokensBefore: 50000, firstKeptEntryId };
}

describe("getHandoffMessages", () => {
	it("maps branch messages in order, dropping non-message entries", () => {
		const branch: HandoffEntry[] = [
			{ type: "session", id: "s1" },
			{ type: "model_change", id: "m1" },
			messageEntry("a1", "user"),
			messageEntry("a2", "assistant"),
			{ type: "custom", id: "c1" },
			messageEntry("a3", "user"),
		];
		const messages = getHandoffMessages(branch);
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
	});

	it("uses the whole branch when no compaction is present", () => {
		const branch: HandoffEntry[] = [messageEntry("a1", "user"), messageEntry("a2", "assistant")];
		expect(getHandoffMessages(branch)).toHaveLength(2);
	});

	it("honors a compaction: summary plus kept entries onward", () => {
		const branch: HandoffEntry[] = [
			messageEntry("a1", "user"), // before the compaction's kept window — dropped
			messageEntry("a2", "assistant"), // kept window starts here
			messageEntry("a3", "user"),
			compactionEntry("k1", "a2"),
			messageEntry("a4", "assistant"), // after the compaction
		];
		const messages = getHandoffMessages(branch);
		// compaction summary, a2, a3 (kept), a4 (after)
		expect(messages.map((m) => m.role)).toEqual(["compactionSummary", "assistant", "user", "assistant"]);
		expect(messages[0].summary).toBe("summarized earlier work");
	});

	it("uses the latest compaction when several exist", () => {
		const branch: HandoffEntry[] = [
			messageEntry("a1", "user"),
			compactionEntry("k1", "a1"),
			messageEntry("a2", "assistant"),
			compactionEntry("k2", "a2"),
			messageEntry("a3", "user"),
		];
		const messages = getHandoffMessages(branch);
		expect(messages.map((m) => m.role)).toEqual(["compactionSummary", "assistant", "user"]);
		expect(messages[1].role).toBe("assistant"); // a2, kept by k2
	});

	it("handles a compaction whose firstKeptEntryId no longer exists", () => {
		const branch: HandoffEntry[] = [
			messageEntry("a1", "user"),
			compactionEntry("k1", "gone"),
			messageEntry("a2", "assistant"),
		];
		const messages = getHandoffMessages(branch);
		expect(messages.map((m) => m.role)).toEqual(["compactionSummary", "assistant"]);
	});

	it("returns empty for a branch with only non-message entries", () => {
		expect(getHandoffMessages([{ type: "session", id: "s1" }])).toEqual([]);
	});
});

describe("resolveGeneratorModel", () => {
	it("returns the physical model of the latest assistant message", () => {
		const branch: HandoffEntry[] = [
			messageEntry("a1", "assistant", { provider: "neural-watt", model: "glm-5.3" }),
			messageEntry("a2", "user"),
			messageEntry("a3", "assistant", { provider: "neural-watt", model: "glm-5.3-flash" }),
		];
		expect(resolveGeneratorModel(branch)).toEqual({ provider: "neural-watt", modelId: "glm-5.3-flash" });
	});

	it("skips tool results and non-message entries", () => {
		const branch: HandoffEntry[] = [
			messageEntry("a1", "assistant", { provider: "neural-watt", model: "glm-5.3" }),
			{ type: "message", id: "t1", message: { role: "toolResult" } },
			{ type: "compaction", id: "k1", summary: "s" },
		];
		expect(resolveGeneratorModel(branch)).toEqual({ provider: "neural-watt", modelId: "glm-5.3" });
	});

	it("returns undefined when no assistant message carries a model", () => {
		const branch: HandoffEntry[] = [messageEntry("a1", "user"), { type: "session", id: "s1" }];
		expect(resolveGeneratorModel(branch)).toBeUndefined();
	});
});

describe("buildHandoffUserMessage", () => {
	it("carries the conversation and the focus", () => {
		const message = buildHandoffUserMessage("USER: hello", "pick up task 246");
		expect(message.role).toBe("user");
		const block = (message.content as { type: string; text: string }[])[0];
		expect(block.type).toBe("text");
		expect(block.text).toContain("## Conversation History");
		expect(block.text).toContain("USER: hello");
		expect(block.text).toContain("## Focus for the Next Session");
		expect(block.text).toContain("pick up task 246");
	});
});

describe("pending handoff store", () => {
	it("round-trips a parked handoff and clears it", () => {
		const dir = mkdtempSync(join(tmpdir(), "handoff-"));
		try {
			expect(readPendingHandoff(dir)).toBeUndefined();
			writePendingHandoff(dir, { sessionFile: "/sessions/old.jsonl", prompt: "pick up here", focus: "task 246", createdAt: 123 });
			expect(readPendingHandoff(dir)).toEqual({ sessionFile: "/sessions/old.jsonl", prompt: "pick up here", focus: "task 246", createdAt: 123 });
			clearPendingHandoff(dir);
			expect(readPendingHandoff(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("overwrites a previous parked handoff — one live handoff at a time", () => {
		const dir = mkdtempSync(join(tmpdir(), "handoff-"));
		try {
			writePendingHandoff(dir, { prompt: "first", focus: "", createdAt: 1 });
			writePendingHandoff(dir, { prompt: "second", focus: "", createdAt: 2 });
			expect(readPendingHandoff(dir)?.prompt).toBe("second");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("tolerates a corrupted or partial parked file", () => {
		const dir = mkdtempSync(join(tmpdir(), "handoff-"));
		try {
			writeFileSync(join(dir, "handoff-pending.json"), "not json at all", "utf8");
			expect(readPendingHandoff(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sessionFile is optional in a parked handoff", () => {
		const dir = mkdtempSync(join(tmpdir(), "handoff-"));
		try {
			writePendingHandoff(dir, { prompt: "p", focus: "", createdAt: 1 });
			const read = readPendingHandoff(dir);
			expect(read?.prompt).toBe("p");
			expect(read?.sessionFile).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
