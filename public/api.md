# gpt.ziikoo.app API 说明

本页说明 gpt.ziikoo.app 的接口，供脚本与 agent 读取。首页的「API 说明」链接到这里。

- Base URL：`https://gpt.ziikoo.app`
- 匿名使用，没有账号。
- 请求体与响应体都是 JSON，请求带 `Content-Type: application/json`。例外在各接口里注明。
- 密钥只放请求体，不放请求头和 URL。
- 站点地址只接受 `https`，拒绝 IP 字面量与 `localhost`，不跟随重定向。
- 不提供跨域头。浏览器里的第三方网页不能调用，脚本与命令行不受影响。

## 接口一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/questions` | 题目清单 |
| POST | `/api/probe` | 用一道题调用站点一次 |
| POST | `/api/models` | 读取站点的模型列表 |
| POST | `/api/claude-case` | 执行一个服务端固定的 Claude 专项用例 |
| POST | `/api/history` | 读取最近几轮的判定与指标 |
| POST | `/api/history/raw` | 读取一轮全部调用的原始数据 |
| POST | `/api/history/delete` | 删除这个站点与密钥的全部历史 |
| POST | `/api/watch` | 建立持续监测 |
| POST | `/api/watch/view` | 读取一个持续监测 |
| POST | `/api/watch/state` | 暂停或继续持续监测 |
| POST | `/api/watch/update` | 修改持续监测的题目与间隔 |
| POST | `/api/watch/delete` | 删除持续监测 |
| POST | `/api/board/view` | 读取看板里的全部持续监测 |
| POST | `/api/board/adopt` | 把旧令牌迁移进看板 |
| POST | `/api/board/move` | 合并看板 |
| POST | `/api/board/order` | 保存看板里的顺序 |
| GET | `/api/frame` | 「播放动画」用的沙箱宿主页，供页面使用，脚本不需要调用 |

## POST /api/claude-case

请求体为 `{ "site": "https://api.example.com", "key": "调用方密钥", "model": "claude-sonnet-4-6", "case": "C1" }`。站点、密钥、模型的校验同 `/api/probe`；`case` 只接受 C1 到 C10、P1 到 P3。调用方不能修改题面、工具或其他上游参数。

协议固定为 Anthropic，仅访问 `POST /v1/messages`、`POST /v1/messages/count_tokens`、`GET /v1/models`，禁止跟随重定向。先过 IP 限速，每次上游调用前再过站点限速，任一步被限速返回 429。结果不落库，不进入历史或持续监测。

| 用例 | 请求与通过条件 |
| --- | --- |
| C1 | 非流式要求只回答 OK，`max_tokens=32`；200 且有 `type=message`、`content`、`usage` |
| C2 | 三次流式请求，每次 200 且依次收到 `message_start`、`text_delta`、`message_stop`；note 记录三次首字耗时 |
| C3 | 固定 8×8 纯红 PNG，200 且回答含 red |
| C4 | `output_config.format` 指定 name、age 的 JSON Schema，200 且回答严格等于 `{"name":"Alice","age":30}` |
| C5 | 强制调用 get_weather；模型名含 `opus-5-5` 或 `sonnet-5-5` 时应返回 400，其余 200 |
| C6 | 先调 get_weather，再回传 tool_result；两轮 200，第一轮有 tool_use |
| C7 | `thinking.type=disabled`，状态码条件同 C5 |
| C8 | adaptive thinking 取得签名后原样回传应为 200，改一个字符再回传应为 4xx |
| C9 | 本轮随机 long-prefix 加 cache_control 连发五次，第 2 到 5 次新鲜缓存命中率均至少 90%；note 同时列出站点报的 cache_read |
| C10 | 先发一次与 C1 相同的 `/v1/messages` 取消息来源，再调 `/v1/messages/count_tokens`；结论只看 count_tokens：200 且 input_tokens 大于 0 为通过，404 记 gap，note 写「中转未暴露同路径」；消息来源为 bedrock 时加「无法测 Mantle」 |
| P1 | 模型列表包含目标模型 |
| P2 | 故意缺 max_tokens，返回 4xx 且 request-id 以 req_ 开头或 JSON 含 request_id 字段 |
| P3 | 恒为 untested，note 写「批量接口会创建异步任务并计费，本站不测」，不发上游请求 |

响应为 `{ id, verdict, note, preview, source, calls }`，用例判定返回 HTTP 200；`verdict` 是 `pass`、`fail`、`gap`、`untested` 之一。`preview` 在脱敏后只保留前 70 字，或为 null。`source` 仅为 anthropic、bedrock、vertex、other 或 null，按消息 id 的 `msg_01`、`msg_bdrk_`、`msg_vrtx_` 前缀分类，不返回消息 id。

`calls` 每项为 `{ status, requestId, ms }`。状态码、请求标识可为 null，耗时单位毫秒；请求标识仅接受 `^[A-Za-z0-9_-]{1,128}$`，包含密钥时同样不返回。响应不包含完整回答、原始响应或签名。日志只含主机名、用例 id、结论、状态码、延迟。

## 错误

站点自身的失败返回 200 加 `ok: false`，见 `/api/probe`。调用方由此区分「站点出问题」与「本站出问题」。

本站的错误返回下面的 JSON：

```json
{ "error": "bad_request", "message": "带 runId 时必须同时给出 stage 与 seq" }
```

| HTTP | `error` | 含义 |
| --- | --- | --- |
| 400 | `bad_request` | 参数不合法或地址被拒。`message` 说明是哪个字段 |
| 404 | `not_found` | 未知接口，或持续监测、看板不存在或已过期 |
| 405 | `bad_request` | 方法不对。响应头 `Allow` 给出可用方法 |
| 409 | `stale` | 看板已变化，只出现在 `/api/board/order` |
| 429 | `rate_limited` | 本站限速。带 `Retry-After` 头与 `retryAfterSec` 字段 |
| 429 | `too_many_calls` | 这一轮的调用已满，不带 `Retry-After` |
| 429 | `watch_limit` | 持续监测已满 |

## GET /api/questions

返回题目数组，只含在用的题。每道题的字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 题 id，`/api/probe` 的 `question` 填它 |
| `version` | 题面或评分一变就加 1 |
| `status` | 固定是 `active` |
| `title`、`measures`、`failureHint` | 标题、测什么、答错说明什么 |
| `kind` | `knowledge`、`reasoning` 或 `metrics`。`metrics` 题只用于测量，不评分，`correct` 是 `null` |
| `prompt` | 题面。生成题的题面是 seed 0 的示例 |
| `expectedLabel` | 期望答案的说明 |
| `calibratedModels` | 校准过的模型 |
| `defaultEffort` | 可省。这道题默认的推理强度 |
| `generator` | 可省。有它的是生成题，按 `seed` 出题 |
| `html` | 可省。为 `true` 时回答是 HTML 页面 |
| `inWatchRotation` | 可省。为 `false` 时不能选进持续监测 |

## POST /api/probe

用一道题调用站点一次，返回评分。

请求体：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `site` | 是 | 站点地址，例如 `https://example.com` |
| `key` | 是 | 站点密钥，8 到 1024 个字母、数字或 `_` `.` `-` |
| `protocol` | 是 | `responses`、`chat` 或 `anthropic`，分别对应站点的 `/v1/responses`、`/v1/chat/completions`、`/v1/messages` |
| `model` | 是 | 1 到 100 个字符 |
| `question` | 二选一 | 题库的题 id |
| `custom` | 二选一 | 自定义题，见下 |
| `effort` | 否 | `low`、`medium`、`high` 或 `xhigh`。不带时用题目的 `defaultEffort`；`anthropic` 协议不带时不设推理强度 |
| `runId` | 否 | UUID。带它结果才保存进历史，同时必须带 `stage` 与 `seq` |
| `stage` | 带 `runId` 时必填 | 关卡号，1 到 4 |
| `seq` | 带 `runId` 时必填 | 关内序号，1 到 15 |
| `attempt` | 否 | 同一 `seq` 的第几次尝试，1 到 3，默认 1 |
| `seed` | 否 | 0 到 4294967295 的整数，默认 0。只对生成题生效 |
| `progress` | 否 | `true` 时按行返回进度，见下。默认 `false` |

自定义题：

```json
{ "prompt": "题面，1 到 2000 个码位",
  "scorer": { "type": "yes_no", "expected": "YES" } }
```

- `scorer` 是 `{ "type": "yes_no", "expected": "YES" | "NO" }` 或 `{ "type": "contains", "expected": "1 到 500 个码位，区分大小写" }`。
- 带 `custom` 时不能带 `question`、`runId`、`seed`。
- 自定义题不保存，不进历史。响应的 `questionVersion` 是 0。

站点答出时返回 200：

```json
{ "ok": true, "questionVersion": 1, "correct": true, "note": "YES",
  "reasoningTokens": 192, "outputTokens": 211, "idShape": "hex",
  "answer": "Yes, I know who Thibault Sottiaux is.",
  "streamed": true, "ttfbMs": 79, "ttftMs": 156, "totalMs": 156,
  "promptTokens": 40, "cachedTokens": 0 }
```

| 字段 | 含义 |
| --- | --- |
| `correct` | `true` 答对，`false` 答错 |
| `note` | 评分说明，例如抽出的答案 |
| `answer` | 回答的前 70 个字符。带 `runId` 的调用，完整回答在 `/api/history/raw` |
| `reasoningTokens`、`outputTokens`、`promptTokens`、`cachedTokens` | 用量。`outputTokens` 含推理 token。站点没返回的字段是 `null` |
| `idShape` | 响应 id 的形状：`hex`、`ft`、`base64` 或 `other` |
| `streamed` | 站点是否按流式返回 |
| `ttfbMs`、`ttftMs`、`totalMs` | 首字节、首字、总耗时，单位毫秒 |
| `artifact` | 只在 HTML 题、且回答里有 HTML 页面时出现：`{ "html", "ending" }`，`ending` 是 `closed`、`unclosed` 或 `truncated`。只供当次使用，不保存 |

站点失败时也返回 200：

```json
{ "ok": false, "reason": "unauthorized", "httpStatus": 401 }
```

`reason` 是 `unauthorized`、`forbidden`、`not_found`、`rate_limited`、`upstream_error`、`timeout` 或 `bad_response`。`httpStatus` 是站点的状态码，没有时是 `null`。

### progress: true

200 响应改为 `application/x-ndjson`，每行一个 JSON：

```
{"type":"start","timeoutMs":120000}
{"type":"progress","chars":0,"reasoning":false}
{"type":"result","response":{ ... }}
```

1. `start` 立即发出。`timeoutMs` 是本次调用的超时。
2. 站点开始响应时发一行 `progress`。之后每收到站点数据，包括心跳，每半秒最多发一行。`chars` 是已收到的回答字符数。`reasoning` 在站点开始推理后为 `true`。
3. 最后一行是 `result`。`response` 与不带 `progress` 时的响应体相同。

400 与 429 仍是普通 JSON。

## POST /api/models

请求体 `{ "site", "key" }`。本站请求站点的 `GET /v1/models`，只返回模型 id：

```json
{ "ok": true, "models": ["gpt-6-astra"] }
```

模型按站点给的顺序去重，最多 500 条。站点失败时返回 200 加 `{ "ok": false, "reason", "httpStatus" }`，`reason` 同 `/api/probe`。结果不保存。

## 历史

读取与删除历史必须给出同一站点与同一密钥。没有记录与记录为空返回相同结果。

| 接口 | 请求体 | 返回 |
| --- | --- | --- |
| `/api/history` | `{ "site", "key" }` | `{ "runs": [RunView] }`，最近 10 轮 |
| `/api/history/raw` | `{ "site", "key", "runId" }` | `{ "calls": [RawCall] }`，这一轮的全部调用 |
| `/api/history/delete` | `{ "site", "key" }` | `{ "deleted": true }` |

`RunView`：

```
{ runId, startedAt, model, protocol,
  overall: "all_passed" | "partial" | "failed" | "unavailable" | "incomplete",
  questions: [{ id, version,
                verdict: { status: "passed" | "failed" | "unavailable" | "incomplete",
                           stage, correct, total, stages: [...] } | null,
                metrics: { calls, validCalls, totalMs, ttfbMs, ttftMs, cacheHitRate } }] }
```

`totalMs`、`ttfbMs`、`ttftMs` 是 `{ min, p50, p95, max }` 或 `null`。

`RawCall` 含调用参数（`runId`、`questionId`、`stage`、`seq`、`attempt`、`protocol`、`model`、`effort`、`seed`）、评分结果（`ok`、`reason`、`correct`、`note`）、用量与耗时，以及 `answer`（完整回答）、`usage`、`rawHeaders`、`rawBody`、`rawEvents`（站点原始响应）。

## 分关规则

一轮测试由调用方驱动。下面是首页的做法，脚本照做，服务端就能给出相同的判定。

每道题单独分关。4 关的调用数依次是 1、5、10、15，通过所需的答对数依次是 1、4、9、14。

1. 用 `GET /api/questions` 选题 id。
2. 生成一个 UUID 作 `runId`，生成一个 0 到 4294967295 的整数作 `seed`。本轮所有调用用同一个 `runId` 与 `seed`。
3. 选协议。模型名含 `claude`（不分大小写）时比较 `anthropic` 与 `chat`，否则比较 `responses` 与 `chat`。
4. 用第一道题的 `stage: 1, seq: 1` 同时调用两个协议。返回 `ok: true` 的协议胜出；两个都是 `ok: true` 时前一个胜出。两个都不是时，`attempt` 加 1 再比，最多 3 次。这次调用就是第一道题第 1 关的结果。
5. 之后的调用都用胜出的协议。不同的题可以并行。
6. 每道题从第 1 关开始。第 n 关的 `seq` 从 1 到这关的调用数，同时最多 4 个调用。
7. 每个 `seq` 从 `attempt: 1` 开始。响应是 `ok: false` 时，用同一 `stage` 与 `seq` 把 `attempt` 加 1 再发，最多尝试 3 次。
8. 第一个 `ok: true` 的响应决定这个 `seq`：`correct` 为 `true` 算答对，否则算答错。
9. 某个 `seq` 3 次都没有 `ok: true` 时，这道题判「无法测试」，停止。第一道题在步骤 4 就无法测试时，整轮停止。
10. 某关的答错数超过「调用数减答对数」时，这关不可能通过。停掉这关没发的调用，这道题判未通过。
11. 一关通过后进入下一关。4 关都通过，这道题通过。
12. 收到 429 且带 `Retry-After` 时，等这么多秒，再发同一个调用，最多等 3 次。本站在记录之前拒绝，重发不会重复计数。429 不带 `Retry-After` 时停止本轮。
13. 跑完后用 `POST /api/history` 读本轮的判定。服务端按同一套规则算出 `overall` 与每道题的 `verdict`。

## 示例

```sh
curl -s https://gpt.ziikoo.app/api/probe \
  -H 'Content-Type: application/json' \
  -d '{"site":"https://example.com","key":"sk-...","protocol":"responses",
       "model":"gpt-6-astra","question":"thibault",
       "runId":"<uuid>","stage":1,"seq":1,"attempt":1}'
```

## 持续监测

持续监测由服务端按间隔调用站点，页面关闭后继续。建立时本站用 AES-GCM 加密保存密钥，所以必须带 `consent: true`。之后只凭令牌或看板码操作，不再需要密钥。

| 接口 | 请求体 | 返回 |
| --- | --- | --- |
| `/api/watch` | `{ "site", "key", "model", "protocol", "intervalMin", "alias", "consent": true, "questions"?, "board"?, "measure"? }` | `{ "board", "token", "watch": WatchView }` |
| `/api/watch/view` | `{ "token" }` | `WatchView` |
| `/api/watch/state` | `{ "token", "action": "pause" \| "resume" }` | `WatchView` |
| `/api/watch/update` | `{ "token", "questions"?, "intervalMin"?, "measure"? }` | `WatchView`。只改给出的字段 |
| `/api/watch/delete` | `{ "token" }` | `{ "deleted": true }`。立即清除密钥与样本 |
| `/api/board/view` | `{ "board" }` | `{ "watches": [{ "token", "watch": WatchView \| null }] }`。`null` 表示这次读取失败 |
| `/api/board/adopt` | `{ "board"?, "tokens" }` | `{ "board" }`。`tokens` 最多 30 个。全部令牌无效时 `board` 是 `null` |
| `/api/board/move` | `{ "from", "into"? }` | `{ "board" }`。把 `from` 的令牌并入 `into` 并删除 `from`；不给 `into` 时新签发 |
| `/api/board/order` | `{ "board", "tokens" }` | `{ "tokens" }`。`tokens` 必须是看板现有令牌的一个排列，否则返回 409 |

- 间隔是 1、5、10、30 分钟之一。2026-10-28 之前建的监测可能是 15 分钟。
- `questions` 是非空的题 id 数组，只能含 `inWatchRotation` 不为 `false` 的题。不带时选全部。
- `alias` 是别名，最多 40 个字符，可以是空字符串。
- `token` 只在建立时返回一次，持有它就能读取、暂停、修改与删除。`board` 给了且非空时加入这个看板，否则新签发。
- 令牌无效或监测已过期时返回 404，不区分两者。7 天没有读取或操作，监测自动删除。
- 全站最多 200 个持续监测，一个看板最多 30 个，超出返回 429 `watch_limit`。
- 建立时参数不合法或站点拒绝密钥返回 400。问题出在 `site`、`key` 或 `model` 时带 `field` 指明字段。

`WatchView`：

```
{ site, host, alias, model, protocol, intervalMin, questions, createdAt, expiresAt,
  status: { kind: "running" | "paused" | "bad_key" },
  monitor: { target, intervalSec, bucketMin, generatedAt, state, uptimePct, correctPct,
             last, buckets: [48 个 30 分钟格] },
  usage: { since, calls, unmetered, promptTokens, cachedTokens, outputTokens, reasoningTokens } | null,
  perf: { checks, cacheChecks, cacheHitPct, tokensPerSec, speedSamples, lastAt, nextInRounds } | null }
```

- `usage` 是累计用量。`since` 是开始计数的时间。`calls` 是发出的调用次数，含重试。`unmetered` 是可能已扣额度但没有返回可用用量的调用次数。`outputTokens` 含 `reasoningTokens`，`promptTokens` 含 `cachedTokens`。这项上线前建的监测在跑完下一轮之前是 `null`。
- `measure` 为 `true` 时开启缓存与速度测量，默认关闭，传 `false` 时关闭并清除结果。测量约每 3 小时一次，次数由间隔算出，每次多发 2 次长调用，消耗这把密钥的额度。
- `perf` 是 24 小时内的测量结果，未开启时是 `null`。每次测量的题面开头带一个新的随机数。`cacheHitPct` 的分母是第 1 次没有缓存的输入 token 数，分子是它减去第 2 次仍没有缓存的输入 token 数（最低为 0）。站点自己加并缓存的输入不算在内。`tokensPerSec` 是回答 token 数除以首字到结束时长的中位数。`nextInRounds` 是距下次测量的轮数。这些是参考值，不参与 `state` 的判定。站点没有返回可用数据时，`cacheHitPct`、`tokensPerSec` 是 `null`。

`state` 是 `operational`、`fair`、`quality`、`degraded`、`down`、`insufficient` 或 `no_data`。

## 限额

- 每个调用方 IP 每 60 秒 150 次，所有 `POST` 接口都计入。
- 每个站点每 60 秒 120 次，`/api/probe` 与 `/api/models` 计入。
- 超出返回 429 并带 `Retry-After`。
- 每轮最多 200 次调用。
- 每次调用读取站点响应最多 256KB 与 120 秒。HTML 题不带 `runId` 时是 8MB 与 900 秒。
- 每个站点与密钥保存最近 10 轮，闲置 90 天后自动删除。
