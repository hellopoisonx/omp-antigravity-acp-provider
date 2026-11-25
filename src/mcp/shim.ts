import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNodeBinary } from "../acp/process.js";

const STDIO_BRIDGE = fileURLToPath(new URL("./stdio-bridge.mjs", import.meta.url));

let shimDir: string | undefined;

/**
 * agy reaches `--ide-mcp-port` by running `nc <host> <port>` from PATH. This
 * private shim replaces that `nc` for the Agy processes we spawn: it ignores
 * the dial arguments and serves the provider's loopback control channel as
 * MCP over stdio, so the tools reach the model even though the Agy agent
 * definition declares `tools: []`.
 */
export function ensureNcShim(): string {
	if (shimDir) return shimDir;
	// Resolve Node explicitly: under a standalone host binary (`omp`),
	// `process.execPath` is the host binary rather than a Node interpreter.
	const nodeBinary = resolveNodeBinary();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-antigravity-acp-bin-"));
	const quote = (value: string) => `'${value.replace(/'/gu, `'\\''`)}'`;
	fs.writeFileSync(
		path.join(directory, "nc"),
		`#!/bin/sh\nexec ${quote(nodeBinary)} ${quote(STDIO_BRIDGE)}\n`,
		{ mode: 0o700 },
	);
	// agy 1.5 runs nc.exe on Windows, never a .cmd; the wrapper is a fallback for
	// a runtime that does pick it up.
	fs.writeFileSync(
		path.join(directory, "nc.cmd"),
		`@echo off\r\n"${nodeBinary}" "${STDIO_BRIDGE}"\r\n`,
	);
	shimDir = directory;
	process.once("exit", () => {
		fs.rmSync(directory, { recursive: true, force: true });
	});
	return directory;
}
