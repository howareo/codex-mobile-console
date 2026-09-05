# 人工应急回滚

回滚脚本不会使用 `.runtime\cutover-state.json` 中记录的旧版
`ChatGPT.exe` 路径。每次执行都会从当前已安装的 `OpenAI.Codex` 包中动态解析
最新可用的 `app\ChatGPT.exe`，因此 Codex Desktop 升级后不需要修改本文档。

## 1. 先做预检

打开 PowerShell：

```powershell
$ProjectRoot = 'C:\path\to\codex-mobile-console' # 改成实际项目目录
Set-Location $ProjectRoot
pwsh -File .\scripts\rollback.ps1
```

预检会完成以下检查，但不会停止进程、修改环境变量或启动程序：

- `.runtime\cutover-state.json` 可以解析，环境变量备份字段类型正确。
- `listenUrl` 是回环 `ws://` 地址。
- 当前安装的 Codex Desktop 中存在可用的 `app\ChatGPT.exe`。
- 如果 4500 正在监听，其所有者必须是回环上的 `codex.exe app-server`。
- “Codex Mobile Console”计划任务必须确实指向当前项目的看门脚本。

看到“回滚预检通过”和“DRY-RUN”后，再执行正式回滚。

## 2. 执行回滚

```powershell
pwsh -File .\scripts\rollback.ps1 -Apply -Confirmation ROLLBACK_SHARED_APP_SERVER
```

脚本只会在全部预检通过后执行以下动作：先停止并禁用手机看门任务，防止它重新
拉起共享 app-server；停止 Codex Desktop；停止经过身份校验的共享 app-server；
恢复切换前的用户级和当前 PowerShell 环境变量；从当前安装目录启动 Codex
Desktop。脚本不会读取或修改 `state_5.sqlite`，也不会删除 `.runtime` 中的状态
文件和日志。

回滚后手机控制台不会自动启动。确认需要重新启用时执行：

```powershell
pwsh -File .\scripts\install-autostart.ps1 -Apply -Confirmation INSTALL_CODEX_MOBILE_AUTOSTART
```

## 3. 解析失败时

如果提示“未找到可用的 `app\ChatGPT.exe`”，脚本尚未停止任何进程，也没有修改
环境变量。先在 Microsoft Store 中完成 Codex Desktop 安装或升级，再重新运行预检。
不要把 `C:\Program Files\WindowsApps\OpenAI.Codex_版本号...` 写进脚本或文档。

可以单独验证动态解析器：

```powershell
. .\scripts\resolve-codex-desktop.ps1
Resolve-CodexDesktopExecutable
```

## 4. 验证回滚脚本

下面的测试只使用临时目录和 dry-run，不会停止当前 PID 36936 或任何
`ChatGPT.exe`：

```powershell
pwsh -File .\scripts\test-rollback-preflight.ps1
```
