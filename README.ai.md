# qq-bridge AI 安装手册

供能读取本地文件、执行命令的 AI 助手使用。目标是完成本机安装，并验证一次 QQ → DSH → QQ 往返。项目介绍见 [README.md](README.md)，权限边界见 [RULES.md](RULES.md)。

## 1. 检查环境，补齐缺少的信息

在包含 `package.json`、`config.example.json` 和 `src/bridge.js` 的仓库根目录执行命令。先读取 [AGENTS.md](AGENTS.md)、[RULES.md](RULES.md) 和示例配置；已有 `config.json` 时保留并按需修改，不用模板覆盖。

检查 `node --version`、`npm --version` 和 `dsh --version`。Node.js 要求 ≥ 22.13.0。默认部署方式为桥接、DSH、SnowLuma 位于同机且使用同一系统用户。

从已有配置和运行环境确认下列信息，只询问无法确定的项：

- DSH Web 地址、实际运行的 profile、数据目录和可用模型。默认地址为 `http://127.0.0.1:3080`，profile 默认为 `web`，桌面端可能是 `desktop`。
- DSH 数据目录默认是当前用户的 `~/.dsh`。使用自定义目录时，为安装脚本和桥接进程设置相同的 `DSH_HOME`。
- SnowLuma 安装目录、QQ 登录状态、OneBot WebSocket 服务端与 HTTP API 地址、各自的令牌。
- 管理员 QQ 号、允许接入的私聊 QQ 号和群号、期望的运行模式。机器人账号与管理员账号要分清。

DSH 必须完成首次初始化，Web 页面可访问且模型可用。缺少 DSH 时，按其官方安装说明准备环境，再继续。SnowLuma 的下载、安装、启动和扫码登录由用户完成；本项目不自动部署或控制 SnowLuma。

不要输出完整配置、凭据文件或令牌。不要为排错开放所有 QQ 目标、关闭鉴权，或将安全聊天预设换成完整工具预设。不要清空用户的 `state/`、角色卡或 DSH 配置。

## 2. 安装依赖并填写配置

```sh
npm install
```

保留安装脚本执行权限，`postinstall` 会修补 SnowLuma SDK 的 ESM 导入。若曾跳过脚本，运行 `node scripts/patch-snowluma-sdk.mjs` 补做。

仅在 `config.json` 不存在时复制模板。PowerShell：

```powershell
if (-not (Test-Path -LiteralPath config.json)) { Copy-Item -LiteralPath config.example.json -Destination config.json }
```

Bash：

```sh
if [ ! -e config.json ]; then cp config.example.json config.json; fi
```

在本机编辑 JSON，修改前备份已有配置。只改安装所需字段，其余沿用模板或用户已有值。

| 字段 | 填写规则 |
| --- | --- |
| `dsh.baseUrl` | 实际 DSH Web 地址。保留本机回环地址与 `dsh.allowRemote: false`。 |
| `dsh.authToken` | 本机部署通常留空。桥接从 `DSH_HOME/.credentials.yaml` 的持久化签名密钥生成 Cookie，不要复制旧启动日志中的 token。 |
| `dsh.provider`、`dsh.model`、`dsh.reasoningEffort` | 使用当前 DSH 支持的值。模板是 `deepseek-official`、`deepseek-flash`、`max`。 |
| `snowluma.wsUrl` | OneBot WebSocket 服务端地址，模板为 `ws://127.0.0.1:3001`。 |
| `snowluma.httpUrl` | OneBot HTTP API 地址，模板为 `http://127.0.0.1:3000`。不能填 WebSocket 端口。 |
| `snowluma.accessToken` | HTTP API 令牌。HTTP 与 WS 令牌可能不同，不要假定通用。 |
| `snowluma.homeDir` | 实际 SnowLuma 安装目录，供读取 `config/onebot_*.json` 发现端点与 WS 令牌。Windows JSON 路径使用 `/` 或转义的 `\\`。 |
| `snowluma.followDiscoveredEndpoint` | 默认 `true`，自动发现可改写端口配置。明确固定其他端点时设为 `false`，并核对 token 发现目录对应的账号。 |
| `ownerQQ` | 管理员 QQ 号，不是机器人 QQ 号。 |
| `allow.private`、`allow.groups` | 用户指定的 QQ 号、群号数组。至少填写测试目标，保持 `allowAllWhenEmpty: false`；`deny` 优先。 |
| `consolePort`、`consoleToken` | 默认控制台端口 `3100`。令牌留空时启动自动生成。 |

`sessionCwd` 留空时使用默认工作目录，不填写作者机器路径。`slang.autoResearch` 默认开启，会将提取的群聊词条交给搜索服务；用户不需要时设为 `false`。

## 3. 安装 DSH 预设和 MCP 工具

确认 `dsh` CLI 可执行，且目标 profile 与正在使用的 DSH 一致，再运行：

```sh
node scripts/setup-dsh.mjs web
```

`web` 替换为实际 profile 名。脚本会修改该 profile 的 `cordis.patch.yml` 与 `package.json`，注册 `qq-mode-console`、`qq-agent-presets`，挂载三个 MCP 服务，并调用 `dsh plugin --profile <profile> install`。脚本还会发布并校验 `qq-chat`、`qq-chat-v2` 预设，新装时创建 `state/mode.json`，默认模式为 `reserved2`，已有模式保留。

执行前备份目标 profile 配置。检查退出码为 0，日志包含预设发布或校验成功及 `Done. Restart DSH`。失败时根据报错修复并重跑，不把部分写入当作成功。不要用 `QQ_BRIDGE_SKIP_DSH_INSTALL=1` 绕过依赖安装失败。

安装使用指向本仓库的目录链接，并记录 Node.js 和脚本路径。之后移动仓库或更换 Node.js 路径，需要重新运行安装脚本。

重启使用该 profile 的 DSH。确认预设列表中出现 `qq-chat` 和 `qq-chat-v2`，并已加载 `snowluma`、`snowluma-host`、`web-search-safe` 三个 MCP 服务。缺少聊天预设时必须修复安装，不能回退到 `standard`。详细机制见 [DSH 配置说明](docs/guides/DSH_SETUP.md)。

## 4. 启动并验收

确认 DSH 与 SnowLuma 已运行后，在仓库根目录执行：

```sh
npm start
```

同一仓库只运行一个桥接实例。打开 `http://127.0.0.1:<consolePort>`，用本机配置或启动日志中的控制台令牌登录，分享结果时隐藏令牌。

依次检查：

1. 控制台可访问，DSH 已连接，聊天预设可用。
2. SnowLuma 已连接，上游状态没有 `good=false` 或接收退化告警。仅有 WebSocket 连接日志不算安装成功。
3. 管理员与测试目标白名单正确。首次验证可经用户同意临时切到 `chat`，测试后恢复原模式；`reserved2` 可以选择不回复。
4. 请用户从白名单账号向机器人私聊或在白名单群内发送测试消息。观察消息进入桥接、创建或复用 DSH 会话、模型完成回合，并确认 QQ 收到回复。不要未经用户授权主动向好友或群发送测试消息。

可选的 DSH 单独诊断：

```sh
npm run self-test -- http://127.0.0.1:3080
```

将地址替换为实际 DSH 地址。该脚本创建测试会话、调用模型并尝试归档，消耗模型额度，使用 DSH 默认预设；它不验证 QQ 收发。离线回归用 `npm run test:audit`。不要把 `verify:adaptation` 当作纯只读探活，它包含在线 DSH 操作。

交付时简述修改的文件、使用的 profile、启动和停止方式、每项验收结果。没有完成 QQ 往返时，明确说明缺少哪一步，不能报告“全部安装成功”。

## 5. 按症状排错

| 症状 | 先检查 |
| --- | --- |
| `dsh` 找不到或安装脚本失败 | CLI 是否在 PATH，profile 是否正确，依赖安装是否完成。修复后重跑 setup。 |
| DSH 401 | DSH 是否完成初始化，系统用户与 `DSH_HOME` 是否一致，是否误填了旧 `dsh.authToken`。不要打印凭据。 |
| 缺少 `qq-chat` 或 `qq-chat-v2` | 是否安装到了实际 profile，安装是否成功，是否重启了对应 DSH。 |
| HTTP 426 | `snowluma.httpUrl` 是否误用了 WebSocket 端口。 |
| WS 首次 1006，随后连接成功 | 可能是 HTTP 与 WS 令牌不同后的自动恢复；持续失败再查 `homeDir`、账号与 OneBot 配置。 |
| 已连接但收不到 QQ 消息 | 先查白名单、静默状态，再查控制台的 SnowLuma 上游状态与 SnowLuma 自己的 `[Hook]` 日志。 |
| 消息进入但不回复 | 查当前模式、DSH 回合错误、模型可用性、预设及工具加载状态；仿真模式可能主动沉默。 |
| 修改端口后又变回去 | 查 `followDiscoveredEndpoint`，明确固定端点时关闭自动跟随。 |
| 修改预设后仍是旧行为 | 重跑 setup，重启 DSH，并新建或重置目标会话。重置会话前告知用户会清除当前上下文映射。 |

更新时保留配置、状态与角色。执行 `npm install`、重跑实际 profile 的 setup，再重启 DSH 与桥接。不要依赖仓库上级目录中的工具或本地私有文档。
