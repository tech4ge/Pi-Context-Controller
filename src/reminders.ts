/**
 * Reminder text composition — pure and unit-testable.
 *
 * Reminders are injected into the conversation at turn_end when usage crosses a
 * configured tier. The text teaches the escalation ladder at the moment it
 * matters: prune nudges appear only when candidates actually exist (and
 * pruning is enabled), so the guidance is always actionable, never noise.
 */

export interface PruneSummary {
	/** Number of current prune candidates. */
	count: number;
	/** Total estimated reclaimable tokens across candidates. */
	tokens: number;
}

/** Guidance per tier band, with optional prune-candidate summary appended. */
export function reminderText(percent: number, tier: number, prune?: PruneSummary | null): string {
	const guidance =
		tier >= 90
			? "Auto-compaction is imminent. Wrap up the current sub-task now: write important state to durable files, then either call compact_context with a preservation focus or propose starting a new session to the user."
			: tier >= 80
				? "High usage. Call prune_context if stale tool results are behind you, then compact_context with a preservation focus at the next sub-task boundary. Prefer structural lookups over full file reads and delegate large reads to subagents."
				: tier >= 65
					? "Moderate usage. Consider prune_context for stale tool results behind you. Size remaining work accordingly: avoid unnecessary full-file reads and be deliberate about what you pull into context."
					: "Context is filling. Keep this in mind when sizing upcoming reads and investigations.";

	const pruneLine =
		prune && prune.count > 0
			? ` ${prune.count} prune candidate${prune.count === 1 ? "" : "s"}, ~${formatTokens(prune.tokens)} tokens reclaimable — consider prune_context before compaction.`
			: "";

	return `[context-controller] Context usage: ${percent}%. ${guidance}${pruneLine}`;
}

function formatTokens(tokens: number): string {
	return Math.round(tokens).toLocaleString();
}
