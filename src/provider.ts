import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	TranscriptContext,
	Model,
	Provider,
	RefreshModelsContext,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import { hasAntigravityAuth } from "./acp/antigravity.js";
import type { AntigravityQuotaSnapshot } from "./acp/usage-quota.js";
import {
	API_ID,
	FALLBACK_MODELS,
	modelForAcpStream,
	OMP_API_ID,
	projectModels,
	PROVIDER_ID,
	restoreModels,
	toOmpModelConfig,
	type OmpProviderModelConfig,
} from "./models.js";
import { AntigravityRuntime, MANAGED_AUTH_MARKER } from "./runtime.js";

export interface AntigravityProviderBundle {
	provider: Provider<"antigravity-acp">;
	runtime: AntigravityRuntime;
	toOmpProviderConfig: () => OmpProviderConfig;
}

/** Callbacks OMP passes an extension-registered provider's `oauth.login`. */
export interface OmpLoginCallbacks {
	signal?: AbortSignal;
	onAuth: (info: { url: string; instructions?: string }) => void;
	onProgress?: (message: string) => void;
	onManualCodeInput?: (signal?: AbortSignal) => Promise<string>;
	onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
}

export interface OmpUsageWindow {
	id: string;
	label: string;
	durationMs?: number;
	resetsAt?: number;
}

export interface OmpUsageLimit {
	id: string;
	label: string;
	scope: {
		provider: string;
		accountId?: string;
		projectId?: string;
		tier?: string;
		windowId?: string;
	};
	window?: OmpUsageWindow;
	amount: {
		unit: "percent";
		usedFraction: number;
		remainingFraction: number;
		used: number;
		remaining: number;
		limit: 100;
	};
	status: "ok" | "warning" | "exhausted";
}

export interface OmpUsageReport {
	provider: string;
	fetchedAt: number;
	limits: OmpUsageLimit[];
	metadata?: Record<string, unknown>;
}

export interface OmpUsageFetchParams {
	provider: string;
	credential: {
		type: "api_key" | "oauth";
		apiKey?: string;
		accessToken?: string;
		accountId?: string;
		projectId?: string;
		email?: string;
	};
	signal?: AbortSignal;
}

export interface OmpUsageProvider {
	id: string;
	fetchUsage: (params: OmpUsageFetchParams, ctx?: unknown) => Promise<OmpUsageReport | null>;
}

/** The two-argument form OMP's `pi.registerProvider(name, config)` takes. */
export interface OmpProviderConfig {
	baseUrl: string;
	api: typeof OMP_API_ID;
	apiKey?: string | undefined;
	models: OmpProviderModelConfig[];
	fetchDynamicModels: (apiKey: string | undefined) => Promise<readonly OmpProviderModelConfig[]>;
	streamSimple: (
		model: Model<typeof OMP_API_ID>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
	oauth: {
		name: string;
		login: (callbacks: OmpLoginCallbacks) => Promise<{ refresh: string; access: string; expires: number }>;
		refreshToken: <T>(credentials: T) => Promise<T>;
		getApiKey: () => string;
	};
	usage: OmpUsageProvider;
}

export function createAntigravityProvider(runtime = new AntigravityRuntime()): AntigravityProviderBundle {
	let models = [...FALLBACK_MODELS];
	const provider: Provider<"antigravity-acp"> = {
		id: PROVIDER_ID,
		name: "Google Antigravity (ACP)",
		auth: {
			oauth: {
				name: "Google Antigravity (ACP)",
				loginLabel: "Sign in with Google",
				async login(interaction) {
					interaction.notify({ type: "progress", message: "Starting Antigravity Google login…" });
					await runtime.loginGoogle(
						interaction.signal,
						(message) => interaction.notify({ type: "progress", message }),
						{
							showAuthorizationUrl(url, instructions) {
								interaction.notify({
									type: "info",
									message: instructions,
									links: [{ url, label: "Google authorization" }],
								});
							},
							promptForCallback: (signal) =>
								interaction.prompt({
									type: "manual_code",
									message: "Paste the final localhost callback URL (or authorization code):",
									placeholder: "http://127.0.0.1:PORT/?state=…&code=…",
									signal,
								}),
						},
					);
					return {
						type: "oauth",
						// Pi needs a durable credential record so the provider stays visible;
						// the actual OAuth tokens remain owned by Google Antigravity.
						refresh: MANAGED_AUTH_MARKER,
						access: MANAGED_AUTH_MARKER,
						expires: Number.MAX_SAFE_INTEGER,
					};
				},
				async refresh(credential) {
					return credential;
				},
				async toAuth() {
					return { apiKey: MANAGED_AUTH_MARKER };
				},
			},
			apiKey: {
				name: "Antigravity Gemini API key",
				async login(interaction) {
					const key = await interaction.prompt({
						type: "secret",
						message: "Gemini API key",
						placeholder: "AIza…",
					});
					if (!key.trim()) throw new Error("Gemini API key is required");
					interaction.notify({ type: "progress", message: "Verifying Gemini API key…" });
					await runtime.verifyApiKey(key.trim(), interaction.signal, (message) =>
						interaction.notify({ type: "progress", message }),
					);
					return { type: "api_key", key: key.trim() };
				},
				async check({ ctx, credential }) {
					if (credential?.key) return { type: "api_key", source: "Pi auth store" };
					if (await ctx.env("GEMINI_API_KEY")) return { type: "api_key", source: "GEMINI_API_KEY" };
					if (hasAntigravityAuth()) {
						return { type: "api_key", source: "Antigravity OAuth refresh token" };
					}
					return undefined;
				},
				async resolve({ ctx, credential }) {
					const key = credential?.key ?? (await ctx.env("GEMINI_API_KEY"));
					if (key) {
						return {
							auth: { apiKey: key },
							source: credential?.key ? "Pi auth store" : "GEMINI_API_KEY",
						};
					}
					if (hasAntigravityAuth()) {
						return { auth: { apiKey: MANAGED_AUTH_MARKER }, source: "Antigravity OAuth refresh token" };
					}
					return undefined;
				},
			},
		},
		getModels: () => models,
		async refreshModels(context: RefreshModelsContext) {
			if (!context.allowNetwork) {
				// Restore the last discovered catalog before Pi resolves startup model
				// patterns, so models outside the offline fallback stay selectable.
				const restored = restoreModels(context.stored?.models ?? []);
				if (restored.length === 0) return;
				await context.publish({
					update: () => {
						models = restored;
					},
				});
				return;
			}
			const key =
				context.credential?.type === "api_key"
					? context.credential.key
					: context.credential?.type === "oauth"
						? MANAGED_AUTH_MARKER
						: undefined;
			let discovered;
			try {
				discovered = projectModels(await runtime.discoverModels(key, context.signal));
			} catch {
				// Startup refresh must not hide the conservative offline catalog when
				// authentication is absent, expired, or temporarily unavailable.
				return;
			}
			if (discovered.length === 0) return;
			await context.publish({
				persist: { models: discovered, checkedAt: Date.now() },
				update: () => {
					models = discovered;
				},
			});
		},
		stream(model, context, options) {
			return stream(runtime, modelForAcpStream(model, models), context, options);
		},
		streamSimple(model, context, options) {
			return stream(runtime, modelForAcpStream(model, models), context, options);
		},
	};
	const toOmpProviderConfig = (): OmpProviderConfig => ({
		// OMP requires a non-empty baseUrl for every provider that declares models; ACP
		// spawns a local process instead of calling an endpoint.
		baseUrl: "acp://antigravity",
		api: OMP_API_ID,
		// agy keeps its own login state where this provider cannot read it, so the marker
		// is the fallback key: requests reach agy, which reports its own auth failures.
		apiKey: process.env.GEMINI_API_KEY?.trim() || MANAGED_AUTH_MARKER,
		models: models.map(toOmpModelConfig),
		async fetchDynamicModels(apiKey) {
			const key = apiKey || process.env.GEMINI_API_KEY?.trim() || MANAGED_AUTH_MARKER;
			try {
				const discovered = projectModels(await runtime.discoverModels(key));
				if (discovered.length > 0) models = discovered;
			} catch {
				// Keep the offline catalog when the runtime is unreachable or unauthenticated.
			}
			return models.map(toOmpModelConfig);
		},
		streamSimple(model, context, options) {
			return stream(runtime, modelForAcpStream({ ...model, api: API_ID }, models), context, options);
		},
		oauth: {
			name: "Google Antigravity (ACP)",
			async login(callbacks) {
				callbacks.onProgress?.("Starting Antigravity Google login…");
				await runtime.loginGoogle(callbacks.signal, callbacks.onProgress, {
					showAuthorizationUrl: (url, instructions) => callbacks.onAuth({ url, instructions }),
					promptForCallback: (signal) => callbacks.onManualCodeInput
						? callbacks.onManualCodeInput(signal)
						: callbacks.onPrompt({
							message: "Paste the final localhost callback URL (or authorization code):",
							placeholder: "http://127.0.0.1:PORT/?state=…&code=…",
						}),
				});
				// OMP needs a durable credential record; the real OAuth tokens stay with Google Antigravity.
				return { refresh: MANAGED_AUTH_MARKER, access: MANAGED_AUTH_MARKER, expires: Number.MAX_SAFE_INTEGER };
			},
			refreshToken: async (credentials) => credentials,
			getApiKey: () => MANAGED_AUTH_MARKER,
		},
		usage: {
			id: PROVIDER_ID,
			async fetchUsage(params) {
				const key = params.credential.type === "api_key"
					? params.credential.apiKey
					: params.credential.accessToken;
				const snapshot = await runtime.quota(key || MANAGED_AUTH_MARKER, params.signal);
				return toOmpUsageReport(snapshot, params);
			},
		},
	});
	return { provider, runtime, toOmpProviderConfig };
}

function stream(
	runtime: AntigravityRuntime,
	model: Model<"antigravity-acp">,
	context: TranscriptContext,
	options: ApiStreamOptions<"antigravity-acp"> | SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
	return runtime.stream(model, context, options as SimpleStreamOptions | undefined).stream;
}

export const ANTIGRAVITY_ACP_API = "antigravity-acp" satisfies Api;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function toOmpUsageWindow(windowName: string, resetTime: string | undefined): OmpUsageWindow {
	const lower = windowName.toLowerCase();
	let descriptor: OmpUsageWindow;
	if (lower === "5h") descriptor = { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS };
	else if (lower === "weekly") descriptor = { id: "weekly", label: "Weekly", durationMs: 7 * DAY_MS };
	else if (lower.includes("daily") || lower.includes("24h")) {
		descriptor = { id: "daily", label: "Daily", durationMs: DAY_MS };
	} else {
		descriptor = { id: slugify(windowName), label: windowName };
	}
	const resetsAt = resetTime ? Date.parse(resetTime) : Number.NaN;
	if (Number.isFinite(resetsAt) && resetsAt > 0) descriptor.resetsAt = resetsAt;
	return descriptor;
}

function toOmpUsageReport(snapshot: AntigravityQuotaSnapshot, params: OmpUsageFetchParams): OmpUsageReport | null {
	const limits: OmpUsageLimit[] = [];
	const seenIds = new Set<string>();
	for (const group of snapshot.groups) {
		const groupSlug = slugify(group.displayName);
		for (const bucket of group.buckets) {
			const window = toOmpUsageWindow(bucket.window, bucket.resetTime);
			const remainingFraction = roundNumber(Math.min(1, Math.max(0, bucket.remainingFraction)), 6);
			const usedFraction = roundNumber(1 - remainingFraction, 6);
			const baseId = `${params.provider}:${groupSlug}:${window.id}`;
			const id = seenIds.has(baseId) ? `${baseId}:${limits.length}` : baseId;
			seenIds.add(id);
			limits.push({
				id,
				label: group.displayName,
				scope: {
					provider: params.provider,
					tier: group.displayName,
					windowId: window.id,
					...(params.credential.accountId ? { accountId: params.credential.accountId } : {}),
					...(params.credential.projectId ? { projectId: params.credential.projectId } : {}),
				},
				window,
				amount: {
					unit: "percent",
					usedFraction,
					remainingFraction,
					used: roundNumber(usedFraction * 100, 4),
					remaining: roundNumber(remainingFraction * 100, 4),
					limit: 100,
				},
				status: remainingFraction <= 0 ? "exhausted" : remainingFraction <= 0.1 ? "warning" : "ok",
			});
		}
	}
	if (limits.length === 0) return null;
	const metadata: Record<string, unknown> = {};
	if (params.credential.email) metadata.email = params.credential.email;
	if (params.credential.accountId) metadata.accountId = params.credential.accountId;
	if (params.credential.projectId) metadata.projectId = params.credential.projectId;
	return {
		provider: params.provider,
		fetchedAt: snapshot.at,
		limits,
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
	};
}

function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "default";
}

function roundNumber(value: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(value * factor) / factor;
}
