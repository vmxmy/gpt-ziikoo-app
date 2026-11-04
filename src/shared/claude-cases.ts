export const CLAUDE_CASES = [
	{ id: "C1", title: "基础对话", does: "发送一次非流式对话，要求只回答 OK。", expect: "返回 200，包含 type=message、content 与 usage。" },
	{ id: "C2", title: "流式对话", does: "连续发送三次流式对话，记录首字耗时。", expect: "三次均返回 200，事件依次包含 message_start、text_delta、message_stop。" },
	{ id: "C3", title: "图片理解", does: "发送固定的 8×8 纯红 PNG，询问主色。", expect: "返回 200，回答包含 red。" },
	{ id: "C4", title: "结构化输出", does: "用 output_config.format 指定 name、age 的 JSON Schema。", expect: '回答严格等于 {"name":"Alice","age":30}。' },
	{ id: "C5", title: "强制工具调用", does: "用 tool_choice 强制调用 get_weather。", expect: "模型名含 opus-5-5 或 sonnet-5-5 时返回 400，其余返回 200。" },
	{ id: "C6", title: "工具结果回传", does: "要求调用 get_weather，再发送 tool_result。", expect: "两轮均返回 200，第一轮包含 tool_use。" },
	{ id: "C7", title: "关闭思考", does: "发送 thinking disabled 请求。", expect: "模型名含 opus-5-5 或 sonnet-5-5 时返回 400，其余返回 200。" },
	{ id: "C8", title: "思考签名校验", does: "通过 adaptive thinking 获取签名，分别原样与改动一个字符回传。", expect: "原样回传返回 200，篡改签名返回 4xx。" },
	{ id: "C9", title: "提示缓存", does: "用本轮随机的 long-prefix 与 cache_control 连发五次。", expect: "第 2 到 5 次扣除站点自加前缀后的缓存命中率均至少 90%，同时列出站点报的 cache_read。" },
	{ id: "C10", title: "输入 token 计数", does: "调用 /v1/messages/count_tokens。", expect: "返回 200 且 input_tokens 大于 0；404 记协议缺口，Bedrock 来源注明无法测 Mantle。" },
	{ id: "P1", title: "模型列表", does: "读取 GET /v1/models。", expect: "模型列表包含目标模型。" },
	{ id: "P2", title: "错误与请求标识", does: "故意省略 max_tokens，检查错误响应和请求标识。", expect: "返回 4xx，且 request-id 以 req_ 开头或响应体含 request_id。" },
	{ id: "P3", title: "批量接口", does: "本站不调用会创建异步任务并计费的批量接口。", expect: "标为未测，不创建异步任务。" },
] as const;

export type ClaudeCaseId = (typeof CLAUDE_CASES)[number]["id"];
export type CaseVerdict = "pass" | "fail" | "gap" | "untested";
export type MessageSource = "anthropic" | "bedrock" | "vertex" | "other";
export type CaseCall = { status: number | null; requestId: string | null; ms: number };
export type ClaudeCaseResult = {
	id: ClaudeCaseId;
	verdict: CaseVerdict;
	note: string;
	preview: string | null;
	source: MessageSource | null;
	calls: CaseCall[];
};
export type ClaudeCaseRequest = { site: string; key: string; model: string; case: ClaudeCaseId };
