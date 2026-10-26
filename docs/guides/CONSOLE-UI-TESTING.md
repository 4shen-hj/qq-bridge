# 控制台预览与测试

预览和浏览器回归使用模拟 API，不读取生产配置与状态，不连接 QQ 或 DSH。发送、清空、重启等按钮只影响模拟环境。

## 预览页面

在仓库根目录运行 `npm run preview:console`，打开 `http://127.0.0.1:4173`，按 `Ctrl+C` 停止。需要换端口时运行 `node scripts/console-ui-fixture.mjs --port=4174`。

模拟写请求会打印到终端，也可从预览服务的 `/__fixture/requests` 查看。

## 运行浏览器回归

先安装测试依赖，再运行测试：

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
npm run test:console-ui
node scripts/test-preset-console-ui.mjs
```

Playwright 模块始终必需。已有可用 Chrome 或 Edge 时可复用浏览器，省略 Chromium 下载；检测规则见 [test-console-ui.mjs](../../scripts/test-console-ui.mjs)。自定义模块目录用 `PLAYWRIGHT_MODULE`，浏览器路径用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`。Linux 缺少系统库时按 Playwright 的安装提示补齐。

测试自行启动随机端口的模拟服务，阻止外部浏览器请求，并在结束时关闭服务和浏览器。需要结果和截图时使用 `node scripts/test-console-ui.mjs --artifacts=.audit/console-ui`。

## 维护测试预期

新增控制台接口时同步 [console-ui-fixture.mjs](../../scripts/console-ui-fixture.mjs)，否则未知接口会使测试失败。测试覆盖以脚本中的断言为准。

修改 API 时先核对后端契约，再修改预期。不要把当前页面输出直接重录为正确答案。历史基线仅在核实原页面契约后，用 `node scripts/test-console-ui.mjs --original --record-baseline` 更新；该命令不会验证当前新增功能。

## 区分后端与在线测试

`npm run test-console` 在隔离环境中测试真实控制台路由，使用模拟网关。`node scripts/test-console-safety.mjs` 检查失败清理与在线测试开关。

[test-console.mjs](../../scripts/test-console.mjs) 的 `--live --base <地址>` 配合环境变量 `QQ_CONSOLE_TEST_TOKEN` 连接真实控制台，默认只读。额外启用 `--live-send` 会真实发送消息，必须取得授权并指定 `--kind` 与 `--target`；不会为测试临时扩大白名单。

前后端离线回归都不能替代真实 QQ 往返验收。
