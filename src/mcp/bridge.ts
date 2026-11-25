import type { Tool } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "typebox/value";

import { PERMISSION_TOOL_NAME } from "../constants.js";
import { projectToolSchema } from "./schema.js";

/**
 * agy holds every MCP tool it loads in one customization budget of roughly
 * 20,000 tokens, counted as ceil(UTF-8 bytes / 3), and drops whole tools past
 * it. Fitting trims only description prose, so every tool keeps its name,
 * schema keys, types, enums, required list and bounds.
 */
export const TOOL_TOKEN_BUDGET = 18_000;
const MIN_DESCRIPTION_BYTES = 24;
/** agy 1.3.5+: a tools/list entry carrying this marker is never deferred out of
 * the model's function list. */
const ALWAYS_LOAD = "antigravity/alwaysLoad";

interface BridgeTool {
	mcpName: string;
	piName: string;
	description: string;
	inputSchema: Record<string, unknown>;
	originalSchema: Tool["parameters"];
}

/** One tools/list entry as serialized toward agy. */
export interface BridgeToolListing {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	_meta: Record<string, unknown>;
}

export interface PiToolInvocation {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface PiMcpBridgeOptions {
	tools: readonly Tool[];
	onCall: (invocation: PiToolInvocation) => Promise<CallToolResult>;
}

export interface ToolOmission {
	name: string;
	reason: string;
}

export function piToolFingerprint(tools: readonly Tool[]): string {
	const omissions: ToolOmission[] = [];
	const projected = projectTools(tools, omissions);
	return projectionFingerprint(projected, omissions);
}

function projectionFingerprint(tools: BridgeTool[], omissions: ToolOmission[]): string {
	return JSON.stringify([tools.map((tool) => [tool.mcpName, tool.description, tool.inputSchema]), omissions]);
}

export function planToolProjection(tools: readonly Tool[]): ToolOmission[] {
	const omissions: ToolOmission[] = [];
	projectTools(tools, omissions);
	return omissions;
}

export const projectedMcpName = (name: string): string =>
	`pi_${name}`.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);

/**
 * The OMP tool catalog as agy must list it: every tool marked always-load and
 * the whole set fitted inside agy's per-session tool budget.
 */
export class PiMcpBridge {
	readonly fingerprint: string;
	readonly omissions: ToolOmission[] = [];
	private readonly tools: BridgeTool[];
	private listingCache: BridgeToolListing[] | undefined;

	constructor(private readonly options: PiMcpBridgeOptions) {
		this.tools = projectTools(options.tools, this.omissions);
		this.fingerprint = projectionFingerprint(this.tools, this.omissions);
	}

	get empty(): boolean {
		return this.tools.length === 0;
	}

	get projectedToolNames(): readonly string[] {
		return this.tools.map((tool) => tool.piName);
	}

	listing(): BridgeToolListing[] {
		return (this.listingCache ??= fitToolsToBudget(this.tools.map((tool) => ({
			name: tool.mcpName,
			description: tool.description,
			inputSchema: tool.inputSchema,
			_meta: { [ALWAYS_LOAD]: true },
		}))));
	}

	/** Whether `mcpName` is a tool this bridge currently projects. */
	has(mcpName: string): boolean {
		return this.tools.some((tool) => tool.mcpName === mcpName);
	}

	async call(mcpName: string, args: Record<string, unknown>): Promise<CallToolResult> {
		const tool = this.tools.find((candidate) => candidate.mcpName === mcpName);
		if (!tool) return toolError("Unknown or inactive Pi tool");
		try {
			if (!Value.Check(tool.originalSchema, args)) {
				return toolError("Arguments failed the original Pi tool schema");
			}
		} catch {
			return toolError("The original Pi tool schema could not validate these arguments");
		}
		return this.options.onCall({ id: crypto.randomUUID(), name: tool.piName, arguments: args });
	}
}

function toolError(text: string): CallToolResult {
	return { content: [{ type: "text", text }], isError: true };
}

const agyTokens = (value: unknown): number => Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 3);

const listingTokens = (tools: readonly BridgeToolListing[]): number =>
	tools.reduce((total, tool) => total + agyTokens(tool), 0);

/** Descriptions shorter than this say nothing ("The fil…") and only spend the
 * budget on the key, so such a cut drops the text entirely. */
function cutDescription(text: string, maxBytes: number): string | undefined {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const characters = [...text];
	let bytes = 0;
	let end = 0;
	for (const character of characters) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > Math.max(0, maxBytes - 3)) break;
		bytes += size;
		end++;
	}
	const cut = characters.slice(0, end).join("").replace(/[\s,;:.-]+$/u, "");
	return Buffer.byteLength(cut, "utf8") >= MIN_DESCRIPTION_BYTES ? `${cut}…` : undefined;
}

function capDescriptions(value: unknown, maxBytes: number): unknown {
	if (Array.isArray(value)) return value.map((item) => capDescriptions(item, maxBytes));
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (key === "description" && typeof child === "string") {
			const cut = cutDescription(child, maxBytes);
			if (cut === undefined) continue;
			output[key] = cut;
			continue;
		}
		output[key] = capDescriptions(child, maxBytes);
	}
	return output;
}

/** Pure: shrink only description prose until the listing fits the budget. A set
 * too large even with no descriptions at all goes with its schemas intact and
 * is left to agy's own trimming. */
function fitToolsToBudget(tools: BridgeToolListing[], budget = TOOL_TOKEN_BUDGET): BridgeToolListing[] {
	if (listingTokens(tools) <= budget) return tools;
	let low = 0;
	let high = budget;
	let best = capDescriptions(tools, 0) as BridgeToolListing[];
	if (listingTokens(best) > budget) return best;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const candidate = capDescriptions(tools, mid) as BridgeToolListing[];
		if (listingTokens(candidate) <= budget) {
			best = candidate;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return best;
}

function projectTools(tools: readonly Tool[], omissions: ToolOmission[]): BridgeTool[] {
	const output: BridgeTool[] = [];
	const names = new Set<string>();
	for (const tool of tools) {
		if (tool.name === PERMISSION_TOOL_NAME) continue;
		const mcpName = projectedMcpName(tool.name);
		if (!mcpName || names.has(mcpName)) {
			omissions.push({ name: tool.name, reason: "duplicate or invalid projected name" });
			continue;
		}
		const projected = projectToolSchema(tool.parameters);
		if ("reason" in projected) {
			omissions.push({ name: tool.name, reason: `schema omitted (${projected.reason})` });
			continue;
		}
		names.add(mcpName);
		output.push({
			mcpName,
			piName: tool.name,
			description: tool.description,
			inputSchema: projected.schema,
			originalSchema: tool.parameters,
		});
	}
	return output;
}
