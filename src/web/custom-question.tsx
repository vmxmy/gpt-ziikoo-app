import { useState } from "preact/hooks";
import type { Protocol } from "../shared/types.ts";
import {
	checkCustom,
	codePoints,
	customResult,
	MAX_CUSTOM_EXPECTED,
	MAX_CUSTOM_PROMPT,
	missingFields,
	probeCustom,
	type CustomDraft,
	type CustomResult,
	type Target,
} from "./api.ts";
import { ms } from "./results.ts";
import { PROTOCOLS } from "./watch.ts";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "done"; result: CustomResult; protocol: Protocol };

const EMPTY: CustomDraft = { prompt: "", scorerType: "yes_no", yesNo: "YES", contains: "" };
const SCORER_TEXT: Record<CustomDraft["scorerType"], string> = { yes_no: "回答 YES 或 NO", contains: "回答包含子串" };
const PROMPT_ERROR_ID = "custom-q-prompt-error";
const EXPECTED_ERROR_ID = "custom-q-expected-error";

function ResultView({ result, protocol }: { result: CustomResult; protocol: Protocol }) {
	return (
		<div class="custom-q-result" data-testid="custom-q-result">
			<p>
				<span class="custom-q-verdict" data-state={result.state} data-testid="custom-q-verdict">
					{result.label}
				</span>{" "}
				<span class="muted small">协议 {protocol}</span>
			</p>
			{result.state === "fail" ? (
				<p data-testid="custom-q-reason">{result.reason}</p>
			) : (
				<dl class="custom-q-fields">
					<dt>评分说明</dt>
					<dd data-testid="custom-q-note">{result.response.note}</dd>
					<dt>总耗时</dt>
					<dd class="num">{ms(result.response.totalMs)}</dd>
					<dt>推理 token 数</dt>
					<dd class="num">{result.response.reasoningTokens ?? "—"}</dd>
					<dt>回答片段</dt>
					<dd class="answer" data-testid="custom-q-answer">
						{result.response.answer}
					</dd>
				</dl>
			)}
		</div>
	);
}

function ScorerFields({ draft, error, onEdit }: { draft: CustomDraft; error: string; onEdit: (patch: Partial<CustomDraft>) => void }) {
	return (
		<div class="custom-q-scorer">
			<label class="field">
				<span class="field-label">评分规则</span>
				<select
					value={draft.scorerType}
					onChange={(e) => onEdit({ scorerType: e.currentTarget.value === "contains" ? "contains" : "yes_no", contains: "" })}
					data-testid="custom-q-scorer"
				>
					{(["yes_no", "contains"] as const).map((t) => (
						<option value={t} key={t}>
							{SCORER_TEXT[t]}
						</option>
					))}
				</select>
			</label>
			{draft.scorerType === "yes_no" ? (
				<label class="field">
					<span class="field-label">标准答案</span>
					<select value={draft.yesNo} onChange={(e) => onEdit({ yesNo: e.currentTarget.value === "NO" ? "NO" : "YES" })} data-testid="custom-q-yes-no">
						<option value="YES">YES</option>
						<option value="NO">NO</option>
					</select>
				</label>
			) : (
				<label class="field">
					<span class="field-label">子串（区分大小写，最多 {MAX_CUSTOM_EXPECTED} 个字符）</span>
					<input
						autocomplete="off"
						spellcheck={false}
						onInput={(e) => onEdit({ contains: e.currentTarget.value })}
						aria-invalid={error !== "" || undefined}
						aria-describedby={error !== "" ? EXPECTED_ERROR_ID : undefined}
						data-testid="custom-q-contains"
					/>
					{error !== "" && (
						<p class="field-error" id={EXPECTED_ERROR_ID} role="alert" data-testid="custom-q-expected-error">
							{error}
						</p>
					)}
				</label>
			)}
		</div>
	);
}

export function CustomQuestionForm({ target, model }: { target: Target; model: string }) {
	const [draft, setDraft] = useState(EMPTY);
	const [protocol, setProtocol] = useState<Protocol>("responses");
	const [status, setStatus] = useState<Status>({ kind: "idle" });
	const [formError, setFormError] = useState("");
	const check = checkCustom(draft);
	const fieldError = (field: "prompt" | "expected") => (!check.ok && check.error?.field === field ? check.error.message : "");
	const promptError = fieldError("prompt");
	const edit = (patch: Partial<CustomDraft>) => setDraft({ ...draft, ...patch });

	const send = async () => {
		if (!check.ok) return;
		const missing = missingFields(target, model);
		if (missing.length > 0) return setFormError(`请填写${missing.join("、")}`);
		setFormError("");
		setStatus({ kind: "sending" });
		const outcome = await probeCustom(target, model.trim(), protocol, check.question);
		setStatus({ kind: "done", result: customResult(outcome), protocol });
	};

	return (
		<div class="custom-q" data-testid="custom-q">
			<p class="muted small">用自己的题面和评分规则，对上面的站点调用一次。不计入分关，不进历史。不要在题面里写密钥。完整回答不保存，刷新页面即失。</p>
			<label class="field">
				<span class="field-label">题面</span>
				{/* Uncontrolled on purpose, like the contains input: no value prop, so neither becomes a DOM attribute. */}
				<textarea
					rows={5}
					spellcheck={false}
					onInput={(e) => edit({ prompt: e.currentTarget.value })}
					aria-invalid={promptError !== "" || undefined}
					aria-describedby={promptError !== "" ? PROMPT_ERROR_ID : undefined}
					data-testid="custom-q-prompt"
				/>
				<span class="muted small num" data-testid="custom-q-prompt-count">
					{codePoints(draft.prompt)}/{MAX_CUSTOM_PROMPT}
				</span>
				{promptError !== "" && (
					<p class="field-error" id={PROMPT_ERROR_ID} role="alert" data-testid="custom-q-prompt-error">
						{promptError}
					</p>
				)}
			</label>
			<ScorerFields draft={draft} error={fieldError("expected")} onEdit={edit} />
			<label class="field">
				<span class="field-label">协议</span>
				<select value={protocol} onChange={(e) => setProtocol(e.currentTarget.value === "chat" ? "chat" : "responses")} data-testid="custom-q-protocol">
					{PROTOCOLS.map((p) => (
						<option value={p} key={p}>
							{p}
						</option>
					))}
				</select>
			</label>
			{formError && (
				<p class="field-error" role="alert" data-testid="custom-q-form-error">
					{formError}
				</p>
			)}
			<div class="actions">
				<button
					type="button"
					class="btn btn-secondary"
					disabled={!check.ok || status.kind === "sending"}
					onClick={() => void send()}
					data-testid="custom-q-run"
				>
					{status.kind === "sending" ? "调用中…" : "测一次"}
				</button>
			</div>
			<div aria-live="polite">{status.kind === "done" && <ResultView result={status.result} protocol={status.protocol} />}</div>
		</div>
	);
}
