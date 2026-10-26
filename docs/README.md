# 文档索引

文档只保留操作步骤、权限契约和非显然的取舍。配置字段、默认值、工具列表与测试覆盖以代码为准，历史改动查 Git 记录。

## 安装与使用

| 任务 | 入口 |
| --- | --- |
| 了解项目与日常操作 | [人类版 README](../README.md)、[English](../README.en.md) |
| 让 AI 协助安装和排错 | [AI 安装手册](../README.ai.md) |
| 配置接入目标与功能 | [配置模板](../config.example.json) |
| 确认权限与使用边界 | [权限规则](../RULES.md) |
| 编写和切换人格 | [角色卡说明](../roles/README.md) |
| 理解用量与费用估算 | [用量看板](guides/TOKEN_USAGE_CONSOLE.md) |

## 维护与验证

| 任务 | 入口 |
| --- | --- |
| 开发约定与代码入口 | [AGENTS.md](../AGENTS.md) |
| 更新 DSH、发布预设、配置重试 | [DSH 维护](guides/DSH_SETUP.md) |
| 修改权限或处理安全问题 | [安全基线](guides/SECURITY_BASELINE.md) |
| 发布前检查隐私 | [隐私检查](guides/PRIVACY.md) |
| 预览和测试控制台 | [控制台测试](guides/CONSOLE-UI-TESTING.md) |

查可用命令运行 `npm run`，查实现从 [src/](../src/) 和 [plugins/](../plugins/) 开始，查行为断言看 [scripts/](../scripts/) 中对应测试。不要在文档中另存一份接口、常量或测试用例清单。
