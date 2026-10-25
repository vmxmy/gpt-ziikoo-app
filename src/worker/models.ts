import type { ModelsResponse } from "../shared/types.ts";
import { MAX_BODY_BYTES, statusReason, thrownReason, UA } from "./probe.ts";

export type ModelsInput = { origin: string; key: string };
export type ModelsDeps = { fetch: (url: string, init: RequestInit) => Promise<Response> };

const TIMEOUT_MS = 15_000;
const MAX_MODELS = 500;
const MAX_ID_CHARS = 100;

const DEFAULT_DEPS: ModelsDeps = { fetch: (url, init) => fetch(url, init) };

async function readCappedText(body: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		const piece = next.value.subarray(0, MAX_BODY_BYTES - bytes);
		bytes += piece.byteLength;
		text += decoder.decode(piece, { stream: true });
		if (piece.byteLength < next.value.byteLength) {
			await reader.cancel();
			break;
		}
	}
	return text + decoder.decode();
}

const idOf = (entry: unknown): unknown => (typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).id : undefined);

function extractModels(data: unknown[]): string[] {
	const models: string[] = [];
	const seen = new Set<string>();
	for (const entry of data) {
		const id = idOf(entry);
		if (typeof id !== "string" || seen.has(id)) continue;
		seen.add(id);
		models.push(id.slice(0, MAX_ID_CHARS));
		if (models.length === MAX_MODELS) break;
	}
	return models;
}

export async function fetchModels(input: ModelsInput, deps: ModelsDeps = DEFAULT_DEPS): Promise<ModelsResponse> {
	let response: Response;
	try {
		response = await deps.fetch(`${input.origin}/v1/models`, {
			headers: { "User-Agent": UA, Authorization: `Bearer ${input.key}`, Accept: "application/json" },
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		return { ok: false, reason: thrownReason(err), httpStatus: null };
	}
	const reason = statusReason(response.status);
	if (reason) {
		await response.body?.cancel();
		return { ok: false, reason, httpStatus: response.status };
	}
	let text: string;
	try {
		text = await readCappedText(response.body);
	} catch (err) {
		return { ok: false, reason: thrownReason(err), httpStatus: response.status };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ok: false, reason: "bad_response", httpStatus: response.status };
	}
	const data = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).data : undefined;
	if (!Array.isArray(data) || !data.some((entry) => typeof idOf(entry) === "string")) {
		return { ok: false, reason: "bad_response", httpStatus: response.status };
	}
	return { ok: true, models: extractModels(data) };
}
