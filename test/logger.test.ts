import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@/logger";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pcc-log-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function readLines(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}

describe("createLogger", () => {
	it("writes JSONL lines with ts, sessionId, cwd, and event", () => {
		const path = join(dir, "cc.jsonl");
		const logger = createLogger({ enabled: true, sessionId: () => "sess-1", cwd: "/proj", filePath: path });
		logger.log("turn_usage", { input: 100, cacheRead: 50 });

		const lines = readLines(path);
		expect(lines).toHaveLength(1);
		expect(lines[0].event).toBe("turn_usage");
		expect(lines[0].sessionId).toBe("sess-1");
		expect(lines[0].cwd).toBe("/proj");
		expect(typeof lines[0].ts).toBe("string");
		expect(lines[0].input).toBe(100);
		expect(lines[0].cacheRead).toBe(50);
	});

	it("resolves sessionId lazily (a later session id is used)", () => {
		const path = join(dir, "cc.jsonl");
		let current = "sess-1";
		const logger = createLogger({ enabled: true, sessionId: () => current, cwd: "/proj", filePath: path });
		current = "sess-2";
		logger.log("reminder_fired", { tier: 30 });
		expect(readLines(path)[0].sessionId).toBe("sess-2");
	});

	it("writes nothing when disabled", () => {
		const path = join(dir, "cc.jsonl");
		const logger = createLogger({ enabled: false, sessionId: () => "s", cwd: "/p", filePath: path });
		logger.log("turn_usage", {});
		expect(existsSync(path)).toBe(false);
	});

	it("creates the log directory if missing", () => {
		const path = join(dir, "nested", "deep", "cc.jsonl");
		const logger = createLogger({ enabled: true, sessionId: () => "s", cwd: "/p", filePath: path });
		logger.log("config_loaded", {});
		expect(readLines(path)).toHaveLength(1);
	});

	it("rotates a file larger than 5 MB to .1 (one generation)", () => {
		const path = join(dir, "cc.jsonl");
		// Pre-create an oversized file
		writeFileSync(path, "x".repeat(5 * 1024 * 1024 + 1));
		const logger = createLogger({ enabled: true, sessionId: () => "s", cwd: "/p", filePath: path });
		logger.log("turn_usage", {});
		expect(statSync(`${path}.1`).size).toBeGreaterThan(5 * 1024 * 1024);
		expect(readLines(path)).toHaveLength(1); // fresh file has only the new event
	});

	it("swallows write errors instead of throwing", () => {
		// "used-as-dir" is a FILE, so creating the log dir under it fails
		writeFileSync(join(dir, "used-as-dir"), "");
		const logger = createLogger({
			enabled: true,
			sessionId: () => "s",
			cwd: "/p",
			filePath: join(dir, "used-as-dir", "child", "cc.jsonl"),
		});
		expect(() => logger.log("turn_usage", {})).not.toThrow();
	});
});
