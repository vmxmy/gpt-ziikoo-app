import { defineLiveStream } from "void/live";
import type { WatchLiveEvent } from "../shared/watch.ts";
import { hmacHex } from "./hmac.ts";

export type { WatchLiveEvent };

export const LIVE_TOPIC_RE = /^watch:[0-9a-f]{64}$/;

export async function liveTopic(pepper: string, id: string): Promise<string> {
	return "watch:" + (await hmacHex(pepper, `live\n${id}`));
}

export const watchLive = defineLiveStream({
	id: "watch-board",
	allowAnonymousControl: true,
	onSubscribe: ({ topic }) => (LIVE_TOPIC_RE.test(topic) ? undefined : new Response("invalid topic", { status: 400 })),
});

export async function publishWatchEvent(
	env: Partial<Pick<Env, "PEPPER" | "VOID_LIVE">>,
	id: string,
	event: WatchLiveEvent,
): Promise<void> {
	if (!env.VOID_LIVE || !env.PEPPER) return;
	try {
		const topic = await liveTopic(env.PEPPER, id);
		await watchLive.withEnv(env).publish(topic, event);
	} catch {
		/* best-effort push */
	}
}
