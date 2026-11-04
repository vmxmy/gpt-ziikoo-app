import type { ProbeResponse } from "./types.ts";

function validCount(value: number | null): value is number {
	return value !== null && Number.isSafeInteger(value) && value >= 0 && value <= 10_000_000;
}

function tokenCounts(response: ProbeResponse | null): { prompt: number; cached: number } | null {
	if (!response?.ok) return null;
	const { promptTokens: prompt, cachedTokens: cached } = response;
	return validCount(prompt) && validCount(cached) && cached <= prompt ? { prompt, cached } : null;
}

export function freshHit(first: ProbeResponse | null, second: ProbeResponse | null): { promptTokens: number; cachedTokens: number } | null {
	const warm = tokenCounts(first);
	const hit = tokenCounts(second);
	if (!warm || !hit) return null;
	const promptTokens = warm.prompt - warm.cached;
	if (promptTokens < 4096) return null;
	return { promptTokens, cachedTokens: Math.max(0, promptTokens - (hit.prompt - hit.cached)) };
}
