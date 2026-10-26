import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { generatePelican } from "../shared/pelican-gen.ts";
import type { Effort, PageEnding, ProbeProgress, Protocol } from "../shared/types.ts";
import { customResult, missingFields, probeHtml, type CustomResult } from "./api.ts";
import { Modal } from "./modal.tsx";
import { ModelField } from "./model-field.tsx";
import { DEFAULT_MODEL, ms, normalizeKey } from "./results.ts";
import { SecretInput } from "./test-form.tsx";
import { ChoiceField } from "./watch-add.tsx";
import { protocolForModel, PROTOCOLS } from "./watch.ts";

type EffortChoice = Effort | "";
const EFFORTS: readonly EffortChoice[] = ["", "low", "medium", "high", "xhigh"];
const effortText = (e: EffortChoice) => e || "不指定";

type Done = { result: CustomResult; protocol: Protocol; effort: EffortChoice; prompt: string; fileName: string };
// timeoutMs arrives with the first progress line; chars stays null until the site answers.
type Sending = { kind: "sending"; startedAt: number; timeoutMs: number | null; chars: number | null };
type Status = { kind: "idle" } | Sending | { kind: "cancelled" } | ({ kind: "done" } & Done);
type CopyStatus = "copied" | "failed";

const ENDING_WARNING: Record<Exclude<PageEnding, "closed">, string> = {
	unclosed: "回答在页面写到 </html> 之前就结束了，页面不完整，可能是站点限制了输出长度。",
	truncated: "站点响应超过 2MB 读取上限，回答被截断，页面可能不完整。",
};

// The frame has an opaque origin, so "*" is the only target that reaches it; the answer is the user's own and holds no key.
function AnimationFrame({ html }: { html: string }) {
	return (
		<iframe
			class="animation-frame"
			sandbox="allow-scripts"
			src="/api/frame"
			title="动画"
			onLoad={(e) => e.currentTarget.contentWindow?.postMessage(html, "*")}
		/>
	);
}

const pad = (n: number) => String(n).padStart(2, "0");

const TICK_MS = 1_000;
const RING_RADIUS = 26;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const clock = (sec: number) => `${Math.floor(sec / 60)}:${pad(sec % 60)}`;

function stageText(chars: number | null): string {
	if (chars === null) return "已发出调用，等站点响应";
	if (chars === 0) return "站点已响应，等首字。推理强度高时可能要几分钟";
	return "正在接收回答";
}

// The countdown runs on the page's clock from the click, so it reaches 0 a little before the worker gives up.
function HtmlProgress({ startedAt, timeoutMs, chars }: Sending) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), TICK_MS);
		return () => clearInterval(timer);
	}, []);
	const elapsed = now - startedAt;
	const left = timeoutMs === null ? null : Math.max(0, timeoutMs - elapsed);
	const spent = timeoutMs === null ? 0 : Math.min(1, elapsed / timeoutMs);
	return (
		<div class="html-progress" data-testid="html-progress">
			<div class="countdown" role="timer" aria-label="剩余时间">
				<svg viewBox="0 0 60 60" aria-hidden="true">
					<circle class="countdown-track" cx="30" cy="30" r={RING_RADIUS} />
					<circle
						class="countdown-bar"
						cx="30"
						cy="30"
						r={RING_RADIUS}
						transform="rotate(-90 30 30)"
						stroke-dasharray={RING_LENGTH}
						stroke-dashoffset={RING_LENGTH * spent}
					/>
				</svg>
				<span class="countdown-text num" data-testid="html-countdown">
					{left === null ? "--:--" : clock(Math.ceil(left / 1000))}
				</span>
			</div>
			<div class="html-progress-text">
				<p role="status" data-testid="html-stage">
					{stageText(chars)}
				</p>
				<p class="muted small num" data-testid="html-received">
					已用 {clock(Math.floor(elapsed / 1000))}
					{chars ? ` · 已收到 ${chars.toLocaleString("zh-CN")} 个字符` : ""}
				</p>
				<p class="muted small">倒计时到 0 时还没写完，本次按超时算失败。</p>
			</div>
		</div>
	);
}

function htmlFileName(model: string, at: Date): string {
	const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
	return `${model.replace(/[^\w.-]+/g, "-")}-${stamp}.html`;
}

// The frame decodes the page as UTF-8 whatever it declares; the BOM makes a browser opening the file do the same.
// octet-stream because a text/html blob URL, if ever navigated to, would run the untrusted page on this site's origin.
function downloadHtml(html: string, fileName: string) {
	const url = URL.createObjectURL(new Blob(["\uFEFF", html], { type: "application/octet-stream" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.click();
	URL.revokeObjectURL(url);
}

function ArtifactActions({ html, fileName }: { html: string; fileName: string }) {
	const [playing, setPlaying] = useState(false);
	const [copy, setCopy] = useState<CopyStatus | null>(null);
	const doCopy = () => {
		const write = navigator.clipboard?.writeText(html) ?? Promise.reject(new Error("clipboard unavailable"));
		write.then(
			() => setCopy("copied"),
			() => setCopy("failed"),
		);
	};
	return (
		<>
			<div class="actions">
				<button type="button" class="btn btn-secondary" onClick={() => setPlaying(true)} data-testid="html-play">
					播放动画
				</button>
				<button type="button" class="btn-text" onClick={doCopy} data-testid="html-copy">
					复制 HTML
				</button>
				<button type="button" class="btn-text" onClick={() => downloadHtml(html, fileName)} data-testid="html-download">
					下载 HTML
				</button>
				<span class="muted small" role="status">
					{copy === "copied" ? "已复制" : copy === "failed" ? "复制失败，请在下面手动选中" : ""}
				</span>
			</div>
			<details>
				<summary class="small">查看 HTML</summary>
				<pre class="prompt html-source" data-testid="html-source">
					{html}
				</pre>
			</details>
			<Modal open={playing} onClose={() => setPlaying(false)} title="播放动画">
				<AnimationFrame html={html} />
			</Modal>
		</>
	);
}

// The output count includes reasoning, so without a reasoning count only the total is known. A relay that
// reports less output than reasoning breaks that rule, and the difference would mean nothing.
function tokenFields(reasoning: number | null, output: number | null): [string, number | null][] {
	if (reasoning === null) return [["输出 token 数（含推理）", output]];
	return [
		["推理 token 数", reasoning],
		["回答 token 数", output === null || output < reasoning ? null : output - reasoning],
	];
}

// No verdict: the user judges the page by playing it, so only a failed call gets a state badge.
function HtmlResult({ result, protocol, effort, prompt, fileName }: Done) {
	return (
		<div class="html-result" data-testid="html-result">
			<p class="muted small">
				协议 {protocol} · 推理强度 {effortText(effort)}
			</p>
			{result.state === "fail" ? (
				<p>
					<span class="html-verdict" data-state="fail">
						{result.label}
					</span>{" "}
					<span data-testid="html-reason">{result.reason}</span>
				</p>
			) : (
				<>
					<dl class="html-fields">
						<dt>总耗时</dt>
						<dd class="num">{ms(result.response.totalMs)}</dd>
						<dt>首字耗时</dt>
						<dd class="num">{ms(result.response.ttftMs)}</dd>
						{tokenFields(result.response.reasoningTokens, result.response.outputTokens).map(([label, value]) => (
							<Fragment key={label}>
								<dt>{label}</dt>
								<dd class="num">{value ?? "—"}</dd>
							</Fragment>
						))}
						<dt>题面</dt>
						<dd data-testid="html-shown-prompt">{prompt}</dd>
						{!result.response.artifact && (
							<>
								<dt>回答片段</dt>
								<dd data-testid="html-answer">{result.response.answer}</dd>
							</>
						)}
					</dl>
					{result.response.artifact ? (
						<>
							{result.response.artifact.ending !== "closed" && (
								<p class="warn" data-testid="html-unfinished">
									{ENDING_WARNING[result.response.artifact.ending]}
								</p>
							)}
							<ArtifactActions html={result.response.artifact.html} fileName={fileName} />
						</>
					) : (
						<p class="warn" data-testid="html-no-page">
							回答里没有 HTML 页面，不能播放。
						</p>
					)}
				</>
			)}
		</div>
	);
}

export function HtmlTest() {
	const [site, setSite] = useState("");
	const [key, setKey] = useState("");
	const [model, setModel] = useState(DEFAULT_MODEL);
	const [protocol, setProtocol] = useState<Protocol>("responses");
	const [effort, setEffort] = useState<EffortChoice>("");
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const [formError, setFormError] = useState("");
	const keyInput = useRef<HTMLInputElement>(null);
	const ctrl = useRef<AbortController | null>(null);
	const target = { site: site.trim(), key };
	const chooseModel = (next: string) => {
		setModel(next);
		setProtocol((current) => protocolForModel(next, current));
	};

	const send = async () => {
		const missing = missingFields(target, model);
		if (missing.length > 0) return setFormError(`请填写${missing.join("、")}`);
		setFormError("");
		const controller = new AbortController();
		ctrl.current = controller;
		const seed = crypto.getRandomValues(new Uint32Array(1))[0];
		setStatus({ kind: "sending", startedAt: Date.now(), timeoutMs: null, chars: null });
		const onProgress = (line: ProbeProgress) =>
			setStatus((current) =>
				current.kind !== "sending" ? current : line.type === "start" ? { ...current, timeoutMs: line.timeoutMs } : { ...current, chars: line.chars },
			);
		try {
			const outcome = await probeHtml(target, model.trim(), protocol, effort || null, seed, controller.signal, onProgress);
			setStatus({ kind: "done", result: customResult(outcome), protocol, effort, prompt: generatePelican(seed), fileName: htmlFileName(model.trim(), new Date()) });
		} catch (err) {
			if (!controller.signal.aborted) throw err;
			setStatus({ kind: "cancelled" });
		}
	};

	return (
		<section class="panel" aria-labelledby="html-h">
			<h2 id="html-h">HTML 生成</h2>
			<p class="muted small">
				让模型直接写一个 HTML 页面，在沙箱里播放，由你看效果判断，本站不判对错。每次随机抽一种鸟和一个场景，让模型用 SVG
				画这只鸟在这个场景里骑自行车的 2D 动画。回答里没有 HTML 页面时不能播放，只显示回答片段。只调用一次站点，不计入分关，不进历史，刷新页面即失。密钥不保存，只在这次调用时转发给站点。
			</p>
			<form
				class="grid html-form"
				onSubmit={(e) => {
					e.preventDefault();
					void send();
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
						data-testid="html-site"
					/>
				</label>
				<label class="field col-12 col-md-6 col-lg-4">
					<span class="field-label">密钥</span>
					<SecretInput inputRef={keyInput} testId="html-key" onInput={(v) => setKey(normalizeKey(v))} />
				</label>
				<ChoiceField label="协议" testId="html-protocol" value={protocol} options={PROTOCOLS} text={(p) => p} onChange={setProtocol} class="col-6 col-lg-2" />
				<ChoiceField label="推理强度" testId="html-effort" value={effort} options={EFFORTS} text={effortText} onChange={setEffort} class="col-6 col-lg-2" />
				{/* From 720px up the button sits beside the model field, where the open model list cannot cover it. */}
				<ModelField value={model} onInput={chooseModel} target={target} testId="html-model" class="col-12 col-md-6 col-lg-4" />
				<div class="actions col-12 col-md-6 col-lg-4">
					{status.kind === "sending" ? (
						<button key="cancel" type="button" class="btn btn-secondary" onClick={() => ctrl.current?.abort()} data-testid="html-cancel">
							取消
						</button>
					) : (
						<button key="run" type="submit" class="btn btn-primary" data-testid="html-run">
							生成一次
						</button>
					)}
				</div>
				{formError && (
					<p class="field-error" role="alert" data-testid="html-form-error">
						{formError}
					</p>
				)}
			</form>
			{status.kind === "sending" && <HtmlProgress {...status} />}
			<div aria-live="polite">
				{status.kind === "cancelled" && <p class="warn">已取消。</p>}
				{status.kind === "done" && <HtmlResult {...status} />}
			</div>
		</section>
	);
}
