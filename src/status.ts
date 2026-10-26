/**
 * Context status digest: what the agent currently has in its context.
 *
 * Pure functions over structural types so they are unit-testable without a
 * live pi session. The extension passes `ctx.sessionManager.getBranch()` and
 * `ctx.getContextUsage()`; both are structurally compatible with the input
 * types below (they are subsets of pi's real shapes).
 */

/** Minimal structural view of a session message entry (subset of pi's SessionEntry). */
export interface DigestMessage {
	role: string;
	content?: unknown;
	timestamp?: number;
}

export interface DigestEntry {
	type: string;
	message?: DigestMessage;
	/** Compaction entries */
	tokensBefore?: number;
	timestamp?: string;
}

export interface ContextUsageInput {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface BranchDigest {
	/** Info about the most recent compaction entry on the active branch, if any. */
	lastCompaction: { tokensBefore: number; timestamp: string } | null;
	/** Entries on the branch after the last compaction (i.e. live context content). */
	entriesSinceCompaction: number;
	messageCounts: { user: number; assistant: number; toolResult: number };
	/** Tool call counts by tool name since the last compaction. */
	toolCallCounts: Record<string, number>;
	/** Unique file paths passed to read/edit/write-style tools, most recent last, capped. */
	filesTouched: string[];
	/** First-line previews of the most recent user messages. */
	recentUserMessages: { preview: string; timestamp: number | undefined }[];
}

const MAX_FILES = 30;
const MAX_USER_MESSAGES = 8;
const PREVIEW_LENGTH = 120;

const FILE_TOOL_PATH_PARAMS = ["file_path", "path", "filePath"] as const;
const FILE_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls", "ast_outline", "ast_imports", "ast_exports", "ast_node_at", "ast_callees"]);

function textPreview(content: unknown): string {
	let text: string;
	if (typeof content === "string") {
		text = content;
	} else if (Array.isArray(content)) {
		text = content
			.filter((block): block is { type: string; text?: string } => typeof block === "object" && block !== null)
			.map((block) => (typeof block.text === "string" ? block.text : ""))
			.join(" ")
			.trim();
	} else {
		text = "";
	}
	const firstLine = text.split("\n", 1)[0] ?? "";
	return firstLine.length > PREVIEW_LENGTH ? `${firstLine.slice(0, PREVIEW_LENGTH)}…` : firstLine;
}

function toolCallFileArg(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
	if (!FILE_TOOLS.has(toolName) || !args) return undefined;
	for (const key of FILE_TOOL_PATH_PARAMS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/** Walk the active branch and summarize what is live in context. */
export function digestBranch(branch: DigestEntry[]): BranchDigest {
	// Find the most recent compaction entry — anything after it is live context.
	let lastCompactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			lastCompactionIndex = i;
			break;
		}
	}

	const lastCompactionEntry = lastCompactionIndex >= 0 ? branch[lastCompactionIndex] : null;
	const liveEntries = branch.slice(lastCompactionIndex + 1);

	const digest: BranchDigest = {
		lastCompaction:
			lastCompactionEntry && typeof lastCompactionEntry.tokensBefore === "number"
				? { tokensBefore: lastCompactionEntry.tokensBefore, timestamp: lastCompactionEntry.timestamp ?? "" }
				: null,
		entriesSinceCompaction: liveEntries.length,
		messageCounts: { user: 0, assistant: 0, toolResult: 0 },
		toolCallCounts: {},
		filesTouched: [],
		recentUserMessages: [],
	};

	const files = new Set<string>();

	for (const entry of liveEntries) {
		const message = entry.message;
		if (!message) continue;

		if (message.role === "user") {
			digest.messageCounts.user++;
			digest.recentUserMessages.push({
				preview: textPreview(message.content),
				timestamp: message.timestamp,
			});
		} else if (message.role === "assistant") {
			digest.messageCounts.assistant++;
			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (
						typeof block === "object" &&
						block !== null &&
						(block as { type?: string }).type === "toolCall"
					) {
						const call = block as { name?: string; arguments?: Record<string, unknown> };
						const name = call.name ?? "(unknown)";
						digest.toolCallCounts[name] = (digest.toolCallCounts[name] ?? 0) + 1;
						const file = toolCallFileArg(name, call.arguments);
						if (file) files.add(file);
					}
				}
			}
		} else if (message.role === "toolResult") {
			digest.messageCounts.toolResult++;
		}
	}

	digest.filesTouched = [...files].slice(-MAX_FILES);
	digest.recentUserMessages = digest.recentUserMessages.slice(-MAX_USER_MESSAGES);

	return digest;
}

/** The percentage of the context window at which pi's auto-compaction triggers (approximate — per-model overrides may change it). */
export function autoCompactionThresholdPercent(contextWindow: number, reserveTokens: number): number {
	if (contextWindow <= 0) return 0;
	return Math.min(100, Math.max(0, Math.round(((contextWindow - reserveTokens) / contextWindow) * 100)));
}

function formatTokens(tokens: number | null): string {
	if (tokens === null || !Number.isFinite(tokens)) return "unknown (no usage data yet — right after a compaction this is normal)";
	return `${Math.round(tokens).toLocaleString()} tokens`;
}

/** Render the full context_status payload as model-facing text. */
export function formatStatus(
	usage: ContextUsageInput,
	digest: BranchDigest,
	autoCompactPercent: number,
): string {
	const lines: string[] = [];

	lines.push("## Context usage");
	if (usage.percent !== null && usage.tokens !== null) {
		lines.push(
			`- Current: ${formatTokens(usage.tokens)} of ${usage.contextWindow.toLocaleString()} (${usage.percent}% of context window)`,
		);
	} else {
		lines.push(`- Current: usage not measurable right now (normal immediately after a compaction, before the next model response)`);
		lines.push(`- Context window: ${usage.contextWindow.toLocaleString()} tokens`);
	}
	lines.push(`- Pi auto-compaction triggers near ~${autoCompactPercent}% (approximate; per-model overrides may change this)`);

	lines.push("");
	lines.push("## What is in context");
	if (digest.lastCompaction) {
		lines.push(
			`- A compaction has already occurred (${digest.lastCompaction.timestamp || "unknown time"}), replacing ${digest.lastCompaction.tokensBefore.toLocaleString()} tokens with a summary.`,
		);
	}
	lines.push(
		`- Live entries since last compaction: ${digest.entriesSinceCompaction} (user: ${digest.messageCounts.user}, assistant: ${digest.messageCounts.assistant}, tool results: ${digest.messageCounts.toolResult})`,
	);

	const toolCalls = Object.entries(digest.toolCallCounts).sort((a, b) => b[1] - a[1]);
	if (toolCalls.length > 0) {
		lines.push(`- Tool calls: ${toolCalls.map(([name, count]) => `${name}×${count}`).join(", ")}`);
	}
	if (digest.filesTouched.length > 0) {
		lines.push(`- Files touched: ${digest.filesTouched.join(", ")}`);
	}

	if (digest.recentUserMessages.length > 0) {
		lines.push("");
		lines.push("## Recent user messages (oldest → newest)");
		for (const msg of digest.recentUserMessages) {
			lines.push(`- ${msg.preview || "(empty)"}`);
		}
	}

	return lines.join("\n");
}
