import { defineDurableObject } from "void/durable";
import { Target } from "../src/worker/target.ts";

export const TargetObject = defineDurableObject({
	name: "target",
	class: Target,
});

export default TargetObject;
