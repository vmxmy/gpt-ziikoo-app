import type { Protocol } from "../shared/types.ts";
import { WATCH_MAX_ALIAS, type WatchCreateRequest, type WatchIntervalMin, type WatchStatus } from "../shared/watch.ts";
import { normalizeKey } from "./results.ts";

export const BOARD_KEY = "gpt.board.v1";
export const TOKENS_KEY = "gpt.watch.v1";
const LEGACY_KEY = "gpt.monitors.v1";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const BOARD_RE = /^[A-Za-z0-9_-]{22}$/;

export const PROTOCOLS: readonly Protocol[] = ["responses", "chat", "anthropic"];

const isClaude = (model: string) => /claude/i.test(model);

// The first protocol wins when both answer the stage-1 race.
export const raceProtocols = (model: string): readonly [Protocol, Protocol] => (isClaude(model) ? ["anthropic", "chat"] : ["responses", "chat"]);

// Follows the model as the user types; a protocol picked by hand stays until the model next changes.
export function protocolForModel(model: string, current: Protocol): Protocol {
	if (isClaude(model)) return "anthropic";
	return current === "anthropic" ? "responses" : current;
}

export type ParsedSite = { ok: true; site: string; host: string } | { ok: false; message: string };

export function parseSite(input: string): ParsedSite {
	const site = input.trim();
	if (!URL.canParse(site)) return { ok: false, message: "请输入完整地址，例如 https://example.com" };
	const url = new URL(site);
	if (url.protocol !== "https:") return { ok: false, message: "只支持 https 地址" };
	return { ok: true, site, host: url.host };
}

export const normalizeAlias = (input: string): string => input.trim().slice(0, WATCH_MAX_ALIAS);

export const cardLabel = ({ alias, host }: { alias: string; host: string }): string => (alias === "" ? host : `${alias}（${host}）`);

export const cardId = (token: string): string => token.slice(0, 8);

export type FieldError = { field: "site" | "key" | "model" | "consent" | "form"; message: string };

export type WatchInput = {
	site: string;
	alias: string;
	key: string;
	model: string;
	protocol: Protocol;
	intervalMin: WatchIntervalMin;
	consent: boolean;
};

export type WatchDraft = { ok: true; request: WatchCreateRequest } | { ok: false; error: FieldError };

export function parseWatchInput(input: WatchInput, board?: string): WatchDraft {
	const parsed = parseSite(input.site);
	if (!parsed.ok) return { ok: false, error: { field: "site", message: parsed.message } };
	const key = normalizeKey(input.key);
	if (key === "") return { ok: false, error: { field: "key", message: "请输入密钥" } };
	const model = input.model.trim();
	if (model === "") return { ok: false, error: { field: "model", message: "请输入模型" } };
	if (!input.consent) return { ok: false, error: { field: "consent", message: "请先勾选同意，再添加持续监测" } };
	return {
		ok: true,
		request: {
			site: parsed.site,
			key,
			model,
			protocol: input.protocol,
			intervalMin: input.intervalMin,
			alias: normalizeAlias(input.alias),
			consent: true,
			...(board ? { board } : {}),
		},
	};
}

export function statusNotice(status: WatchStatus): string | null {
	switch (status.kind) {
		case "running":
			return null;
		case "paused":
			return "已暂停";
		case "bad_key":
			return "密钥无效：站点连续拒绝这把密钥，请删除后重新添加";
	}
}

export function parseTokens(raw: string | null): string[] {
	if (raw === null) return [];
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	const list = Array.isArray(data) ? data : [];
	return list.filter((t): t is string => typeof t === "string" && TOKEN_RE.test(t));
}

export function loadBoard(): string | null {
	try {
		const raw = localStorage.getItem(BOARD_KEY);
		return raw && BOARD_RE.test(raw) ? raw : null;
	} catch {
		return null;
	}
}

export function saveBoard(board: string): boolean {
	try {
		localStorage.setItem(BOARD_KEY, board);
		return true;
	} catch {
		return false;
	}
}

export function parseBoardHash(hash: string): string | null {
	const match = /^#watch\/b=([A-Za-z0-9_-]{22})$/.exec(hash);
	return match ? match[1] : null;
}

export function loadLegacyTokens(): string[] {
	try {
		localStorage.removeItem(LEGACY_KEY);
		return parseTokens(localStorage.getItem(TOKENS_KEY));
	} catch {
		return [];
	}
}

export function clearLegacyTokens(): void {
	try {
		localStorage.removeItem(TOKENS_KEY);
	} catch {}
}
