import { STAGES } from "../shared/ladder.ts";
import type { FailReason, OverallStatus, ProbeResponse, QuestionStatus, QuestionVerdict } from "../shared/types.ts";
import type { Attempt } from "./runner.ts";

export const DEFAULT_MODEL = "gpt-6-astra";

export const MAX_CALLS_PER_QUESTION = STAGES.reduce((n, s) => n + s.calls, 0);

export function costLine(selected: number): string {
	return `已选 ${selected} 题，最多 ${selected * MAX_CALLS_PER_QUESTION} 次调用。第 1 关未通过时，测试在第 1 关停止。第 1 关另加 1 次调用，用来确认协议。`;
}

export const OVERALL_LABEL: Record<OverallStatus, string> = {
	all_passed: "全部通过",
	partial: "部分通过",
	failed: "未通过",
	unavailable: "无法测试",
	incomplete: "未完成",
};

export const VERDICT_LABEL: Record<QuestionStatus, string> = {
	passed: "通过",
	failed: "未通过",
	unavailable: "无法测试",
	incomplete: "未完成",
};

export type FailureAdvice = { reason: string; next: string };

const NETWORK: FailureAdvice = { reason: "连不上本站接口", next: "检查网络后重测" };

export const FAILURE_ADVICE: Record<FailReason, FailureAdvice> = {
	unauthorized: { reason: "密钥无效或模型无权限", next: "检查密钥" },
	forbidden: { reason: "站点拒绝了来自服务器的请求", next: "联系站点，或换网络自测" },
	not_found: { reason: "地址或协议不对", next: "检查是否多填了路径" },
	rate_limited: { reason: "站点正忙或限流", next: "几分钟后再测" },
	upstream_error: { reason: "站点推理接口不可用", next: "等恢复后重测" },
	timeout: { reason: "站点响应太慢", next: "稍后重测" },
	bad_response: { reason: "站点返回无效内容", next: "若该站点与密钥此前已有历史，可在历史里点「下载原始数据」查看站点返回内容；否则请在本机用 curl 自测该地址" },
};

export function resultText(a: Attempt): string {
	if (!a.response) return "网络失败";
	if (!a.response.ok) return `失败 ${a.response.reason}${a.response.httpStatus ? ` ${a.response.httpStatus}` : ""}`;
	if (a.response.correct === null) return "不评分";
	return a.response.correct ? "答对" : "答错";
}

export function dotLabel(a: Attempt): string {
	return `第 ${a.stage} 关，第 ${a.seq} 个调用，第 ${a.attempt} 次尝试 · ${a.protocol}：${a.done ? resultText(a) : "进行中"}`;
}

export function failureAdvice(attempts: Attempt[]): FailureAdvice {
	const failed = attempts.filter((a) => a.done && !a.response?.ok);
	const last = failed[failed.length - 1]?.response;
	return last && !last.ok ? FAILURE_ADVICE[last.reason] : NETWORK;
}

export function diagnosis(verdict: QuestionVerdict, attempts: Attempt[], failureHint: string): string {
	if (verdict.status === "passed") return `四关全部通过，答对 ${verdict.correct}/${verdict.total}。`;
	if (verdict.status === "failed") return `第 ${verdict.stage} 关未达标，答对 ${verdict.correct}/${verdict.total}。${failureHint}`;
	if (verdict.status === "unavailable") {
		const { reason, next } = failureAdvice(attempts);
		return `第 ${verdict.stage} 关连续 3 次没有有效响应：${reason}。下一步：${next}。`;
	}
	return `停在第 ${verdict.stage} 关，测试没有跑完。`;
}

// Couples to the "missing [...]" note format written by the numbers scorer in src/worker/scorers.ts.
export function missingNumbers(response: ProbeResponse | null): string {
	if (!response?.ok || !response.note.startsWith("missing ")) return "";
	return (response.note.match(/\d+/g) ?? []).join("、");
}

export function ms(value: number | null | undefined): string {
	return value === null || value === undefined ? "—" : `${Math.round(value)} ms`;
}

export function pct(value: number | null): string {
	return value === null ? "—" : `${value.toFixed(1)}%`;
}

export function normalizeKey(input: string): string {
	return input.replace(/^\s*bearer\s+/i, "").replace(/\s+/g, "");
}
