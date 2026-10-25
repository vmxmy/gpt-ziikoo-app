import { DurableObject } from "cloudflare:workers";
import { BOARD_MAX_WATCHES } from "../shared/watch.ts";
import { IDLE_MS, seal, unseal } from "./watch.ts";

const STATE_KEY = "tokens";

export function mergeTokens(existing: string[], incoming: string[], max: number): string[] | null {
	const unique = Array.from(new Set([...existing, ...incoming]));
	return unique.length > max ? null : unique;
}

export function reorderTokens(existing: string[], incoming: string[]): string[] | null {
	if (incoming.length !== existing.length || new Set(incoming).size !== incoming.length) return null;
	const before = new Set(existing);
	return incoming.every((t) => before.has(t)) ? incoming : null;
}

export function newBoardCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class Board extends DurableObject<Env> {
	private async load(board: string): Promise<string[]> {
		const sealed = await this.ctx.storage.get<{ iv: string; data: string }>(STATE_KEY);
		if (!sealed) return [];
		try {
			const plain = await unseal(board, sealed);
			const data = JSON.parse(plain);
			return Array.isArray(data) ? data.filter((t): t is string => typeof t === "string") : [];
		} catch {
			return [];
		}
	}

	private async save(board: string, tokens: string[], alarmAt: number): Promise<void> {
		if (tokens.length === 0) {
			await this.ctx.storage.deleteAll();
			return;
		}
		const sealed = await seal(board, JSON.stringify(tokens));
		await this.ctx.storage.put(STATE_KEY, sealed);
		await this.ctx.storage.setAlarm(alarmAt);
	}

	async list(board: string, now: number): Promise<string[]> {
		const tokens = await this.load(board);
		if (tokens.length > 0) await this.ctx.storage.setAlarm(now + IDLE_MS);
		return tokens;
	}

	// The crypto awaits between load and save release the input gate, so two adds could each miss the other's token.
	async add(board: string, incoming: string[], now: number): Promise<"ok" | "full"> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const merged = mergeTokens(await this.load(board), incoming, BOARD_MAX_WATCHES);
			if (merged === null) return "full";
			await this.save(board, merged, now + IDLE_MS);
			return "ok";
		});
	}

	async reorder(board: string, incoming: string[], now: number): Promise<"ok" | "stale"> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const ordered = reorderTokens(await this.load(board), incoming);
			if (ordered === null) return "stale";
			await this.save(board, ordered, now + IDLE_MS);
			return "ok";
		});
	}

	async remove(board: string, gone: string[], now: number): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const remaining = (await this.load(board)).filter((t) => !gone.includes(t));
			await this.save(board, remaining, now + IDLE_MS);
		});
	}

	async deleteAll(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	async alarm(): Promise<void> {
		await this.deleteAll();
	}
}
