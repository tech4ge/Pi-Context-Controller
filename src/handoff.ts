/**
 * Session handoff — pure functions over structural session shapes,
 * unit-testable without a live pi session (same discipline as prune.ts).
 *
 * A handoff transfers context to a NEW session instead of compacting the
 * current one: the branch is summarized into a self-contained starting
 * prompt, the user reviews/edits it, and a fresh session opens with the
 * prompt as a draft. Unlike compaction (lossy, same session), a handoff is
 * lossless-by-artifact — the old session stays intact and parent-linked.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";

/** Minimal structural view of a session entry (subset of pi's SessionEntry). */
export interface HandoffEntry {
	type: string;
	id: string;
	/** Present on message entries. */
	message?: {
		role?: string;
		content?: unknown;
		/** Present on assistant messages: the physical model that produced them. */
		provider?: string;
		model?: string;
	};
	/** Present on compaction entries. */
	summary?: string;
	tokensBefore?: number;
	/** SessionEntry.id of the first entry kept after the compaction. */
	firstKeptEntryId?: string;
}

/** A minimal structural view of an AgentMessage (what convertToLlm consumes). */
export interface HandoffMessage {
	role: string;
	content?: unknown;
	summary?: string;
	tokensBefore?: number;
	timestamp?: number;
}

/** System prompt for the model that writes the handoff prompt. */
export const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and a focus for the next session, generate a focused prompt that:

1. Includes the focus content VERBATIM as the core of the prompt — you may reorganize around it and add detail from the conversation, but you must never drop, shorten, or paraphrase away anything the focus states
2. Adds relevant context from the conversation (decisions made, approaches taken, key findings, work completed and verified)
3. Lists any relevant files that were discussed or modified
4. Clearly states the next task based on the stated focus
5. Is self-contained — the new session should be able to proceed without the old conversation

Distinguish what was verified from what was assumed or left open. Do not include a preamble like "Here's the prompt" — just output the prompt itself. Include all necessary context; err on the side of completeness rather than brevity.`;

/**
 * The messages a handoff summary should be built from: the current branch,
 * honoring a compaction if one happened (summary + kept entries onward, per
 * pi's own handoff example). Entries with no message contribution (commands,
 * model changes, custom entries) are dropped.
 */
export function getHandoffMessages(branch: HandoffEntry[]): HandoffMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((message): message is HandoffMessage => message !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	const compactedBranch = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compactedBranch.map(entryToMessage).filter((message): message is HandoffMessage => message !== undefined);
}

function entryToMessage(entry: HandoffEntry): HandoffMessage | undefined {
	if (entry.type === "message" && entry.message) {
		const message = entry.message;
		return { role: message.role ?? "user", content: message.content, timestamp: undefined };
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
		};
	}
	return undefined;
}

/**
 * The physical model that should WRITE the handoff prompt: the model behind
 * the latest assistant response in the branch. Under a virtual model (e.g.
 * dyna/auto), ctx.model names the virtual selection while assistant messages
 * name the physical model that actually answered — the physical one is what
 * modelRegistry.complete can dispatch to. Assistant-recorded models are also
 * the freshest capable context-holder, which is exactly who should summarize.
 */
export function resolveGeneratorModel(
	branch: HandoffEntry[],
): { provider: string; modelId: string } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = branch[i].message;
		if (branch[i].type === "message" && message?.role === "assistant" && message.provider && message.model) {
			return { provider: message.provider, modelId: message.model };
		}
	}
	return undefined;
}

/** The user message handed to the generator model: conversation + focus. */
export function buildHandoffUserMessage(conversationText: string, focus: string): Message {
	return {
		role: "user",
		content: [
			{
				type: "text",
			text: `## Conversation History\n\n${conversationText}\n\n## Focus for the Next Session\n\n${focus}`,
			},
		],
		timestamp: Date.now(),
	} satisfies Message;
}

/** An approved handoff parked for the /handoff command to execute. */
export interface PendingHandoffFile {
	/** Session file the handoff was approved in (becomes the new session's parent), when resolvable. */
	sessionFile?: string;
	/** The user-approved handoff prompt. */
	prompt: string;
	/** The agent's focus directive (provenance, shown by /handoff). */
	focus: string;
	createdAt: number;
}

const PENDING_HANDOFF_FILE = "handoff-pending.json";

function pendingHandoffPath(agentDir: string): string {
	return join(agentDir, PENDING_HANDOFF_FILE);
}

/** Park an approved handoff. Overwrites any previous one — one live handoff at a time. */
export function writePendingHandoff(agentDir: string, data: PendingHandoffFile): void {
	writeFileSync(pendingHandoffPath(agentDir), JSON.stringify(data, null, "\t"), "utf8");
}

/** Read the parked handoff, if any. Returns undefined when absent or unreadable. */
export function readPendingHandoff(agentDir: string): PendingHandoffFile | undefined {
	try {
		const path = pendingHandoffPath(agentDir);
		if (!existsSync(path)) return undefined;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingHandoffFile>;
		if (typeof parsed.prompt === "string") {
			return {
				sessionFile: typeof parsed.sessionFile === "string" ? parsed.sessionFile : undefined,
				prompt: parsed.prompt,
				focus: typeof parsed.focus === "string" ? parsed.focus : "",
				createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** Clear the parked handoff (after execution, or when superseded). Never throws. */
export function clearPendingHandoff(agentDir: string): void {
	try {
		rmSync(pendingHandoffPath(agentDir), { force: true });
	} catch {
		// best effort
	}
}
