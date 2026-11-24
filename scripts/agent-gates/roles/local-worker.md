# 项目 worker 附加约束：gpt-ziikoo-app

追加在 `roles/worker.md` 之后进入每份 task spec。只加约束，不改写四段。

## Owns（追加）

- 类型检查只用 `pnpm typecheck`（当前依次运行 `cf workers types`、`tsc -p tsconfig.worker.json`、`tsc -p tsconfig.web.json`；迁到 Void 后以 `package.json` 的 `typecheck` 为准）。依据：`package.json`、`.github/workflows/ci.yml`。
- 定向单测用 `pnpm exec vitest run <test-file>`，全量单测用 `pnpm test`（全量约数秒）。依据：`package.json`、`vitest.config.ts`。
- 构建用 `pnpm build`；`cf` 架构下离线部署校验用 `pnpm exec cf deploy --dry-run --prebuilt --mode production`，Void 架构下离线资源校验用 `pnpm exec void info`。依据：`package.json`、`scripts/agent-gates/gate.project.sh`。
- 改动接口、配置、工具链或架构决定时，同步更新 `public/api.md`、`docs/architecture.md`、`AGENTS.md`。依据：`AGENTS.md`。

## Does Not Own（追加）

- 裸 `tsc --noEmit`：不会生成绑定类型且只看默认 tsconfig，不许用来代替 `pnpm typecheck`。依据：`package.json`、`tsconfig.worker.json`、`tsconfig.web.json`。
- 生产部署与秘密操作：`cf deploy`（不带 `--dry-run`）、`void deploy`、`cf workers secrets`、`void secret put`、`void domain`、`void email setup`、`void project delete/rollback`，以及修改 `ziikoo.app` zone 设置（Bot Fight Mode、WAF 限速）。依据：`AGENTS.md`、`COORDINATOR.project.md`。
- 在生产 Worker `gpt-ziikoo-app` 上运行 Void 关联已有 Worker 流程（DO 类迁移不可回滚）。依据：`COORDINATOR.project.md`。
- 线上 e2e（`pnpm e2e`）：只能打线上站点与共享 mock 中转站，会撞每分钟 150 次 IP 限速，不放进实现自测或 `CHECK`。依据：`docs/architecture.md`、`COORDINATOR.project.md`。
- 读取 `.env*`、`.dev.vars*` 或 `~/.config/gpt-ziikoo-app/*` 里的秘密内容。依据：`AGENTS.md`。
- 使用 `pkill`、`killall`（同机其他会话共用开发服务器）。依据：`AGENTS.md`。
- 手改 `scripts/agent-gates/` 下由 core 分发的文件（`gate.sh`、`constitution/{engineering,workflow,handoffs}.md`、`roles/{worker,coordinator,reviewer,resolver,intake,correction}.md` 等）。依据：`ONBOARD.md`。

## Verification（追加）

- 改动 `public/_headers`、`void.config.ts` 的 `routing.headers` 或 `/api/frame` 时，必须验证：主站页面 CSP 含 `style-src 'self'`；`/api/frame` 保持沙箱 CSP 且未被 `/*` 覆盖；`/api/*` 保持 `Cache-Control: no-store` 且无 CORS 头。依据：`AGENTS.md`、`public/_headers`。
- 改动 `.gitignore` 时，需用 `git status` 确认已通过 `git add -f .gitignore` 纳入跟踪。依据：`AGENTS.md`。
