# AGENTS.md

本文件是入口。产品行为见 [`docs/design.md`](docs/design.md),平台与部署见 [`docs/architecture.md`](docs/architecture.md)。

## 硬约束

- 用户密钥不落盘、不进日志、不进错误上报、不回显。历史存储只存密钥与站点的 HMAC 指纹,也不存密钥尾号。唯一例外是用户明确勾选同意的持续监测:密钥用 AES-GCM 加密后存进 `Watch` Durable Object,明文密钥只在当次调用期间短暂存在。
- 密钥只放请求体,不放请求头和 URL。官方文档说明请求头会被日志捕获。
- 所有入库文本写入前必须把完整密钥以及 `Bearer ` 加密钥替换掉。站点可能在报错里回显密钥。
- 日志不含任何用户数据,只含目标主机名、题 id、结果类别、状态码、延迟。回答原文与原始响应只存在于按密钥访问的对象存储里。
- 读取与删除历史必须出示同一站点和同一密钥。对象不存在与为空返回相同结果。
- 探针接口发的题只来自题库里的固定题、服务端用封闭词表生成的题,或调用方随请求给出的自定义题(2026-10-23 授权,规则见「自定义题」节)。自定义题只在 `/api/probe` 当次调用内存在:不落库、不进历史、不进监测轮转、不占用题库 id。只访问 `/v1/responses` 或 `/v1/chat/completions`。
- 目标地址只允许 `https`,拒绝 IP 字面量与 `localhost`,不跟随重定向。
- 来自中转站的回答是不可信内容。页面只用文本节点渲染,不拼 HTML。
- `workers.dev` 与预览地址保持关闭,否则绕过边缘限速。这个开关写在 `cloudflare.config.ts` 的 `triggers` 里。
- 工具链是 `cf`(测试版)加 `cloudflare.config.ts`,不使用 `wrangler` 命令与 `wrangler.jsonc`。Node.js 22.18 或更高。CI 里不依赖自动配置,配置必须本地生成、审阅并提交。
- `cf` 是测试版,升级版本后先读变更说明再改配置。查资料时官方多数示例仍是 Wrangler 写法,对照「Wrangler 到 cf 对照」页。
- `ziikoo.app` 是 Free zone,且还承载其他站点。Bot Fight Mode 现在是关的,必须保持关闭,它不能被规则跳过,会质询匿名脚本。改这个全区设置前先想到本站。边缘限速只有 1 条规则、10 秒窗口,主要限速在 Worker 里。
- 不在本仓库记录具体中转站的名字或测评结论。不做公开站点榜单。监测样本只存数字字段,不存回答原文。
- 题面或评分一变,题的 `version` 加 1。
- pepper 不可轮换,换掉会让全部历史对象失联。

## 做 X 之前先读 Y

| 你要做的事 | 先读 |
| --- | --- |
| 加一道题 | `docs/design.md` 的「题库」一节 |
| 改自定义题 | `docs/design.md` 的「自定义题」一节 |
| 改接口 | `docs/design.md` 的「接口」一节 |
| 改评分或梯度 | `reference/apitest.py` 与「梯度规则」一节 |
| 改存储或保留策略 | `docs/design.md` 的「持久化」一节与 `docs/architecture.md` 的「存储」 |
| 改限速、部署、日志 | `docs/architecture.md` |

## 工作方式

- 落 `main` 走分支、PR、合并,不直推。首个提交是建仓例外。
- 只在被要求时提交和推送。
- 维护者的全局 gitignore 有 `*.gitignore` 规则,会把 `.gitignore` 自己也忽略。改 `.gitignore` 必须 `git add -f`。
- 代理不要使用 `pkill`、`killall`,本机其他会话也在用开发服务器。只停自己启动并记录了 PID 的进程。
- e2e 只能跑在线上(Worker 拒绝本机与 IP 地址),命令与 mock 地址见 `docs/architecture.md` 的「已部署资源与运维」。
- 部署是生产操作,由维护者或在维护者明确授权下由主会话执行,不要交给子代理。
- 持续监测的浏览器侧只存服务器签发的看板码(`gpt.board.v1`)。密钥本身不得写入 `localStorage`、`sessionStorage`、URL、DOM 属性或日志;序列化只显式挑选字段。
- 页面 CSP 是 `style-src 'self'`:不得出现内联 `style` 属性(包括 Preact 的 `style={{}}`)与内联 `<style>`。
- e2e 用 `getByTestId`,同名多个会触发严格模式报错。监测卡片一律用 `custom-<id>-` 前缀。
- 状态颜色只在 `src/web/styles.css` 的「语义表」里映射。组件 CSS 写 `background: var(--tone)` 或 `color: var(--tone-text)`,不要按状态值各写一份颜色规则,也不要在组件里写色值。新增状态词汇就在语义表加一行。
- 界面文案的用词以 `docs/design.md` 的「界面用词」表为准:一个概念只用一个词,一个词只表一个意思。
