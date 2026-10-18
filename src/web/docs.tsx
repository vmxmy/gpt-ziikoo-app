import { MAX_ATTEMPTS, STAGES } from "../shared/ladder.ts";
import { CONCURRENCY } from "./runner.ts";

const CURL = `curl -s https://gpt.ziikoo.app/api/probe \\
  -H 'Content-Type: application/json' \\
  -d '{"site":"https://example.com","key":"sk-...","protocol":"responses",
       "model":"gpt-6-astra","question":"thibault",
       "runId":"<uuid>","stage":1,"seq":1,"attempt":1}'`;

export function ApiDocs() {
	return (
		<details class="block docs col-12 col-md-6" id="api-docs" data-testid="api-docs">
			<summary>
				<h2>API 说明</h2>
				<span class="muted small">接口约定、梯度规则、curl 示例、限额</span>
			</summary>
			<h3>接口约定</h3>
			<ul>
				<li>
					<code>GET /api/questions</code>：题目清单，含题面。
				</li>
				<li>
					<code>POST /api/probe</code>：请求体 <code>{"{ site, key, protocol, model, question, effort?, runId?, stage?, seq?, attempt? }"}</code>
					。一次调用一道固定题。带 <code>runId</code> 时必须同时带 <code>stage</code> 与 <code>seq</code>，结果才保存。
				</li>
				<li>站点自身的失败返回 200 加 <code>ok:false</code> 与 <code>reason</code>；参数不合法返回 400；本站限流或超出每轮调用上限返回 429。</li>
				<li>
					<code>POST /api/history</code>、<code>/api/history/raw</code>、<code>/api/history/delete</code>：请求体带同一站点与密钥。密钥只放请求体，不放请求头和 URL。
				</li>
				<li>不提供跨域头，第三方网页不能调用，脚本与命令行不受影响。</li>
			</ul>
			<h3>梯度规则</h3>
			<ul>
				<li>
					每道题各跑一条独立梯度：{STAGES.map((s) => s.calls).join("、")} 次调用，晋级所需正确数{" "}
					{STAGES.map((s) => s.need).join("、")}。任何一关不达标即淘汰。
				</li>
				<li>每关内并发 {CONCURRENCY}。某关已不可能达标时立即停掉本关剩余调用。</li>
				<li>单次调用最多尝试 {MAX_ATTEMPTS} 次，连续 {MAX_ATTEMPTS} 次没有有效响应判「无法测试」。</li>
				<li>第 1 关同时用 responses 与 chat 各发一次，用返回有效答案的通道；都有效时用 responses。</li>
				<li>梯度在调用方循环，脚本按上述规则自己驱动。</li>
			</ul>
			<h3>curl 示例</h3>
			<pre class="code">{CURL}</pre>
			<h3>限额</h3>
			<ul>
				<li>每个调用方 IP 每 60 秒 150 次，每个目标站点每 60 秒 60 次。超出返回 429 并带 Retry-After。</li>
				<li>每轮最多 200 次调用。回答只返回前 70 字，完整内容在历史原始数据里。</li>
				<li>每个站点与密钥保存最近 10 轮，闲置 90 天后自动删除。</li>
			</ul>
		</details>
	);
}
