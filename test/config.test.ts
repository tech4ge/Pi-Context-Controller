import { afterAll, describe, it, expect } from "vitest";
import { applyConfigFile, DEFAULT_CONFIG, loadConfig, type ContextControllerConfig } from "@/config";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("applyConfigFile", () => {
	it("returns base unchanged when file is undefined", () => {
		const { config, warnings } = applyConfigFile(DEFAULT_CONFIG, undefined, "test");
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(warnings).toEqual([]);
	});

	it("applies valid booleans", () => {
		const { config } = applyConfigFile(DEFAULT_CONFIG, { confirmBeforeCompaction: false }, "test");
		expect(config.confirmBeforeCompaction).toBe(false);
		expect(config.remindersEnabled).toBe(true);
	});

	it("falls back on invalid values with a warning", () => {
		const { config, warnings } = applyConfigFile(
			DEFAULT_CONFIG,
			{ confirmBeforeCompaction: "yes please", remindersEnabled: 1, reminderRepeatMode: "always" },
			"test",
		);
		expect(config.confirmBeforeCompaction).toBe(DEFAULT_CONFIG.confirmBeforeCompaction);
		expect(config.remindersEnabled).toBe(DEFAULT_CONFIG.remindersEnabled);
		expect(config.reminderRepeatMode).toBe(DEFAULT_CONFIG.reminderRepeatMode);
		expect(warnings).toHaveLength(3);
	});

	it("normalizes thresholds: dedupes, sorts, drops out-of-range", () => {
		const { config } = applyConfigFile(
			DEFAULT_CONFIG,
			{ reminderThresholds: [95, 50, 50, 0, 150, "70", 70] },
			"test",
		);
		expect(config.reminderThresholds).toEqual([50, 70, 95]);
	});

	it("keeps fallback thresholds when none are valid", () => {
		const { config } = applyConfigFile(DEFAULT_CONFIG, { reminderThresholds: ["high"] }, "test");
		expect(config.reminderThresholds).toEqual(DEFAULT_CONFIG.reminderThresholds);
	});
});

describe("loadConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-config-"));

	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("uses defaults when no config files exist", () => {
		const { config, sources } = loadConfig(join(dir, "empty-project"));
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(sources).toEqual([]);
	});

	it("loads project config from <cwd>/.pi/context-controller.json", () => {
		const project = join(dir, "project-a");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "context-controller.json"), JSON.stringify({ confirmBeforeCompaction: false }));
		const { config, sources } = loadConfig(project);
		expect(config.confirmBeforeCompaction).toBe(false);
		expect(sources).toEqual([join(project, ".pi", "context-controller.json")]);
	});

	it("recovers from malformed JSON by ignoring the file", () => {
		const project = join(dir, "project-b");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "context-controller.json"), "{ not json");
		const { config, sources } = loadConfig(project);
		expect(config).toEqual(DEFAULT_CONFIG);
		expect(sources).toEqual([]);
	});
});

describe("prune config fields", () => {
	const dir = mkdtempSync(join(tmpdir(), "pcc-prune-cfg-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("applies valid prune fields", () => {
		const project = join(dir, "project-prune");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			join(project, ".pi", "context-controller.json"),
			JSON.stringify({ pruningEnabled: false, pruneProtectTailTokens: 8000, pruneMinCallAge: 5, pruneMinTokens: 1000, pruneMaxPerPass: 3 }),
		);
		const { config, warnings } = loadConfig(project);
		expect(config.pruningEnabled).toBe(false);
		expect(config.pruneProtectTailTokens).toBe(8000);
		expect(config.pruneMinCallAge).toBe(5);
		expect(config.pruneMinTokens).toBe(1000);
		expect(config.pruneMaxPerPass).toBe(3);
		expect(warnings).toEqual([]);
	});

	it("falls back on invalid prune fields, and warns on the obsolete turn-based field", () => {
		const project = join(dir, "project-prune-bad");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			join(project, ".pi", "context-controller.json"),
			JSON.stringify({ pruningEnabled: "yes", pruneProtectTailTokens: -2, pruneMinCallAge: "soon", pruneMinTokens: "big", pruneMaxPerPass: -1, pruneProtectTurns: 5 }),
		);
		const { config, warnings } = loadConfig(project);
		expect(config.pruningEnabled).toBe(true);
		expect(config.pruneProtectTailTokens).toBe(20000);
		expect(config.pruneMinCallAge).toBe(15);
		expect(config.pruneMinTokens).toBe(400);
		expect(config.pruneMaxPerPass).toBe(12);
		expect(warnings).toHaveLength(6); // 5 invalid fields + the obsolete-field warning
		expect(warnings.some((w) => w.includes("pruneProtectTurns is obsolete"))).toBe(true);
	});
});
