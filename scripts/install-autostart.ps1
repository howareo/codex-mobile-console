[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$TaskName = "Codex Mobile Console",
  [string]$AppServerUrl = "ws://127.0.0.1:4500"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$StatePath = Join-Path $RuntimeDir "autostart-state.json"
$WatchScript = Join-Path $PSScriptRoot "watch-mobile-stack.ps1"
. (Join-Path $PSScriptRoot "resolve-powershell.ps1")
$Pwsh = Resolve-StablePowerShell
$UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not $Apply) {
  Write-Output "预览：为 $UserId 创建登录自启动任务“$TaskName”。"
  Write-Output "预览：看门脚本 $WatchScript"
  Write-Output "预览：每 30 秒检查一次，现有 4500/4174 进程会被复用，不会启动第二个 app-server。"
  exit 0
}
if ($Confirmation -ne "INSTALL_CODEX_MOBILE_AUTOSTART") { throw "需要确认词：INSTALL_CODEX_MOBILE_AUTOSTART" }
if (-not (Test-Path -LiteralPath $WatchScript -PathType Leaf)) { throw "缺少看门脚本：$WatchScript" }

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$oldWs = if (Test-Path -LiteralPath $StatePath -PathType Leaf) {
  (Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json).oldWs
} else {
  [Environment]::GetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", "User")
}
$state = [ordered]@{
  taskName = $TaskName
  userId = $UserId
  oldWs = $oldWs
  installedAt = (Get-Date).ToUniversalTime().ToString("o")
  mode = "watchdog"
}
$state | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
[Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $AppServerUrl, "User")

$actionArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchScript`""
$action = New-ScheduledTaskAction -Execute $Pwsh -Argument $actionArguments -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "登录 Windows 后持续看护共享 Codex app-server 和手机 HTTPS 网关。"
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Write-Output "已安装登录自启动任务：$TaskName"
Write-Output "运行身份：$UserId"
Write-Output "看门间隔：30 秒"
Write-Output "回滚命令：pwsh -File .\scripts\uninstall-autostart.ps1 -Apply -Confirmation REMOVE_CODEX_MOBILE_AUTOSTART"
