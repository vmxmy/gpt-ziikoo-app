import type { Board } from "./board.ts";
import type { Target } from "./target.ts";
import type { Watch, WatchRegistry } from "./watch.ts";

declare global {
	interface Env {
		PEPPER: string;
		WATCH_ENC_KEY: string;
		IP_LIMITER: RateLimit;
		HOST_LIMITER: RateLimit;
		TARGET: DurableObjectNamespace<Target>;
		WATCH: DurableObjectNamespace<Watch>;
		WATCH_REGISTRY: DurableObjectNamespace<WatchRegistry>;
		BOARD: DurableObjectNamespace<Board>;
	}
}
