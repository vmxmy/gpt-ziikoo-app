import { useRef, useState } from "preact/hooks";
import { generatePelican } from "../shared/pelican-gen.ts";
import type { Effort, Protocol } from "../shared/types.ts";
import { codePoints, customResult, MAX_CUSTOM_PROMPT, missingFields, probeHtml, type CustomResult, type HtmlSource } from "./api.ts";
import { Modal } from "./modal.tsx";
import { ModelField } from "./model-field.tsx";
import { DEFAULT_MODEL, ms, normalizeKey } from "./results.ts";
import { SecretInput } from "./test-form.tsx";
import { ChoiceField } from "./watch-add.tsx";
import { PROTOCOLS } from "./watch.ts";

type EffortChoice = Effort | "";
const EFFORTS: readonly EffortChoice[] = ["", "low", "medium", "high", "xhigh"];
const effortText = (e: EffortChoice) => e || "不指定";

type Done = { result: CustomResult; protocol: Protocol; effort: EffortChoice; prompt: string };
type Status = { kind: "idle" } | { kind: "sending" } | { kind: "cancelled" } | ({ kind: "done" } & Done);
type CopyStatus = "copied" | "failed";

// The frame has an opaque origin, so "*" is the only target that reaches it; the answer is the user's own and holds no key.
function AnimationFrame({ artifact }: { artifact: string }) {
	return (
		<iframe
			class="animation-frame"
			sandbox="allow-scripts"
			src="/api/frame"
			title="动画"
			onLoad={(e) => e.currentTarget.contentWindow?.postMessage(artifact, "*")}
		/>
	);
}

function ArtifactActions({ artifact }: { artifact: string }) {
	const [playing, setPlaying] = useState(false);
	const [copy, setCopy] = useState<CopyStatus | null>(null);
	const doCopy = () => {
		const write = navigator.clipboard?.writeText(artifact) ?? Promise.reject(new Error("clipboard unavailable"));
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
				<span class="muted small" role="status">
					{copy === "copied" ? "已复制" : copy === "failed" ? "复制失败，请在下面手动选中" : ""}
				</span>
			</div>
			<details>
				<summary class="small">查看 HTML</summary>
				<pre class="prompt html-source" data-testid="html-source">
					{artifact}
				</pre>
			</details>
			<Modal open={playing} onClose={() => setPlaying(false)} title="播放动画">
				<AnimationFrame artifact={artifact} />
			</Modal>
		</>
	);
}

// No verdict: the user judges the page by playing it, so only a failed call gets a state badge.
function HtmlResult({ result, protocol, effort, prompt }: Done) {
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
						<dt>推理 token 数</dt>
						<dd class="num">{result.response.reasoningTokens ?? "—"}</dd>
						<dt>题面</dt>
						<dd data-testid="html-shown-prompt">{prompt}</dd>
					</dl>
					{result.response.artifact && <ArtifactActions artifact={result.response.artifact} />}
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
	const [prompt, setPrompt] = useState("");
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const [formError, setFormError] = useState("");
	const keyInput = useRef<HTMLInputElement>(null);
	const ctrl = useRef<AbortController | null>(null);
	const target = { site: site.trim(), key };

	const send = async () => {
		const missing = missingFields(target, model);
		if (missing.length > 0) return setFormError(`请填写${missing.join("、")}`);
		const length = codePoints(prompt);
		if (length > MAX_CUSTOM_PROMPT) return setFormError(`题面最多 ${MAX_CUSTOM_PROMPT} 个字符，现在 ${length} 个`);
		setFormError("");
		const controller = new AbortController();
		ctrl.current = controller;
		const source: HtmlSource = prompt.trim() === "" ? { seed: crypto.getRandomValues(new Uint32Array(1))[0] } : { prompt };
		setStatus({ kind: "sending" });
		try {
			const outcome = await probeHtml(target, model.trim(), protocol, effort || null, source, controller.signal);
			const shown = "seed" in source ? generatePelican(source.seed) : source.prompt;
			setStatus({ kind: "done", result: customResult(outcome), protocol, effort, prompt: shown });
		} catch (err) {
			if (!controller.signal.aborted) throw err;
			setStatus({ kind: "cancelled" });
		}
	};

	return (
		<section class="panel" aria-labelledby="html-h">
			<h2 id="html-h">HTML 生成</h2>
			<p class="muted small">
				让模型直接写一个 HTML 页面，在沙箱里播放，由你看效果判断，本站不判对错。题面留空时，随机让模型用 SVG
				画一种动物骑一种交通工具的 2D 动画；也可以写自己的题面，不要在题面里写密钥。只调用一次站点，不计入分关，不进历史，刷新页面即失。密钥不保存，只在这次调用时转发给站点。
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
				<label class="field col-12">
					<span class="field-label">题面（可选）</span>
					{/* Uncontrolled like the custom question's prompt: no value prop, so the text never becomes a DOM attribute. */}
					<textarea
						rows={3}
						spellcheck={false}
						placeholder="留空时随机出题：用 SVG 画动物骑交通工具的 2D 动画"
						onInput={(e) => setPrompt(e.currentTarget.value)}
						data-testid="html-prompt"
					/>
					<span class="muted small num" data-testid="html-prompt-count">
						{codePoints(prompt)}/{MAX_CUSTOM_PROMPT}
					</span>
				</label>
				{/* From 720px up the button sits beside the model field, where the open model list cannot cover it. */}
				<ModelField value={model} onInput={setModel} target={target} testId="html-model" class="col-12 col-md-6 col-lg-4" />
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
					{status.kind === "sending" && <span class="muted small">生成中，最长等 5 分钟…</span>}
				</div>
				{formError && (
					<p class="field-error" role="alert" data-testid="html-form-error">
						{formError}
					</p>
				)}
			</form>
			<div aria-live="polite">
				{status.kind === "cancelled" && <p class="warn">已取消。</p>}
				{status.kind === "done" && <HtmlResult result={status.result} protocol={status.protocol} effort={status.effort} prompt={status.prompt} />}
			</div>
		</section>
	);
}
