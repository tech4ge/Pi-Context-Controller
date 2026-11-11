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
 *   - `handoff_session` tool: agent-initiated handoff to a NEW session. Instead of
 *     compacting (lossy, same session), the agent's `focus` brief becomes the new
 *     session's starting prompt verbatim (no second LLM call — the agent writes it
 *     with full live context); `generate: true` opts into an LLM summary instead.
 *     The user reviews and edits the prompt, and a fresh session opens with it as a
 *     draft — the old session stays intact, parent-linked. The user approves
 *     by submitting the draft; cancelling the editor declines the handoff.
 *   - Threshold reminders injected into the conversation as context usage rises
 *   - JSONL logging of context decisions, per-turn usage samples, and outcomes to
 *     ~/.pi/agent/logs/context-controller.jsonl (local session deep-dives)
 *   - `/context-status` and `/context-config` commands for the user
 *
 * Configuration: see src/config.ts — `~/.pi/agent/context-controller.json`
 * (user defaults) and `<project>/.pi/context-controller.json` (project overrides).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, estimateTokens, getAgentDir, serializeConversation } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
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
import {
	buildHandoffUserMessage,
	clearPendingHandoff,
	getHandoffMessages,
	HANDOFF_SYSTEM_PROMPT,
	readPendingHandoff,
	resolveGeneratorModel,
	writePendingHandoff,
	type HandoffEntry,
} from "./handoff.ts";
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

/** A handoff requested via the handoff_session tool, awaiting the run boundary. */
interface PendingHandoff {
	focus: string;
	reason?: string;
	/** Opt into the LLM summarizer instead of using `focus` verbatim. */
	generate?: boolean;
	requestedAt: number;
}

/**
 * The live session manager pi hands extensions is typed ReadonlySessionManager —
 * a type-level facade over the same runtime object, which implements
 * appendContextEdit (spike-verified; see docs/PRUNING_DESIGN.md Appendix A).
 * This is the single place the extension steps past the declared read-only
 * *type* surface: appending context_edit entries mid-run from the
 * prune_context handler. If pi ever exposes this officially, delete this.
 */
interface EditCapableSessionManager {
	appendContextEdit(
		targetId: string,
		replacement: { content: string | { type: "text"; text: string }[] } | null,
	): string;
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
	// Session-scoped state. Cleared on session_start; compaction is consumed by the
	// agent_before_settle handler (approval flow).
	let pendingCompaction: PendingCompaction | undefined;
	/** A handoff supersedes a pending compaction when both are requested. */
	let pendingHandoff: PendingHandoff | undefined;
	/** Reminder tiers that have already fired (once_per_tier mode). */
	const firedTiers = new Set<number>();
	/** JSONL logger, created lazily per session (sessionId is stable within one). */
	let logger: Logger | undefined;
	/** Running session totals. */
	let sessionStats = emptyStats();
	/** Fault tracker for pruning: pins paths whose eviction caused a re-fetch. */
	let faultState = createFaultState();
	/** Branch length at the last fault scan (turn_end). */
	let lastFaultScanIndex = 0;

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
			"Prefer handoff_session over compact_context at the end of a body of work when the NEXT task is materially different — the new session starts clean instead of carrying summaries.",
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
	// Agent-initiated handoff to a new session: consumed at the run boundary
	// ---------------------------------------------------------------------------

	pi.registerTool({
		name: "handoff_session",
		label: "Handoff Session",
		description:
			"Request a handoff: transfer context to a NEW session with your `focus` text as its starting prompt, instead of compacting the current one. Use at the end of a body of work when the next task is materially different — a fresh session beats carrying compaction summaries across tasks. By default the `focus` is used VERBATIM as the new session's starting prompt (no rewriting) — write it as a complete, self-contained brief: the goal, current work state, relevant files, and the next concrete step. Pass `generate: true` only when the conversation must be summarized into the prompt (e.g. the user gave a one-line goal); the generated version is lossier. Deferred like compaction: it runs when your current run settles, not immediately. The user reviews and edits the handoff prompt before anything happens — cancelling the editor declines the handoff. Requires interactive (TUI) mode.",
		promptSnippet: "Hand off context to a new session (your focus becomes the prompt; user approves)",
		promptGuidelines: [
			"Call handoff_session at the end of a body of work — after a merge gate, a completed task, or when the next task is materially different from the current one.",
			"Prefer compact_context instead when continuing related work in the same session: a handoff is for a clean start, compaction is for staying.",
			"The `focus` becomes the new session's starting point VERBATIM — state the goal, current work state, files involved, and the next concrete step, not a narration of the session. Write it fully: nothing will be added by a summarizer.",
			"handoff_session is deferred and needs user approval: it runs at the end of your current run, and the user must review and submit the handoff prompt. Finish your response normally after calling it.",
		],
		parameters: Type.Object({
			focus: Type.String({
				description:
					"What the next session must pick up: the goal, current work state, relevant files, and the next concrete step. Used VERBATIM as the new session's starting prompt, so write it complete and self-contained. The user reviews and can edit it.",
			}),
			generate: Type.Optional(
				Type.Boolean({
					description:
						"Opt into generating the prompt with an LLM summary of the conversation instead of using `focus` verbatim. Only pass true when a summary of the conversation itself is needed (lossier, can truncate detail).",
				}),
			),
			reason: Type.Optional(
				Type.String({ description: "One line on why a new session is better than continuing or compacting (shown to the user)." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Aborted." }], details: { kind: "aborted" } };
			}

			const focus = params.focus.trim();
			if (!focus) {
				return {
					content: [{ type: "text", text: "The `focus` parameter is empty — state what the next session must pick up." }],
					details: { kind: "validation-error" },
					isError: true,
				};
			}

			// Only the latest request is kept — the model should not stack handoffs.
			pendingHandoff = {
				focus,
				reason: params.reason?.trim() || undefined,
				generate: params.generate === true,
				requestedAt: Date.now(),
			};

			const usage = ctx.getContextUsage();
			log(ctx, "handoff_requested", {
				reason: params.reason?.trim() || null,
				focusLength: focus.length,
				generate: params.generate === true,
				percent: usage?.percent ?? null,
			});

			return {
				content: [
					{
					type: "text",
					text: params.generate
						? "Handoff requested with your focus. It will run when this run settles (not immediately) — finish your current response normally. A summarizer will draft the prompt from the conversation and your focus; the user will review and edit it, a new session opens with it as a draft, and the user submits it when ready."
						: "Handoff requested with your focus. It will run when this run settles (not immediately) — finish your current response normally. Your focus text becomes the new session's starting prompt VERBATIM; the user will review and can edit it, a new session opens with it as a draft, and the user submits it when ready.",
				},
			],
				details: { kind: "success", focus, reason: params.reason },
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
			"Selectively evict stale tool results from context. Called with no arguments (or listOnly), returns a size-ranked report of prune candidates (superseded file reads, stale command output) with estimated reclaimable tokens. Select with entryIds, files+keepLatest, or allCandidates. Pruning is cheaper and safer than compaction: results are replaced with tombstones and can be re-fetched by re-running the tool. Applies immediately, mid-run — your next request is built without the pruned content.",
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

			const estTokens = selected.reduce((sum, c) => sum + c.sizeTokens, 0);
			log(ctx, "prune_requested", {
				cappedOut,
				count: selected.length,
				estimatedTokens: estTokens,
				percent: usage?.percent ?? null,
				entries: selected.map((c) => ({ entryId: c.entryId, label: c.label, sizeTokens: c.sizeTokens })),
			});

			// Apply immediately, mid-run. appendContextEdit() is a public
			// session-manager method (spike-verified — see PRUNING_DESIGN.md
			// Appendix A): each turn's model request is rebuilt from the branch,
			// so the agent's NEXT request in this very run projects through the
			// tombstones. This is what makes pruning amortize in single-prompt
			// mega-runs, which have exactly one boundary: run end.
			const branchForFaults = ctx.sessionManager.getBranch() as import("./prune.ts").PruneEntry[];
			registerPruned(faultState, branchForFaults, selected);
			const editSession = ctx.sessionManager as unknown as EditCapableSessionManager;
			const applied: PruneCandidate[] = [];
			let appendError: string | undefined;
			for (const candidate of selected) {
				try {
					editSession.appendContextEdit(candidate.entryId, {
						content: [{ type: "text", text: buildTombstone(candidate) }],
					});
					applied.push(candidate);
				} catch (error) {
					appendError = appendError ?? String((error as Error)?.message ?? error);
				}
			}
			const appliedTokens = applied.reduce((sum, c) => sum + c.sizeTokens, 0);
			sessionStats.prunes += 1;
			sessionStats.pruneReclaimedTokens += appliedTokens;
			log(ctx, "prune_applied", {
				applied: "mid-run",
				entries: applied.length,
				estimatedTokens: appliedTokens,
				tokensBefore: usage?.tokens ?? null,
				percentBefore: usage?.percent ?? null,
				labels: applied.map((c) => c.label),
				...(appendError ? { appendError } : {}),
			});

			if (appendError) {
				return {
					content: [
						{
							type: "text",
							text: `Prune partially applied: ${applied.length}/${selected.length} entries tombstoned, then appendContextEdit failed: ${appendError}. The applied edits stand (already in effect); re-run prune_context to retry the remainder.`,
						},
					],
					details: { kind: "partial-error", applied, error: appendError },
					isError: true,
				};
			}

			const rejectedText = rejected.length > 0 ? ` Rejected (not pruned): ${rejected.map((r) => r.entryId).join(", ")}.` : "";
			const cappedText = cappedOut > 0 ? ` Per-pass cap: ${cappedOut} smaller entries were held back and remain candidates for a later pass.` : "";
			return {
				content: [
					{
						type: "text",
						text: `Pruned ${applied.length} entr${applied.length === 1 ? "y" : "ies"} (~${appliedTokens.toLocaleString()} tokens est.) — applied immediately; your next request is built without them. Pruned content is tombstoned — re-run the tools if you need it; do not answer from memory of it.${rejectedText}${cappedText}`,
					},
				],
				details: { kind: "success", selected, rejected, editCount: applied.length },
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

	/** Generate the handoff prompt and get user approval in the editor. Returns the approved prompt, or undefined after telling the agent why not. */
	async function generateAndApproveHandoff(ctx: ExtensionContext, request: PendingHandoff): Promise<string | undefined> {
		// The editor gate and the new-session draft are inherently interactive.
		// Headless modes cannot hand off — compaction remains available there.
		if (!ctx.hasUI || ctx.mode !== "tui") {
			log(ctx, "handoff_unavailable", { reason: "non-tui" });
			sendNotice(
				"Handoff declined: it requires interactive mode (the user must review the handoff prompt before the new session opens). Use compact_context instead, or let the user start the next session.",
				{ triggerTurn: true },
			);
			return undefined;
		}

		// Verbatim mode (default): the agent's focus IS the handoff prompt. The
		// agent writes it with full live context and the tool schema demands it be
		// self-contained — a second LLM call can only shorten or re-interpret it.
		if (request.reason) ctx.ui.notify(`Handoff requested — agent's reason: ${request.reason}`, "info");
		if (!request.generate) {
			return approveHandoffPrompt(ctx, request.focus, "verbatim");
		}

		const branch = ctx.sessionManager.getBranch() as HandoffEntry[];
		const messages = getHandoffMessages(branch);
		if (messages.length === 0) {
			log(ctx, "handoff_unavailable", { reason: "empty-branch" });
			sendNotice("Handoff declined: there is no conversation to hand off.", { triggerTurn: true });
			return undefined;
		}

		// Generate on the physical model behind the latest assistant response —
		// under a virtual model (dyna/auto), ctx.model names the virtual selection,
		// which modelRegistry.complete cannot dispatch to.
		const modelSpec = resolveGeneratorModel(branch);
		const model = modelSpec ? ctx.modelRegistry.find(modelSpec.provider, modelSpec.modelId) : undefined;
		if (!model) {
			log(ctx, "handoff_unavailable", { reason: "no-generator-model", modelSpec: modelSpec ?? null });
			sendNotice(
				"Handoff declined: no physical model was found to generate the handoff prompt. Let the user start the next session.",
				{ triggerTurn: true },
			);
			return undefined;
		}

		const conversationText = serializeConversation(convertToLlm(messages as Parameters<typeof convertToLlm>[0]));

		// Generate with a cancellable loader, exactly like pi's own handoff example.
		const generated = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
			loader.onAbort = () => done(null);

			const doGenerate = async () => {
				const response = await ctx.modelRegistry.complete(
					model,
					{
						systemPrompt: HANDOFF_SYSTEM_PROMPT,
						messages: [buildHandoffUserMessage(conversationText, request.focus)],
					},
					{ signal: loader.signal, cacheRetention: "none", sessionId: uuidv7() },
				);
				if (response.stopReason === "aborted") return null;
				return response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
			};

			doGenerate()
				.then(done)
				.catch((err) => {
					log(ctx, "handoff_failed", { error: String(err) });
					done(null);
				});

			return loader;
		});

		if (generated === null) {
			log(ctx, "handoff_cancelled", { stage: "generation" });
			ctx.ui.notify("Handoff cancelled", "info");
			sendNotice("The handoff was cancelled before the prompt was generated. Nothing has changed — the session continues.", { triggerTurn: true });
			return undefined;
		}

		return approveHandoffPrompt(ctx, generated, "generated");
	}

	/** The approval gate: the user reviews and edits the handoff prompt in the editor. Cancelling the editor declines the handoff entirely. */
	async function approveHandoffPrompt(ctx: ExtensionContext, prompt: string, mode: "verbatim" | "generated"): Promise<string | undefined> {
		const edited = await ctx.ui.editor("Edit handoff prompt", prompt);
		if (edited === undefined) {
			log(ctx, "handoff_declined", { mode });
			ctx.ui.notify("Handoff declined — the agent will be told", "warning");
			sendNotice(
				"The user DECLINED the handoff to a new session. Do not immediately re-request it. Either continue in this session (consider compact_context or prune_context for pressure) or ask the user how they want to proceed.",
				{ triggerTurn: true },
			);
			return undefined;
		}

		log(ctx, "handoff_approved", { mode, editedLength: edited.length, generatedLength: prompt.length });
		return edited;
	}

	/** Execute an approved handoff: switch to a new session with the prompt as a draft. Command context only. */
	async function executeHandoff(ctx: ExtensionCommandContext, prompt: string, parentSession: string | undefined) {
		await ctx.newSession({
			parentSession,
			withSession: async (replacementCtx) => {
				replacementCtx.ui.setEditorText(prompt);
				replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
			},
		});
	}

	pi.on("agent_before_settle", async (_event, ctx) => {
		// Handoff + compaction approval + execution at the boundary. A requested
		// handoff supersedes a pending compaction: the new session makes
		// compacting the old one moot. Prune edits no longer pass through here:
		// they are applied mid-run by the prune_context handler (see
		// PRUNING_DESIGN.md Appendix A), so by the time this fires they are
		// already persisted on the branch — the summarizer sees tombstones, not
		// stale content, with no deferral.
		const handoff = pendingHandoff;
		pendingHandoff = undefined;
		if (handoff) {
			pendingCompaction = undefined;
			const approved = await generateAndApproveHandoff(ctx, handoff);
			if (approved !== undefined) {
				// Session control (newSession) is command-context only in pi's extension
				// API, so the switch itself happens through the /handoff command. Park
				// the approved prompt where it can pick it up; the user runs /handoff.
				writePendingHandoff(getAgentDir(), {
					sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
					prompt: approved,
					focus: handoff.focus,
					createdAt: Date.now(),
				});
				ctx.ui.notify("Handoff approved and parked. Run /handoff to open the new session.", "info");
			}
			return undefined;
		}

		const request = pendingCompaction;
		pendingCompaction = undefined;
		if (!request) {
			return undefined;
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
			return undefined;
		}
		log(ctx, "compaction_approved", { percent: usage?.percent ?? null });
		runCompaction(ctx, request.preserve);
		return undefined;
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
		pendingHandoff = undefined;
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

	pi.registerCommand("handoff", {
		description:
			"Open a new session with a handoff prompt. With no args: execute the agent's approved handoff if one is parked. With a goal: generate a fresh handoff prompt from this session, review it, then switch.",
		handler: async (args, ctx) => {
			const parked = readPendingHandoff(getAgentDir());
			const goal = args.trim();

			if (!goal && parked) {
				clearPendingHandoff(getAgentDir());
				log(ctx, "handoff_executed", { fromAgent: true, createdAt: parked.createdAt });
				await executeHandoff(ctx, parked.prompt, parked.sessionFile);
				return;
			}

			if (!goal) {
				ctx.ui.notify(
					parked
							? "Usage: /handoff <goal> (an approved handoff from the agent is parked — run /handoff with no arguments to execute it)"
							: "Usage: /handoff <goal for the new session>",
					"warning",
				);
				return;
			}

			// Manual flow: generate from the stated goal, review, switch.
			// A parked agent handoff is superseded by the manual one.
			if (parked) clearPendingHandoff(getAgentDir());
			// A goal is a one-liner, not a finished brief — it needs the summarizer.
			const approved = await generateAndApproveHandoff(ctx, { focus: goal, generate: true, requestedAt: Date.now() });
			if (approved === undefined) return; // the user was told why
			log(ctx, "handoff_executed", { fromAgent: false });
			await executeHandoff(ctx, approved, ctx.sessionManager.getSessionFile());
		},
	});

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
