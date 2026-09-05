[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$Reason = 'manual',
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\.runtime'),
  [string]$ListenUrl = 'ws://127.0.0.1:4500',
  [string]$HostAddress = '',
  [int]$GatewayPort = 4174,
  [int]$TimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-mobile-host.ps1')
$HostAddress = Resolve-MobileHostAddress $HostAddress
. (Join-Path $PSScriptRoot 'codex-config-fingerprint.ps1')
$resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeDir)
$url = [Uri]$ListenUrl
if ($url.Scheme -ne 'ws' -or $url.Host -notin @('127.0.0.1', 'localhost', '::1')) {
  throw '共享 app-server 必须使用回环 ws:// 地址。'
}
if ($TimeoutSeconds -lt 10 -or $TimeoutSeconds -gt 120) {
  throw '等待超时必须在 10 到 120 秒之间。'
}

function Get-Listener([int]$Port) {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-VerifiedAppServerOwner {
  $listener = Get-Listener $url.Port
  if (-not $listener) { throw "共享 app-server 未监听端口 $($url.Port)。" }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction Stop
  if ($listener.LocalAddress -notin @('127.0.0.1', '::1') -or $owner.Name -ine 'codex.exe' -or $owner.CommandLine -notmatch '\bapp-server\b') {
    throw "端口 $($url.Port) 不是受管 Codex app-server，已停止重载。"
  }
  return $owner
}

function Get-ReloadBlockers {
  $blockers = [System.Collections.Generic.List[string]]::new()
  $gatewayListener = Get-Listener $GatewayPort
  $gatewayProcessId = if ($gatewayListener) { [int]$gatewayListener.OwningProcess } else { 0 }
  $otherClients = @(
    Get-NetTCPConnection -RemotePort $url.Port -State Established -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -ne $gatewayProcessId } |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  if ($otherClients.Count -gt 0) {
    $blockers.Add("桌面端或其他客户端仍连接 4500（PID：$($otherClients -join ', ')）")
  }
  $phoneConnections = @(
    Get-NetTCPConnection -LocalPort $GatewayPort -State Established -ErrorAction SilentlyContinue
  )
  if ($phoneConnections.Count -gt 0) {
    $blockers.Add("手机端仍连接 $GatewayPort（连接数：$($phoneConnections.Count)）")
  }
  return @($blockers)
}

$record = Get-CodexConfigFingerprintRecord
$markerPath = Join-Path $resolvedRuntime 'pending-app-server-reload.json'
$statePath = Join-Path $resolvedRuntime 'app-server-config-fingerprint.json'
$owner = Get-VerifiedAppServerOwner
$blockers = @(Get-ReloadBlockers)

if (-not $Apply) {
  Write-Output "预览：将为 PID $($owner.ProcessId) 应用配置指纹 $($record.fingerprint)。"
  if ($blockers.Count -gt 0) {
    Write-Output "当前不可重载：$($blockers -join '；')。"
  } else {
    Write-Output '当前连接已清空，可以执行受控重载。'
  }
  Write-Output '预览不会写标记、停止进程或修改配置。'
  exit 0
}
if ($Confirmation -ne 'RELOAD_SHARED_APP_SERVER') {
  throw '需要确认词：RELOAD_SHARED_APP_SERVER'
}

Write-CodexConfigReloadMarker $markerPath $record $Reason | Out-Null
if ($blockers.Count -gt 0) {
  throw "已登记待重载，但当前任务链路仍在使用 app-server：$($blockers -join '；')。关闭 Codex 桌面端和手机页面后重新执行。"
}

$oldPid = [int]$owner.ProcessId
Stop-Process -Id $oldPid -Force -ErrorAction Stop
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Milliseconds 250
  $listener = Get-Listener $url.Port
} while ($listener -and (Get-Date) -lt $deadline)
if ($listener) { throw "旧 app-server PID $oldPid 未在超时内释放端口 $($url.Port)。" }

$ensureScript = Join-Path $PSScriptRoot 'ensure-mobile-stack.ps1'
& $ensureScript -HostAddress $HostAddress -GatewayPort $GatewayPort -AppServerUrl $ListenUrl
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Milliseconds 250
  $listener = Get-Listener $url.Port
} while (-not $listener -and (Get-Date) -lt $deadline)
if (-not $listener) { throw "新 app-server 未在超时内监听端口 $($url.Port)。待重载标记已保留。" }
$newOwner = Get-VerifiedAppServerOwner
if ([int]$newOwner.ProcessId -eq $oldPid) { throw 'app-server PID 未变化，重载验证失败。' }
$applied = Read-CodexConfigFingerprintRecord $statePath
if (-not $applied -or $applied.fingerprint -ne $record.fingerprint) {
  throw '新 app-server 已启动，但配置指纹记录未更新。'
}
$current = Get-CodexConfigFingerprintRecord
if ($current.fingerprint -ne $applied.fingerprint) {
  Write-CodexConfigReloadMarker $markerPath $current 'reload-during-switch' | Out-Null
  throw "配置在重载期间再次变化，已保留最新待处理标记：$($current.fingerprint)"
}
if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
  throw '新 app-server 已启动，但待重载标记仍存在。'
}
Write-Output "app-server 配置重载完成：PID $oldPid -> $($newOwner.ProcessId)。"
Write-Output "已应用指纹：$($applied.fingerprint)"
