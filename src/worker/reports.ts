import { PROTOCOLS, PROTOCOL_MESSAGE } from "../shared/protocols.ts";
import type { ReportSaveRequest, ReportSummary } from "../shared/reports.ts";
import type { OverallStatus } from "../shared/types.ts";
import { parseSite } from "./target-url.ts";

export type ParseReportResult = { ok: true; value: ReportSaveRequest } | { ok: false; message: string };

const OVERALL_STATUSES: readonly OverallStatus[] = ["all_passed", "partial", "failed", "unavailable", "incomplete"];
const MAX_HOST_LENGTH = 253;
const MAX_MODEL_LENGTH = 100;
const MAX_NOTE_LENGTH = 200;
const MAX_CALLS = 10_000;
const MAX_LATENCY_MS = 3_600_000;

const SUMMARY_KEYS = new Set(["totalCalls", "passedCalls", "failedCalls", "p50Ms", "ttftP50Ms", "note"]);
const KEY_PATTERN = /(?:\bsk-[A-Za-z0-9_-]{6,}|\bBearer\s+[A-Za-z0-9._-]{6,}|\bAIza[0-9A-Za-z_-]{10,})/i;

function bad(message: string): ParseReportResult {
	return { ok: false, message };
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

function isIntIn(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseOptionalMs(value: unknown, field: string): { ok: true; value?: number } | { ok: false; message: string } {
	if (value === undefined || value === null) return { ok: true };
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_LATENCY_MS) {
		return { ok: false, message: `${field} 必须是 0 到 ${MAX_LATENCY_MS} 之间的数字` };
	}
	return { ok: true, value: Math.round(value) };
}

export function hasKeyLikePattern(value: string): boolean {
	return KEY_PATTERN.test(value);
}

export function parseReportSave(body: unknown): ParseReportResult {
	const f = asRecord(body);
	if (!f) return bad("请求体必须是 JSON 对象");

	if (typeof f.host !== "string" || f.host.length === 0 || f.host.length > MAX_HOST_LENGTH || /[\s/:?#@\\]/.test(f.host)) {
		return bad("host 不合法：只接受域名或公网 IPv4");
	}
	const site = parseSite(`https://${f.host}`);
	if (!site.ok) return bad("host 不合法：只接受域名或公网 IPv4");

	if (typeof f.model !== "string") return bad("model 必须是 1 到 100 个字符");
	const model = f.model.trim();
	if (model.length === 0 || model.length > MAX_MODEL_LENGTH) return bad("model 必须是 1 到 100 个字符");
	if (hasKeyLikePattern(model)) return bad("model 不能包含密钥");

	const protocol = PROTOCOLS.find((p) => p === f.protocol);
	if (!protocol) return bad(PROTOCOL_MESSAGE);

	const overall = OVERALL_STATUSES.find((s) => s === f.overall);
	if (!overall) return bad("overall 状态不合法");

	const s = asRecord(f.summary);
	if (!s) return bad("summary 必须是对象");
	for (const key of Object.keys(s)) {
		if (!SUMMARY_KEYS.has(key)) return bad(`summary 包含不支持的字段：${key}`);
	}

	if (!isIntIn(s.totalCalls, 0, MAX_CALLS)) return bad("summary.totalCalls 必须是合法整数");
	if (!isIntIn(s.passedCalls, 0, s.totalCalls)) return bad("summary.passedCalls 必须是合法整数");
	if (!isIntIn(s.failedCalls, 0, s.totalCalls) || s.passedCalls + s.failedCalls > s.totalCalls) {
		return bad("summary.failedCalls 必须是合法整数");
	}

	const p50 = parseOptionalMs(s.p50Ms, "summary.p50Ms");
	if (!p50.ok) return bad(p50.message);
	const ttftP50 = parseOptionalMs(s.ttftP50Ms, "summary.ttftP50Ms");
	if (!ttftP50.ok) return bad(ttftP50.message);

	let note: string | undefined;
	if (s.note !== undefined && s.note !== null) {
		if (typeof s.note !== "string") return bad("summary.note 必须是字符串");
		const trimmed = s.note.trim();
		if (trimmed.length > MAX_NOTE_LENGTH) return bad(`summary.note 最多 ${MAX_NOTE_LENGTH} 个字符`);
		if (hasKeyLikePattern(trimmed)) return bad("summary.note 不能包含密钥");
		if (trimmed.length > 0) note = trimmed;
	}

	const summary: ReportSummary = {
		totalCalls: s.totalCalls,
		passedCalls: s.passedCalls,
		failedCalls: s.failedCalls,
		...(p50.value !== undefined && { p50Ms: p50.value }),
		...(ttftP50.value !== undefined && { ttftP50Ms: ttftP50.value }),
		...(note !== undefined && { note }),
	};

	return {
		ok: true,
		value: {
			host: site.host,
			model,
			protocol,
			overall,
			summary,
		},
	};
}
