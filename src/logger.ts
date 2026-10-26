/**
 * JSONL logging for local session deep-dives: what the context controller did,
 * when, and what it cost. One append-only file; every line carries `sessionId`
 * and `cwd` so lines can be sliced per session or per project with jq.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface Logger {
	/** Append one JSONL event line. No-op when logging is disabled. */
	log(event: string, payload?: Record<string, unknown>): void;
}

export interface LoggerOptions {
	enabled: boolean;
	/** Lazily evaluated so a not-yet-started session resolves when first needed. */
	sessionId: () => string;
	cwd: string;
	/** Override log file location (tests). Defaults into the pi agent dir. */
	filePath?: string;
	agentDir?: string;
}

/**
 * Create a JSONL logger. Rotation: when the active file exceeds 5 MB at
 * initialization, it is renamed to `<file>.1` (one generation kept).
 */
export function createLogger(options: LoggerOptions): Logger {
	const filePath =
		options.filePath ?? join(options.agentDir ?? "", "logs", "context-controller.jsonl");

	let ready = false;

	const prepare = () => {
		if (ready) return;
		ready = true;
		try {
			mkdirSync(dirname(filePath), { recursive: true });
			const stats = statSync(filePath);
			if (stats.size > MAX_LOG_BYTES) {
				renameSync(filePath, `${filePath}.1`);
			}
		} catch {
			// Missing file (or unwritable dir): appendFileSync will surface real errors
		}
	};

	if (!options.enabled) {
		return { log: () => {} };
	}

	return {
		log(event: string, payload: Record<string, unknown> = {}) {
			try {
				prepare();
				const line = JSON.stringify({
					ts: new Date().toISOString(),
					sessionId: options.sessionId(),
					cwd: options.cwd,
					event,
					...payload,
				});
				appendFileSync(filePath, `${line}\n`);
			} catch {
				// Logging must never break the host: swallow write errors
			}
		},
	};
}
