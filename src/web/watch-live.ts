import type { WatchLiveEvent, WatchView } from "../shared/watch.ts";

export type WatchCard =
	| { kind: "loading"; token: string }
	| { kind: "live"; token: string; view: WatchView; actionError: string | null }
	| { kind: "error"; token: string; message: string };

export function applyWatchLiveEvent(cards: WatchCard[], topic: string, event: WatchLiveEvent): WatchCard[] {
	if (event.kind === "deleted") {
		const next = cards.filter((c) => !(c.kind === "live" && c.view.liveTopic === topic));
		return next.length === cards.length ? cards : next;
	}
	let changed = false;
	const next = cards.map((c) => {
		if (c.kind === "live" && c.view.liveTopic === topic) {
			changed = true;
			return { ...c, view: event.view };
		}
		return c;
	});
	return changed ? next : cards;
}
