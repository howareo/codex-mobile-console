# Codex 升级规律与处理手册

## 这次日志的规律

1. **配置语义错误先于运行时升级。** 05:53-07:08 的 Desktop 日志反复出现 `failed to load configuration: invalid transport in mcp_servers.codex_app`，因此旧会话的 `thread/start` 和 `thread/resume` 都失败。这类错误不是任务数据损坏，也不是 API key 失效；修复配置条目后才会恢复。
2. **Desktop 外壳和 primary runtime 分开升级。** 08:50-08:51 安装了 `26.826.12353` primary runtime，而 WindowsApps 外壳仍是 `26.820.9563.0`。不能用外壳版本推断实际 app-server 版本。
3. **共享 app-server 需要重新握手。** 07:13-07:17 多个 Desktop 实例记录 `initialize handshake timed out`，对应 4500 在重启/连接切换期间尚未 ready。仅看到端口监听不等于协议已就绪。
4. **路径是易失的。** WindowsApps 每次安装会产生新目录；把路径写死到首选记录会让下一次升级后的启动失败。运行时快照必须保存到项目 `.runtime\codex-bundles`，并从当前安装重新生成。
5. **云端登录错误是独立噪声。** 自定义 provider 下出现 `ChatGPT.com Unauthorized` 属于 Desktop 云端附加功能未登录，不代表本地 4500 故障。

## 现在的自动化边界

- 看门每 30 秒检查 4500、4174、`readyz` 和配置可读性。
- 发现 Desktop 或 primary runtime 更新时，只预存新快照；活动连接保持不动。
- app-server 异常退出时，自动从当前完整 bundle 启动，并验证 `readyz=200` 后才写入运行记录。
- `mcp_servers.codex_app` 缺少 `command` 会在指纹阶段直接标记为配置错误，避免把坏配置当成健康状态。
- 配置和凭据只记录 SHA-256 指纹，不记录 key；不修改 `state_5.sqlite`。

## 日常排障顺序

```powershell
$ProjectRoot = 'C:\path\to\codex-mobile-console' # 改成实际项目目录
Set-Location $ProjectRoot
pwsh -File .\scripts\diagnose-codex-stack.ps1
pwsh -File .\scripts\show-autostart-status.ps1
```

看到 `healthz=200`、`readyz=200` 且版本正常时，继续使用桌面端即可。看到配置 `readable=false`，先修复配置文件本身；看到 `pending`，关闭桌面端和手机页面后让看门自动在维护窗口重载。不要直接杀 4500，也不要编辑会话数据库。

## 回滚原则

- 新 bundle 启动失败时上一个已验证快照仍保留，首选记录不会被坏文件覆盖；看门会继续重试，必要时可用 `switch-shared-app-server.ps1` 明确切回该快照。
- 需要撤销本次代码修复时使用 Git 提交 `99a8e0d` 的反向提交；运行中的 4500、4174 和会话库不受影响。
- 手机网关异常单独处理，不通过重启 4500 来修复 4174。
