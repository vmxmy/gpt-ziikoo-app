# gpt-ziikoo-app

GPT 降智测试。用户填入中转站地址和密钥,用可插拔题库检查所买的模型是不是原装。

- 域名 `gpt.ziikoo.app`
- 单页站点,无登录,接口匿名可调用
- 独立于 `zhiyun-ai-dashboard`,不共享部署、登录态和绑定

## 状态

已上线:https://gpt.ziikoo.app 。设计见 [`docs/design.md`](docs/design.md),部署与运维见 [`docs/architecture.md`](docs/architecture.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `docs/design.md` | 产品行为、题库、接口、持久化、指标、决策记录,实现以它为准 |
| `docs/architecture.md` | 平台选型、存储、部署、可观测性,以及实现前待核实项 |
| `reference/apitest.py` | 原始梯度筛选脚本,评分与梯度语义的参考,不属于产品代码 |
| `AGENTS.md` | 给代码代理的入口与硬约束 |
