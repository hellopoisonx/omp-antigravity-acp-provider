import { AntigravityAcpError } from "./errors.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface AntigravityQuotaSnapshot {
	at: number;
	groups: { displayName: string; buckets: { window: string; remainingFraction: number; resetTime?: string }[] }[];
}

const GROUP = /^- \*\*(.+)\*\*$/u;
const BUCKET = /^ {2}- \*\*(.+?):\*\* (\d+)% remaining(?: \(resets (.+)\))?$/u;
const RESET = new RegExp(`^(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}), (\\d{2}):(\\d{2}) UTC$`, "u");

/** Parses the Quota Limits section of agy's `/usage` reply; buckets reported as units or Available carry no fraction and are skipped. */
export function parseUsageQuota(text: string, now = Date.now()): AntigravityQuotaSnapshot {
	const section = /^### Quota Limits$([\s\S]*?)(?=^### |(?![\s\S]))/mu.exec(text)?.[1] ?? "";
	const groups: AntigravityQuotaSnapshot["groups"] = [];
	let notice: string | undefined;
	for (const line of section.split("\n")) {
		const group = GROUP.exec(line);
		if (group) {
			groups.push({ displayName: group[1]!, buckets: [] });
			continue;
		}
		const bucket = BUCKET.exec(line);
		if (bucket && groups.length) {
			const [, label, percent, reset] = bucket;
			const resetTime = reset ? resetIso(reset) : undefined;
			groups.at(-1)!.buckets.push({
				window: normalizeWindowLabel(label!),
				remainingFraction: Number(percent) / 100,
				...(resetTime ? { resetTime } : {}),
			});
			continue;
		}
		if (line.startsWith("- ")) notice ??= line.slice(2);
	}
	if (!groups.length) {
		throw new AntigravityAcpError("protocol", `Antigravity /usage reply had no quota groups: ${notice ?? "empty"}`);
	}
	return { at: now, groups };
}

/** Parses tab-separated output from `agy --app_data_dir=antigravity-acp -p /usage`. */
export function parseCliUsageQuota(text: string, now = Date.now()): AntigravityQuotaSnapshot {
	const groups = new Map<string, AntigravityQuotaSnapshot["groups"][number]>();
	for (const raw of text.split(/\r?\n/u)) {
		const columns = raw.trim().split("\t").map((value) => value.trim());
		if (columns.length < 3) continue;
		const [displayName, label, percent, reset] = columns;
		if (!displayName || !label || !/^\d+(?:\.\d+)?%$/u.test(percent ?? "")) continue;
		const value = Number(percent!.slice(0, -1));
		if (!Number.isFinite(value) || value < 0 || value > 100) {
			throw new AntigravityAcpError("protocol", `Antigravity CLI /usage returned an invalid percentage: ${percent}`);
		}
		let resetTime: string | undefined;
		if (reset) {
			const parsedReset = Date.parse(reset);
			if (!Number.isFinite(parsedReset)) {
				throw new AntigravityAcpError("protocol", `Antigravity CLI /usage returned an invalid reset time: ${reset}`);
			}
			// agy emits Unix epoch zero when a bucket is full and has no active reset timer.
			if (parsedReset > 0) resetTime = new Date(parsedReset).toISOString();
		}
		const group = groups.get(displayName) ?? { displayName, buckets: [] };
		group.buckets.push({
			window: normalizeWindowLabel(label),
			remainingFraction: value / 100,
			...(resetTime ? { resetTime } : {}),
		});
		groups.set(displayName, group);
	}
	if (!groups.size) {
		throw new AntigravityAcpError(
			"protocol",
			`Antigravity CLI /usage reply had no quota groups: ${text.trim() ? `unrecognized format (${text.trim().length} chars)` : "empty"}`,
		);
	}
	return { at: now, groups: [...groups.values()] };
}

function normalizeWindowLabel(label: string): string {
	return /weekly/iu.test(label) ? "weekly" : /five hour/iu.test(label) ? "5h" : label;
}

function resetIso(text: string): string | undefined {
	const match = RESET.exec(text);
	if (!match) return undefined;
	const [, month, day, year, hours, minutes] = match;
	return new Date(Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hours), Number(minutes))).toISOString();
}
