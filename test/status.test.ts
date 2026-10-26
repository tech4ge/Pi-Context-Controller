import { describe, it, expect } from "vitest";
import { autoCompactionThresholdPercent, digestBranch, formatStatus, type DigestEntry } from "@/status";

function userEntry(text: string, timestamp = 1000): DigestEntry {
	return { type: "message", message: { role: "user", content: text, timestamp } };
}

function assistantEntry(toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>): DigestEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: toolCalls.map((call, i) => ({ type: "toolCall", id: `call-${i}`, name: call.name, arguments: call.arguments ?? {} })),
		},
	};
}

function toolResultEntry(): DigestEntry {
	return { type: "message", message: { role: "toolResult", content: [] } };
}

describe("digestBranch", () => {
	it("returns empty digest for an empty branch", () => {
		const digest = digestBranch([]);
		expect(digest.lastCompaction).toBeNull();
		expect(digest.entriesSinceCompaction).toBe(0);
		expect(digest.messageCounts).toEqual({ user: 0, assistant: 0, toolResult: 0 });
		expect(digest.filesTouched).toEqual([]);
	});

	it("counts entries, tool calls, and files", () => {
		const branch: DigestEntry[] = [
			userEntry("Fix the login bug"),
			assistantEntry([{ name: "read", arguments: { path: "src/auth.ts" } }]),
			toolResultEntry(),
			assistantEntry([{ name: "ast_outline", arguments: { file_path: "src/auth.ts" } }]),
			toolResultEntry(),
			userEntry("Also check the session refresh"),
		];

		const digest = digestBranch(branch);
		expect(digest.entriesSinceCompaction).toBe(6);
		expect(digest.messageCounts).toEqual({ user: 2, assistant: 2, toolResult: 2 });
		expect(digest.toolCallCounts).toEqual({ read: 1, ast_outline: 1 });
		expect(digest.filesTouched).toEqual(["src/auth.ts"]);
		expect(digest.recentUserMessages.map((m) => m.preview)).toEqual(["Fix the login bug", "Also check the session refresh"]);
	});

	it("only counts entries after the last compaction", () => {
		const branch: DigestEntry[] = [
			userEntry("old work"),
			{ type: "compaction", tokensBefore: 90000, timestamp: "2026-01-01T00:00:00Z" },
			userEntry("new work"),
		];

		const digest = digestBranch(branch);
		expect(digest.lastCompaction).toEqual({ tokensBefore: 90000, timestamp: "2026-01-01T00:00:00Z" });
		expect(digest.entriesSinceCompaction).toBe(1);
		expect(digest.messageCounts.user).toBe(1);
	});

	it("uses the most recent compaction when several exist", () => {
		const branch: DigestEntry[] = [
			{ type: "compaction", tokensBefore: 1000, timestamp: "first" },
			userEntry("middle work"),
			{ type: "compaction", tokensBefore: 2000, timestamp: "second" },
			userEntry("latest work"),
		];

		const digest = digestBranch(branch);
		expect(digest.lastCompaction?.timestamp).toBe("second");
		expect(digest.entriesSinceCompaction).toBe(1);
	});

	it("ignores non-file tools and dedupes file paths", () => {
		const branch: DigestEntry[] = [
			assistantEntry([
				{ name: "bash", arguments: { command: "ls" } },
				{ name: "read", arguments: { path: "a.ts" } },
				{ name: "read", arguments: { path: "a.ts" } },
				{ name: "edit", arguments: { path: "b.ts" } },
			]),
		];

		const digest = digestBranch(branch);
		expect(digest.toolCallCounts).toEqual({ bash: 1, read: 2, edit: 1 });
		expect(digest.filesTouched).toEqual(["a.ts", "b.ts"]);
	});

	it("truncates long user message previews to one line", () => {
		const long = `${"x".repeat(300)}\nsecond line`;
		const digest = digestBranch([userEntry(long)]);
		expect(digest.recentUserMessages[0].preview).toHaveLength(121); // 120 chars + ellipsis
		expect(digest.recentUserMessages[0].preview).not.toContain("second line");
	});

	it("handles array content for user messages", () => {
		const digest = digestBranch([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello from blocks" }] } },
		]);
		expect(digest.recentUserMessages[0].preview).toBe("hello from blocks");
	});
});

describe("autoCompactionThresholdPercent", () => {
	it("computes threshold from window and reserve", () => {
		expect(autoCompactionThresholdPercent(200000, 16384)).toBe(92);
		expect(autoCompactionThresholdPercent(100000, 16384)).toBe(84);
	});

	it("clamps to 0-100", () => {
		expect(autoCompactionThresholdPercent(0, 16384)).toBe(0);
		expect(autoCompactionThresholdPercent(100, 200)).toBe(0);
	});
});

describe("formatStatus", () => {
	it("renders usage and digest sections", () => {
		const digest = digestBranch([
			userEntry("Fix the login bug"),
			assistantEntry([{ name: "read", arguments: { path: "src/auth.ts" } }]),
		]);
		const text = formatStatus({ tokens: 88000, contextWindow: 200000, percent: 44 }, digest, 92);

		expect(text).toContain("44% of context window");
		expect(text).toContain("~92%");
		expect(text).toContain("Fix the login bug");
		expect(text).toContain("read×1");
		expect(text).toContain("src/auth.ts");
	});

	it("handles null usage gracefully", () => {
		const text = formatStatus({ tokens: null, contextWindow: 200000, percent: null }, digestBranch([]), 92);
		expect(text).toContain("not measurable right now");
	});
});
