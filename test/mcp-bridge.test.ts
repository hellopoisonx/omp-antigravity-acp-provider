import type { Tool } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import net from "node:net";
import path from "node:path";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { PiMcpBridge } from "../src/mcp/bridge.js";
import { McpControlServer } from "../src/mcp/control.js";
import { ensureNcShim } from "../src/mcp/shim.js";

const tools: Tool[] = [
	{
		name: "echo",
		description: "Echo text",
		parameters: Type.Object({ text: Type.String() }),
	},
];

/** One control line over loopback, answered by the given payload. */
function controlLine(port: number, payload: unknown): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			resolve(buffer.slice(0, newline));
			socket.destroy();
		});
		socket.on("error", reject);
	});
}

describe("PiMcpBridge", () => {
	it("lists namespaced tools as always-load and revalidates arguments", async () => {
		const onCall = vi.fn(async ({ arguments: args }) => ({
			content: [{ type: "text" as const, text: String(args.text) }],
		}));
		const bridge = new PiMcpBridge({ tools, onCall });
		const listing = bridge.listing();
		expect(listing.map((tool) => tool.name)).toEqual(["pi_echo"]);
		expect(listing[0]?._meta).toEqual({ "antigravity/alwaysLoad": true });

		const invalid = await bridge.call("pi_echo", { text: 7 });
		expect(invalid.isError).toBe(true);
		expect(onCall).not.toHaveBeenCalled();
		const valid = await bridge.call("pi_echo", { text: "hello" });
		expect(valid.content).toEqual([{ type: "text", text: "hello" }]);
		expect(onCall).toHaveBeenCalledOnce();
		expect((await bridge.call("pi_missing", {})).isError).toBe(true);
	});

	it("fits a large catalog inside agy's tool budget without dropping tools", () => {
		const manyTools: Tool[] = Array.from({ length: 96 }, (_, index) => ({
			name: `tool_${index}`,
			description: "A long description that exists only to spend agy's tool budget. ".repeat(20),
			parameters: Type.Object({ value: Type.String() }),
		}));
		const bridge = new PiMcpBridge({ tools: manyTools, onCall: async () => ({ content: [] }) });
		expect(bridge.omissions).toEqual([]);
		const listing = bridge.listing();
		expect(listing).toHaveLength(96);
		expect(listing.at(-1)?.name).toBe("pi_tool_95");
		// Descriptions shrink; every schema constraint survives.
		expect(JSON.stringify(listing).length).toBeLessThan(18_000 * 3);
		expect(listing[0]?.inputSchema).toEqual({
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		});
	});

	it("serves the catalog over the nc shim and refuses a wrong control token", async () => {
		const onCall = vi.fn(async ({ arguments: args }) => ({
			content: [{ type: "text" as const, text: String(args.text) }],
		}));
		const bridge = new PiMcpBridge({ tools, onCall });
		const control = new McpControlServer("test-token", bridge);
		const handshake = await control.start();
		const shim = path.join(ensureNcShim(), "nc");
		const client = new Client({ name: "bridge-test", version: "1" }, { capabilities: {} });
		const transport = new StdioClientTransport({
			command: shim,
			args: ["127.0.0.1", String(handshake.port)],
			env: { ...process.env, ...handshake.env } as Record<string, string>,
		});
		try {
			await client.connect(transport);
			expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["pi_echo"]);
			const valid = await client.callTool({ name: "pi_echo", arguments: { text: "hello" } });
			expect(valid.content).toEqual([{ type: "text", text: "hello" }]);
			expect(await control.waitForListing(0)).toBe(true);

			const refused = await controlLine(handshake.port, { token: "wrong", kind: "list" });
			expect(refused).toContain("invalid or expired control token");
		} finally {
			await client.close();
			await control.close();
		}
	});

	it("reports a session whose catalog was never listed so the prompt can fail closed", async () => {
		const bridge = new PiMcpBridge({ tools, onCall: async () => ({ content: [] }) });
		const control = new McpControlServer("test-token", bridge);
		const handshake = await control.start();
		try {
			expect(await control.waitForListing(50)).toBe(false);
			await controlLine(handshake.port, { token: "test-token", kind: "list" });
			expect(await control.waitForListing(50)).toBe(true);
		} finally {
			await control.close();
		}
	});
});
