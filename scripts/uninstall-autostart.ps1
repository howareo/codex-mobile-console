[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$TaskName = "Codex Mobile Console"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$StatePath = Join-Path $ProjectRoot ".runtime\autostart-state.json"

if (-not $Apply) {
  Write-Output "预览：删除登录自启动任务“$TaskName”，不停止当前桌面端、app-server 或手机网关。"
  exit 0
}
if ($Confirmation -ne "REMOVE_CODEX_MOBILE_AUTOSTART") { throw "需要确认词：REMOVE_CODEX_MOBILE_AUTOSTART" }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  if ($task.State -eq "Running") { Stop-ScheduledTask -TaskName $TaskName }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
if (Test-Path -LiteralPath $StatePath) {
  $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json
  [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $state.oldWs, "User")
}
Write-Output "已删除登录自启动任务：$TaskName"
Write-Output "当前运行中的 Codex 桌面端、app-server 和手机网关保持不变。"
