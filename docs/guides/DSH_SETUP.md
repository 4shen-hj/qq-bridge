# DSH 维护

首次安装和连接排错见 [AI 安装手册](../../README.ai.md)。本文只说明更新已有安装时需要额外处理的事项。

## 更新预设

修改人格使用[角色卡](../../roles/README.md)。只有需要改变工具协议或行为规则时，才修改 [dsh/agent-presets/](../../dsh/agent-presets/) 中的预设源。

1. 备份实际 DSH profile 的配置，保留现有角色和状态。
2. 运行 `node scripts/setup-dsh.mjs <profile>`，检查命令成功退出且预设已发布或校验。`<profile>` 必须与运行中的 DSH 一致。
3. 重启对应 DSH。若同时改了桥接代码，也重启桥接。
4. 新建或重置目标会话，验证新预设。旧会话不会因文件更新自动改用新预设。

控制台保存或还原仿真提示词已执行发布步骤，仍需重启 DSH 并更新会话。只运行补丁生成器不等于完成安装；不要手改生成的 patch 文件。

发布失败时修复原因再重跑。预设发布的回滚不涵盖此前的 MCP 配置和外部依赖安装，也不保证断电时多文件一起回滚。实现见 [setup-dsh.mjs](../../scripts/setup-dsh.mjs) 和 [preset-publication.js](../../src/preset-publication.js)。

## 验证 DSH 升级

仓库保留的适配基线为 DSH `0.2.1-rc.2`，SnowLuma 的既有运行记录为 `1.14.20`。这些记录不能证明更新版本兼容。

1. 在隔离配置中升级，记录实际版本、profile 和回退方式。
2. 运行 `npm run test:audit`，检查离线回归。
3. 运行 `npm run scan:tool-names`，核对新 DSH 的工具名与守卫。它扫描本机安装包，候选列表不能替代运行时权限验证。
4. 安装并重启目标 profile，验证两套 QQ 预设和 MCP 可用，并完成 [QQ 往返验收](../../README.ai.md)。

`npm run verify:adaptation` 会检查安装配置、回写 DSH 设置、创建测试会话并调用模型，不是只读探活。当前脚本读取 `DSH_HOME/profiles/web`；其他 profile 先核对并调整验证目标，不能直接套用其结果。具体断言以 [验证脚本](../../scripts/verify-dsh-021-adaptation.mjs)为准。

工具边界由 [qq-tool-restrict.mjs](../../plugins/qq-agent-presets/qq-tool-restrict.mjs)及[权限回归](../../scripts/test-audit-setup-guards.mjs)定义。升级不能通过换成 `standard` 或放宽工具权限来消除错误。

## 配置模型请求重试

当 DSH provider 支持 `retryPolicy` 时，可对工具参数 JSON 格式错误启用有限重试。重试应发生在模型请求层；重新投递整条用户消息可能重复已经完成的 QQ 发送。

备份实际 profile 的 `cordis.patch.yml`，找到当前 provider，在其 `config` 下合并以下配置，保留已有连接参数：

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

`retryableCodes` 会替换整张列表，已有自定义错误码要一并保留。重试次数也影响列表中的其他错误。修改后检查 YAML，重载 provider 或重启 DSH，并确认实际设置生效。安装脚本不替用户修改 provider 重试策略。
