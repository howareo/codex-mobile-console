# Codex Mobile Console 全面审查（2026-08-16）

## 结论

本次资源问题由三个因素叠加造成：

1. 浏览器 MCP 入口在用户全局配置中启用，使每个被 app-server 加载的 task 都可能启动一套浏览器工具运行时。
2. 手机打开 task 时会同时调用 `thread/turns/list` 和 `thread/read`；现场记录表明批量 `thread/read` 与新 MCP 运行时出现的时间一致。
3. 手机网关发送消息时会 `thread/resume`，但手机返回列表或切换到其他页面时没有显式取消实时订阅，延长了 task 运行时的驻留时间。

现场有多套已加载 task，各自持有工具运行时。它们不是同一个 task 内重复创建，而是多个 task 分别加载造成资源叠加。

## 已修复

- 关闭全局浏览器 MCP 入口。
- 仅在明确需要的项目配置中注册浏览器 MCP。
- 将浏览器 MCP 固定为已验证版本，不使用浮动的 `@latest`。
- 打开、刷新和翻页 task 时只调用 `thread/turns/list`，不再自动调用 `thread/read`。
- 手机返回任务列表、进入“实时”或“设置”页面时，主动发送 `thread/unsubscribe`。
- 服务端忽略同一 WebSocket 对同一 task 的重复订阅，避免重复首页快照。
- 停止 task 完成后补做空闲释放，覆盖“空闲通知先于 interrupt 返回”的竞态。
- 增加 CSP、HSTS、`nosniff`、点击劫持、Referrer 和浏览器权限策略响应头。

## 线上验证

- 共享 app-server 在验证期间保持同一进程，未停止、未重启。
- 手机网关已切换到新的受管进程，访问地址使用部署机器的私网入口（具体地址不记录）。
- 移动端和指定项目的 MCP 配置均加载正常。
- TypeScript 类型检查通过；Vitest `34/34` 通过；生产构建通过。
- 官方 npm 审计端点报告生产依赖漏洞 `0`。
- 未登录访问 `/api/health` 返回 `401`；原始 app-server 仍只监听 `127.0.0.1:4500`。
- 真实调用任务列表后打开一个 task，返回 10 轮记录；该时间窗内网关日志的 `thread/read` 次数为 `0`。
- 最终资源审计确认旧工具运行时数量下降，且没有产生新的重复实例。
- 当前 app-server 稳定快照的来源与桌面端当前安装目录一致，没有旧 binary 漂移。

## 剩余风险

### P1：旧 task 运行时仍占用内存

现有工具运行时属于已经加载的 task。本次没有批量结束子进程，也没有对未知归属的 task 强制 `thread/unsubscribe`，避免打断桌面端正在运行的工作。配置修复负责阻止非目标项目再启动浏览器 MCP；已有进程要等 task 被 app-server 卸载，或在所有 task 空闲时做一次受控 app-server 维护重启后才会全部回收。

### P1：Node REPL 路径仍包含版本目录

全局配置中的 `node_repl.exe` 当前路径存在，因此现在可用。但路径仍包含版本目录标识，未来桌面端升级并清理旧运行时时可能再次失效。建议单独实现版本无关的 Node REPL 解析与原子切换，先验证新路径，再在维护窗口更新配置；不要在正在运行的 app-server 上直接替换工具 host。

### P2：资源审计缺少 task 名称映射

`thread/loaded/list` 只返回 task ID，当前审计能准确统计进程树和内存，但不能在不逐项读取 task 的情况下显示名称和工作区。建议后续让网关记录自己执行过的 `thread/resume` / `thread/unsubscribe` 配对，并在诊断页展示“网关持有的 task 数”，这样可以区分桌面端持有和手机端持有。

### P2：任务列表不提供模型和推理强度

当前协议的 `thread/list` 和现场 `/api/threads` 响应均不包含 `model`、`reasoningEffort`。因此普通打开 task 不再预读 metadata 后，参数栏会显示“跟随任务设置”，不会套用手机端默认值；发送前仍会执行一次 `thread/read`，以真实会话设置为准。若后续要求在发送前显示具体值，应新增用户展开参数栏时的按需 metadata 读取，不能恢复为每次打开 task 自动读取。

### P2：默认 npm 镜像不支持安全审计

`registry.npmmirror.com` 对 npm audit 接口返回 404。使用官方端点验证为 0 漏洞。后续 CI 或人工检查应显式使用：

```powershell
npm audit --registry=https://registry.npmjs.org --omit=dev
```

## 回滚

这份审查记录只保留问题模式和验证结论，不包含任何部署机器的配置备份或回滚命令。运行时回滚请按照 README 中的通用回滚流程执行，并先在维护窗口确认客户端和任务均已停止。
