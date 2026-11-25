import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

import { AntigravityAcpError } from "../acp/errors.js";
import type { BridgeToolListing, PiMcpBridge } from "./bridge.js";

const LINE_LIMIT = 16 * 1024 * 1024;
const CONTROL_PORT_ENV = "PI_ANTIGRAVITY_CONTROL_PORT";
const CONTROL_TOKEN_ENV = "PI_ANTIGRAVITY_CONTROL_TOKEN";

export interface ControlHandshake {
	port: number;
	token: string;
	env: Record<string, string>;
}

/**
 * Loopback control channel between the provider and the private `nc` shim that
 * agy runs for `--ide-mcp-port`. agy dials the shim, the shim asks here for the
 * current tool catalog and relays calls, so the model sees the OMP tools while
 * the Agy agent definition keeps `tools: []`.
 */
export class McpControlServer {
	private server: Server | undefined;
	private controlPort: number | undefined;
	private listedAt: number | undefined;
	private readonly listingWaiters = new Set<() => void>();
	private readonly watchers = new Set<Socket>();

	constructor(readonly token: string, private readonly bridge: PiMcpBridge) {}

	async start(): Promise<ControlHandshake> {
		if (this.controlPort !== undefined) return this.handshake(this.controlPort);
		const server = createServer((socket) => this.handle(socket));
		server.maxConnections = 32;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			throw new AntigravityAcpError("spawn", "Antigravity tool control channel failed to bind");
		}
		this.server = server;
		this.controlPort = address.port;
		return this.handshake(address.port);
	}

	/** True once agy has asked for the catalog, so a prompt cannot run with the
	 * model seeing fewer tools than OMP declared. */
	async waitForListing(timeoutMs: number): Promise<boolean> {
		if (this.listedAt !== undefined) return true;
		if (timeoutMs <= 0) return false;
		return new Promise<boolean>((resolve) => {
			const settle = (listed: boolean) => {
				clearTimeout(timer);
				this.listingWaiters.delete(onListed);
				resolve(listed);
			};
			const onListed = () => settle(true);
			const timer = setTimeout(() => settle(false), timeoutMs);
			timer.unref?.();
			this.listingWaiters.add(onListed);
		});
	}

	/** Announce a changed catalog; agy re-lists on tools/list_changed. */
	toolsChanged(): void {
		for (const socket of this.watchers) {
			try {
				socket.write(`${JSON.stringify({ event: "tools_changed" })}\n`);
			} catch {
				this.watchers.delete(socket);
			}
		}
	}

	async close(): Promise<void> {
		for (const socket of this.watchers) socket.destroy();
		this.watchers.clear();
		for (const waiter of [...this.listingWaiters]) waiter();
		const server = this.server;
		this.server = undefined;
		this.controlPort = undefined;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	private handshake(port: number): ControlHandshake {
		return {
			port,
			token: this.token,
			env: { [CONTROL_PORT_ENV]: String(port), [CONTROL_TOKEN_ENV]: this.token },
		};
	}

	private handle(socket: Socket): void {
		socket.setEncoding("utf8");
		let buffer = "";
		let handled = false;
		socket.on("error", () => undefined);
		socket.on("data", (chunk: string) => {
			if (handled) return;
			buffer += chunk;
			if (buffer.length > LINE_LIMIT) {
				socket.destroy();
				return;
			}
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			handled = true;
			void this.dispatch(socket, buffer.slice(0, newline));
		});
	}

	private async dispatch(socket: Socket, line: string): Promise<void> {
		let message: {
			token?: unknown;
			kind?: unknown;
			name?: unknown;
			arguments?: unknown;
		};
		try {
			message = JSON.parse(line) as typeof message;
		} catch {
			socket.end(`${JSON.stringify({ error: "invalid control JSON" })}\n`);
			return;
		}
		if (!this.tokenMatches(message.token)) {
			socket.end(`${JSON.stringify({ error: "invalid or expired control token" })}\n`);
			return;
		}
		if (message.kind === "list") {
			this.listedAt ??= Date.now();
			for (const waiter of [...this.listingWaiters]) waiter();
			const tools: BridgeToolListing[] = this.bridge.listing();
			socket.end(`${JSON.stringify({ result: { tools } })}\n`);
			return;
		}
		if (message.kind === "watch") {
			this.watchers.add(socket);
			socket.once("close", () => this.watchers.delete(socket));
			return;
		}
		if (message.kind === "call") {
			const name = typeof message.name === "string" ? message.name : "";
			const args = message.arguments && typeof message.arguments === "object" && !Array.isArray(message.arguments)
				? message.arguments as Record<string, unknown>
				: {};
			if (!name || !this.bridge.has(name)) {
				socket.end(`${JSON.stringify({ error: `unknown tool ${name}` })}\n`);
				return;
			}
			try {
				const result = await this.bridge.call(name, args);
				socket.end(`${JSON.stringify({ result })}\n`);
			} catch (error) {
				socket.end(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n`);
			}
			return;
		}
		socket.end(`${JSON.stringify({ error: "unknown control request" })}\n`);
	}

	private tokenMatches(candidate: unknown): boolean {
		if (typeof candidate !== "string") return false;
		const expected = createHash("sha256").update(this.token).digest();
		const actual = createHash("sha256").update(candidate).digest();
		return timingSafeEqual(expected, actual);
	}
}

export const controlTokenEnv = CONTROL_TOKEN_ENV;
export const controlPortEnv = CONTROL_PORT_ENV;

/** Whether the permission request names a call the model can only make through
 * the bridged tools, in agy's own words (never the model-written arguments). */
export function bridgedToolName(toolCall: unknown): string | undefined {
	if (!toolCall || typeof toolCall !== "object") return undefined;
	const record = toolCall as Record<string, unknown>;
	for (const value of [record.title, record.name, record.toolName]) {
		if (typeof value !== "string") continue;
		const match = /^(?:mcp\(ide-tools\/([^()\s]+)\)|(?:mcp\s+)?"?ide-tools\/([^()\s"]+)"?|mcp_ide-tools_(\S+))$/u
			.exec(value.trim().replace(/\?$/u, ""));
		if (match) return match[1] ?? match[2] ?? match[3];
	}
	return undefined;
}

export const newControlToken = (): string => randomUUID();
