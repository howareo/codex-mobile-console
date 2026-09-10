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
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot 'resolve-mobile-host.ps1')
$HostAddress = Resolve-MobileHostAddress $HostAddress
. (Join-Path $PSScriptRoot 'codex-config-fingerprint.ps1')
. (Join-Path $PSScriptRoot 'codex-binary-update.ps1')
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

function Assert-AppServerProtocol {
  $projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
  $entry = Join-Path $projectRoot 'dist\server\probe\protocol-health-cli.js'
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw "缺少协议检查程序：$entry" }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $output = @(& $node $entry --url $ListenUrl --timeout-ms '8000' 2>&1)
  $exitCode = $LASTEXITCODE
  try { $result = ([string]::Join("`n", $output)) | ConvertFrom-Json -ErrorAction Stop } catch { throw "新 app-server 协议输出无法解析：$([string]::Join(' ', $output))" }
  if ($exitCode -ne 0 -or -not $result.ok -or -not $result.initialize -or -not $result.threadList) {
    throw "新 app-server 协议验证失败：initialize=$($result.initialize)，thread/list=$($result.threadList)，原因=$($result.error)"
  }
  return $result
}

$record = Get-CodexConfigFingerprintRecord
$markerPath = Join-Path $resolvedRuntime 'pending-app-server-reload.json'
$statePath = Join-Path $resolvedRuntime 'app-server-config-fingerprint.json'
$switchPath = Join-Path $resolvedRuntime 'pending-app-server-switch.json'
$pendingSwitch = Read-CodexBinaryRecord -Path $switchPath
if ($pendingSwitch -and -not (Test-CodexPendingBinarySwitch -Record $pendingSwitch -Full)) {
  throw '待切换 Codex bundle 校验失败，保留当前 4500；请先运行 diagnose。'
}
$owner = Get-VerifiedAppServerOwner
$blockers = @(Get-ReloadBlockers)

if (-not $Apply) {
  Write-Output "预览：将为 PID $($owner.ProcessId) 应用配置指纹 $($record.fingerprint)。"
  if ($pendingSwitch) { Write-Output "版本切换：$($pendingSwitch.version)，目标 $($pendingSwitch.snapshotBinary)。" }
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
$oldBinary = [System.IO.Path]::GetFullPath([string]$owner.ExecutablePath)
$preferredPath = Join-Path $resolvedRuntime 'preferred-app-server-bundle.json'
$oldPreferred = Read-CodexBinaryRecord -Path $preferredPath
try {
  Stop-Process -Id $oldPid -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do { Start-Sleep -Milliseconds 250; $listener = Get-Listener $url.Port } while ($listener -and (Get-Date) -lt $deadline)
  if ($listener) { throw "旧 app-server PID $oldPid 未在超时内释放端口 $($url.Port)。" }

  & (Join-Path $PSScriptRoot 'ensure-mobile-stack.ps1') -HostAddress $HostAddress -GatewayPort $GatewayPort -AppServerUrl $ListenUrl -ApplyPendingSwitch
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do { Start-Sleep -Milliseconds 250; $listener = Get-Listener $url.Port } while (-not $listener -and (Get-Date) -lt $deadline)
  if (-not $listener) { throw "新 app-server 未在超时内监听端口 $($url.Port)。" }
  $newOwner = Get-VerifiedAppServerOwner
  if ([int]$newOwner.ProcessId -eq $oldPid) { throw 'app-server PID 未变化，重载验证失败。' }
  if ($pendingSwitch) {
    $newBinary = [System.IO.Path]::GetFullPath([string]$newOwner.ExecutablePath)
    if (-not [string]::Equals($newBinary, [System.IO.Path]::GetFullPath([string]$pendingSwitch.snapshotBinary), [StringComparison]::OrdinalIgnoreCase)) { throw "新 app-server 未使用待切换版本：$newBinary" }
    if ((Get-FileHash -LiteralPath $newBinary -Algorithm SHA256).Hash -ne [string]$pendingSwitch.codexSha256) { throw '新 app-server 程序哈希验证失败。' }
    if ($pendingSwitch.bundleSha256 -and (Get-CodexBundleContentFingerprint -BinaryPath $newBinary) -ne [string]$pendingSwitch.bundleSha256) { throw '新 app-server 完整 bundle 哈希验证失败。' }
    $newVersion = Get-CodexBinaryVersion -BinaryPath $newBinary
    if ($pendingSwitch.version -and $newVersion -ne [string]$pendingSwitch.version) { throw "新 app-server 版本验证失败：$newVersion" }
    if (Test-Path -LiteralPath $switchPath -PathType Leaf) { throw '新 app-server 已启动，但版本待切换标记仍存在。' }
  }
  $protocol = Assert-AppServerProtocol
  $applied = Read-CodexConfigFingerprintRecord $statePath
  if (-not $applied -or $applied.fingerprint -ne $record.fingerprint) { throw '新 app-server 已启动，但配置指纹记录未更新。' }
  $current = Get-CodexConfigFingerprintRecord
  if ($current.fingerprint -ne $applied.fingerprint) {
    Write-CodexConfigReloadMarker $markerPath $current 'reload-during-switch' | Out-Null
    throw "配置在重载期间再次变化，已保留最新待处理标记：$($current.fingerprint)"
  }
  if (Test-Path -LiteralPath $markerPath -PathType Leaf) { throw '新 app-server 已启动，但待重载标记仍存在。' }
  Write-Output "app-server 受控重载完成：PID $oldPid -> $($newOwner.ProcessId)。"
  if ($pendingSwitch) { Write-Output "已切换版本：$(Get-CodexBinaryVersion -BinaryPath $newOwner.ExecutablePath)" }
  Write-Output "协议加载验证：initialize + thread/list 通过，任务数 $($protocol.threadCount)。"
  Write-Output "已应用指纹：$($applied.fingerprint)"
} catch {
  $failure = $_.Exception.Message
  try { Write-CodexConfigReloadMarker $markerPath (Get-CodexConfigFingerprintRecord) 'reload-failed' | Out-Null } catch { }
  if ($pendingSwitch) { Write-CodexBinaryRecord -Path $switchPath -Record $pendingSwitch }
  $rollbackListener = Get-Listener $url.Port
  if ($rollbackListener) {
    $rollbackOwner = Get-VerifiedAppServerOwner
    if ([int]$rollbackOwner.ProcessId -ne $oldPid) { Stop-Process -Id ([int]$rollbackOwner.ProcessId) -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
  }
  $rollbackError = $null
  try {
    if (-not (Get-Listener $url.Port) -and (Test-CodexBundle -BinaryPath $oldBinary)) {
      & (Join-Path $PSScriptRoot 'start-shared-app-server.ps1') -Apply -Confirmation START_SHARED_APP_SERVER -ListenUrl $ListenUrl -CodexBinary $oldBinary -RuntimeDir $resolvedRuntime | Out-Null
      if ($oldPreferred -and $oldPreferred.sourceBinary) { Set-PreferredCodexBundle -RuntimeDir $resolvedRuntime -SourceBinary ([string]$oldPreferred.sourceBinary) -SnapshotBinary $oldBinary | Out-Null }
      [void](Assert-AppServerProtocol)
    }
  } catch { $rollbackError = $_.Exception.Message }
  if ($rollbackError) { throw "重载失败且原版本恢复验证也失败，待处理标记已保留：$failure；恢复错误：$rollbackError" }
  throw "重载失败，原版本已恢复且待处理标记已保留：$failure"
}
