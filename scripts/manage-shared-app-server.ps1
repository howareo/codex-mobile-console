[CmdletBinding()]
param(
  [ValidateSet('Start', 'Stop')]
  [string]$Action,
  [switch]$Apply,
  [string]$Confirmation,
  [string]$ListenUrl = 'ws://127.0.0.1:4500',
  [string]$HostAddress = '',
  [int]$GatewayPort = 4174,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-mobile-host.ps1')
$HostAddress = Resolve-MobileHostAddress $HostAddress
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskName = 'Codex Mobile Console'
$url = [Uri]$ListenUrl
if ($url.Scheme -ne 'ws' -or $url.Host -notin @('127.0.0.1', 'localhost', '::1')) { throw '共享 app-server 必须使用回环 ws:// 地址。' }

function Get-Listener {
  Get-NetTCPConnection -LocalPort $url.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-VerifiedOwner {
  $listener = Get-Listener
  if (-not $listener) { return $null }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
  if ($listener.LocalAddress -notin @('127.0.0.1', '::1') -or $owner.Name -ine 'codex.exe' -or $owner.CommandLine -notmatch '\bapp-server\b') {
    throw "端口 $($url.Port) 不是受管 Codex app-server，未操作该进程。"
  }
  return $owner
}

function Get-StopBlockers {
  $gatewayListener = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $gatewayPid = if ($gatewayListener) { [int]$gatewayListener.OwningProcess } else { 0 }
  $desktopClients = @(
    Get-NetTCPConnection -RemotePort $url.Port -State Established -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -ne $gatewayPid } |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  $phoneConnections = @(Get-NetTCPConnection -LocalPort $GatewayPort -State Established -ErrorAction SilentlyContinue)
  $blockers = [System.Collections.Generic.List[string]]::new()
  if ($desktopClients.Count -gt 0) { $blockers.Add("桌面端或其他客户端仍连接 4500（PID：$($desktopClients -join ', ')）") }
  if ($phoneConnections.Count -gt 0) { $blockers.Add("手机端仍连接 $GatewayPort（连接数：$($phoneConnections.Count)）") }
  return @($blockers)
}

if ($Action -eq 'Start') {
  $owner = Get-VerifiedOwner
  if ($owner) {
    Write-Output "4500 已经运行，PID $($owner.ProcessId)，未启动第二个实例。"
  } else {
    $other = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'codex.exe' -and $_.CommandLine -match '\bapp-server\b' })
    if ($other.Count -gt 0) { throw "检测到其他 app-server（PID：$($other.ProcessId -join ', ')），未启动第二个实例。" }
    & (Join-Path $PSScriptRoot 'ensure-mobile-stack.ps1') -HostAddress $HostAddress -GatewayPort $GatewayPort -AppServerUrl $ListenUrl
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do { Start-Sleep -Milliseconds 250; $owner = Get-VerifiedOwner } while (-not $owner -and (Get-Date) -lt $deadline)
    if (-not $owner) { throw '4500 未在超时内启动。' }
    Write-Output "4500 已启动，PID $($owner.ProcessId)。"
  }
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task -and $task.State -ne 'Running') { Start-ScheduledTask -TaskName $taskName; Write-Output '看门已恢复运行。' }
  & (Join-Path $PSScriptRoot 'test-app-server-protocol.ps1') -Url $ListenUrl
  exit $LASTEXITCODE
}

$owner = Get-VerifiedOwner
$blockers = @(Get-StopBlockers)
if (-not $Apply) {
  Write-Output "预览：$(if ($owner) { "将停止 4500 PID $($owner.ProcessId)" } else { '4500 当前未运行' })，并暂停看门，防止自动拉起。"
  if ($blockers.Count -gt 0) { Write-Output "当前不可停止：$($blockers -join '；')。" }
  else { Write-Output '当前连接已清空，可以停止。' }
  Write-Output '预览不会停止任何进程。'
  exit 0
}
if ($Confirmation -ne 'STOP_SHARED_APP_SERVER') { throw '需要确认词：STOP_SHARED_APP_SERVER' }
if ($blockers.Count -gt 0) { throw "当前任务链路仍在使用 4500：$($blockers -join '；')。" }

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $taskName
  $deadline = (Get-Date).AddSeconds(10)
  do { Start-Sleep -Milliseconds 250; $task = Get-ScheduledTask -TaskName $taskName } while ($task.State -eq 'Running' -and (Get-Date) -lt $deadline)
  if ($task.State -eq 'Running') { throw '看门未能暂停，保留 4500。' }
}

$owner = Get-VerifiedOwner
if ($owner) {
  Stop-Process -Id ([int]$owner.ProcessId) -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do { Start-Sleep -Milliseconds 250; $listener = Get-Listener } while ($listener -and (Get-Date) -lt $deadline)
  if ($listener) { throw "4500 PID $($owner.ProcessId) 未在超时内退出。" }
  Write-Output "4500 已停止，原 PID $($owner.ProcessId)。"
} else {
  Write-Output '4500 原本未运行。'
}
Write-Output '看门已暂停；4174 保持运行但在 4500 恢复前不能读取任务。使用 start-4500 恢复。'
