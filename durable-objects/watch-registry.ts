import { defineDurableObject } from "void/durable";
import { WatchRegistry } from "../src/worker/watch.ts";

export const WatchRegistryObject = defineDurableObject({
	name: "watch-registry",
	class: WatchRegistry,
});

export default WatchRegistryObject;
