# 技术架构

产品行为见 [`design.md`](design.md)。本文只写平台选型、部署与运维。依据是 2026-10-18 查阅的 Cloudflare 官方文档,凡未核实的内容在末尾列出。

## 工具链决定

项目使用 Cloudflare 新的统一命令行 `cf`(2026-09-28 发布的测试版,本文写作时最新为 `1.0.0-beta.18`),项目配置写在 `cloudflare.config.ts`,不使用 `wrangler.jsonc`。这是维护者的决定。

官方文档对测试版的提醒:命令、配置和构建输出在稳定版之前可能变化。所以本项目承担两项成本:

1. 升级 `cf` 或 `@cloudflare/vite-plugin` 的 beta 版本时,配置可能需要跟着改。
2. 官方的最佳实践页和多数示例仍以 `wrangler.jsonc` 为准,查资料时要对照 `cf` 的「Wrangler 到 cf 对照」页。

约束:

- Node.js 22.18 或更高。Bun 不受支持,在 Bun 上加载 `cloudflare.config.ts` 的命令会失败。
- `cf` 有自己的登录,不复用 Wrangler 的登录。
- 项目把 `cf` 作为开发依赖安装,`cloudflare.config.ts` 从 `cf/config` 导入。
- `.cloudflare/` 目录存放构建输出与生成的类型,加入 `.gitignore`。
- `package.json` 设置 `"type": "module"`,否则每次加载配置都有告警。
- 脚本用 `cf dev`、`cf build`、`cf deploy`。`cf build` 直接运行 Vite,不运行 `package.json` 里的 `build` 脚本,额外步骤自己串起来,例如 `tsc -b && cf build`。

## 选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 托管 | Workers 加 Static Assets,自定义域 `gpt.ziikoo.app` | 官方最佳实践写明新项目用 Workers 而不是 Pages |
| 命令行与配置 | `cf` 加 `cloudflare.config.ts` | 维护者决定。配置是 TypeScript,绑定类型由配置推断 |
| 构建 | Vite 加 `@cloudflare/vite-plugin@beta` | 官方说明该 beta 版读取 `cloudflare.config.ts`,且没有 `configPath` 选项。选 Vite 而不是 Wrangler 打包器,因为页面本来就用 Vite,题面用 `?raw` 导入 |
| 语言 | TypeScript 严格模式 | 题库清单与接口形状固定,类型挡住非法状态 |
| Worker 路由 | 手写,不用框架 | 路由只有 `/api/questions`、`/api/probe`、`/api/history*` |
| 请求校验 | 手写解析函数,边界处一次解析成类型 | 字段少。字段变多再换 valibot |
| 页面渲染 | Preact | JSX 默认转义,站点返回的不可信文本不会变成 HTML |
| 样式 | 一份手写 CSS,颜色用令牌,`prefers-color-scheme` 做深色 | 单页不需要组件库 |
| 存储 | Durable Objects SQLite,每 [站点 × 密钥] 对象一实例 | 见下 |
| 类型 | Vite 构建时生成 `.cloudflare/types/index.d.ts`,也可 `cf workers types` | 不手写 `Env` |
| 测试 | Vitest。纯函数加带假 `fetch` 的处理器测试 | DO 的集成测试见「测试」 |
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
     → 静态资源(页面,不唤醒 Worker)
     → Worker(仅 /api/*)
          ├ 解析与校验请求体
          ├ 限速绑定(键 = 调用方 IP,60 秒;键 = 目标主机,60 秒)
          ├ 代发,流式读取并计字节与计时,120 秒超时
          ├ 评分
          └ 带 runId 则写入对象(DO),写入前脱敏
```

## 暴露面

- `workers.dev` 与预览地址必须关闭。Worker 默认还挂在 `workers.dev` 上,从那里进来的请求绕过按 zone 生效的 WAF 限速。官方说明 `cf workers triggers deploy` 会应用路由、自定义域和 `workers.dev` 开关,所以这些写在配置的 `triggers` 里,具体字段名实现时读配置参考页。
- 页面的 CSP 等响应头写在 `_headers`。`_headers` 只作用于静态资源响应,不作用于 Worker 生成的响应,所以 `/api/*` 的响应头要在代码里设。
- 不提供跨域头。

## 配置

实际配置就是仓库根目录的 `cloudflare.config.ts`,以它为准。构建产物 `.cloudflare/output/v0/workers/default/worker.config.json` 能看到工具链实际识别出的字段。已核实的写法:

- `domains`、`workersDev`、`previewUrls` 是 `worker` 下的字段;定时触发是 `triggers: [triggers.scheduled({ schedule })]`,`triggers` 从 `cf/config` 导入。
- Durable Object 用 `exports: { Name: exports.durableObject({ storage: "sqlite" }) }` 声明,同一个 Worker 内通过 `ctx.exports.Name` 访问,需要兼容性标志 `enable_ctx_exports`。
- 秘密用 `bindings.secret()` 声明,文本变量用 `bindings.text()`,限速用 `bindings.rateLimit({ namespace, simple })`,`namespace` 写成字符串即可,构建与部署都接受。
- `worker.assets` 的键是 camelCase(`runWorkerFirst`),`worker.observability` 同理。

秘密的规矩:`cf deploy` 在任何已声明的秘密没有值时拒绝部署。`PEPPER` 与 `GAOXIN_KEY` 都通过 `--secrets-file` 随版本上传,文件放在 0600 权限的临时位置,用完即删。之后的部署不带 `--secrets-file` 也会保留已有的秘密值。

## 目录

```
cloudflare.config.ts
vite.config.ts
questions/<id>/meta.json   清单字段,不含题面
questions/<id>/prompt.txt  题面原文,含制表符,以 ?raw 导入
questions/index.ts         显式登记所有题,不扫目录
src/shared/                类型、一轮结论的共享计算函数
src/worker/                路由、probe、评分器表、目标地址校验、脱敏、Target(DO)
src/web/                   页面、梯度引擎(纯函数)
public/_headers
test/
.cloudflare/               构建输出与生成的类型,不入库
```

题面单独存成文本文件,避免编辑器把制表符改成空格。「展示给用户」和「实际发出」读同一个文件。完整性测试断言目录与登记一致。

## 可观测性

- Workers Logs 开启,调用日志关闭。每次探针写一条结构化日志,字段见 `design.md` 的「安全边界」。
- 官方文档说明请求头会被捕获。密钥只放请求体。
- 追踪默认关,开启则低采样。文档写明从 2026-12-01 起追踪计入用量计费。
- 开启 Workers Issues。
- 本地开发用 `cf dev` 的 Local Explorer(开发服务器地址加 `/cdn-cgi/local/explorer`),可查看本地绑定数据、日志和追踪,适合检查 DO 里存了什么。
- 限速绑定在控制台里不可见。官方建议用 Workers Logs 观察 Worker 返回的 429,或在被限速时往 Analytics Engine 写事件。首期用日志。

## 发布

官方为 `cf` 提供了 GitHub Actions 流程。本项目采用它,不使用 Workers Builds,因为文档里 Workers Builds 的默认命令是 `wrangler deploy`,没有查到它支持 `cf deploy`。

| 事件 | 动作 |
| --- | --- |
| PR | 类型检查、Vitest、`cf deploy --dry-run`。dry-run 不发任何 API 请求,不需要凭证,所以来自 fork 的 PR 也能跑。作为必需检查 |
| 合并到 `main` | `cf build` 一次,再 `cf deploy --prebuilt --mode production` 部署同一份构建输出。只有这一步拿到秘密 |
| 预览 | `cf previews deploy`,预览名默认取当前分支。是否支持带 DO 的 Worker,待查 |
| 灰度与回滚 | `cf workers versions create` 上传版本,`cf workers deployments create --strategy percentage` 分流。回滚对应的 `cf` 命令待查 |

CI 凭证:`CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。令牌权限只给这个 Worker 与 `ziikoo.app` 所需的最小范围。账号有多个时必须显式设置账号,否则非交互模式会失败。

`--prebuilt` 要求部署时的 `--mode` 与构建输出里记录的一致。Vite 构建总是记录模式,不带 `--mode` 的 `cf build` 记录 `production`。

在 CI 里,没有 `cloudflare.config.ts` 的项目会先运行自动配置,它会改文件。所以配置必须在本地生成、审阅并提交,CI 里不依赖自动配置。

实际状态(2026-10-18):`.github/workflows/ci.yml` 已作为 PR 门禁(类型检查、测试、构建、`cf deploy --dry-run`),在 GitHub 上实测通过。main 自动部署**没有启用**,因为它需要把一个限定范围的 Cloudflare API 令牌放进 GitHub 秘密,创建凭证需要维护者决定。目前由维护者在本机按「已部署资源与运维」里的命令部署。
## 测试

- 纯函数(评分器、目标地址校验、脱敏、对象标识、梯度引擎、一轮结论计算)用 Vitest 在 Node 里测。
- 保留最近 10 轮与闲置清空,把「删什么」写成纯函数测,DO 本身只留薄壳。
- DO 的集成测试官方推荐 `@cloudflare/vitest-plugin`,它提供对实例的直接访问。它是否与 `cloudflare.config.ts` 配合,待查。查清前不引入,DO 薄壳用 `cf dev` 加手动检查覆盖。

## 已部署资源与运维

| 资源 | 说明 |
| --- | --- |
| Worker `gpt-ziikoo-app` | 自定义域 `gpt.ziikoo.app`,定时触发 `* * * * *`,`workers.dev` 与预览地址关闭 |
| Durable Object `Target` | 每 [站点 × 密钥] 对象一实例,存最近 10 轮 |
| Durable Object `Monitor` | 单例,名字 `gaoxin`,存 7 天监测样本 |
| Worker `gpt-ziikoo-mock-relay` | e2e 用的 mock 中转站,`https://gpt-ziikoo-mock-relay.blueyang.workers.dev`,不绑域名。任何人都能访问,它不存任何东西 |
| 秘密 `PEPPER` | 备份在维护者本机 `~/.config/gpt-ziikoo-app/pepper`,权限 0600。**不可轮换**:换掉它会让全部历史对象失联 |
| 秘密 `GAOXIN_KEY` | 目前是占位 `unset`,监测静默跳过。换成真密钥的方法见下 |

换入真正的监测密钥(密钥不会出现在命令行历史和对话里):

```sh
cd ~/github/gpt-ziikoo-app
( umask 077; read -rs "K?监测密钥: "; echo; printf '{"GAOXIN_KEY":"%s"}' "$K" > "$TMPDIR/gk.json" )
pnpm build && cf deploy --prebuilt --mode production --secrets-file "$TMPDIR/gk.json"; rm -f "$TMPDIR/gk.json"
```

之后约 1 分钟内就会有第一个样本。`GET /api/monitor` 有 60 秒边缘缓存,页面最多晚一分钟看到。

日常部署:

```sh
git checkout main && git pull --ff-only
pnpm build && cf deploy --prebuilt --mode production --message "说明"
```

跑线上 e2e(需要先 `pnpm exec playwright install chromium`):

```sh
BASE_URL=https://gpt.ziikoo.app MOCK_URL=https://gpt-ziikoo-mock-relay.blueyang.workers.dev pnpm e2e
```

e2e 满跑一次约 62 次调用,会撞 IP 每分钟 150 次的限速,页面会按 `Retry-After` 等待后继续,所以单次完整运行约 4 到 5 分钟。

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
8. 流式请求的字段与选项名、缓存的前缀阈值,来自对 OpenAI 接口的了解,只在 mock 上走通,没有在真实站点上核对。**这是最大的未验证点,需要真实站点校准。**
9. 真实站点上首字时延的表现,尤其是经过缓冲的中转站。
10. `cf` 与 `@cloudflare/vite-plugin` 都是测试版,以实现时的最新版本说明为准。
