[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$TaskName = "Codex Mobile Console"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$WatchScript = Join-Path $PSScriptRoot "watch-mobile-stack.ps1"
. (Join-Path $PSScriptRoot "resolve-powershell.ps1")

if (-not $Apply) {
  Write-Output "预览：将自启动任务“$TaskName”改为稳定的 WindowsApps pwsh 别名；不会停止当前看门、手机网关或 app-server。"
  exit 0
}
if ($Confirmation -ne "UPDATE_CODEX_MOBILE_AUTOSTART_ACTION") { throw "需要确认词：UPDATE_CODEX_MOBILE_AUTOSTART_ACTION" }
if (-not (Test-Path -LiteralPath $WatchScript -PathType Leaf)) { throw "缺少看门脚本：$WatchScript" }

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$backup = Join-Path $RuntimeDir "scheduled-task-before-pwsh-alias.xml"
Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath $backup -Encoding utf8

$pwsh = Resolve-StablePowerShell
$arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$WatchScript`""
$action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $ProjectRoot
Set-ScheduledTask -TaskName $TaskName -Action $action | Out-Null

Write-Output "已更新“$TaskName”的下一次启动动作：$pwsh"
Write-Output "当前看门状态：$($task.State)；未请求停止当前实例。"
Write-Output "原任务定义备份：$backup"
