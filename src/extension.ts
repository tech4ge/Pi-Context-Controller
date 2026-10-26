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

import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { estimateTokens, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { createLogger, type Logger } from "./logger.ts";
import {
	buildTombstone,
	computePruneCandidates,
	renderCandidateReport,
	resolvePruneSelection,
	type PruneCandidate,
	type PruneSelectionParams,
} from "./prune.ts";
import { autoCompactionThresholdPercent, digestBranch, formatStatus } from "./status.ts";
import { reminderText } from "./reminders.ts";
import {
	buildFaultState,
	createFaultState,
	pinnedKeys,
	registerPruned,
	scanForFaults,
	seedPins,
} from "./faults.ts";

/** A compaction requested via the compact_context tool, awaiting the run boundary. */
interface PendingCompaction {
	preserve: string;
	reason?: string;
	requestedAt: number;
}

/** A prune selection awaiting the run boundary. */
interface PendingPrune {
	candidates: PruneCandidate[];
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
	prunes: number;
	pruneReclaimedTokens: number;
	pruneFaults: number;
	faultReReadTokens: number;
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
		prunes: 0,
		pruneReclaimedTokens: 0,
		pruneFaults: 0,
		faultReReadTokens: 0,
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
	/** Prune selection awaiting the run boundary. */
	let pendingPrune: PendingPrune | undefined;
	/** Compaction held until prune edits are persisted (edits first, compaction last). */
	let deferredCompact: PendingCompaction | undefined;
	/** Fault tracker for pruning: pins paths whose eviction caused a re-fetch. */
	let faultState = createFaultState();
	/** Branch length at the last fault scan (turn_end). */
	let lastFaultScanIndex = 0;
	/** Summary of the prune applied at the last boundary, for the post-settle notice. */
	let lastPrunedForNotice: { entries: number; estimatedTokens: number; labels: string[]; percentBefore: number | null } | undefined;

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

	/** Fault keys pinned in prior processes for this session (from the JSONL log). Defensive: never throws. */
	function readLoggedFaultKeys(sessionId: string): string[] {
		try {
			const logPath = join(getAgentDir(), "logs", "context-controller.jsonl");
			if (!existsSync(logPath)) return [];
			const keys: string[] = [];
			for (const line of readFileSync(logPath, "utf8").split("\n")) {
				if (!line.includes("prune_fault")) continue;
				try {
					const ev = JSON.parse(line) as { event?: string; sessionId?: string; key?: string };
					if (ev.event === "prune_fault" && ev.sessionId === sessionId && typeof ev.key === "string") {
						keys.push(ev.key);
					}
				} catch {
					// partial line during a concurrent write — ignore
				}
			}
			return [...new Set(keys)];
		} catch {
			return [];
		}
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
			"Prefer prune_context first when stale tool results are the bloat; compact only when structure itself is too large.",
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
	// Selective pruning: candidates computed here, judgment applied by the agent
	// ---------------------------------------------------------------------------

	/** Estimate tokens for a structural message view via pi's own estimator. */
	const estimateMessageTokens = (message: NonNullable<import("./prune.ts").PruneEntry["message"]>) =>
		estimateTokens(message as Parameters<typeof estimateTokens>[0]);

	pi.registerTool({
		name: "prune_context",
		label: "Prune Context",
		description:
			"Selectively evict stale tool results from context. Called with no arguments (or listOnly), returns a size-ranked report of prune candidates (superseded file reads, stale command output) with estimated reclaimable tokens. Select with entryIds, files+keepLatest, or allCandidates. Pruning is cheaper and safer than compaction: results are replaced with tombstones and can be re-fetched by re-running the tool. Runs when your current run settles, like compact_context.",
		promptSnippet: "Evict stale tool results from context (tombstoned, re-fetchable)",
		promptGuidelines: [
			"Call with no arguments first to see candidates — never prune blind.",
			"Prefer pruning over compaction when stale tool results are the bloat; compact only when structure itself is too large.",
			"Pruned content must be re-fetched, not recalled — after a prune, re-run the tool if you need pruned content; say so rather than guessing.",
			"Don't prune mid-derivation or entries the current task still references.",
		],
		parameters: Type.Object({
			listOnly: Type.Optional(Type.Boolean({ description: "Only list candidates; do not prune (default when no selection given)." })),
			entryIds: Type.Optional(Type.Array(Type.String(), { description: "Entry ids from the candidate report to prune." })),
			files: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({ description: "File path whose reads to prune." }),
						keepLatest: Type.Optional(Type.Boolean({ description: "Keep the newest read of the path (prune only older ones)." })),
					}),
					{ description: "Select by file path instead of entry id." },
				),
			),
			allCandidates: Type.Optional(Type.Boolean({ description: "Prune the entire current candidate report." })),
		}),
		async execute(_toolCallId, params: PruneSelectionParams, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Aborted." }], details: { kind: "aborted" } };
			}

			const { config } = loadConfig(ctx.cwd);
			if (!config.pruningEnabled) {
				return {
					content: [{ type: "text", text: "Pruning is disabled in configuration (pruningEnabled: false)." }],
					details: { kind: "disabled" },
					isError: true,
				};
			}

			const branch = ctx.sessionManager.getBranch() as import("./prune.ts").PruneEntry[];
			const candidates = computePruneCandidates(
				branch,
				{
					protectTailTokens: config.pruneProtectTailTokens,
					minCallAge: config.pruneMinCallAge,
					minTokens: config.pruneMinTokens,
					maxPerPass: config.pruneMaxPerPass,
					cwd: ctx.cwd,
					pinnedPaths: pinnedKeys(faultState),
				},
				estimateMessageTokens,
			);
			const usage = ctx.getContextUsage();

			const hasSelection = params.allCandidates || params.entryIds || params.files;
			if (!hasSelection || params.listOnly) {
				return {
					content: [
						{
							type: "text",
							text: renderCandidateReport(
								candidates,
								{
									protectTailTokens: config.pruneProtectTailTokens,
									minCallAge: config.pruneMinCallAge,
									minTokens: config.pruneMinTokens,
									maxPerPass: config.pruneMaxPerPass,
								},
								usage?.tokens ?? null,
							),
						},
					],
					details: { kind: "success", candidates },
				};
			}

			const { selected, rejected, cappedOut } = resolvePruneSelection(candidates, params, {
				maxPerPass: config.pruneMaxPerPass,
			});
			if (selected.length === 0) {
				const rejectionText = rejected.length > 0 ? ` Rejections: ${rejected.map((r) => `${r.entryId} (${r.reason})`).join("; ")}` : "";
				return {
					content: [{ type: "text", text: `Nothing selected to prune.${rejectionText}` }],
					details: { kind: "validation-error", rejected },
					isError: true,
				};
			}

			// Only the latest request is kept — the model should not stack prunes.
			pendingPrune = { candidates: selected, requestedAt: Date.now() };
			const estTokens = selected.reduce((sum, c) => sum + c.sizeTokens, 0);
			log(ctx, "prune_requested", {
				cappedOut,
				count: selected.length,
				estimatedTokens: estTokens,
				percent: usage?.percent ?? null,
				entries: selected.map((c) => ({ entryId: c.entryId, label: c.label, sizeTokens: c.sizeTokens })),
			});

			const rejectedText = rejected.length > 0 ? ` Rejected (not pruned): ${rejected.map((r) => r.entryId).join(", ")}.` : "";
			const cappedText = cappedOut > 0 ? ` Per-pass cap: ${cappedOut} smaller entries were held back and remain candidates for a later pass.` : "";
			return {
				content: [
					{
						type: "text",
						text:
							`Prune requested: ${selected.length} entr${selected.length === 1 ? "y" : "ies"}, ~${estTokens.toLocaleString()} tokens est. It will apply when this run settles — finish your current response normally. Pruned content is tombstoned; re-run the tools if you need it again.${rejectedText}${cappedText}`,
					},
				],
				details: { kind: "success", selected, rejected },
			};
		},
	});

	// ---------------------------------------------------------------------------
	// Agent-initiated compaction: consumed at the run boundary
	// ---------------------------------------------------------------------------

	/** Shared compaction execution (used directly, and deferred after prune edits). */
	function runCompaction(ctx: ExtensionContext, preserve: string) {
		ctx.compact({
			customInstructions: preserve,
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
	}

	pi.on("agent_before_settle", async (_event, ctx) => {
		// 1. Prune edits first (cheaper, reversible) — returned as boundary drafts.
		const prune = pendingPrune;
		pendingPrune = undefined;
		let drafts: SessionBoundaryDraft[] = [];
		if (prune && prune.candidates.length > 0) {
			const usageBefore = ctx.getContextUsage();
			drafts = prune.candidates.map((candidate) => ({
				type: "context_edit",
				targetId: candidate.entryId,
				replacement: { content: [{ type: "text", text: buildTombstone(candidate) }] },
			}));
			const estTokens = prune.candidates.reduce((sum, c) => sum + c.sizeTokens, 0);
			// Register evicted entries with the fault tracker (content hashes
			// for fault detection) before the edits are drafted.
			const branchForFaults = ctx.sessionManager.getBranch() as import("./prune.ts").PruneEntry[];
			registerPruned(faultState, branchForFaults, prune.candidates);
			sessionStats.prunes += 1;
			sessionStats.pruneReclaimedTokens += estTokens;
			lastPrunedForNotice = {
				entries: prune.candidates.length,
				estimatedTokens: estTokens,
				labels: prune.candidates.map((c) => c.label),
				percentBefore: usageBefore?.percent ?? null,
			};
			log(ctx, "prune_applied", {
				entries: prune.candidates.length,
				estimatedTokens: estTokens,
				tokensBefore: usageBefore?.tokens ?? null,
				percentBefore: usageBefore?.percent ?? null,
				labels: prune.candidates.map((c) => c.label),
			});
		}

		// 2. Compaction last — and if prune edits are pending, the ctx.compact()
		// call is deferred to agent_settled so it runs against the branch WITH
		// the edits persisted (the summarizer sees tombstones, not stale content).
		const request = pendingCompaction;
		pendingCompaction = undefined;
		if (!request) {
			return drafts.length > 0 ? { entries: drafts } : undefined;
		}

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
			return drafts.length > 0 ? { entries: drafts } : undefined;
		}
		log(ctx, "compaction_approved", { percent: usage?.percent ?? null });

		if (drafts.length > 0) {
			// Prune edits pending: hold the compaction until they are persisted.
			deferredCompact = request;
			return { entries: drafts };
		}

		runCompaction(ctx, request.preserve);
		return undefined;
	});

	// Deferred compaction (after prune edits are persisted at settle) and the
	// post-prune re-engagement notice.
	pi.on("agent_settled", async (_event, ctx) => {
		const compact = deferredCompact;
		deferredCompact = undefined;

		if (compact) {
			sendNotice(
				"Prune edits applied; compaction starting now (edits persisted first so the summarizer sees tombstones, not stale content).",
			);
			runCompaction(ctx, compact.preserve);
			return;
		}

		// Standalone prune (no compaction): report and re-engage. Usage is
		// measurable immediately after edits (unlike after compaction).
		const lastPrune = lastPrunedForNotice;
		lastPrunedForNotice = undefined;
		if (lastPrune) {
			const usage = ctx.getContextUsage();
			// Note: after context_edits, pi's usage measurement falls back to its
			// estimator (the API anchor is invalidated), so a before/after percent
			// comparison mixes bases. Report the after-percent and the estimated
			// reclaim; the next model response re-anchors to real token counts.
			const usageLine =
				usage?.percent !== null && usage?.percent !== undefined
					? ` Usage now ~${usage.percent}% (estimate-basis; re-anchors to measured tokens on the next response).`
					: "";
			sendNotice(
				`Pruned ${lastPrune.entries} entr${lastPrune.entries === 1 ? "y" : "ies"} (~${lastPrune.estimatedTokens.toLocaleString()} tokens est.): ${lastPrune.labels.join("; ")}.${usageLine} Pruned content is tombstoned — re-run the tools if you need it; do not answer from memory of it.`,
				{ triggerTurn: true },
			);
		}
	});

	// ---------------------------------------------------------------------------
	// Threshold reminders
	// ---------------------------------------------------------------------------

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

		// Fault scan: detect re-fetches of evicted content in entries added
		// since the last scan. Pins the path on identical content (fault),
		// unpins on changed content. Independent of reminders.
		{
			const branch = ctx.sessionManager.getBranch() as import("./prune.ts").PruneEntry[];
			const scanFrom = Math.min(lastFaultScanIndex, branch.length);
			if (scanFrom < branch.length) {
				const { events, nextIndex } = scanForFaults(faultState, branch, scanFrom, estimateMessageTokens, ctx.cwd);
				lastFaultScanIndex = nextIndex;
				for (const event of events) {
					if (event.kind === "fault") {
						sessionStats.pruneFaults += 1;
						sessionStats.faultReReadTokens += event.sizeTokens;
						log(ctx, "prune_fault", { key: event.key, toolName: event.toolName, sizeTokens: event.sizeTokens });
					} else {
						log(ctx, "prune_unpinned", { key: event.key, toolName: event.toolName });
					}
				}
			}
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

		// Prune nudges: only when candidates actually exist and pruning is on —
		// actionable guidance, never noise. Computed only when a reminder fires.
		let pruneSummary: { count: number; tokens: number } | null = null;
		if (config.pruningEnabled) {
			const candidates = computePruneCandidates(
				ctx.sessionManager.getBranch() as import("./prune.ts").PruneEntry[],
				{
					protectTailTokens: config.pruneProtectTailTokens,
					minCallAge: config.pruneMinCallAge,
					minTokens: config.pruneMinTokens,
					cwd: ctx.cwd,
					pinnedPaths: pinnedKeys(faultState),
				},
				estimateMessageTokens,
			);
			if (candidates.length > 0) {
				pruneSummary = {
					count: candidates.length,
					tokens: candidates.reduce((sum, c) => sum + c.sizeTokens, 0),
				};
			}
		}

		const message = { customType: REMINDER_CUSTOM_TYPE, content: reminderText(percent, tier, pruneSummary), display: true };
		log(ctx, "reminder_fired", {
			tier,
			percent,
			tokens: usage.tokens,
			candidateCount: pruneSummary?.count ?? 0,
			candidateTokens: pruneSummary?.tokens ?? 0,
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
		pendingPrune = undefined;
		deferredCompact = undefined;
		lastPrunedForNotice = undefined;
		firedTiers.clear();
		sessionStats = emptyStats();
		logger = undefined;
		// Rebuild the fault tracker from this session's history: context_edit
		// entries reconstruct evicted records (content is still in the tree),
		// and prior-process fault events (JSONL log) seed the pins.
		const startBranch = ctx.sessionManager.getBranch() as import("./prune.ts").PruneEntry[];
		faultState = buildFaultState(startBranch, ctx.cwd);
		lastFaultScanIndex = startBranch.length;
		const sessionId = ctx.sessionManager.getSessionId();
		const faultKeys = readLoggedFaultKeys(sessionId);
		if (faultKeys.length > 0) seedPins(faultState, faultKeys);
		const { config, sources, warnings } = loadConfig(ctx.cwd);
		if (config.loggingEnabled) {
			log(ctx, "config_loaded", { sources, warnings, config });
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const { config } = loadConfig(ctx.cwd);
		if (config.loggingEnabled) {
			log(ctx, "session_summary", {
				...sessionStats,
				netReclaimedTokens:
					sessionStats.compactionTokensReclaimed +
					sessionStats.pruneReclaimedTokens -
					sessionStats.faultReReadTokens,
			});
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
				`pruningEnabled: ${config.pruningEnabled}`,
				`pruneProtectTailTokens: ${config.pruneProtectTailTokens}`,
				`pruneMinCallAge: ${config.pruneMinCallAge}`,
				`pruneMinTokens: ${config.pruneMinTokens}`,
				`pruneMaxPerPass: ${config.pruneMaxPerPass}`,
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
