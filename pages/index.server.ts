import { defineHandler, defineHead } from "void";

export const ssr = false;

export const loader = defineHandler(() => ({}));

export const head = defineHead(() => ({
	title: "GPT 降智测试",
	meta: [
		{ name: "description", content: "用固定题目调用你的站点，检查它返回的是不是你购买的 GPT 模型" },
	],
}));
