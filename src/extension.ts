/**
 * Pi-Context-Controller
 *
 * Gives the agent control over (and awareness of) its own context:
 *
 *   - `context_status` tool: current context usage + a digest of what is live in context
 *   - `compact_context` tool: agent-initiated compaction with a preservation focus.
 *     The compaction runs when the current agent run settles (never mid-run), and —
 *     when `confirmBeforeCompaction` is enabled — the user first sees the agent's
 *     proposed compaction instructions in a Yes/No approval dialog.
 *   - Threshold reminders injected into the conversation as context usage rises
 *   - JSONL logging of context decisions, per-turn usage samples, and outcomes to
 *     ~/.pi/agent/logs/context-controller.jsonl (local session deep-dives)
 *   - `/context-status` and `/context-config` commands for the user
 *
 * Configuration: see src/config.ts — `~/.pi/agent/context-controller.json`
 * (user defaults) and `<project>/.pi/context-controller.json` (project overrides).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import { autoCompactionThresholdPercent, digestBranch, formatStatus } from "./status.ts";

/** A compaction requested via the compact_context tool, awaiting the run boundary. */
interface PendingCompaction {
	preserve: string;
	reason?: string;
	requestedAt: number;
}

/** Running totals for the session_summary log event. */
interface SessionStats {
	turns: number;
	totalInput: number;
	totalOutput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	totalCost: number;
	compactions: number;
	compactionTokensReclaimed: number;
}

function emptyStats(): SessionStats {
	return {
		turns: 0,
		totalInput: 0,
		totalOutput: 0,
		totalCacheRead: 0,
		totalCacheWrite: 0,
		totalCost: 0,
		compactions: 0,
		compactionTokensReclaimed: 0,
	};
}

const REMINDER_CUSTOM_TYPE = "context-controller-reminder";
const NOTICE_CUSTOM_TYPE = "context-controller";

export default function (pi: ExtensionAPI) {
	// Session-scoped state. Cleared on session_start; pending is consumed by the
	// agent_before_settle handler.
	let pendingCompaction: PendingCompaction | undefined;
	/** Reminder tiers that have already fired (once_per_tier mode). */
	const firedTiers = new Set<number>();
	/** JSONL logger, created lazily per session (sessionId is stable within one). */
	let logger: Logger | undefined;
	/** Running session totals. */
	let sessionStats = emptyStats();

	/** Log one JSONL event if logging is enabled. Never throws. */
	function log(ctx: ExtensionContext, event: string, payload: Record<string, unknown> = {}) {
		if (!logger) {
			logger = createLogger({
				enabled: true,
				sessionId: () => ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
			});
		}
		logger.log(event, payload);
	}

	function sendNotice(content: string, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }) {
		pi.sendMessage({ customType: NOTICE_CUSTOM_TYPE, content, display: true }, options);
	}

	// ---------------------------------------------------------------------------
	// Tools
	// ---------------------------------------------------------------------------

	pi.registerTool({
		name: "context_status",
		label: "Context Status",
		description:
			"Check how much of the context window is used and what is currently in context: usage percentage, entries since the last compaction, tool-call counts, files touched, and recent user messages. Use this to decide how to size remaining work — whether there is room for more large reads, whether to delegate to subagents, and when compaction or a session handoff is warranted.",
		promptSnippet: "Check current context-window usage and what is in context",
		promptGuidelines: [
			"Call context_status before deciding whether to read more large content, delegate work, compact, or propose a new session.",
			"context_status is cheap and read-only — prefer it over guessing how much context remains.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Aborted." }], details: { kind: "aborted" } };
			}

			const usage = ctx.getContextUsage();
			const branch = ctx.sessionManager.getBranch();
			const digest = digestBranch(branch);

			const settings = pi.getSettings();
			const reserveTokens = settings.compaction?.reserveTokens ?? 16384;
			const contextWindow = usage?.contextWindow ?? 0;
			const autoCompactPercent = autoCompactionThresholdPercent(contextWindow, reserveTokens);

			const text = usage
				? formatStatus(usage, digest, autoCompactPercent)
				: formatStatus(
						{ tokens: null, contextWindow: 0, percent: null },
						digest,
						autoCompactPercent,
					);

			return {
				content: [{ type: "text", text }],
				details: { kind: "success", usage: usage ?? null, digest },
			};
		},
	});

	pi.registerTool({
		name: "compact_context",
		label: "Compact Context",
		description:
			"Request a compaction of your own context with a preservation focus. The `preserve` string becomes the custom instructions given to the summarizer, so state exactly what must survive: active task and goal, key decisions and their rationale, current work state, file paths, errors and resolutions, and the next concrete step. The compaction does NOT run immediately — it runs when your current run settles, so finish your response normally. If the user has approval enabled, they will be shown your preservation instructions and asked to confirm before it runs.",
		promptSnippet: "Compact own context with an explicit preservation focus",
		promptGuidelines: [
			"Call compact_context when a sub-task has just resolved, or when work is converging and the detail behind you is no longer needed.",
			"Do NOT call compact_context mid-derivation or while stuck — you may need the working detail you would be summarizing away.",
			"compact_context is deferred: it runs at the end of your current run, not immediately. Finish your response after calling it.",
		],
		parameters: Type.Object({
			preserve: Type.String({
				description:
					"What must be preserved in the compaction summary: goal, decisions, state, files, next step. This is shown to the user for approval when confirmation is enabled.",
			}),
			reason: Type.Optional(
				Type.String({ description: "One line on why now is a good compaction point (shown to the user)." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Aborted." }], details: { kind: "aborted" } };
			}

			const preserve = params.preserve.trim();
			if (!preserve) {
				return {
					content: [{ type: "text", text: "The `preserve` parameter is empty — provide the preservation focus for the compaction summary." }],
					details: { kind: "validation-error" },
					isError: true,
				};
			}

			// Only the latest request is kept — the model should not stack compactions.
			pendingCompaction = { preserve, reason: params.reason?.trim() || undefined, requestedAt: Date.now() };

			const { config } = loadConfig(ctx.cwd);
			const usage = ctx.getContextUsage();
			log(ctx, "compaction_requested", {
				reason: params.reason?.trim() || null,
				preserveLength: preserve.length,
				percent: usage?.percent ?? null,
				confirmExpected: config.confirmBeforeCompaction && ctx.hasUI,
			});

			const usageLine =
				usage?.percent !== null && usage?.percent !== undefined
					? ` Current usage: ${usage.percent}%.`
					: "";

			const confirmLine = config.confirmBeforeCompaction
				? " The user will be shown your preservation instructions and asked to approve the compaction — if they decline, you will be told."
				: "";

			return {
				content: [
					{
						type: "text",
						text:
							`Compaction requested with your preservation focus. It will run when this run settles (not immediately) — finish your current response normally.${usageLine}${confirmLine}`,
					},
				],
				details: { kind: "success", preserve, reason: params.reason },
			};
		},
	});

	// ---------------------------------------------------------------------------
	// Agent-initiated compaction: consumed at the run boundary
	// ---------------------------------------------------------------------------

	pi.on("agent_before_settle", async (_event, ctx) => {
		const request = pendingCompaction;
		if (!request) return;
		pendingCompaction = undefined;

		const { config } = loadConfig(ctx.cwd);
		const usage = ctx.getContextUsage();

		// Build the approval body: what the user is being asked to sign off on.
		const usageLine =
			usage?.tokens !== null && usage?.tokens !== undefined
				? `Context usage: ${usage.tokens.toLocaleString()} of ${usage.contextWindow.toLocaleString()} tokens (${usage.percent}%).`
				: "Context usage: not measurable right now.";
		const bodyLines = [usageLine];
		if (request.reason) bodyLines.push(`Agent's reason: ${request.reason}`);
		bodyLines.push("", "Proposed compaction instructions (passed to the summarizer):", "", request.preserve);

		let approved = true;
		if (config.confirmBeforeCompaction && ctx.hasUI) {
			approved = await ctx.ui.confirm("Approve agent-requested compaction?", bodyLines.join("\n"));
		}
		// Headless modes (json/print) have no UI to confirm with — proceed and
		// let the post-compaction notice record what happened.

		if (!approved) {
			log(ctx, "compaction_declined", { percent: usage?.percent ?? null });
			if (ctx.hasUI) ctx.ui.notify("Compaction declined — the agent will be told", "warning");
			sendNotice(
				"The user DECLINED the proposed compaction. Do not immediately re-request the same compaction. Either continue with less context pressure (delegate large reads to subagents, use structural lookups instead of full reads, summarize state to durable files) or ask the user whether they would prefer to start a new session.",
				{ triggerTurn: true },
			);
			return;
		}
		log(ctx, "compaction_approved", { percent: usage?.percent ?? null });

		ctx.compact({
			customInstructions: request.preserve,
			onComplete: (result) => {
				if (ctx.hasUI) ctx.ui.notify("Compaction completed", "info");
				const before = result.tokensBefore;
				const after = result.estimatedTokensAfter;
				const reclaimed =
					typeof before === "number" && typeof after === "number" ? before - after : null;
				if (reclaimed && reclaimed > 0) sessionStats.compactionTokensReclaimed += reclaimed;
				log(ctx, "compaction_result", {
					tokensBefore: before ?? null,
					estimatedTokensAfter: after ?? null,
					reclaimed,
				});
				sendNotice(
					`Compaction completed (${before?.toLocaleString() ?? "unknown"} → ~${after?.toLocaleString() ?? "unknown"} tokens). Your preservation focus was passed to the summarizer. Re-orient with context_status if needed, then continue your work.`,
					{ triggerTurn: true },
				);
			},
			onError: (error) => {
				if (ctx.hasUI) ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				sendNotice(
					`Compaction failed: ${error.message}. Context may still be under pressure — prefer small reads and consider asking the user to start a new session.`,
					{ triggerTurn: true },
				);
			},
		});
	});

	// ---------------------------------------------------------------------------
	// Threshold reminders
	// ---------------------------------------------------------------------------

	function reminderText(percent: number, tier: number): string {
		const guidance =
			tier >= 90
				? "Auto-compaction is imminent. Wrap up the current sub-task now: write important state to durable files, then either call compact_context with a preservation focus or propose starting a new session to the user."
				: tier >= 80
					? "High usage. Prefer structural lookups over full file reads, delegate large reads to subagents, and consider calling compact_context with a preservation focus at the next sub-task boundary."
					: tier >= 65
						? "Moderate usage. Size remaining work accordingly: avoid unnecessary full-file reads and be deliberate about what you pull into context."
						: "Context is filling. Keep this in mind when sizing upcoming reads and investigations.";
		return `[context-controller] Context usage: ${percent}%. ${guidance}`;
	}

	pi.on("turn_end", async (event, ctx) => {
		const { config } = loadConfig(ctx.cwd);

		// Per-turn usage sample — the impact-measurement workhorse. Accumulates
		// session totals even when the per-turn lines themselves are disabled.
		const usage = ctx.getContextUsage();
		const messageUsage = (
			event.message as {
				usage?: {
					input?: number;
					output?: number;
					cacheRead?: number;
					cacheWrite?: number;
					cost?: { total?: number };
				};
			}
		).usage;
		if (messageUsage && typeof messageUsage.input === "number") {
			sessionStats.turns += 1;
			sessionStats.totalInput += messageUsage.input ?? 0;
			sessionStats.totalOutput += messageUsage.output ?? 0;
			sessionStats.totalCacheRead += messageUsage.cacheRead ?? 0;
			sessionStats.totalCacheWrite += messageUsage.cacheWrite ?? 0;
			sessionStats.totalCost += messageUsage.cost?.total ?? 0;
		}
		if (config.loggingEnabled && config.logTurnUsage) {
			log(ctx, "turn_usage", {
				turnIndex: event.turnIndex,
				model: (event.message as { model?: string }).model ?? null,
				input: messageUsage?.input ?? null,
				output: messageUsage?.output ?? null,
				cacheRead: messageUsage?.cacheRead ?? null,
				cacheWrite: messageUsage?.cacheWrite ?? null,
				costTotal: messageUsage?.cost?.total ?? null,
				tokens: usage?.tokens ?? null,
				percent: usage?.percent ?? null,
			});
		}

		if (!config.remindersEnabled || config.reminderThresholds.length === 0) return;
		if (!usage || usage.percent === null) return;

		const percent = usage.percent;
		let tier: number | undefined;
		for (const threshold of config.reminderThresholds) {
			if (percent >= threshold) tier = threshold;
		}

		if (config.reminderRepeatMode === "once_per_tier") {
			if (tier === undefined) {
				// Usage dropped below every threshold — re-arm all tiers.
				firedTiers.clear();
				return;
			}
			if (firedTiers.has(tier)) return;
			firedTiers.add(tier);
		}

		if (tier === undefined) return;

		const message = { customType: REMINDER_CUSTOM_TYPE, content: reminderText(percent, tier), display: true };
		log(ctx, "reminder_fired", {
			tier,
			percent,
			tokens: usage.tokens,
		});
		if (event.continue) {
			// Run continues: deliver before the next model request.
			pi.sendMessage(message, { deliverAs: "steer" });
		} else {
			// Run is ending: append without forcing another turn.
			pi.sendMessage(message);
		}
	});

	// Any compaction (manual, auto, or ours) re-arms the reminder tiers.
	pi.on("session_before_compact", async () => {
		firedTiers.clear();
	});

	// ---------------------------------------------------------------------------
	// Compaction outcomes (agent-requested, user /compact, and automatic)
	// ---------------------------------------------------------------------------

	pi.on("session_compact", async (event, ctx) => {
		sessionStats.compactions += 1;
		log(ctx, "compaction_completed", {
			reason: event.reason,
			fromExtension: event.fromExtension,
			tokensBefore: event.compactionEntry.tokensBefore ?? null,
			willRetry: event.willRetry,
		});
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		log(ctx, "compaction_failed", {
			reason: event.reason,
			error: event.errorMessage ?? null,
			aborted: event.aborted,
		});
	});

	// ---------------------------------------------------------------------------
	// Session lifecycle
	// ---------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		pendingCompaction = undefined;
		firedTiers.clear();
		sessionStats = emptyStats();
		logger = undefined;
		const { config, sources, warnings } = loadConfig(ctx.cwd);
		if (config.loggingEnabled) {
			log(ctx, "config_loaded", { sources, warnings, config });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const { config } = loadConfig(ctx.cwd);
		if (config.loggingEnabled) {
			log(ctx, "session_summary", { ...sessionStats });
		}
	});

	// ---------------------------------------------------------------------------
	// User commands
	// ---------------------------------------------------------------------------

	pi.registerCommand("context-status", {
		description: "Show current context usage and what is in context",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const branch = ctx.sessionManager.getBranch();
			const digest = digestBranch(branch);
			const settings = pi.getSettings();
			const reserveTokens = settings.compaction?.reserveTokens ?? 16384;
			const autoCompactPercent = autoCompactionThresholdPercent(usage?.contextWindow ?? 0, reserveTokens);
			const text = usage
				? formatStatus(usage, digest, autoCompactPercent)
				: formatStatus({ tokens: null, contextWindow: 0, percent: null }, digest, autoCompactPercent);
			if (ctx.hasUI) ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("context-config", {
		description: "Show the effective Pi-Context-Controller configuration and its sources",
		handler: async (_args, ctx) => {
			const { config, sources, warnings } = loadConfig(ctx.cwd);
			const lines = [
				`confirmBeforeCompaction: ${config.confirmBeforeCompaction}`,
				`remindersEnabled: ${config.remindersEnabled}`,
				`reminderThresholds: ${config.reminderThresholds.join(", ")}%`,
				`reminderRepeatMode: ${config.reminderRepeatMode}`,
				`loggingEnabled: ${config.loggingEnabled}`,
				`logTurnUsage: ${config.logTurnUsage}`,
				"",
				sources.length > 0 ? `Config sources: ${sources.join(", ")}` : "No config files found — using defaults.",
				"Config locations: ~/.pi/agent/context-controller.json (user), .pi/context-controller.json (project)",
				`Log file: ~/.pi/agent/logs/context-controller.jsonl`,
			];
			if (warnings.length > 0) {
				lines.push("", "Warnings:");
				lines.push(...warnings.map((w) => `- ${w}`));
			}
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
