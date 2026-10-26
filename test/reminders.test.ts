import { describe, it, expect } from "vitest";
import { reminderText } from "@/reminders";

describe("reminderText", () => {
	it("prefixes every reminder with the controller tag and percentage", () => {
		const text = reminderText(42.5, 30);
		expect(text).toContain("[context-controller] Context usage: 42.5%.");
	});

	it("uses tier-appropriate guidance", () => {
		expect(reminderText(31, 30)).toContain("Context is filling");
		expect(reminderText(67, 65)).toContain("Moderate usage");
		expect(reminderText(82, 80)).toContain("High usage");
		expect(reminderText(91, 90)).toContain("Auto-compaction is imminent");
	});

	it("high tiers teach prune-before-compact", () => {
		expect(reminderText(82, 80)).toContain("prune_context");
		expect(reminderText(82, 80)).toContain("compact_context");
	});

	it("appends the prune candidate line when candidates exist", () => {
		const text = reminderText(72, 70, { count: 3, tokens: 12400 });
		expect(text).toContain("3 prune candidates, ~12,400 tokens reclaimable");
		expect(text).toContain("consider prune_context before compaction");
	});

	it("singularizes one candidate", () => {
		const text = reminderText(72, 70, { count: 1, tokens: 800 });
		expect(text).toContain("1 prune candidate, ~800 tokens reclaimable");
	});

	it("omits the prune line when there are no candidates", () => {
		const text = reminderText(72, 70, { count: 0, tokens: 0 });
		expect(text).not.toContain("prune candidate");
		expect(text).not.toContain("reclaimable");
	});

	it("omits the prune line when no summary is given", () => {
		const text = reminderText(72, 70);
		expect(text).not.toContain("reclaimable");
	});
});
