// MCP server agy talks to through the private `nc` shim that `--ide-mcp-port`
// makes it run. agy starts `nc <host> <port>` and speaks MCP over that stdio;
// this script ignores the dial arguments and relays tools/list and tools/call
// to the provider's loopback control channel, authenticated by a per-process
// token from the environment.
import net from "node:net";

const PROTOCOL_VERSION = "2025-11-25";
const SERVER_INFO = { name: "pi-antigravity-acp-tools", version: "1.0.0" };
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const CONTROL_PORT = Number(process.env.PI_ANTIGRAVITY_CONTROL_PORT);
const CONTROL_TOKEN = process.env.PI_ANTIGRAVITY_CONTROL_TOKEN ?? "";
const CONFIGURED = Number.isInteger(CONTROL_PORT) && CONTROL_PORT >= 1 && CONTROL_PORT <= 65535 && CONTROL_TOKEN.length > 0;

const pendingCalls = new Map();
let watchSocket;
let closed = false;

function send(message) {
	if (closed) return;
	try {
		process.stdout.write(`${JSON.stringify(message)}\n`);
	} catch {
		process.exit(0);
	}
}

function sendResult(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

function closeAll() {
	if (closed) return;
	closed = true;
	for (const call of pendingCalls.values()) call.destroy();
	pendingCalls.clear();
	watchSocket?.destroy();
}

// One request per connection: the control server answers with a single line.
function controlRequest(payload) {
	const socket = net.createConnection({ host: "127.0.0.1", port: CONTROL_PORT });
	const outcome = Promise.withResolvers();
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("connect", () => {
		try {
			socket.write(`${JSON.stringify({ token: CONTROL_TOKEN, ...payload })}\n`);
		} catch {
			outcome.resolve({ error: "control channel failure" });
		}
	});
	socket.on("data", (chunk) => {
		buffer += chunk;
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		try {
			outcome.resolve(JSON.parse(buffer.slice(0, newline)));
		} catch {
			outcome.resolve({ error: "invalid control response" });
		}
		socket.destroy();
	});
	socket.on("error", () => outcome.resolve({ error: "control channel failure" }));
	socket.on("close", () => outcome.resolve({ error: "control channel closed" }));
	return { socket, promise: outcome.promise };
}

function startWatch() {
	if (!CONFIGURED || watchSocket || closed) return;
	const socket = net.createConnection({ host: "127.0.0.1", port: CONTROL_PORT });
	watchSocket = socket;
	socket.setEncoding("utf8");
	let buffer = "";
	socket.on("connect", () => {
		try {
			socket.write(`${JSON.stringify({ token: CONTROL_TOKEN, kind: "watch" })}\n`);
		} catch {
			// a dead watch only costs catalog-change notifications
		}
	});
	socket.on("data", (chunk) => {
		buffer += chunk;
		if (buffer.length > MAX_MESSAGE_BYTES) {
			socket.destroy();
			return;
		}
		let newline;
		while ((newline = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				continue;
			}
			if (event && event.event === "tools_changed") {
				send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			}
		}
	});
	socket.on("error", () => undefined);
	socket.on("close", () => {
		if (watchSocket === socket) watchSocket = undefined;
	});
}

async function handleMessage(message) {
	const hasId = Object.hasOwn(message, "id");
	if (!CONFIGURED) {
		if (hasId) sendError(message.id, -32603, "Antigravity tool channel is not configured");
		return;
	}
	switch (message.method) {
		case "server/discover":
			// Answer as a pre-2026 server so agy keeps using tools/list plus
			// notifications/tools/list_changed instead of subscriptions/listen.
			if (hasId) sendError(message.id, -32601, "Method not found");
			return;
		case "initialize": {
			if (!hasId) return;
			const requested = message.params && typeof message.params.protocolVersion === "string"
				? message.params.protocolVersion
				: PROTOCOL_VERSION;
			sendResult(message.id, {
				protocolVersion: requested,
				capabilities: { tools: { listChanged: true } },
				serverInfo: SERVER_INFO,
			});
			return;
		}
		case "notifications/initialized":
			startWatch();
			return;
		case "notifications/cancelled": {
			const requestId = message.params?.requestId;
			const call = requestId === undefined ? undefined : pendingCalls.get(requestId);
			if (call) {
				pendingCalls.delete(requestId);
				call.destroy();
			}
			return;
		}
		case "ping":
			if (hasId) sendResult(message.id, {});
			return;
		case "tools/list": {
			if (!hasId) return;
			const outcome = await controlRequest({ kind: "list" }).promise;
			if (outcome.error) sendError(message.id, -32603, String(outcome.error));
			else sendResult(message.id, outcome.result ?? { tools: [] });
			return;
		}
		case "tools/call": {
			const params = message.params;
			if (!hasId) return;
			if (!params || typeof params.name !== "string" || !params.name) {
				sendError(message.id, -32602, "Invalid params");
				return;
			}
			const request = controlRequest({
				kind: "call",
				name: params.name,
				arguments: params.arguments && typeof params.arguments === "object" ? params.arguments : {},
			});
			pendingCalls.set(message.id, request.socket);
			try {
				const outcome = await request.promise;
				if (outcome.error) sendError(message.id, -32603, String(outcome.error));
				else sendResult(message.id, outcome.result);
			} finally {
				if (pendingCalls.get(message.id) === request.socket) pendingCalls.delete(message.id);
			}
			return;
		}
		default:
			if (hasId) sendError(message.id, -32601, "Method not found");
	}
}

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	inputBuffer += chunk;
	if (inputBuffer.length > MAX_MESSAGE_BYTES) {
		closeAll();
		process.exit(1);
	}
	let newline;
	while ((newline = inputBuffer.indexOf("\n")) >= 0) {
		const line = inputBuffer.slice(0, newline).trim();
		inputBuffer = inputBuffer.slice(newline + 1);
		if (!line) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			sendError(null, -32700, "Parse error");
			continue;
		}
		handleMessage(message).catch((error) => {
			if (Object.hasOwn(message, "id")) sendError(message.id, -32603, String(error?.message ?? error));
		});
	}
});
process.stdin.on("end", closeAll);
process.stdin.on("close", closeAll);
process.stdin.on("error", closeAll);
process.stdout.on("error", () => process.exit(0));
