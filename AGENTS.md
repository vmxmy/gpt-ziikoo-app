# AGENTS.md

本文件是入口。产品行为见 [`docs/design.md`](docs/design.md),平台与部署见 [`docs/architecture.md`](docs/architecture.md)。

## 硬约束

- 用户密钥不落盘、不进日志、不进错误上报、不回显。只存密钥与站点的 HMAC 指纹,也不存密钥尾号。
- 密钥只放请求体,不放请求头和 URL。官方文档说明请求头会被日志捕获。
- 所有入库文本写入前必须把完整密钥以及 `Bearer ` 加密钥替换掉。站点可能在报错里回显密钥。
- 日志不含任何用户数据,只含目标主机名、题 id、结果类别、状态码、延迟。回答原文与原始响应只存在于按密钥访问的对象存储里。
- 读取与删除历史必须出示同一站点和同一密钥。对象不存在与为空返回相同结果。
- 探针接口只发题库里的固定题,只访问 `/v1/responses` 或 `/v1/chat/completions`。不接受自由题面。
- 目标地址只允许 `https`,拒绝 IP 字面量与 `localhost`,不跟随重定向。
- 来自中转站的回答是不可信内容。页面只用文本节点渲染,不拼 HTML。
- `workers_dev` 与 `preview_urls` 保持关闭,否则绕过边缘限速。
- `ziikoo.app` 是 Free zone。Bot Fight Mode 保持关闭,它不能被规则跳过,会质询匿名脚本。边缘限速只有 1 条规则、10 秒窗口,主要限速在 Worker 里。
- 不在本仓库记录具体中转站的名字或测评结论。不做公开站点榜单。
- 题面或评分一变,题的 `version` 加 1。
- pepper 不可轮换,换掉会让全部历史对象失联。

## 做 X 之前先读 Y

| 你要做的事 | 先读 |
| --- | --- |
| 加一道题 | `docs/design.md` 的「题库」一节 |
| 改接口 | `docs/design.md` 的「接口」一节 |
| 改评分或梯度 | `reference/apitest.py` 与「梯度规则」一节 |
| 改存储或保留策略 | `docs/design.md` 的「持久化」一节与 `docs/architecture.md` 的「存储」 |
| 改限速、部署、日志 | `docs/architecture.md` |

## 工作方式

- 落 `main` 走分支、PR、合并,不直推。首个提交是建仓例外。
- 只在被要求时提交和推送。
