# 技术架构

产品行为见 [`design.md`](design.md)。本文只写平台选型、部署与运维。依据是 2026-10-18 查阅的 Cloudflare 官方文档,凡未核实的内容在末尾列出。

## 选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 托管 | Workers 加 Static Assets,`custom_domain` 绑 `gpt.ziikoo.app` | 官方最佳实践写明新项目用 Workers 而不是 Pages |
| 构建 | `@cloudflare/vite-plugin`、Vite、Preact | 一条构建同时出页面与 Worker。本地开发跑在真实运行时里。题面用 Vite 自带的 `?raw` 导入 |
| 语言 | TypeScript 严格模式 | 题库清单与接口形状固定,类型挡住非法状态 |
| Worker 路由 | 手写,不用框架 | 路由只有 `/api/questions`、`/api/probe`、`/api/history*` |
| 请求校验 | 手写解析函数,边界处一次解析成类型 | 字段少。字段变多再换 valibot |
| 页面渲染 | Preact | JSX 默认转义,站点返回的不可信文本不会变成 HTML |
| 样式 | 一份手写 CSS,颜色用令牌,`prefers-color-scheme` 做深色 | 单页不需要组件库 |
| 存储 | Durable Objects SQLite,每 [站点 × 密钥] 对象一实例 | 见下 |
| 测试 | Vitest | 纯函数加带假 `fetch` 的处理器测试,首期不引入 Workers 测试池 |
| 包管理 | pnpm | 与主项目一致 |

不选:Pages Functions(新功能集中在 Workers)、Node 或 Fastify 加 VPS(要自己运维)、Next.js(单页太重)、Hono(路由太少)、Turnstile(接口要匿名可调,脚本过不了验证码)、D1 加 R2(见下)。

## 存储

| 方案 | 结论 |
| --- | --- |
| DO SQLite,每对象一实例 | **采用。** 单对象 10GB 上限。「保留最近 10 轮」是一条删除语句。标识由密钥派生,没有可枚举的全局表。付费套餐含 5GB·月,超出 $0.20/GB·月。读写行数含量远高于预期用量 |
| D1 加 R2 | 不采用。D1 存储 $0.75/GB·月。原始数据放 R2 多一个系统,主项目实测 R2 单对象读取约 560ms |

代价是跨对象的全局统计做不了。需要时再加一条旁路写入,首期不做。

计费要点,来自官方定价页。删除计入写入行数。每次设置闹钟计一行写入。数据在删除之前一直计费,删除后对象被系统自动清理。

## 请求分层

```
请求 → WAF 限速(按 IP,边缘,封禁期内直接拦)
     → 静态资源(页面,不唤醒 Worker)
     → Worker(仅 /api/*)
          ├ 解析与校验请求体
          ├ 限速绑定(键 = 目标主机)
          ├ 代发,流式读取并计字节与计时,120 秒超时
          ├ 评分
          └ 带 runId 则写入对象(DO),写入前脱敏
```

## 暴露面

- `workers_dev: false`、`preview_urls: false`。Worker 默认还挂在 `workers.dev` 上,从那里进来的请求绕过按 zone 生效的 WAF 限速。
- 页面的 CSP 等响应头写在 `_headers`。`_headers` 只作用于静态资源响应,不作用于 Worker 生成的响应,所以 `/api/*` 的响应头要在代码里设。
- 不提供跨域头。

## 配置草图

草图,值取自官方示例,实现时以当时的官方文档与 `wrangler types` 为准。

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "gpt-ziikoo-app",
  "main": "./src/worker/index.ts",
  "compatibility_date": "<当天或 wrangler 支持的最新日期>",
  "compatibility_flags": ["nodejs_compat"],
  "upload_source_maps": true,
  "workers_dev": false,
  "preview_urls": false,
  "routes": [{ "pattern": "gpt.ziikoo.app", "custom_domain": true }],
  "assets": { "directory": "./dist/client", "run_worker_first": ["/api/*"] },
  "durable_objects": { "bindings": [{ "name": "TARGETS", "class_name": "Target" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Target"] }],
  "ratelimits": [{ "name": "HOST_LIMITER", "namespace_id": "<唯一整数>",
                   "simple": { "limit": 60, "period": 60 } }],
  "observability": {
    "enabled": true,
    "logs": { "invocation_logs": false, "head_sampling_rate": 1 },
    "issues": { "enabled": true }
  }
}
```

`Env` 由 `wrangler types` 生成,不手写。pepper 用 `wrangler secret put` 设置,不进配置文件。

## 目录

```
questions/<id>/meta.json   清单字段,不含题面
questions/<id>/prompt.txt  题面原文,含制表符,以 ?raw 导入
questions/index.ts         显式登记所有题,不扫目录
src/shared/                类型、一轮结论的共享计算函数
src/worker/                路由、probe、评分器表、目标地址校验、脱敏、Target(DO)
src/web/                   页面、梯度引擎(纯函数)
test/
wrangler.jsonc
```

题面单独存成文本文件,避免编辑器把制表符改成空格。「展示给用户」和「实际发出」读同一个文件。完整性测试断言目录与登记一致。

## 可观测性

- Workers Logs 开启,调用日志关闭。每次探针写一条结构化日志,字段见 `design.md` 的「安全边界」。
- 官方文档说明请求头会被捕获。密钥只放请求体。
- 追踪默认关,开启则低采样。文档写明从 2026-12-01 起追踪计入用量计费。
- 开启 Workers Issues,需要 wrangler 4.134.0 及以上。

## 发布

| 事件 | 动作 |
| --- | --- |
| PR | GitHub Actions 跑类型检查与 Vitest,作为必需检查 |
| 合并到 `main` | Workers Builds 部署 |
| 非生产分支 | Workers Builds 预览 |
| 出问题 | 灰度发布时在指标图上对照版本,必要时回滚到最近 100 个版本之一 |

Workers Builds 管理部署凭证,GitHub 里不放部署令牌(推断,首次接入时核对)。

## 未核实,实现前必须验证

1. `ziikoo.app` 这个 zone 的套餐。它决定 WAF 限速的计数窗口与规则条数。官方文档的可用窗口为 Free 10 秒、Pro 最长 1 分钟、Business 最长 10 分钟。
2. Bot Fight Mode 或 Super Bot Fight Mode 是否会质询匿名脚本,以及对 `/api/*` 的跳过规则怎么配。
3. WAF 限速规则可选的计数特征随套餐不同,只确认了「按 IP」。
4. 兼容性标志 `global_fetch_strictly_public` 的语义。启用前读文档。
5. Cloudflare Vite 插件的版本与配置,读它的入门页。
6. DO SQLite 的单行大小上限,我没有查到。原始数据单次上限 256KB,必须先确认在行限制之内。
7. 流式请求的字段与选项名,以及缓存的前缀阈值,来自对 OpenAI 接口的了解,实现时核对官方文档。
