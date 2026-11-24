# 项目工程条款：gpt-ziikoo-app

与 `constitution/engineering.md` 并列读取，只追加，不覆盖共享条款。

## 生成物

- `.cloudflare/` 由 `cf workers types` 与 `cf build` 生成，不入库、不手改。依据：`.gitignore`、`docs/architecture.md`。
- 迁移到 Void 后，`.void/` 与 `.void-wrangler.jsonc` 由 `void prepare` / `vite build` 生成，不入库、不手改；`void.lock.json` 记录 Cloudflare 资源 ID 与 Durable Object 迁移历史，由工具生成并审阅后提交，不得删除或重排已部署的迁移步骤。依据：`.gitignore`、Void 文档。

## 必读

- 改题库、自定义题、接口、评分/梯度、存储、限速/部署/日志前，按根 `AGENTS.md`「做 X 之前先读 Y」表先读对应文档。依据：`AGENTS.md`。
- 改接口同步 `public/api.md`；题面或评分变动时题的 `version` 加 1。依据：`AGENTS.md`。

## 安全与前端不变量

- 密钥边界：用户密钥不落盘、不进日志、不进错误上报、不回显、不进 URL 或普通请求头（Gemini 原生协议仅用 `x-goog-api-key`）；入库文本写入前替换完整密钥与 `Bearer ` + 密钥；禁止将明文密钥拼入抛出的 `Error.message`（Void 运行时 `onError` 会调用 `console.error(error)`）；浏览器侧只存看板码 `gpt.board.v1`。依据：`AGENTS.md`、Void P0 审计。
- 暴露面与 CSP：`workers.dev` 与预览地址保持关闭；页面 CSP 为 `style-src 'self'`，不得出现内联 `style` 属性（含 Preact 内联 `style` prop）与内联 `<style>`；不可信回答只用文本节点渲染，唯一例外为 `pelican-svg` 在 `/api/frame` 沙箱 iframe 运行；`/api/*` 不提供跨域头且保持 `Cache-Control: no-store`。依据：`AGENTS.md`、`public/_headers`。
- Void 响应头覆盖陷阱：Void 会把 `public/_headers` 编译为 Hono 全局 `headerMiddleware` 并在路由执行后覆盖响应头（后匹配生效）。迁移 Void 时必须显式为 `/api/*` 保留 `Cache-Control: no-store`、为 `/api/frame` 保留沙箱 CSP，避免被 `/*` 规则覆盖。依据：Void P0 审计、`src/worker/index.ts`。
- 样式、测试 ID 与文案：状态颜色只在 `src/web/styles.css` 语义表映射；监测卡片 `data-testid` 一律用 `custom-<id>-` 前缀；界面用词以 `docs/design.md`「界面用词」表为准。依据：`AGENTS.md`。
- 本机与 Git 约束：维护者全局 gitignore 含 `*.gitignore`，改动 `.gitignore` 必须用 `git add -f .gitignore`；禁止使用 `pkill`、`killall`。依据：`AGENTS.md`。
