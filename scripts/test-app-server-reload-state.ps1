[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'get-app-server-reload-state.ps1')

function Assert-True($Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

$clients = [pscustomobject]@{ Messages = @('Codex Desktop（ChatGPT.exe PID 31976）') }
$ready = [pscustomobject]@{ pid = 123; updatedAt = [DateTime]::UtcNow.ToString('o') }
Assert-True (Test-GatewayMaintenanceReady -Status $ready -ProcessId 123) '新版网关新鲜心跳应允许进入维护流程'
$decoded = $ready | ConvertTo-Json | ConvertFrom-Json
Assert-True (Test-GatewayMaintenanceReady -Status $decoded -ProcessId 123) 'JSON自动转换的UTC日期不得丢失时区'
Assert-True ((ConvertTo-AppServerUtc $decoded.updatedAt) -eq (ConvertTo-AppServerUtc $ready.updatedAt)) 'JSON往返必须保持同一时间点'
Assert-True (-not (Test-GatewayMaintenanceReady -Status $ready -ProcessId 456)) '旧网关进程心跳不得绕过连接保护'
$ready.updatedAt = [DateTime]::UtcNow.AddMinutes(-1).ToString('o')
Assert-True (-not (Test-GatewayMaintenanceReady -Status $ready -ProcessId 123)) '过期心跳必须拒绝'
Assert-True (-not (Test-GatewayMaintenanceReady -Status $null -ProcessId 123)) '旧网关无握手能力必须拒绝'
$idle = [pscustomobject]@{ idle = $false; loaded = 29; busyCount = 2; unknownCount = 0; error = $null }
$lines = Format-AppServerReloadPreview -ProcessId 25948 -Fingerprint 'abc' -PendingSwitch $null -Clients $clients -Idle $idle
Assert-True (($lines -join "`n") -match 'ChatGPT.exe') '预览应写出桌面进程名'
Assert-True (($lines -join "`n") -match 'restart-4500 -Wait') '预览应给出等待模式命令'
Assert-True (($lines -join "`n") -match '2 个仍在跑') '预览应说明会打断正在跑的任务'
Assert-True (($lines -join "`n") -match '不会打断') '预览应说明会等待任务空闲'

$waitLines = Format-AppServerReloadPreview -ProcessId 25948 -Fingerprint 'abc' -PendingSwitch $null -Clients $clients -Idle $idle -Wait -WaitSeconds 180
Assert-True (($waitLines -join "`n") -match '最多等 180 秒') '等待模式预览应包含超时'
Assert-True (($waitLines -join "`n") -match '任务明确空闲') '等待模式应同时等待任务空闲'

$reloadSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'request-app-server-reload.ps1') -Raw
foreach ($required in @('[switch]$Wait', 'RESTART_4500', 'Get-AppServerIdleSnapshot', 'Get-AppServerClientBlockers', 'Resolve-StablePowerShell')) {
  if (-not $reloadSource.Contains($required)) { throw "重载脚本缺少：$required" }
}
$watchSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'watch-mobile-stack.ps1') -Raw
foreach ($required in @('$ReloadRetryCooldownSeconds', '$ReloadMaxAttempts', 'Get-AppServerIdleSnapshot', '待重载等待')) {
  if (-not $watchSource.Contains($required)) { throw "看门缺少：$required" }
}
$mobileSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'codex-mobile.ps1') -Raw
if (-not $mobileSource.Contains('-Wait') -or -not $mobileSource.Contains('WaitSeconds')) { throw '统一入口没有暴露 -Wait' }
$statusSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'show-autostart-status.ps1') -Raw
if (-not $statusSource.Contains('重载等待')) { throw 'status 没有重载等待字段' }
$idleSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\src\probe\idle-cli.ts') -Raw
if ($idleSource -notmatch 'busyCount' -or $idleSource -notmatch 'threadStatus') { throw 'idle-cli 没有返回忙碌任务详情' }

$unknown = [pscustomobject]@{ idle = $false; loaded = 1; busyCount = 0; unknownCount = 1; error = $null }
function Get-AppServerClientBlockers { [pscustomobject]@{ Messages = @() } }
function Get-AppServerIdleSnapshot { $unknown }
$reason = Get-AppServerReloadWaitReason -TargetKey 'target'
Assert-True ($reason -match '状态未知' -and $reason -match '暂停') '未知任务状态必须阻止自动重载'

Write-Output 'PASS: restart-4500 wait mode and safe idle-only reload are wired'
