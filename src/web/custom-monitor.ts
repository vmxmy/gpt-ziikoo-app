import { buildMonitor, type MonitorResponse, type MonitorSample } from "../shared/monitor.ts";
import type { ProbeRequest, ProbeResponse } from "../shared/types.ts";
import type { ProbeOutcome } from "./runner.ts";

export const STORAGE_KEY = "gpt.monitors.v1";
export const MAX_SITES = 6;
export const INTERVALS = [1, 2, 5] as const;
export const UNAUTHORIZED_LIMIT = 5;
const MAX_SAMPLES = 1440;
const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_RETRY_SEC = 60;

export type IntervalMin = (typeof INTERVALS)[number];

export type SiteConfig = { id: string; site: string; model: string; intervalMin: IntervalMin; createdAt: number };

export type CardStatus =
	| { kind: "running" }
	| { kind: "rate_limited"; until: number }
	| { kind: "paused" }
	| { kind: "needs_key" }
	| { kind: "bad_key" }
	| { kind: "rejected"; message: string };

export type CustomCard = SiteConfig & {
	host: string;
	samples: MonitorSample[];
	status: CardStatus;
	nextAt: number;
	unauthorized: number;
};

export type SiteProbe = (body: ProbeRequest) => Promise<ProbeOutcome>;

export type ParsedSite = { ok: true; site: string; host: string } | { ok: false; message: string };

// Only a quick shape check; the Worker's 400 stays the authority on which targets are allowed.
export function parseSite(input: string): ParsedSite {
	const site = input.trim();
	if (!URL.canParse(site)) return { ok: false, message: "请输入完整地址，例如 https://example.com" };
	const url = new URL(site);
	if (url.protocol !== "https:") return { ok: false, message: "只支持 https 地址" };
	return { ok: true, site, host: url.host };
}

export function newCard(config: SiteConfig, host: string): CustomCard {
	return { ...config, host, samples: [], status: { kind: "running" }, nextAt: 0, unauthorized: 0 };
}

export const canAdd = (cards: CustomCard[]) => cards.length < MAX_SITES;

export const pickQuestion = (ids: readonly string[], now: number): string => ids[Math.floor(now / 60_000) % ids.length]!;

export function isDue(card: CustomCard, now: number): boolean {
	if (card.status.kind === "running") return now >= card.nextAt;
	return card.status.kind === "rate_limited" && now >= card.status.until;
}

export const needsKey = (status: CardStatus) => status.kind === "needs_key" || status.kind === "bad_key";

export function toSample(ts: number, question: string, r: ProbeResponse): MonitorSample {
	if (!r.ok) return { ts, question, ok: false, correct: null, reason: r.reason, httpStatus: r.httpStatus, totalMs: null, ttfbMs: null, ttftMs: null };
	return { ts, question, ok: true, correct: r.correct, reason: null, httpStatus: null, totalMs: r.totalMs, ttfbMs: r.ttfbMs, ttftMs: r.ttftMs };
}

export const trimSamples = (samples: MonitorSample[], now: number): MonitorSample[] =>
	samples.filter((s) => s.ts > now - DAY_MS).slice(-MAX_SAMPLES);

function nextStatus(card: CustomCard, outcome: ProbeOutcome, unauthorized: number, now: number): CardStatus {
	if (outcome.kind === "stop") {
		if (outcome.status !== 429) return { kind: "rejected", message: outcome.message };
		return { kind: "rate_limited", until: now + (outcome.retryAfterSec ?? DEFAULT_RETRY_SEC) * 1000 };
	}
	return unauthorized >= UNAUTHORIZED_LIMIT ? { kind: "bad_key" } : { kind: "running" };
}

export function applyOutcome(card: CustomCard, question: string, outcome: ProbeOutcome, now: number): CustomCard {
	const response = outcome.kind === "response" ? outcome.response : null;
	const unauthorized = response && !response.ok && response.reason === "unauthorized" ? card.unauthorized + 1 : response ? 0 : card.unauthorized;
	const samples = response ? trimSamples([...card.samples, toSample(now, question, response)], now) : card.samples;
	// A pause made while the call was in flight wins over the call's result.
	const active = card.status.kind === "running" || card.status.kind === "rate_limited";
	const status = active ? nextStatus(card, outcome, unauthorized, now) : card.status;
	const nextAt = status.kind === "rate_limited" ? status.until : now + card.intervalMin * 60_000;
	return { ...card, samples, unauthorized, status, nextAt };
}

// Returns an updater so the result lands on whatever the card looks like when the call settles.
export async function probeCard(
	card: CustomCard,
	key: string,
	questionIds: readonly string[],
	probe: SiteProbe,
	now: number,
): Promise<(latest: CustomCard) => CustomCard> {
	const question = pickQuestion(questionIds, now);
	const outcome = await probe({ site: card.site, key, model: card.model, question, protocol: "responses" });
	return (latest) => applyOutcome(latest, question, outcome, now);
}

export const pauseCard = (card: CustomCard): CustomCard => ({ ...card, status: { kind: "paused" } });

export const resumeCard = (card: CustomCard, now: number): CustomCard => ({ ...card, status: { kind: "running" }, nextAt: now, unauthorized: 0 });

export function cardMonitor(card: CustomCard, now: number): MonitorResponse {
	return { ...buildMonitor(card.samples, now, card.host, true), intervalSec: card.intervalMin * 60 };
}

export function statusNotice(status: CardStatus, now: number): string | null {
	switch (status.kind) {
		case "running":
			return null;
		case "rate_limited":
			return `本站限流，${Math.max(0, Math.ceil((status.until - now) / 1000))} 秒后继续`;
		case "paused":
			return "已暂停";
		case "needs_key":
			return "已暂停：需要重新输入密钥才能继续";
		case "bad_key":
			return "密钥无效，请重新输入";
		case "rejected":
			return `已暂停：${status.message}`;
	}
}

// Picks fields explicitly so nothing held only in memory, such as a key, can reach storage by accident.
export function serializeCards(cards: CustomCard[]): string {
	const sites = cards.map(({ id, site, model, intervalMin, createdAt, samples }) => ({ id, site, model, intervalMin, createdAt, samples }));
	return JSON.stringify({ sites });
}

const isInterval = (v: unknown): v is IntervalMin => INTERVALS.some((i) => i === v);

function restoreCard(raw: unknown, now: number): CustomCard | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || typeof r.site !== "string" || typeof r.model !== "string") return null;
	if (!isInterval(r.intervalMin) || typeof r.createdAt !== "number" || !Array.isArray(r.samples)) return null;
	const parsed = parseSite(r.site);
	if (!parsed.ok) return null;
	const samples = r.samples.filter((s): s is MonitorSample => typeof s === "object" && s !== null && "ts" in s && typeof s.ts === "number");
	const config = { id: r.id, site: parsed.site, model: r.model, intervalMin: r.intervalMin, createdAt: r.createdAt };
	return { ...newCard(config, parsed.host), samples: trimSamples(samples, now), status: { kind: "needs_key" } };
}

// Keys are never stored, so every restored card waits for its key to be entered again.
export function deserializeCards(raw: string | null, now: number): CustomCard[] {
	if (raw === null) return [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	const sites = typeof data === "object" && data !== null && Array.isArray((data as { sites?: unknown }).sites) ? (data as { sites: unknown[] }).sites : [];
	return sites.flatMap((s) => restoreCard(s, now) ?? []).slice(0, MAX_SITES);
}
