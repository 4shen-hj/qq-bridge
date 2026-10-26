# DSH 配置说明

首次安装按 [AI 安装手册](../../README.ai.md) 执行，手动安装也适用。本文补充 DSH 预设、MCP 和模型配置的细节。

安装命令为 `node scripts/setup-dsh.mjs <profile>`，省略 profile 时使用 `web`。必须指定实际 DSH 进程使用的 profile；自定义数据目录通过 `DSH_HOME` 设置。安装后重启对应 DSH，预设更新后新建或重置会话。

`dsh/agent-presets/` 是预设源文件，`plugins/qq-agent-presets/` 是安装脚本发布的 bundle。旧 `~/.dsh/.agent-presets/` 目录不再用于加载，也不作为安装成功的依据。

控制台保存或还原仿真提示词时，会发布并核验已注册 profile 的产物。安装缺失或链接指向其他仓库时，先运行本仓库的安装脚本修复。发布失败会尝试恢复本次预设改动；安装脚本此前写入的 MCP、模式插件和外部依赖不在同一事务中，失败后需修复并重跑。

## 配置工具参数格式错误的有界重试

DSH 的 DeepSeek Messages 适配器会拒绝非法的 tool-call 参数 JSON，并报告 `MALFORMED_RESPONSE`。在支持 provider `retryPolicy` 的 DSH 版本中，可让失败的模型请求重新采样。桥接不重新投递原始用户消息，避免重放此前已完成的发送动作。

1. 确认桥接实际连接的 DSH 进程、profile 和 provider。桌面端可能使用 `desktop` profile，不能只修改默认的 `web` profile。
2. 备份该 profile 的 `cordis.patch.yml`。找到实际 provider 的配置行，保留已有连接参数和其他配置，在其 `config` 下合并以下字段：

   ```yaml
   retryPolicy:
     mode: normal
     maxRetries: 2
     retryableCodes:
       - EMPTY_RESPONSE
       - RATE_LIMIT
       - SERVER
       - TIMEOUT
       - TRANSPORT
       - MALFORMED_RESPONSE
   ```

3. 验证 YAML，并通过运行中 DSH 的设置读取确认策略已生效。当前版本若不热加载该配置，需要重载对应 provider 或重启 DSH。

`maxRetries: 2` 表示最多额外请求两次，也影响这个策略中的其他错误。`retryableCodes` 是整表替换；已有自定义错误码需要一并保留。不要使用无界的 `always` 模式。profile 的 provider 配置可能整体覆盖 bundle 配置，修改时必须保留该路由需要的现有字段。安装脚本不会自动覆盖用户的 provider 重试策略。

重试耗尽后，桥接在 `reserved` 和 `reserved2` 模式下静默处理已识别的工具参数 JSON 格式错误。其他回合错误仍给出普通失败提示，原始错误不会发送到 QQ。本地日志保留脱敏诊断。错误和中止回合释放忙状态，但不累计“无行动”或“未设置唤醒”惩罚，也不自动确认未读消息。有效唤醒配置保持不变；如果本次唤醒已消耗唯一的定时器，结束后没有任何唤醒途径，则恢复默认唤醒配置并保留行为计数，不重新投递失败回合。

更新唤醒工具说明后，模型只需提交变化的配置字段。省略 `triggers.keywords` 保留原列表，传 `[]` 清空；配置不变时，在完成观察后用 `qq_mark_read` 和已查看的 `throughSeq` 收尾。预设更新后运行 `node scripts/build-agent-preset-patches.mjs`，并确认运行中的 DSH 已加载更新的预设和 MCP 工具说明。

## 控制模型输入中的重复说明

二代预设保存完整的行为、安全与收尾协议。MCP 工具总说明只介绍用途和必要前置条件，参数细则放在对应 schema 字段。每轮唤醒保留身份、角色名、动态等待数值、消息时间、状态和记忆，不再重复整段参与策略、表情策略与等待教程。

更新二代预设后，运行 `node scripts/setup-dsh.mjs <profile>` 发布 bundle，重启 DSH 和桥接，并新建或重置二代 QQ 会话。`qq-session-tools` 会从当前 DSH 会话取得工具认证；模型调用 `qq_send_message` 时只需填写 `messages` 等动作参数，无需填写会话 key、目标群号或令牌。旧会话仍使用创建时的预设，直到重置。

完整角色卡由 `qq_get_prompt` 提供。首次进入、角色变化、当前上下文缺少人设或需要刷新配置时读取；仅需当前状态时用 `qq_social_state`。角色没有新增“读过就永远省略”的缓存，管理员仍可更新角色。工具名、业务参数、开关、权限检查及发送、已读和等待逻辑保持不变；二代模型工具的会话目标与认证参数由宿主隐藏并填写。

运行 `node scripts/probe-model-input.mjs --output before.json` 可用隔离的 MCP `tools/list` 和合成会话保存输入大小。改动后运行 `node scripts/probe-model-input.mjs --compare before.json --output after.json`，会比较字符数、UTF-8 字节数，并验证去掉说明后的工具声明是否一致。脚本不读取生产配置或调用业务工具；统计不包含历史、其他 MCP、provider 包装或模型分词，不能换算成费用或延迟降幅。

修改后重新生成预设 patch，并重载 DSH 的 QQ MCP 插件与预设；桥接代码在下次启动时加载。已有会话历史不被改写，历史里的旧说明仍可能留在上下文中。

## 验证与排错

连接和 QQ 往返验收按 [AI 安装手册](../../README.ai.md) 执行。`npm run verify:adaptation` 包含在线 DSH 操作，需要独立测试时再运行，不作为只读探活。

离线检查可运行 `node scripts/test-audit-setup.mjs` 和 `node scripts/test-audit-setup-guards.mjs`，验证安装配置和预设工具边界。需要完整离线回归时运行 `npm run test:audit`。

模式通过桥接控制台切换。`qq-mode-console` 只有 host 插件，没有 DSH 设置页的浏览器卡片，因此不能用“设置页没有卡片”判断安装失败。

缺少预设或 MCP 工具时，先核对实际 profile、仓库路径与插件目录链接，再重跑 setup 并重启对应 DSH。安全聊天模式缺少预设时会拒绝建会话，不能改用 `standard` 绕过。
