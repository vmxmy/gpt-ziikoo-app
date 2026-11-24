import { defineDurableObject } from "void/durable";
import { Watch } from "../src/worker/watch.ts";

export const WatchObject = defineDurableObject({
	name: "watch",
	class: Watch,
});

export default WatchObject;
