# QQ ↔ DeepSeek Harness 桥接

[AI 安装手册](README.ai.md) · [English](README.en.md) · [文档索引](docs/README.md)

把 QQ 私聊和群聊接入 DeepSeek Harness（DSH）。通过 SnowLuma 收发消息，每个 QQ 会话对应独立的 DSH 会话；本地控制台可管理白名单、角色、运行模式和用量。

## 让 AI 帮你安装

拉取仓库后，在能读取本地文件、执行命令的 AI 编程助手中打开项目，发送：

> 请阅读 README.ai.md，按手册帮我安装 qq-bridge。先检查本机环境和已有配置，仅询问缺少的信息。需要我完成 SnowLuma 登录或 QQ 测试时告诉我，最后报告实际验证结果。

AI 会安装桥接依赖、配置 DSH 插件并检查连接。你需要从 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases) 下载对应平台的完整发行包，解压、启动并完成 QQ 登录；AI 手册会引导你开启 OneBot 接口。

## 准备环境

- Node.js ≥ 22.13.0 和 npm。
- 已初始化的 [DSH](https://github.com/deepseek-ai/deepseek-harness)，Web 服务可访问，模型可用，`dsh` 命令可执行。
- 已登录 QQ 的 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)，启用 OneBot v11 WebSocket 服务端和 HTTP API。

默认在同一台机器、同一系统用户下运行。仓库适配记录对应 DSH `0.2.1-rc.2`，SnowLuma 运行时记录为 `1.14.20`。其他版本需验证，升级说明见[文档索引](docs/README.md)。

## 手动安装

```sh
git clone https://github.com/4shen-hj/qq-bridge.git
cd qq-bridge
npm install
```

1. 复制 `config.example.json` 为 `config.json`，已有配置请保留。填写 SnowLuma 地址、令牌和安装目录，以及 `ownerQQ`、`allow.private` 或 `allow.groups`。空白名单默认不接收消息。
2. 运行 `node scripts/setup-dsh.mjs web` 安装 DSH 预设和 MCP 工具。`web` 要替换为实际使用的 profile，桌面端可能使用 `desktop`。
3. 重启对应的 DSH 进程，再运行 `npm start`。
4. 打开 [本地控制台](http://127.0.0.1:3100)，使用有效的 `config.json` 中的 `consoleToken` 登录。未配置或格式不合法时，完整的自动令牌保存在本机 `state/console-token`，启动日志只显示前 6 位。
5. 检查 DSH、SnowLuma 上游状态和白名单，再从白名单账号发送测试消息，确认 QQ 收到回复。

端口、令牌发现、验收与排错步骤见 [AI 安装手册](README.ai.md)，手动安装也可照着执行。

## 选择运行模式

在控制台切换模式。

| 模式 | 行为 |
| --- | --- |
| `chat` | 在白名单内聊天，自动转发回复。 |
| `reserved2` | 二代仿真群友，自主决定何时阅读、发言和等待。新装默认。 |
| `reserved` | 一代仿真群友，选择性参与聊天。 |
| `closed-agent` | 仅管理员私聊，使用 DSH 完整工具，可操作本机。 |

首次验证可临时切到 `chat`，避免把仿真模式的主动沉默误判为故障。角色在控制台「人格与角色」中设置，写法见[角色卡说明](roles/README.md)。

## 日常使用

- 前台运行用 `npm start`，停止用 `Ctrl+C`。Windows 可用 `start.bat` 在崩溃后自动重启，关闭窗口停止守护；同一仓库只运行一个实例。
- 管理员可在 QQ 使用 `/status`、`/reset`、`/role <角色名>`、`/silent`、`/active`。
- 更新前备份配置与角色。拉取更新后执行 `npm install` 和 `node scripts/setup-dsh.mjs <实际profile>`，重启 DSH 与桥接；预设变更后新建或重置会话。

## 使用边界

保持白名单限制。`closed-agent` 拥有完整本地工具，仅在需要管理员远程操作时启用。消息会交给 DSH 模型处理；默认黑话学习还可能把提取的词条提交给搜索服务，可用 `slang.autoResearch: false` 关闭自动研究。

不提交 `config.json`、`state/`、`audio/` 或凭据。权限规则见 [RULES.md](RULES.md)，数据处理见[隐私说明](docs/guides/PRIVACY.md)。本项目采用 [MIT 许可证](LICENSE)，SnowLuma 按其自身许可使用。
