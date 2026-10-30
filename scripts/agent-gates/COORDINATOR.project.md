# gpt-ziikoo-app 的项目规则

通用流程见 `COORDINATOR.md`；本文件只写本仓库特有的 lane 判据与合并上线规矩。参数在 `agent-graph.env`，重型检查在 `gate.project.sh`。工人还须遵守仓库根 `AGENTS.md` 的硬约束与「做 X 之前先读 Y」表。

## Lane 判据

判定在 `agent-graph.env`：`AGENT_LANE2_GLOBS` 命中 → lane 2，`AGENT_LANE3_GLOBS` 命中 → lane 3（gate 直接判红），`scripts/agent-gates/*` 在 `gate.sh` 里硬编码为 lane 2；其余 lane 1。以 env 里的 glob 为准，gate 输出的 `LANE` 行就是结论。下表仅为展示用说明，改判据改 env，不改表。

| Lane | 本仓库的路径 / 操作 |
| --- | --- |
| 1 可逆·局部 | 页面与组件 `src/web/*`（`html-test.tsx` 除外）、Worker 业务逻辑 `src/worker/*`（下行列出的文件除外）、`src/shared/*`（`types.ts` 除外）、题库 `questions/*`、测试 `test/*` `e2e/*`、mock 中转站源码 `mock/src/*`、接口说明 `public/api.md`、`README.md`。依据：`AGENTS.md` 的「做 X 之前先读 Y」表，这些改动有 Vitest 定向断言可写 |
| 2 可逆·宽（`AGENT_LANE2_GLOBS`） | CI `.github/*`；依赖清单 `package.json` `pnpm-lock.yaml` `pnpm-workspace.yaml` `mock/package.json`；构建与部署配置 `cloudflare.config.ts` `mock/cloudflare.config.ts` `tsconfig*.json` `vite.config.ts` `mock/vite.config.ts` `vitest.config.ts` `playwright.config.ts`（`workersDev`/`previewUrls` 开关、秘密声明、Durable Object 导出都在这里）；设计与架构文档 `docs/*`（`docs/design.md` 是实现依据，含带授权日期的决策）；页面 CSP `public/_headers`；Worker 与页面共享类型 `src/shared/types.ts`；路由与沙箱 iframe CSP `src/worker/index.ts`；执行密钥规则的 `src/worker/identity.ts`（HMAC 指纹）、`src/worker/redact.ts`（入库前替换密钥）、`src/worker/request.ts`（密钥只放请求体、只访问三个端点）、`src/worker/watch.ts`（AES-GCM 加密密钥）；目标地址校验 `src/worker/target-url.ts`；沙箱 iframe 属性 `src/web/html-test.tsx`；agent 配置 `AGENTS.md` `CLAUDE.md` `.claude/*` `.codex/*` `scripts/agent-gates/*`。依据：`.github/workflows/ci.yml`、`AGENTS.md` 硬约束、源码 grep（HMAC/AES-GCM/sandbox/CSP）；lane 2 自合依据：用户答复 |
| 3 不可逆（`AGENT_LANE3_GLOBS` + 操作） | 文件：`.env*` `.dev.vars*`（含子目录）、`*secrets*`、`.github/workflows/deploy*`、Cloudflare 本地状态 `.cloudflare/*`（含 `mock/.cloudflare/*`）。操作（不经文件，靠流程禁止）：`cf deploy`（含 mock 中转站）、`cf workers secrets` 写入、轮换 `PEPPER`（会让全部历史对象失联）、删除 Durable Object 或其数据、改 `ziikoo.app` zone 设置（Bot Fight Mode、WAF 限速规则）、push main / force push。依据：`.gitignore`、`AGENTS.md` 硬约束、`docs/architecture.md`「已部署资源与运维」 |

## 外部契约

- 录制样本目录：无。`src/worker/parse.ts`、`src/worker/models.ts` 解析中转站的模型输出与 `/v1/models` 响应，但仓库没有提交真实录制样本，`test/worker/*` 用手写响应。依据：`find . -iname '*fixture*' -o -iname testdata` 只找到 `e2e/fixtures.ts`（Playwright fixture，不是样本）。
- 契约清单：接口契约以 `docs/design.md`「接口」一节为准，改动后同步 `public/api.md`。依据：`AGENTS.md`。

## 合并与上线

- lane 1 合并策略：coordinator 自合（squash）；lane 2 满足复核、CI 与路径条件后也自合（`AGENT_LANE2_AUTOMERGE=1`）。依据：用户答复。
- 无自动部署：`AGENT_DEPLOY_WORKFLOW`/`AGENT_SMOKE_CMD` 留空，跳过上线步。CI 在 main 上只跑 `cf deploy --dry-run`，线上由维护者在本机运行 `pnpm build && cf deploy --prebuilt --mode production`。依据：`.github/workflows/ci.yml`、`docs/architecture.md`「发布」、用户答复。
- 部署是生产操作，worker、处置 Agent 与 coordinator 都不执行；合并写 Done 不代表线上已更新。线上 e2e 只能跑在 `gpt.ziikoo.app`，会消耗共享 mock 中转站的限速额度，不放进 gate 或 `CHECK`。依据：`AGENTS.md`「工作方式」。
