/// <reference types="vite/client" />
import { useRef, useState } from "preact/hooks";
import { GENERATORS } from "../shared/generators.ts";
import { PERF_DURATIONS, PERF_QPS, sendOffsets, summarizeLoad, type PerfConfig, type PerfCriterion, type PerfSample, type PerfStats, type PerfSummary } from "../shared/perf.ts";
import type { ProbeResponse, Protocol } from "../shared/types.ts";
import { missingFields, probeLoad } from "./api.ts";
import { ModelField } from "./model-field.tsx";
import "./perf.css";
import { downloadReport, escapeHtml, reportFileName } from "./report.ts";
import { DEFAULT_MODEL, ms, normalizeKey } from "./results.ts";
import type { ProbeOutcome } from "./runner.ts";
import { SecretInput } from "./test-form.tsx";
import { parseSite, protocolForModel, PROTOCOLS } from "./watch.ts";
import { ChoiceField } from "./watch-strategy.tsx";

// Calibrated on a real site: the long-prefix prompt of about 21,400 characters counted about 4,700 input tokens.
const CHARS_PER_TOKEN = 4.5;
const SAMPLE_PROMPT_CHARS = GENERATORS.prefix(0).prompt.length;

type Counts = { sent: number; returned: number; failed: number };
type Send = (signal: AbortSignal) => Promise<ProbeOutcome>;
type Stop = Extract<ProbeOutcome, { kind: "stop" }>;
type LoadEnd = { kind: "done"; warm: ProbeResponse | null; samples: PerfSample[] } | { kind: "stopped"; stop: Stop } | { kind: "cancelled" };
type Fired = { sample: PerfSample } | { stop: Stop } | null;

type RunInfo = { host: string; model: string; protocol: Protocol; config: PerfConfig; promptChars: number; at: Date };
type Done = RunInfo & { summary: PerfSummary };
type Status =
	| { kind: "idle" }
	| { kind: "running"; warming: boolean; counts: Counts }
	| ({ kind: "done" } & Done)
	| { kind: "limited" }
	| { kind: "stopped"; message: string }
	| { kind: "cancelled" };

const ZERO: Counts = { sent: 0, returned: 0, failed: 0 };

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, Math.max(0, ms));
		signal.addEventListener("abort", finish);
	});
}

async function attempt(send: Send, signal: AbortSignal): Promise<ProbeOutcome | null> {
	try {
		return await send(signal);
	} catch (err) {
		if (signal.aborted) return null;
		throw err;
	}
}

// Open loop: each call leaves at its own offset whether or not earlier calls have returned. A stop from this site halts the rest.
async function loadRun(send: Send, offsets: number[], signal: AbortSignal, onCount: (counts: Counts) => void): Promise<LoadEnd> {
	const warm = await attempt(send, signal);
	if (warm === null) return { kind: "cancelled" };
	if (warm.kind === "stop") return { kind: "stopped", stop: warm };
	const halt = new AbortController();
	const onAbort = () => halt.abort();
	signal.addEventListener("abort", onAbort);
	let counts = ZERO;
	const t0 = performance.now();
	const fire = async (offset: number): Promise<Fired> => {
		await delay(t0 + offset - performance.now(), halt.signal);
		if (halt.signal.aborted) return null;
		const sentAt = performance.now();
		counts = { ...counts, sent: counts.sent + 1 };
		onCount(counts);
		const outcome = await attempt(send, halt.signal);
		if (outcome === null) return null;
		if (outcome.kind === "stop") {
			halt.abort();
			return { stop: outcome };
		}
		const response = outcome.kind === "response" ? outcome.response : null;
		counts = { ...counts, returned: counts.returned + 1, failed: counts.failed + (response?.ok ? 0 : 1) };
		onCount(counts);
		return { sample: { sentAt, response } };
	};
	const fired = await Promise.all(offsets.map(fire));
	signal.removeEventListener("abort", onAbort);
	if (signal.aborted) return { kind: "cancelled" };
	const stopped = fired.find((f) => f !== null && "stop" in f);
	if (stopped && "stop" in stopped) return { kind: "stopped", stop: stopped.stop };
	const samples = fired.flatMap((f) => (f !== null && "sample" in f ? [f.sample] : []));
	return { kind: "done", warm: warm.kind === "response" ? warm.response : null, samples };
}

const percent = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const fine = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} ms`);
const perMinute = (v: number | null) => (v === null ? "—" : v >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)} M` : Math.round(v).toLocaleString("zh-CN"));
const count = (v: number | null) => (v === null ? "—" : v.toLocaleString("zh-CN"));

const CRITERION_TEXT: Record<PerfCriterion["id"], { label: string; rule: string; value: (v: number | null) => string }> = {
	cache: { label: "缓存命中率", rule: "≥ 90%", value: percent },
	success: { label: "有效成功率", rule: "≥ 99%", value: percent },
	ttft: { label: "首字耗时 P90", rule: "< 20 秒", value: ms },
	tpot: { label: "每 token 耗时 P90", rule: "< 30 ms", value: fine },
	tpm: { label: "累计 TPM", rule: "≥ 5.00 M", value: perMinute },
};
const VERDICT_TEXT: Record<PerfCriterion["verdict"], string> = { pass: "通过", fail: "未通过", na: "不判定" };

const statsRows = (label: string, s: PerfStats, format: (v: number | null) => string): [string, string][] => [
	[`${label} 平均`, format(s.avg)],
	[`${label} 中位数`, format(s.p50)],
	[`${label} P90`, format(s.p90)],
];

function detailRows(s: PerfSummary): [string, string][] {
	return [
		["调用数", count(s.requestCount)],
		["成功数", count(s.successCount)],
		["有效成功率", percent(s.successRate)],
		["RPM", s.rpm.toFixed(1)],
		["输入 TPM", perMinute(s.inputTpm)],
		["输出 TPM", perMinute(s.outputTpm)],
		["累计 TPM", perMinute(s.totalTpm)],
		["缓存 TPM", perMinute(s.cachedTpm)],
		["缓存命中率", percent(s.cacheHitRate)],
		...statsRows("总耗时", s.latencyMs, ms),
		["总耗时 最大值", ms(s.maxLatencyMs)],
		...statsRows("首字耗时", s.ttftMs, ms),
		...statsRows("每 token 耗时", s.tpotMs, fine),
	];
}

function conditionRows(d: Done): [string, string][] {
	return [
		["站点", d.host],
		["模型", d.model],
		["协议", d.protocol],
		["QPS × 时长", `${d.config.qps} × ${d.config.durationSec} 秒`],
		["题面字符数", count(d.promptChars)],
		["实际输入 token 数中位数", count(d.summary.promptTokensMedian)],
		["预热", "有，先发 1 次并等它返回，不计入调用数"],
		["耗时口径", "从本站边缘到站点量起，不是你本机的耗时"],
		["TPM", "本站只有探测档，本档不判定 TPM"],
	];
}

function conclusion(s: PerfSummary): string {
	const failed = s.criteria.filter((c) => c.verdict === "fail").map((c) => CRITERION_TEXT[c.id].label);
	const head = failed.length === 0 ? "通过：缓存命中率、有效成功率、首字耗时、每 token 耗时四项都达标。" : `未通过：${failed.join("、")}不达标。`;
	return `${head}累计 TPM 本档不判定。`;
}

const verdictWord = (s: PerfSummary) => (s.verdict === "pass" ? "通过" : "未通过");
const stamp = (at: Date) => at.toLocaleString("zh-CN", { hour12: false });

function reportTable(head: string[], rows: string[][]): string {
	const cells = (tag: string, row: string[]) => row.map((c) => `<${tag}>${escapeHtml(c)}</${tag}>`).join("");
	return `<table><thead><tr>${cells("th", head)}</tr></thead><tbody>${rows.map((r) => `<tr>${cells("td", r)}</tr>`).join("")}</tbody></table>`;
}

// Every value goes through escapeHtml; the key never reaches this function.
function reportHtml(d: Done): string {
	const criteria = d.summary.criteria.map((c) => [CRITERION_TEXT[c.id].label, CRITERION_TEXT[c.id].rule, CRITERION_TEXT[c.id].value(c.value), VERDICT_TEXT[c.verdict], c.note]);
	const title = `性能测试：${d.host} · ${d.model}`;
	return [
		`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>`,
		`<h1>${escapeHtml(title)}</h1>`,
		`<p>${escapeHtml(`${stamp(d.at)} · ${verdictWord(d.summary)}`)}</p>`,
		"<h2>五项达标</h2>",
		reportTable(["项目", "标准", "实测", "结论", "说明"], criteria),
		"<h2>明细</h2>",
		reportTable(["指标", "数值"], detailRows(d.summary)),
		"<h2>测试条件</h2>",
		reportTable(["条件", "内容"], conditionRows(d)),
		"<h2>结论</h2>",
		`<p>${escapeHtml(conclusion(d.summary))}</p>`,
		"</body></html>",
	].join("\n");
}

function PairTable({ testId, head, rows }: { testId: string; head: [string, string]; rows: [string, string][] }) {
	return (
		<div class="table-wrap">
			<table data-testid={testId}>
				<thead>
					<tr>
						<th>{head[0]}</th>
						<th>{head[1]}</th>
					</tr>
				</thead>
				<tbody>
					{rows.map(([label, value]) => (
						<tr key={label}>
							<td>{label}</td>
							<td class="num">{value}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function PerfResult(d: Done) {
	const { summary } = d;
	return (
		<div class="perf-result" data-testid="perf-result">
			<p class="perf-title">
				<span>
					{d.host} · {d.model} · {stamp(d.at)}
				</span>{" "}
				<span class="perf-verdict" data-verdict={summary.verdict} data-testid="perf-verdict">
					{verdictWord(summary)}
				</span>
			</p>
			<h3>五项达标</h3>
			<div class="table-wrap">
				<table data-testid="perf-criteria">
					<thead>
						<tr>
							<th>项目</th>
							<th>标准</th>
							<th class="num">实测</th>
							<th>结论</th>
							<th>说明</th>
						</tr>
					</thead>
					<tbody>
						{summary.criteria.map((c) => (
							<tr key={c.id} data-testid={`perf-criterion-${c.id}`}>
								<td>{CRITERION_TEXT[c.id].label}</td>
								<td>{CRITERION_TEXT[c.id].rule}</td>
								<td class="num">{CRITERION_TEXT[c.id].value(c.value)}</td>
								<td>
									<span class="perf-verdict" data-verdict={c.verdict}>
										{VERDICT_TEXT[c.verdict]}
									</span>
								</td>
								<td>{c.note}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<h3>明细</h3>
			<PairTable testId="perf-details" head={["指标", "数值"]} rows={detailRows(summary)} />
			<h3>测试条件</h3>
			<PairTable testId="perf-conditions" head={["条件", "内容"]} rows={conditionRows(d)} />
			<h3>结论</h3>
			<p data-testid="perf-conclusion">{conclusion(summary)}</p>
			<div class="actions">
				<button type="button" class="btn btn-secondary" onClick={() => downloadReport(reportHtml(d), reportFileName(d.host, d.model, "qps_bench"))} data-testid="perf-download">
					下载报告
				</button>
			</div>
		</div>
	);
}

function PerfProgress({ warming, counts }: { warming: boolean; counts: Counts }) {
	return (
		<p class="perf-counts num" role="status" data-testid="perf-counts">
			{warming ? "预热中，等第 1 次调用返回" : `已发 ${counts.sent} · 已返回 ${counts.returned} · 失败 ${counts.failed}`}
		</p>
	);
}

export function PerfTest() {
	const [site, setSite] = useState("");
	const [key, setKey] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [protocol, setProtocol] = useState<Protocol>("responses");
	const [qps, setQps] = useState<PerfConfig["qps"]>(1);
	const [durationSec, setDurationSec] = useState<PerfConfig["durationSec"]>(30);
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const [formError, setFormError] = useState("");
	const keyInput = useRef<HTMLInputElement>(null);
	const ctrl = useRef<AbortController | null>(null);
	const target = { site: site.trim(), key };
	const calls = qps * durationSec;
	const chooseModel = (next: string) => {
		setModel(next);
		setProtocol((current) => protocolForModel(next, current));
	};

	const start = async () => {
		const missing = missingFields(target, model);
		if (missing.length > 0) return setFormError(`请填写${missing.join("、")}`);
		const parsed = parseSite(site);
		if (!parsed.ok) return setFormError(parsed.message);
		setFormError("");
		const controller = new AbortController();
		ctrl.current = controller;
		const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
		const config = { qps, durationSec };
		const run: RunInfo = { host: parsed.host, model: model.trim(), protocol, config, promptChars: GENERATORS.prefix(seed).prompt.length, at: new Date() };
		setStatus({ kind: "running", warming: true, counts: ZERO });
		const send: Send = (signal) => probeLoad(target, run.model, protocol, seed, signal);
		const end = await loadRun(send, sendOffsets(config), controller.signal, (counts) => setStatus({ kind: "running", warming: false, counts }));
		if (end.kind === "cancelled") return setStatus({ kind: "cancelled" });
		if (end.kind === "stopped") return setStatus(end.stop.status === 429 ? { kind: "limited" } : { kind: "stopped", message: end.stop.message });
		setStatus({ kind: "done", ...run, summary: summarizeLoad(end.warm, end.samples, config) });
	};

	return (
		<section class="panel" aria-labelledby="perf-h">
			<h2 id="perf-h">性能测试</h2>
			<p class="muted small">
				按固定 QPS 连续调用站点，核对缓存命中率、有效成功率、首字耗时、每 token 耗时与累计 TPM 五项门槛。每轮先发 1 次预热并等它返回，再按固定间隔发出，不等前一次返回。只调用站点，不进历史，刷新页面即失。密钥不保存，只在调用时转发给站点。
			</p>
			<form
				class="grid perf-form"
				onSubmit={(e) => {
					e.preventDefault();
					void start();
				}}
			>
				<label class="field col-12 col-md-6 col-lg-4">
					<span class="field-label">站点地址</span>
					<input
						type="text"
						inputMode="url"
						autocomplete="username"
						placeholder="https://example.com"
						value={site}
						onInput={(e) => setSite(e.currentTarget.value)}
						data-testid="perf-site"
					/>
				</label>
				<label class="field col-12 col-md-6 col-lg-4">
					<span class="field-label">密钥</span>
					<SecretInput inputRef={keyInput} testId="perf-key" onInput={(v) => setKey(normalizeKey(v))} />
				</label>
				<ModelField value={model} onInput={chooseModel} target={target} testId="perf-model" class="col-12 col-md-6 col-lg-4" />
				<ChoiceField label="协议" testId="perf-protocol" value={protocol} options={PROTOCOLS} text={(p) => p} onChange={setProtocol} class="col-6 col-lg-2" />
				<ChoiceField label="QPS" testId="perf-qps" value={qps} options={PERF_QPS} text={String} onChange={setQps} class="col-6 col-lg-2" />
				<ChoiceField label="时长" testId="perf-duration" value={durationSec} options={PERF_DURATIONS} text={(d) => `${d} 秒`} onChange={setDurationSec} class="col-6 col-lg-2" />
				<div class="actions col-12 col-md-6 col-lg-4">
					{status.kind === "running" ? (
						<button key="cancel" type="button" class="btn btn-secondary" onClick={() => ctrl.current?.abort()} data-testid="perf-cancel">
							取消
						</button>
					) : (
						<button key="run" type="submit" class="btn btn-primary" data-testid="perf-run">
							开始测试
						</button>
					)}
				</div>
				<p class="muted small col-12" data-testid="perf-cost">
					本次调用 {calls + 1} 次（{calls} 次加 1 次预热），按题面估算约 {count(Math.round(((calls + 1) * SAMPLE_PROMPT_CHARS) / CHARS_PER_TOKEN))} 个输入 token，站点额外加的输入不算在内。
				</p>
				{formError && (
					<p class="field-error" role="alert" data-testid="perf-form-error">
						{formError}
					</p>
				)}
			</form>
			{status.kind === "running" && <PerfProgress warming={status.warming} counts={status.counts} />}
			<div aria-live="polite">
				{status.kind === "cancelled" && <p class="warn">已取消。</p>}
				{status.kind === "limited" && (
					<p class="perf-verdict" data-kind="rate_limited" data-testid="perf-limited">
						本站限速，结果无效
					</p>
				)}
				{status.kind === "stopped" && <p class="warn">已停止：{status.message}</p>}
				{status.kind === "done" && <PerfResult {...status} />}
			</div>
		</section>
	);
}
