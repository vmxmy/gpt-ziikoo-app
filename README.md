# gpt-ziikoo-app

GPT 降智测试。用户填入中转站地址和密钥,用可插拔题库检查所买的模型是不是原装。

- 域名 `gpt.ziikoo.app`
- 单页站点,无登录,接口匿名可调用
- 独立于 `zhiyun-ai-dashboard`,不共享部署、登录态和绑定

## 状态

设计阶段,尚无实现代码。设计见 [`docs/design.md`](docs/design.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `docs/design.md` | 产品与技术设计,实现以它为准 |
| `reference/apitest.py` | 原始梯度筛选脚本,评分与梯度语义的参考,不属于产品代码 |
| `AGENTS.md` | 给代码代理的入口与硬约束 |
