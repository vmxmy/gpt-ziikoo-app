# 技术架构

产品行为见 [`design.md`](design.md)。本文只写平台选型、部署与运维。依据是 2026-10-18 查阅的 Cloudflare 官方文档,凡未核实的内容在末尾列出。

## 工具链决定

主应用使用 Void(`void@1.11.0`)加 `void.config.ts` 与 `void.lock.json`,直连部署到自有 Cloudflare 账号(`void deploy --platform cloudflare`),不使用 Void Platform。这是维护者在 2026-11-24 授权的试点迁移决定(独立子应用 `mock/` 仍保留原 `cf` 配置)。

约束:

- Node.js 24.22 或更高。
- `void` 内部调用 `cf` 执行部署与版本管理,配置写在 `void.config.ts`,资源 ID 与 Durable Object 迁移历史由 `void.lock.json` 锁定。
- `.void/`、`.void-wrangler.jsonc`、`.cloudflare/` 存放生成物与构建输出,加入 `.gitignore`;`void.lock.json` 必须提交,不得删除或重排已部署的迁移步骤。
- `package.json` 设置 `"type": "module"`。
- 脚本用 `vite`(本地开发)、`vite build`、`void deploy --platform cloudflare`、`void prepare` 与 `void info`。
- 每次升级 `void` 前,必须审计其运行时错误日志与注入的 `/__void/*` 端点。

## 选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 托管 | Workers 加 Static Assets,自定义域 `gpt.ziikoo.app` | 官方最佳实践写明新项目用 Workers 而不是 Pages |
| 命令行与配置 | `void` 加 `void.config.ts`、`void.lock.json` | 2026-11-24 维护者授权试点迁移;支持就绪检查与 `void project rollback` |
| 构建 | Vite 加 `voidPlugin()` 与 `@preact/preset-vite` | SPA + API 模式,前端仍用 Preact,题面用 `?raw` 导入 |
| 语言 | TypeScript 严格模式 | 题库清单与接口形状固定,类型挡住非法状态 |
| Worker 路由 | Void 文件路由(`routes/api/**`,底层 Hono)加兜底 404/405 | 保持 `public/api.md` 的 JSON 错误契约与流式透传 |
| 请求校验 | 手写解析函数,边界处一次解析成类型 | 字段少,不经过第三方表单解析器 |
| 页面渲染 | Preact | JSX 默认转义,站点返回的不可信文本不会变成 HTML |
| 样式 | 一份手写 CSS,颜色用令牌,`prefers-color-scheme` 做深色 | 单页不需要组件库 |
| 存储 | Durable Objects SQLite,每 [站点 × 密钥] 对象一实例 | 通过 `durable-objects/*.ts` 的 `defineDurableObject` 包装原生 DO 类 |
| 类型 | `void prepare` 生成 `.void/` 类型,配合 `src/worker/env.d.ts` | 保持 worker 与 web 两套 tsconfig 严格检查 |
| 测试 | Vitest。纯函数加带假 `fetch` 的处理器测试 | DO 薄壳用 `void dev` 与线上 e2e 覆盖 |
| 包管理 | pnpm | 与主项目一致 |

不选:Pages Functions(新功能集中在 Workers)、Node 或 Fastify 加 VPS(要自己运维)、Next.js(单页太重)、Hono(路由太少)、Turnstile(接口要匿名可调,脚本过不了验证码)、D1 加 R2(见下)、Workers Builds 部署(官方文档给出的默认命令是 `wrangler deploy`,没有查到它对 `cf deploy` 的支持,见「发布」)。

## 存储

| 方案 | 结论 |
| --- | --- |
| DO SQLite,每对象一实例 | **采用。** 单对象 10GB 上限。「保留最近 10 轮」是一条删除语句。标识由密钥派生,没有可枚举的全局表。付费套餐含 5GB·月,超出 $0.20/GB·月。读写行数含量远高于预期用量。官方的 Durable Objects 规则也要求沿着自然边界分片,不要做全局单例,本设计每个对象一个实例,符合 |
| D1 加 R2 | 不采用。D1 存储 $0.75/GB·月。原始数据放 R2 多一个系统,主项目实测 R2 单对象读取约 560ms |

代价是跨对象的全局统计做不了。需要时再加一条旁路写入,首期不做。

计费要点,来自官方定价页。删除计入写入行数。每次设置闹钟计一行写入。数据在删除之前一直计费,删除后对象被系统自动清理。

DO 类用配置里的 `exports` 声明存储引擎,例如 `exports.durableObject({ storage: "sqlite" })`。它取代了 Wrangler 的有序 `migrations` 历史。同一个 Worker 内可以通过 `ctx.exports` 直接访问自己导出的 DO 类,不需要 `env` 绑定。

## 请求分层

```
请求 → WAF 限速(Free zone 只有 1 条规则,10 秒窗口,按 IP,当洪水闸)
     → Worker(Void 因 public/_headers 将 run_worker_first 设为 ["/**"],全部路径先进 Worker)
          ├ 非 /api/* 路径: 经 Void headerMiddleware 附加主站 CSP 后由 ASSETS 静态资源返回
          └ /api/* 路径:
               ├ 解析与校验请求体
               ├ 限速绑定(键 = 调用方 IP,60 秒;键 = 目标主机,60 秒)
               ├ 代发,流式读取并计字节与计时,256KB 上限,120 秒超时
               │ (不带 runId 的 HTML 题:8MB,900 秒)
               ├ 评分
               └ 带 runId 则写入对象(DO),写入前脱敏
```

架构权衡(2026-11-24 迁移引入):原 `cf` 配置用 `runWorkerFirst: ["/api/*"]`,静态资源不唤醒 Worker。Void 在存在响应头规则时强制 `run_worker_first: ["/**"]`,因此静态页面可用性耦合到 Worker 运行时,且针对首页的突发流量也会消耗 Worker 调用额度(Worker 内部限速绑定仍只覆盖 `/api/*`)。本站目前仅维护者自用,在试点评估中将其作为显式权衡项跟踪。

## 暴露面

- `workers.dev` 与预览地址必须关闭。Worker 默认还挂在 `workers.dev` 上,从那里进来的请求绕过按 zone 生效的 WAF 限速。官方说明 `cf workers triggers deploy` 会应用路由、自定义域和 `workers.dev` 开关,所以这些写在配置的 `triggers` 里,具体字段名实现时读配置参考页。
- 页面的 CSP 等响应头写在 `_headers`。`_headers` 只作用于静态资源响应,不作用于 Worker 生成的响应,所以 `/api/*` 的响应头要在代码里设。
- 不提供跨域头。

## 配置

实际配置写在仓库根目录的 `void.config.ts`、`env.ts`、`durable-objects/*.ts` 与 `void.lock.json`,以它们为准。构建产物 `dist/*/wrangler.json` 能看到工具链实际生成的 Cloudflare 配置:

- `workers_dev: false`、`preview_urls: false`、`routes`、`ratelimits`、`observability` 写在 `void.config.ts` 的 `cloudflare` 字段。
- `inference.bindings` 显式关闭 `db`、`kv`、`storage`、`ai` 的自动推断。
- Durable Object 通过 `durable-objects/{target,watch,watch-registry,board}.ts` 里的 `defineDurableObject` 包装原生类,绑定名为 `TARGET`、`WATCH`、`WATCH_REGISTRY`、`BOARD`,导出类名为 `<Name>DurableObject`,SQLite 迁移历史记录在 `void.lock.json`。
- 秘密在 `env.ts` 里用 `defineEnv({ PEPPER: string(), WATCH_ENC_KEY: string() })` 声明,由 `void secret put <NAME>` 写入(值走交互输入或 stdin,不进命令行参数、不落文件)。

## 目录

```
void.config.ts             Worker 与 Cloudflare 透传配置
void.lock.json             资源 ID 与 DO 迁移历史锁文件(提交入库)
env.ts                     服务端秘密声明
vite.config.ts             Preact + voidPlugin()
durable-objects/           Target / Watch / WatchRegistry / Board 的 DO 包装
routes/api/                Void 文件路由与 /api/* 404/405 兜底
questions/<id>/meta.json   清单字段,不含题面
questions/<id>/prompt.txt  题面原文,含制表符,以 ?raw 导入
questions/index.ts         显式登记所有题,不扫目录
src/shared/                类型、一轮结论的共享计算函数
src/worker/                处理器、probe、评分器表、目标地址校验、脱敏、DO 原生类
src/web/                   页面、梯度引擎(纯函数)
public/_headers            页面 CSP 与 /api/*、/api/frame 响应头覆盖规则
public/api.md              对外的 API 说明,线上地址 /api.md
test/
.void/ .cloudflare/ dist/  构建输出与生成的类型,不入库
```

题面单独存成文本文件,避免编辑器把制表符改成空格。「展示给用户」和「实际发出」读同一个文件。完整性测试断言目录与登记一致。

## 可观测性

- Workers Logs 开启,调用日志关闭。每次探针写一条结构化日志,字段见 `design.md` 的「安全边界」。
- 官方文档说明请求头会被捕获。密钥只放请求体。
- 追踪默认关,开启则低采样。文档写明从 2026-12-01 起追踪计入用量计费。
- `void project logs` 提供实时日志 tail。
- 限速绑定在控制台里不可见。官方建议用 Workers Logs 观察 Worker 返回的 429,或在被限速时往 Analytics Engine 写事件。首期用日志。

## 发布

| 事件 | 动作 |
| --- | --- |
| PR | 类型检查(`void prepare` + `tsc`)、Vitest、`vite build`、`void info`。`void info` 为纯离线检查,不需要凭证,来自 fork 的 PR 也能跑 |
| 部署 | 维护者在本机运行 `pnpm deploy`(`void deploy --platform cloudflare`),部署前审阅生成的配置并提交变更的 `void.lock.json` |
| 回滚 | `void project status` 查看版本,`void project rollback [version]` 回滚代码与触发器 |

实际状态(2026-11-24):`.github/workflows/ci.yml` 作为 PR 门禁(类型检查、测试、构建、`void info`)。main 自动部署暂未启用,由维护者在本机执行部署。

## 测试

- 纯函数(评分器、目标地址校验、脱敏、对象标识、梯度引擎、一轮结论计算)用 Vitest 在 Node 里测。
- 保留最近 10 轮与闲置清空,把「删什么」写成纯函数测,DO 本身只留薄壳。
- DO 薄壳与路由响应头用 `pnpm dev`(`vite`)加本地 HTTP 冒烟与线上 e2e 覆盖。

## 已部署资源与运维

| 资源 | 说明 |
| --- | --- |
| Worker `gpt-ziikoo-void` | Void 迁移后的生产 Worker,自定义域 `gpt.ziikoo.app`,`workers_dev` 与 `preview_urls` 关闭 |
| Worker `gpt-ziikoo-app` | 原 `cf` Worker(切换自定义域后保留一周作为回滚备份,确认稳定后删除) |
| Durable Object `TargetDurableObject` (`TARGET`) | 每 [站点 × 密钥] 对象一实例,存最近 10 轮 |
| Durable Object `WatchDurableObject` / `WatchRegistryDurableObject` | 每个持续监测一实例,存加密密钥与 24 小时样本;Registry 是名为 `global` 的单例,只存上限计数行 |
| Durable Object `BoardDurableObject` (`BOARD`) | 每个看板一实例,存看板码加密的令牌列表,最多 30 个。闲置 7 天 alarm 清除 |
| Worker `gpt-ziikoo-mock-relay` | e2e 用的 mock 中转站,`https://gpt-ziikoo-mock-relay.blueyang.workers.dev`,不绑域名。任何人都能访问,它不存任何东西。Gemini 协议走 `/v1beta/models/{model}:streamGenerateContent`,密钥只认 `x-goog-api-key`,URL 带 `?key=` 时回 400;模型 `mock-gemini` 用来触发表单的 `gemini` 默认值 |
| 秘密 `PEPPER` | 备份在维护者本机 `~/.config/gpt-ziikoo-app/`,权限 0600。**不可轮换**:换掉它会让全部历史对象失联 |
| 秘密 `WATCH_ENC_KEY` | `Watch` 对象里密钥的 AES-GCM 加密密钥(取 SHA-256 后使用)。**不可轮换**:换掉它会让全部持续监测的密钥失联 |

日常部署:

```sh
git checkout main && git pull --ff-only
pnpm deploy
```

跑线上 e2e(需要先 `pnpm exec playwright install chromium`):

```sh
BASE_URL=https://gpt.ziikoo.app MOCK_URL=https://gpt-ziikoo-mock-relay.blueyang.workers.dev pnpm e2e
```

e2e 满跑一次约 62 次调用,会撞 IP 每分钟 150 次的限速,页面会按 `Retry-After` 等待后继续,所以单次完整运行约 4 到 5 分钟。

最近一次全量线上 e2e(2026-10-25,`gpt.ziikoo.app` 加 mock 中转站,鹈鹕 SVG 动画题与页面布局四批优化上线之后):49 个用例,分两次跑完。第一次 36 通过,1 个重试后通过,2 失败,9 个因 `run.spec.ts` 的串行组在首个失败后整组跳过,1 个按设计跳过(只在手机项目运行的用例在桌面项目里跳过),运行约 12.1 分钟。两个失败分别是 mock 中转站不认识鹈鹕题面(回「OK」,评分四项全缺)与迁移用例在进站点之前就写 `localStorage`(about:blank 是不透明源,Chromium 抛 SecurityError);修复在 #50。mock 重新部署后重跑 `run.spec.ts` 整文件 10 通过,迁移用例 1 通过,约 7.5 分钟。线上 e2e 抓到过四处只有真实环境才暴露的缺陷:短答案首字时延、Cloudflare 注入统计脚本、添加站点表单没等题目加载、新题落地没同步 mock 中转站。新题落地时要同步改 `mock/src/index.ts` 的 `topicOf` 与 `ANSWERS`,并在 `mock/` 目录里重新部署。

两个坑:

- 维护者的全局 gitignore 有一条 `*.gitignore`,会把 `.gitignore` 自己也忽略。新增或修改 `.gitignore` 必须 `git add -f`。干净的 worktree 里没有它,构建产物会显示为未跟踪。
- 本机另有会话也在用开发服务器,代理不要使用 `pkill` 或 `killall`。

## P0 核查结果

2026-10-18 用 `cf`(1.0.0-beta.18)以只读命令核查,全部通过,没有改动任何设置。

| 项 | 结果 |
| --- | --- |
| 账号 | `ziikoo.app` 与 `ziikoo.com` 在同一个账号下,账号类型为标准 |
| 套餐 | `ziikoo.app` 为 Free,状态 active |
| Bot Fight Mode | 关闭(`fight_mode: false`),JavaScript 检测也关闭。匿名脚本不会被质询,无需改动 |
| 边缘限速规则 | 该 zone 没有限速规则集。Free 只允许 1 条,这个名额是空的 |
| 自定义 WAF 规则 | 没有 |
| `gpt` 的 DNS 记录 | 不存在,自定义域部署时会新建 |
| 该 zone 的其他内容 | 还有其他走代理的站点。Bot Fight Mode 是全区设置,以后任何人打开它,都会同时影响本站的匿名 API,改动前必须想到这一点 |

核查命令:`cf zones list`、`cf bot-management get --zone`、`cf rulesets entrypoint get <phase> --zone`、`cf dns records list --zone`。

## 未核实,仍待验证

已在上线中解决:`triggers` 与 `domains` 的字段形状、限速命名空间、秘密的设置与保留、pepper 的设置与备份、`enable_ctx_exports`、流式字段在 mock 上的解析路径。

1. Free zone 的 WAF 限速规则被触发时,响应头是否带 `Retry-After`。文档只写明默认响应码 429。
2. 限速绑定在多节点下的实际放行量,以及是否需要提前引入限速 Durable Object。
3. `cf previews deploy` 对带 Durable Object 的 Worker 的支持。
4. 回滚到旧版本对应的 `cf` 命令。
5. `@cloudflare/vitest-plugin` 与 `cloudflare.config.ts` 的配合。
6. `global_fetch_strictly_public` 兼容性标志的语义。
7. DO SQLite 的单行大小上限没有查到。入库行超过约 1.9MB 时代码会先丢原始数据再标截断,但真实上限未确认。
8. 流式请求的字段与选项名、缓存的前缀阈值,来自对 OpenAI 接口的了解,只在 mock 上走通,没有在真实站点上核对。`gemini` 协议的字段来自 2026-11-21 对 Google 官方文档与一个开源中转网关源码的核对,同样只在 mock 上走通。**这是最大的未验证点,需要真实站点校准。**
9. 真实站点上首字时延的表现,尤其是经过缓冲的中转站。
10. `cf` 与 `@cloudflare/vite-plugin` 都是测试版,以实现时的最新版本说明为准。
