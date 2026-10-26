import { MAX_ATTEMPTS, STAGES } from "../shared/ladder.ts";
import { CONCURRENCY } from "./runner.ts";

const CURL = `curl -s https://gpt.ziikoo.app/api/probe \\
  -H 'Content-Type: application/json' \\
  -d '{"site":"https://example.com","key":"sk-...","protocol":"responses",
       "model":"gpt-6-astra","question":"thibault",
       "runId":"<uuid>","stage":1,"seq":1,"attempt":1}'`;

export function ApiDocs() {
	return (
		<details class="block docs col-12" id="api-docs" data-testid="api-docs">
			<summary>
				<h2>API 说明</h2>
				<span class="muted small">接口约定、分关规则、curl 示例、限额</span>
			</summary>
			<h3>接口约定</h3>
			<ul>
				<li>
					<code>GET /api/questions</code>：题目清单，含题面。
				</li>
				<li>
					<code>POST /api/probe</code>：请求体 <code>{"{ site, key, protocol, model, question, effort?, runId?, stage?, seq?, attempt?, seed?, progress? }"}</code>
					。一次调用一道题。<code>effort</code> 可选 low、medium、high、xhigh。带 <code>runId</code> 时必须同时带 <code>stage</code> 与 <code>seq</code>，结果才保存。
				</li>
				<li>
					生成题（<code>candy-var</code> 与 <code>pelican-svg</code>）按 <code>seed</code> 出题。同一轮的所有调用用同一个 <code>seed</code>，不带 <code>seed</code> 时用示例 seed 0。
				</li>
				<li>站点自身的失败返回 200 加 <code>ok:false</code> 与 <code>reason</code>；参数不合法返回 400；本站限流或超出每轮调用上限返回 429。</li>
				<li>
					请求体加 <code>progress: true</code> 时，200 响应改为每行一个 JSON：先是 <code>{"{ type: \"start\", timeoutMs }"}</code>，站点响应后每半秒最多一行{" "}
					<code>{"{ type: \"progress\", chars }"}</code>（已收到的回答字符数），最后一行 <code>{"{ type: \"result\", response }"}</code>，<code>response</code>{" "}
					与不带这个字段时的响应体相同。
				</li>
				<li>
					<code>POST /api/history</code>、<code>/api/history/raw</code>、<code>/api/history/delete</code>：请求体带同一站点与密钥。密钥只放请求体，不放请求头和 URL。
				</li>
				<li>
					<code>POST /api/watch</code>、<code>/api/watch/view</code>、<code>/api/watch/state</code>、<code>/api/watch/delete</code>：持续监测的建立、读取、暂停与删除，凭建立时签发的随机令牌，供页面使用。
					<code>POST /api/board/view</code>、<code>/api/board/adopt</code>、<code>/api/board/move</code>：看板的批量读取、旧令牌迁移与合并，凭看板码。
				</li>
				<li>不提供跨域头，第三方网页不能调用，脚本与命令行不受影响。</li>
			</ul>
			<h3>分关规则</h3>
			<ul>
				<li>
					每道题单独分关：各关的调用数是 {STAGES.map((s) => s.calls).join("、")}，通过所需的答对数是{" "}
					{STAGES.map((s) => s.need).join("、")}。任何一关未通过，该题停止。
				</li>
				<li>每关内同时发 {CONCURRENCY} 个调用。某关已不可能通过时，立即停止该关剩余调用。</li>
				<li>单次调用最多尝试 {MAX_ATTEMPTS} 次，连续 {MAX_ATTEMPTS} 次没有有效响应判「无法测试」。</li>
				<li>协议是站点接口的格式，有 responses、chat 与 anthropic 三种。第 1 关两种协议各调用一次，用返回有效答案的那种；都有效时用第一种。模型名含 claude 时比 anthropic 与 chat，否则比 responses 与 chat。</li>
				<li>分关的循环由调用方负责，脚本按上述规则自己驱动。</li>
			</ul>
			<h3>curl 示例</h3>
			<pre class="code">{CURL}</pre>
			<h3>限额</h3>
			<ul>
				<li>每个调用方 IP 每 60 秒 150 次，每个站点每 60 秒 120 次。超出返回 429 并带 Retry-After。</li>
				<li>每轮最多 200 次调用。回答只返回前 70 字，完整内容在历史原始数据里。</li>
				<li>每次调用读取站点响应最多 256KB，等待最多 120 秒。不带 <code>runId</code> 的 <code>pelican-svg</code> 调用是 2MB 与 300 秒。</li>
				<li>每个站点与密钥保存最近 10 轮，闲置 90 天后自动删除。</li>
			</ul>
		</details>
	);
}
