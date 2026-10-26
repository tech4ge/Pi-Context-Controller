/**
 * Configuration loading for Pi-Context-Controller.
 *
 * Config is read from two optional JSON files, merged field-by-field:
 *   1. ~/.pi/agent/context-controller.json  (user-level defaults)
 *   2. <project>/.pi/context-controller.json (project-level overrides, wins)
 *
 * A dedicated config file is used rather than a key inside .pi/settings.json
 * because pi's settings schema is strictly typed and owned by the host;
 * unknown keys have no stability guarantee. This file is ours alone.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ContextControllerConfig {
	/** Show a Yes/No approval dialog (with the agent's proposed compaction instructions) before an agent-requested compaction runs. */
	confirmBeforeCompaction: boolean;
	/** Inject context-usage reminders into the conversation at configured thresholds. */
	remindersEnabled: boolean;
	/** Ascending percentages of the context window at which to inject a reminder. */
	reminderThresholds: number[];
	/** "once_per_tier": each threshold fires once until usage drops below it or a compaction happens. "every_turn": remind on every turn while above a threshold. */
	reminderRepeatMode: "once_per_tier" | "every_turn";
	/** Append JSONL events (context decisions, usage samples, outcomes) to the pi agent log dir. */
	loggingEnabled: boolean;
	/** Include a per-turn token/cache/cost sample event at every turn end. */
	logTurnUsage: boolean;
	/** Register the prune_context tool (selective eviction of stale tool results). */
	pruningEnabled: boolean;
	/** Tool results from the last N turns are never prunable (working-set protection). */
	pruneProtectTurns: number;
	/** Tool results below this estimated size are not worth a context_edit. */
	pruneMinTokens: number;
}

export const DEFAULT_CONFIG: ContextControllerConfig = {
	confirmBeforeCompaction: true,
	remindersEnabled: true,
	reminderThresholds: [50, 70, 85, 95],
	reminderRepeatMode: "once_per_tier",
	loggingEnabled: true,
	logTurnUsage: true,
	pruningEnabled: true,
	pruneProtectTurns: 5,
	pruneMinTokens: 400,
};

export interface LoadedConfig {
	config: ContextControllerConfig;
	/** Paths of config files that were found and applied, in application order. */
	sources: string[];
	/** Per-field notes about values that were invalid and fell back (for diagnostics). */
	warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceThresholds(value: unknown, fallback: number[]): number[] {
	if (!Array.isArray(value)) return fallback;
	const thresholds = value
		.filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v < 100)
		.map((v) => Math.floor(v));
	const unique = [...new Set(thresholds)].sort((a, b) => a - b);
	return unique.length > 0 ? unique : fallback;
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const raw = readFileSync(path, "utf8");
		const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Merge a partial config object (from a file) onto a base config. Returns the new config plus warnings for invalid values. */
export function applyConfigFile(
	base: ContextControllerConfig,
	file: Record<string, unknown> | undefined,
	sourceName: string,
): { config: ContextControllerConfig; warnings: string[] } {
	const warnings: string[] = [];
	if (!file) return { config: base, warnings };

	const next: ContextControllerConfig = { ...base };

	if ("confirmBeforeCompaction" in file) {
		if (typeof file.confirmBeforeCompaction === "boolean") {
			next.confirmBeforeCompaction = file.confirmBeforeCompaction;
		} else {
			warnings.push(`${sourceName}: confirmBeforeCompaction must be a boolean, keeping ${base.confirmBeforeCompaction}`);
		}
	}
	if ("remindersEnabled" in file) {
		if (typeof file.remindersEnabled === "boolean") {
			next.remindersEnabled = file.remindersEnabled;
		} else {
			warnings.push(`${sourceName}: remindersEnabled must be a boolean, keeping ${base.remindersEnabled}`);
		}
	}
	if ("reminderThresholds" in file) {
		if (Array.isArray(file.reminderThresholds)) {
			next.reminderThresholds = coerceThresholds(file.reminderThresholds, base.reminderThresholds);
		} else {
			warnings.push(`${sourceName}: reminderThresholds must be an array of percentages, keeping ${base.reminderThresholds.join(", ")}`);
		}
	}
	if ("reminderRepeatMode" in file) {
		if (file.reminderRepeatMode === "once_per_tier" || file.reminderRepeatMode === "every_turn") {
			next.reminderRepeatMode = file.reminderRepeatMode;
		} else {
			warnings.push(`${sourceName}: reminderRepeatMode must be "once_per_tier" or "every_turn", keeping ${base.reminderRepeatMode}`);
		}
	}
	for (const key of ["loggingEnabled", "logTurnUsage", "pruningEnabled"] as const) {
		if (key in file) {
			if (typeof file[key] === "boolean") {
				next[key] = file[key] as boolean;
			} else {
				warnings.push(`${sourceName}: ${key} must be a boolean, keeping ${base[key]}`);
			}
		}
	}
	for (const key of ["pruneProtectTurns", "pruneMinTokens"] as const) {
		if (key in file) {
			const value = file[key];
			if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
				next[key] = Math.floor(value);
			} else {
				warnings.push(`${sourceName}: ${key} must be a non-negative number, keeping ${base[key]}`);
			}
		}
	}

	return { config: next, warnings };
}

/** Load the effective configuration. Safe to call repeatedly; files are tiny. */
export function loadConfig(cwd: string): LoadedConfig {
	const sources: string[] = [];
	const warnings: string[] = [];

	let { config } = { config: { ...DEFAULT_CONFIG } };

	const userPath = join(homedir(), ".pi", "agent", "context-controller.json");
	const userFile = readJsonFile(userPath);
	if (userFile) {
		const result = applyConfigFile(config, userFile, userPath);
		config = result.config;
		warnings.push(...result.warnings);
		sources.push(userPath);
	}

	const projectPath = join(cwd, ".pi", "context-controller.json");
	const projectFile = readJsonFile(projectPath);
	if (projectFile) {
		const result = applyConfigFile(config, projectFile, projectPath);
		config = result.config;
		warnings.push(...result.warnings);
		sources.push(projectPath);
	}

	return { config, sources, warnings };
}
