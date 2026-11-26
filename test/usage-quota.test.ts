import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCliUsageQuota, parseUsageQuota } from "../src/acp/usage-quota.js";

const reply = fs.readFileSync(new URL("./fixtures/usage-reply.md", import.meta.url), "utf8");
const now = 1_800_000_000_000;
const unavailable = (line: string) =>
	`### Session Usage\n- **Session total:** data not available yet\n\n### Quota Limits\n${line}`;

describe("parseUsageQuota", () => {
	it("reads every group from the server's /usage reply", () => {
		expect(parseUsageQuota(reply, now)).toEqual({
			at: now,
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{ window: "weekly", remainingFraction: 0.75, resetTime: "2026-01-12T18:00:00.000Z" },
						{ window: "5h", remainingFraction: 0.9, resetTime: "2026-01-08T04:30:00.000Z" },
					],
				},
				{
					displayName: "Claude and GPT models",
					buckets: [
						{ window: "weekly", remainingFraction: 0.6, resetTime: "2026-01-14T09:15:00.000Z" },
						{ window: "5h", remainingFraction: 1, resetTime: "2026-01-08T06:45:00.000Z" },
					],
				},
				{
					displayName: "Gemini 4 Argon",
					buckets: [{ window: "weekly", remainingFraction: 0.4, resetTime: "2026-01-13T12:00:00.000Z" }],
				},
			],
		});
	});

	it("keeps a group without active limits and buckets without a reset", () => {
		const text = unavailable(
			"- **Gemini Models**\n  - **Daily Cap:** 50% remaining\n- **Other**\n  - No active bucket limits",
		);
		expect(parseUsageQuota(text, now)).toEqual({
			at: now,
			groups: [
				{ displayName: "Gemini Models", buckets: [{ window: "Daily Cap", remainingFraction: 0.5 }] },
				{ displayName: "Other", buckets: [] },
			],
		});
	});

	it("rejects replies without quota groups", () => {
		expect(() => parseUsageQuota(unavailable("- Unable to retrieve quota status (backend unavailable)"), now))
			.toThrow("Unable to retrieve quota status (backend unavailable)");
		expect(() => parseUsageQuota(unavailable("- Not applicable for current authentication method."), now))
			.toThrow("Not applicable for current authentication method.");
		expect(() => parseUsageQuota("Hello", now)).toThrow("no quota groups");
	});
});

describe("parseCliUsageQuota", () => {
	it("parses tab-separated agy -p /usage output and drops epoch-zero reset timers", () => {
		const output = [
			"Gemini Models\tWeekly Limit Remaining\t78%\t2026-12-02T04:24:23Z",
			"Gemini Models\tFive Hour Limit Remaining\t69%\t2026-11-26T05:56:25Z",
			"Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z",
			"Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z",
		].join("\n");
		expect(parseCliUsageQuota(output, now)).toEqual({
			at: now,
			groups: [
				{
					displayName: "Gemini Models",
					buckets: [
						{ window: "weekly", remainingFraction: 0.78, resetTime: "2026-12-02T04:24:23.000Z" },
						{ window: "5h", remainingFraction: 0.69, resetTime: "2026-11-26T05:56:25.000Z" },
					],
				},
				{
					displayName: "Claude and GPT models",
					buckets: [
						{ window: "weekly", remainingFraction: 1 },
						{ window: "5h", remainingFraction: 1 },
					],
				},
			],
		});
	});

	it("rejects empty or invalid CLI /usage output", () => {
		expect(() => parseCliUsageQuota("", now)).toThrow("no quota groups: empty");
		expect(() => parseCliUsageQuota("Gemini Models\tWeekly\t2026-12-02T04:24:23Z", now)).toThrow("no quota groups");
		expect(() => parseCliUsageQuota("Gemini Models\tWeekly\t105%\t2026-12-02T04:24:23Z", now)).toThrow("invalid percentage");
		expect(() => parseCliUsageQuota("Gemini Models\tWeekly\t50%\tnot-a-date", now)).toThrow("invalid reset time");
	});
});
