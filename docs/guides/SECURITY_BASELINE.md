# 安全基线

使用者权限见 [RULES.md](../../RULES.md)。本文件保留信任边界与取舍；更改安全契约时，在同一修改中更新文档及对应测试。

## 信任边界

QQ 内容、模型输出、工具参数和网页都不可信。受限预设缺失、身份无法确认或权限过期时应拒绝操作。新增工具、管理接口和文件路径参数不能靠提示词约束权限。

控制台持有者是管理员。QQ 会话令牌只代表当前会话，不等于控制台权限。修改管理员、模式或会话映射时必须撤销旧授权；异步准备和排队不能绕过发送时的权限复核。

不将 QQ 账号被盗、SnowLuma 或 DSH 被攻陷、操作系统管理员，以及已可读写凭据目录的进程视为本项目能隔离的攻击者。`closed-agent` 有意授予管理员完整本地工具。

## 必须保留的限制

- 文本审计与发布扫描均为启发式，不能证明任意秘密不会泄露。主要边界是访问规则、受限预设和会话授权。
- 凭据和聊天状态明文落盘，依赖操作系统权限保护。Windows ACL 收紧失败会告警但不阻止启动；用户必须能看到该降级状态。
- 收紧 `state/` 后，DSH 沙箱可能无法写入该目录。这是保护凭据的取舍，不应为方便沙箱写入而放宽权限。测试使用临时目录；ACL 诊断运行 `npm run diagnose:acl`。
- 发送到 QQ 没有事务或幂等保证。重置和停止不能撤回已执行的动作；结果不确定时不能盲目重发。断线队列保存在进程内，退出会丢失，恢复不能承诺恰好一次交付。
- 所有桥接发送共享账号级尝试额度和最小间隔，包括文本、表情、语音、拍一拍及操作者发送。语音另受其专用额度限制。尝试时间在调用 QQ 前原子落盘；失败或结果不确定的调用仍占额度，权限拒绝不占额度。额度记录损坏或无法写入时停止发送。
- 队列只保存在内存中，同一会话保持顺序，等待条间间隔的会话不阻塞其他就绪会话。队列满、到期或取消以正常业务结果返回，已成功部分按实际数量报告。请求断开后清除未发送工作；已经交给 QQ 的调用可能仍完成，桥接不会自动重试。重启只恢复尝试记录，不恢复待发消息；首次升级汇总旧会话记录，之后不再重复迁移。旧会话尝试记录保留供迁移写入失败后恢复；账号记录写成后，它是唯一的额度依据。
- 贴纸备注在本账号的会话间共享，不是按群隔离的秘密存储。
- 预设发布在运行失败时尝试恢复文件，不保证断电时多文件同时回滚。安装脚本的外部依赖与其他配置写入不属于同一事务。

## 从实现与测试核对边界

| 关注点 | 实现 | 验证入口 |
| --- | --- | --- |
| 准入、控制台、会话隔离 | [bridge.js](../../src/bridge.js) | [控制台安全](../../scripts/test-audit-security.mjs)、[MCP 安全](../../scripts/test-audit-security-mcp.mjs) |
| 预设工具权限 | [qq-tool-restrict.mjs](../../plugins/qq-agent-presets/qq-tool-restrict.mjs)、[会话工具](../../plugins/qq-agent-presets/qq-session-tools.mjs) | [预设守卫](../../scripts/test-audit-setup-guards.mjs) |
| 内容审计与外网抓取 | [sensitive.js](../../src/sensitive.js)、[safe-fetch.js](../../src/safe-fetch.js) | [加固回归](../../scripts/test-hardening.mjs) |
| 账号发送队列 | [outbound-scheduler.js](../../src/outbound-scheduler.js) | [调度器回归](../../scripts/test-outbound-scheduler.mjs)、[桥接发送回归](../../scripts/test-account-send.mjs) |
| 预设发布 | [preset-publication.js](../../src/preset-publication.js) | [发布回归](../../scripts/test-preset-publication.mjs) |
| 发布隐私 | [privacy-scan.mjs](../../scripts/privacy-scan.mjs) | [扫描回归](../../scripts/test-privacy-scan.mjs) |

工具名、路由、限额及覆盖用例以这些文件为准，不在文档中维护平行清单。

## 验证改动

提交代码改动前运行 `npm run test:audit`，发布前运行 `npm run privacy-scan`。控制台改动补做[浏览器回归](CONSOLE-UI-TESTING.md)，DSH 升级按[维护步骤](DSH_SETUP.md)检查实际安装和工具边界。

离线通过不代表真实操作系统 ACL、QQ 收发或上游版本兼容已验证。Windows ACL 改动还需在有权限的普通终端验证实际保护效果，并检查收紧失败时的告警。
