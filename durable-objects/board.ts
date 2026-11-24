import { defineDurableObject } from "void/durable";
import { Board } from "../src/worker/board.ts";

export const BoardObject = defineDurableObject({
	name: "board",
	class: Board,
});

export default BoardObject;
