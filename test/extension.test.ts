import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AntigravityAcpError } from "../src/acp/errors.js";
import { parseUsageQuota } from "../src/acp/usage-quota.js";
import { QUOTA_REQUEST_CHANNEL } from "../src/constants.js";
import type { OmpProviderConfig } from "../src/provider.js";
import { MANAGED_AUTH_MARKER, PERMISSION_TOOL_NAME } from "../src/runtime.js";
import {
	createFakeContext,
	createFakeExtensionApi,
	type FakeContext,
	type FakeExtensionApi,
	type FakeProviderRegistry,
} from "./helpers/fake-extension-api.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const usageReply = fs.readFileSync(new URL("./fixtures/usage-reply.md", import.meta.url), "utf8");
const now = 1_800_000_000_000;
const model: Model<"antigravity-acp"> = { id: "gemini-test", name: "Test", api: "antigravity-acp", provider: "antigravity-acp", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 8192 };
const user = (content: string, timestamp = 1): Context["messages"][number] => ({ role: "user", content, timestamp });

let root: string;
let log: string;
let registry: FakeProviderRegistry;
let loaded: Array<{ pi: FakeExtensionApi; ctx: FakeContext }>;
let connections: AntigravityAcpConnection[];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-extension-"));
	fs.mkdirSync(path.join(root, "home"));
	fs.mkdirSync(path.join(root, "agent"));
	log = path.join(root, "calls.jsonl");
	fs.writeFileSync(log, "");
	// Never read or migrate a developer's real configuration.
	vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
	vi.spyOn(os, "homedir").mockReturnValue(path.join(root, "home"));
	registry = new Map();
	loaded = [];
	connections = [];
});

afterEach(async () => {
	for (const { pi, ctx } of loaded.splice(0)) await pi.emit("session_shutdown", { reason: "quit" }, ctx);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

// Pi loads each extension instance with a fresh module graph.
async function load(sessionId: string, events?: FakeExtensionApi["api"]["events"]) {
	vi.resetModules();
	const { registerAntigravityAcp } = await import("../extensions/index.js");
	const pi = createFakeExtensionApi(registry);
	if (events) pi.api.events = events;
	registerAntigravityAcp(pi.api, (options) => {
		const connection = new AntigravityAcpConnection({
			...options, command: process.execPath,
			args: [fakeAgent], env: { ...process.env, FAKE_AGENT_LOG_FILE: log }
		});
		connections.push(connection);
		return connection;
	});
	const ctx = createFakeContext({ sessionId, cwd: root });
	loaded.push({ pi, ctx });
	return { pi, ctx };
}

// load() imports a fresh module graph; spy on that graph's runtime class.
async function spyQuota() {
	const { AntigravityRuntime } = await import("../src/runtime.js");
	return vi.spyOn(AntigravityRuntime.prototype, "quota");
}

function stream(messages: Context["messages"], sessionId: string, provider = registry.get("antigravity-acp")) {
	if (!provider) throw new Error("antigravity-acp provider is not registered");
	return provider.streamSimple(model, normalizeContext({ messages }), { sessionId, apiKey: "test-key" }).result();
}

// Synthetic ACP processes only: no Google account or real agent actions.
describe("extension entry point", () => {
	it("registers the provider, permission tool, and commands", async () => {
		const { pi } = await load("parent");
		expect(registry.get("antigravity-acp")).toBe(pi.providers[0]);
		expect(pi.tools.has(PERMISSION_TOOL_NAME)).toBe(true);
		expect([...pi.commands.keys()]).toEqual(["pi-antigravity-acp"]);
	});

	it("completes arguments on the command without opening an ACP connection", async () => {
		const { pi, ctx } = await load("parent");
		const command = pi.commands.get("pi-antigravity-acp")!;
		expect(await command.getArgumentCompletions!("tool-activity f")).toEqual([
			{ value: "tool-activity full", label: "full" },
		]);
		expect(await command.getArgumentCompletions!("doctor --v")).toEqual([
			{ value: "doctor --verbose", label: "--verbose" },
		]);
		expect(connections).toHaveLength(0);
		const items = (await command.getArgumentCompletions!("tool-activity o"))!;
		await command.handler(items[0]!.value, ctx as never);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Antigravity tool activity: off", "info");
	});

	it("registers OMP's two-argument provider config with effort thinking and a managed key", async () => {
		vi.resetModules();
		// A fresh module graph is the point: the extension caches state per load.
		const { registerAntigravityAcp } = await import("../extensions/index.js");
		const pi = createFakeExtensionApi(registry);
		const registered: Array<{ name: string; config: OmpProviderConfig }> = [];
		Object.assign(pi.api, {
			// OMP's host method takes (name, config); its arity selects the OMP path.
			registerProvider: (name: string, config: OmpProviderConfig) => {
				registered.push({ name, config });
			},
		});
		registerAntigravityAcp(pi.api, (options) => {
			const connection = new AntigravityAcpConnection({
				...options, command: process.execPath,
				args: [fakeAgent], env: { ...process.env, FAKE_AGENT_LOG_FILE: log }
			});
			connections.push(connection);
			return connection;
		});
		const ctx = createFakeContext({ sessionId: "omp", cwd: root });
		loaded.push({ pi, ctx });

		const [registration] = registered;
		expect(registration?.name).toBe("antigravity-acp");
		expect(registration?.config.baseUrl).toBe("acp://antigravity");
		// OMP reserves "antigravity-acp" for its built-in API, so the registered one differs.
		expect(registration?.config.api).toBe("pi-antigravity-acp");
		expect(registration?.config.models.some(
			(entry) => entry.thinking?.mode === "effort" && entry.thinking.efforts.includes("low"),
		)).toBe(true);
		expect(registration?.config.oauth.getApiKey()).toBe(MANAGED_AUTH_MARKER);
		expect(registration?.config.usage.id).toBe("antigravity-acp");
		expect(pi.tools.get(PERMISSION_TOOL_NAME)).toMatchObject({ loadMode: "essential", intent: "omit" });
	});

	it("exposes live Antigravity quota through OMP's UsageProvider", async () => {
		vi.resetModules();
		const { registerAntigravityAcp } = await import("../extensions/index.js");
		const { AntigravityRuntime } = await import("../src/runtime.js");
		const pi = createFakeExtensionApi(registry);
		const registered: Array<{ name: string; config: OmpProviderConfig }> = [];
		Object.assign(pi.api, {
			registerProvider: (name: string, config: OmpProviderConfig) => {
				registered.push({ name, config });
			},
		});
		const quotaSpy = vi.spyOn(AntigravityRuntime.prototype, "quota").mockResolvedValue(parseUsageQuota(usageReply, now));
		registerAntigravityAcp(pi.api);
		const ctx = createFakeContext({ sessionId: "omp-usage", cwd: root });
		loaded.push({ pi, ctx });

		const usageProvider = registered[0]!.config.usage;
		const report = await usageProvider.fetchUsage({
			provider: "antigravity-acp",
			credential: { type: "api_key", apiKey: MANAGED_AUTH_MARKER, email: "user@example.com", accountId: "acc-1" },
		});

		expect(quotaSpy).toHaveBeenCalledWith(MANAGED_AUTH_MARKER, undefined);
		expect(report).toMatchObject({
			provider: "antigravity-acp",
			fetchedAt: now,
			metadata: { email: "user@example.com", accountId: "acc-1" },
		});
		expect(report?.limits).toEqual([
			{
				id: "antigravity-acp:gemini-models:weekly",
				label: "Gemini Models",
				scope: { provider: "antigravity-acp", tier: "Gemini Models", windowId: "weekly", accountId: "acc-1" },
				window: { id: "weekly", label: "Weekly", durationMs: 7 * 86_400_000, resetsAt: Date.parse("2026-01-12T18:00:00.000Z") },
				amount: { unit: "percent", usedFraction: 0.25, remainingFraction: 0.75, used: 25, remaining: 75, limit: 100 },
				status: "ok",
			},
			{
				id: "antigravity-acp:gemini-models:5h",
				label: "Gemini Models",
				scope: { provider: "antigravity-acp", tier: "Gemini Models", windowId: "5h", accountId: "acc-1" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * 3_600_000, resetsAt: Date.parse("2026-01-08T04:30:00.000Z") },
				amount: { unit: "percent", usedFraction: 0.1, remainingFraction: 0.9, used: 10, remaining: 90, limit: 100 },
				status: "ok",
			},
			{
				id: "antigravity-acp:claude-and-gpt-models:weekly",
				label: "Claude and GPT models",
				scope: { provider: "antigravity-acp", tier: "Claude and GPT models", windowId: "weekly", accountId: "acc-1" },
				window: { id: "weekly", label: "Weekly", durationMs: 7 * 86_400_000, resetsAt: Date.parse("2026-01-14T09:15:00.000Z") },
				amount: { unit: "percent", usedFraction: 0.4, remainingFraction: 0.6, used: 40, remaining: 60, limit: 100 },
				status: "ok",
			},
			{
				id: "antigravity-acp:claude-and-gpt-models:5h",
				label: "Claude and GPT models",
				scope: { provider: "antigravity-acp", tier: "Claude and GPT models", windowId: "5h", accountId: "acc-1" },
				window: { id: "5h", label: "5 Hour", durationMs: 5 * 3_600_000, resetsAt: Date.parse("2026-01-08T06:45:00.000Z") },
				amount: { unit: "percent", usedFraction: 0, remainingFraction: 1, used: 0, remaining: 100, limit: 100 },
				status: "ok",
			},
			{
				id: "antigravity-acp:gemini-4-argon:weekly",
				label: "Gemini 4 Argon",
				scope: { provider: "antigravity-acp", tier: "Gemini 4 Argon", windowId: "weekly", accountId: "acc-1" },
				window: { id: "weekly", label: "Weekly", durationMs: 7 * 86_400_000, resetsAt: Date.parse("2026-01-13T12:00:00.000Z") },
				amount: { unit: "percent", usedFraction: 0.6, remainingFraction: 0.4, used: 60, remaining: 40, limit: 100 },
				status: "ok",
			},
		]);

		quotaSpy.mockResolvedValueOnce({ at: now, groups: [{ displayName: "Other", buckets: [] }] });
		expect(await usageProvider.fetchUsage({ provider: "antigravity-acp", credential: { type: "oauth" } })).toBeNull();
	});


	it("keeps the parent session usable after a child instance shuts down", async () => {
		await load("parent");
		const child = await load("child");
		const first = await stream([user("hello")], "parent");
		expect(first.stopReason).toBe("stop");

		await child.pi.emit("session_shutdown", { reason: "quit" }, child.ctx);

		const second = await stream([user("hello"), first, user("next", 2)], "parent");
		expect(second.stopReason).toBe("stop");
	});

	it("closes only the child's ACP process when the child shuts down", async () => {
		await load("parent");
		const child = await load("child");
		const first = await stream([user("hello")], "parent");
		await stream([user("hello")], "child");
		const [parentConnection, childConnection] = connections;

		await child.pi.emit("session_shutdown", { reason: "quit" }, child.ctx);

		await childConnection!.process.exited;
		expect(parentConnection!.process.alive).toBe(true);
		await stream([user("hello"), first, user("next", 2)], "parent");
		expect(connections).toHaveLength(2);
		expect(parentConnection!.process.alive).toBe(true);
	});

	it("resolves a permission parked through one instance with another instance's permission tool", async () => {
		const parent = await load("parent");
		const child = await load("child");
		const parked = await stream([user("request permission")], "parent", parent.pi.providers[0]);
		const call = parked.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing permission tool call");

		const ctx = createFakeContext({ sessionId: "child", selectAnswer: (labels) => labels[0] });
		const tool = child.pi.tools.get(PERMISSION_TOOL_NAME);
		if (!tool) throw new Error("missing permission tool");
		const result = await tool.execute("call", { requestId: call.id }, undefined, undefined, ctx as never);

		expect(result.details).toMatchObject({ requestId: call.id, optionId: "allow-once", cancelled: false });
	});

	it("shares one provider across loads and closes it when the last instance quits", async () => {
		const instances = [await load("a"), await load("b"), await load("c")];
		expect(new Set(instances.map(({ pi }) => pi.providers[0])).size).toBe(1);
		await stream([user("hello")], "a");
		await stream([user("hello")], "b");
		expect(connections.length).toBeGreaterThan(0);

		for (const { pi, ctx } of loaded.splice(0)) await pi.emit("session_shutdown", { reason: "quit" }, ctx);

		expect(connections.every((connection) => !connection.process.alive)).toBe(true);
	});

	it("reports process token totals without counting reasoning twice", async () => {
		const { pi, ctx } = await load("parent");
		await stream([user("usage single")], "parent");
		await pi.commands.get("pi-antigravity-acp")!.handler("quota", ctx as never);
		// Thought tokens are already part of output, so tokens= is input + output + cacheRead + cacheWrite.
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain(
			"Usage this process: turns=1 tokens=1200 input=600 output=200 reasoning=50 cacheRead=400",
		);
	});

	it("configures tool-activity via command arguments, interactive selector, and doctor output", async () => {
		const { pi, ctx } = await load("parent");
		const { loadConfig } = await import("../src/config.js");
		const command = pi.commands.get("pi-antigravity-acp")!;

		expect(loadConfig().toolActivity).toBe("compact");

		await command.handler("tool-activity off", ctx as never);
		expect(loadConfig().toolActivity).toBe("off");
		expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(["Antigravity tool activity: off", "info"]);

		const offTurn = await stream([user("emit tool activity")], "parent");
		const offThinking = offTurn.content.filter((b) => b.type === "thinking").map((b) => b.thinking).join("\n");
		expect(offThinking).not.toContain("[Antigravity tool:");

		const selectCtx = createFakeContext({
			sessionId: "parent",
			cwd: root,
			selectAnswer: (labels) => labels.find((label) => label.startsWith("full ")),
		});
		await command.handler("tool-activity", selectCtx as never);
		expect(loadConfig().toolActivity).toBe("full");

		const fullTurn = await stream([user("emit tool activity", 2)], "parent");
		const fullThinking = fullTurn.content.filter((b) => b.type === "thinking").map((b) => b.thinking).join("\n");
		expect(fullThinking).toContain("[Antigravity tool: pi_echo — in_progress]");
		expect(fullThinking).toContain("[Antigravity tool update: tc-1 — completed]");

		await command.handler("tool-activity invalid", ctx as never);
		expect(ctx.ui.notify.mock.calls.at(-1)).toEqual([
			"Usage: /pi-antigravity-acp tool-activity [off|compact|full]",
			"warning",
		]);

		await command.handler("doctor", ctx as never);
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain("Tool activity mode: full");
	});

	it("preserves existing updates and permissions subcommand behavior alongside tool-activity", async () => {
		const { pi, ctx } = await load("parent");
		const { loadConfig } = await import("../src/config.js");
		const command = pi.commands.get("pi-antigravity-acp")!;

		await command.handler("tool-activity off", ctx as never);
		await command.handler("updates notify", ctx as never);
		expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(["Antigravity runtime updates: notify", "info"]);
		await command.handler("permissions auto-edit", ctx as never);
		expect(ctx.ui.notify.mock.calls.at(-1)).toEqual(["Antigravity permission mode: auto-edit.", "info"]);
		expect(loadConfig()).toEqual({ permissions: "auto_edit", runtimeUpdates: "notify", toolActivity: "off", nativeWorkflows: false });
	});
});

describe("live quota", () => {
	it("shows the live quota above the process totals", async () => {
		const snapshot = parseUsageQuota(usageReply, now);
		const { pi, ctx } = await load("a");
		const quota = (await spyQuota()).mockResolvedValue(snapshot);

		await pi.commands.get("pi-antigravity-acp")!.handler("quota", ctx as never);
		expect(quota).toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Gemini Models: weekly 75% (resets 2026-01-12T18:00:00.000Z), 5h 90% (resets 2026-01-08T04:30:00.000Z)"),
			"info",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage this process: turns=0"), "info");
		expect(ctx.ui.notify.mock.calls[0]![0]).not.toContain("not supplied");
	});

	it("labels groups without percentages as no percentage limits reported", async () => {
		const snapshot = {
			at: now,
			groups: [{ displayName: "Other", buckets: [] }],
		};
		const { pi, ctx } = await load("a");
		(await spyQuota()).mockResolvedValue(snapshot);

		await pi.commands.get("pi-antigravity-acp")!.handler("quota", ctx as never);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Other: no percentage limits reported"),
			"info",
		);
	});

	it("shows why the live quota is unavailable", async () => {
		const { pi, ctx } = await load("a");
		(await spyQuota()).mockRejectedValue(
			new AntigravityAcpError("protocol", "Antigravity /usage reply had no quota groups: Unable to retrieve quota status (backend unavailable)"),
		);

		await pi.commands.get("pi-antigravity-acp")!.handler("quota", ctx as never);

		const text = ctx.ui.notify.mock.calls.at(-1)![0] as string;
		expect(text).toContain("Antigravity quota: unavailable (");
		expect(text).toContain("Unable to retrieve quota status");
	});

	it("replies once with the live quota snapshot", async () => {
		const snapshot = parseUsageQuota(usageReply, now);
		const { pi } = await load("a");
		(await spyQuota()).mockResolvedValue(snapshot);

		const reply = vi.fn();
		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply });

		await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		expect(reply).toHaveBeenCalledWith({ ok: true, quota: snapshot });
	});

	it("replies once with an error when the quota cannot be read", async () => {
		const { pi } = await load("a");
		(await spyQuota()).mockRejectedValue(
			new AntigravityAcpError("protocol", "Antigravity /usage reply had no quota groups: Unable to retrieve quota status (backend unavailable)"),
		);

		let callCount = 0;
		const reply = vi.fn(() => {
			callCount++;
			if (callCount === 1) throw new Error("listener error");
		});

		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply });

		await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith({
			ok: false,
			error: expect.stringContaining("Unable to retrieve quota status"),
		});
	});

	it("replies once when several instances share one event bus", async () => {
		const snapshot = parseUsageQuota(usageReply, now);
		const parent = await load("a");
		// Both instances share the runtime built by the first module graph.
		(await spyQuota()).mockResolvedValue(snapshot);
		const child = await load("b", parent.pi.api.events);

		const reply = vi.fn();
		parent.pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply });

		await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(reply).toHaveBeenCalledTimes(1);
		expect(reply).toHaveBeenCalledWith({ ok: true, quota: snapshot });

		// The surviving instance still answers once the other one stops listening.
		await child.pi.emit("session_shutdown", { reason: "reload" }, child.ctx);
		const next = vi.fn();
		parent.pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply: next });
		await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));
	});

	it("ignores requests without a reply function", async () => {
		const { pi } = await load("a");
		const quota = (await spyQuota()).mockResolvedValue({ at: 0, groups: [] });

		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, {});
		pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { reply: "not-a-function" });

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(quota).not.toHaveBeenCalled();
	});

	it("stops listening on session shutdown", async () => {
		const { pi, ctx } = await load("a");
		expect(pi.listeners.get(QUOTA_REQUEST_CHANNEL)).toHaveLength(1);

		await pi.emit("session_shutdown", { reason: "reload" }, ctx);

		expect(pi.listeners.get(QUOTA_REQUEST_CHANNEL)).toHaveLength(0);
	});
});
