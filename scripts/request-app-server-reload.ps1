[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$Reason = 'manual',
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\.runtime'),
  [string]$ListenUrl = 'ws://127.0.0.1:4500',
  [string]$HostAddress = '',
  [int]$GatewayPort = 4174,
  [int]$TimeoutSeconds = 30,
  [switch]$Wait,
  [int]$WaitSeconds = 180
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-mobile-host.ps1')
$HostAddress = Resolve-MobileHostAddress $HostAddress
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot 'codex-config-fingerprint.ps1')
. (Join-Path $PSScriptRoot 'codex-binary-update.ps1')
. (Join-Path $PSScriptRoot 'test-app-server-idle.ps1')
. (Join-Path $PSScriptRoot 'get-managed-app-server.ps1')
. (Join-Path $PSScriptRoot 'resolve-powershell.ps1')
. (Join-Path $PSScriptRoot 'stack-diagnostics.ps1')
$resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeDir)
$url = [Uri]$ListenUrl
if ($url.Scheme -ne 'ws' -or $url.Host -notin @('127.0.0.1', 'localhost', '::1')) {
  throw '共享 app-server 必须使用回环 ws:// 地址。'
}
if ($TimeoutSeconds -lt 10 -or $TimeoutSeconds -gt 120) {
  throw '等待超时必须在 10 到 120 秒之间。'
}
if ($WaitSeconds -lt 30 -or $WaitSeconds -gt 600) {
  throw '断开等待必须在 30 到 600 秒之间。'
}
if ($Apply) {
  Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.invoked' -Details @{ reason = $Reason; port = $url.Port }
}

function Get-Listener([int]$Port) {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-VerifiedAppServerOwner {
  return Resolve-ManagedAppServerOwner -Port $url.Port
}

function Get-ReloadBlockers {
  return @((Get-AppServerClientBlockers -AppPort $url.Port -GatewayPort $GatewayPort).Messages)
}

function Invoke-ReloadEnsure([string]$ScriptPath, [string[]]$Arguments, [string]$OutputDirectory, [int]$TimeoutMilliseconds = 120000) {
  $stamp = [Guid]::NewGuid().ToString('N')
  $stdout = Join-Path $OutputDirectory "reload-ensure.$stamp.stdout.log"
  $stderr = Join-Path $OutputDirectory "reload-ensure.$stamp.stderr.log"
  $args = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $ScriptPath)) + $Arguments
  # Wait for this process, not stdout EOF inherited by long-lived descendants.
  $child = Start-Process -FilePath (Resolve-StablePowerShell) -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  if (-not $child.WaitForExit($TimeoutMilliseconds)) {
    Stop-Process -Id $child.Id -Force -ErrorAction Stop
    throw "启动检查超过 $TimeoutMilliseconds 毫秒，进入原版本恢复流程；详情见 reload-ensure 日志。"
  }
  return [pscustomobject]@{ ExitCode = $child.ExitCode; Output = @(Get-Content -LiteralPath $stdout, $stderr -ErrorAction SilentlyContinue) }
}

function Wait-AppServerReady([int]$Seconds = 20) {
  # The protocol probe connects once; a freshly started process needs the same
  # listener + readyz wait that ensure-mobile-stack applies on the forward path.
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    Start-Sleep -Milliseconds 250
    if (Get-Listener $url.Port) {
      try { if ((Invoke-WebRequest -Uri "http://127.0.0.1:$($url.Port)/readyz" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { return $true } } catch { }
    }
  } while ((Get-Date) -lt $deadline)
  return $false
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
$failurePath = Join-Path $resolvedRuntime 'failed-auto-reload.json'
$pendingSwitch = Read-CodexBinaryRecord -Path $switchPath
if ($pendingSwitch -and -not (Test-CodexPendingBinarySwitch -Record $pendingSwitch -Full)) {
  if ($Apply) { Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.refused' -Details @{ stage = 'bundle-validation'; targetVersion = [string]$pendingSwitch.version } }
  throw '待切换 Codex bundle 校验失败，保留当前 4500；请先运行 diagnose。'
}
try { $owner = Get-VerifiedAppServerOwner } catch {
  if ($Apply) { Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.refused' -Details @{ stage = 'owner-identification'; appServer = (Get-StackPortSnapshot -Port $url.Port) } }
  throw
}
$ownerStartedAt = [string]$owner.CreationDate
$reloadTargetKey = "$($record.fingerprint):$($pendingSwitch.codexSha256)"
$clients = Get-AppServerClientBlockers -AppPort $url.Port -GatewayPort $GatewayPort
$blockers = @($clients.Messages)
$idle = Get-AppServerIdleSnapshot -Url $ListenUrl

if (-not $Apply) {
  Format-AppServerReloadPreview -ProcessId $owner.ProcessId -Fingerprint $record.fingerprint -PendingSwitch $pendingSwitch -Clients $clients -Idle $idle -Wait:$Wait -WaitSeconds $WaitSeconds | Write-Output
  exit 0
}
if ($Confirmation -notin @('RELOAD_SHARED_APP_SERVER', 'RESTART_4500')) {
  throw '需要确认词：RELOAD_SHARED_APP_SERVER 或 RESTART_4500'
}

Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.target' -Details @{
  oldPid = [int]$owner.ProcessId
  configFingerprint = $record.fingerprint
  targetVersion = [string]$pendingSwitch.version
  blockers = $blockers.Count
  busyTasks = $idle.busyCount
  unknownTasks = $idle.unknownCount
  idleError = [bool]$idle.error
}
Write-CodexConfigReloadMarker $markerPath $record $Reason | Out-Null
if ($Wait -and ($blockers.Count -gt 0 -or $idle.error -or $idle.unknownCount -gt 0 -or -not $idle.idle)) {
  Write-Output "已登记待重载，最多等待 $WaitSeconds 秒直到桌面和手机断开且任务明确空闲。"
  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  do {
    Start-Sleep -Seconds 5
    $clients = Get-AppServerClientBlockers -AppPort $url.Port -GatewayPort $GatewayPort
    $blockers = @($clients.Messages)
    $idle = Get-AppServerIdleSnapshot -Url $ListenUrl
    $remain = [Math]::Max(0, [int]($deadline - (Get-Date)).TotalSeconds)
    if ($blockers.Count -gt 0) { Write-Output "还连着：$($blockers -join '；')。剩余 $remain 秒。" }
    elseif ($idle.error) { Write-Output "任务空闲检查失败：$($idle.error)。剩余 $remain 秒。" }
    elseif ($idle.unknownCount -gt 0) { Write-Output "还有 $($idle.unknownCount) 个任务状态未知。剩余 $remain 秒。" }
    elseif (-not $idle.idle) { Write-Output "还有 $($idle.busyCount) 个任务在跑。剩余 $remain 秒。" }
  } while (($blockers.Count -gt 0 -or $idle.error -or $idle.unknownCount -gt 0 -or -not $idle.idle) -and (Get-Date) -lt $deadline)
}
if ($blockers.Count -gt 0) {
  Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.deferred' -Details @{ stage = 'clients'; oldPid = [int]$owner.ProcessId; blockers = $blockers }
  throw "已登记待重载，但当前任务链路仍在使用 app-server：$($blockers -join '；')。先关 Codex Desktop 和手机页面，或加上 -Wait 后再关窗口。"
}
if ($idle.error -or $idle.unknownCount -gt 0 -or -not $idle.idle) {
  Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.deferred' -Details @{ stage = 'idle'; oldPid = [int]$owner.ProcessId; busyTasks = $idle.busyCount; unknownTasks = $idle.unknownCount; idleError = [bool]$idle.error }
  throw '已登记待重载，但任务仍在运行、状态未知或空闲检查失败；4500 保持运行。'
}

$oldPid = [int]$owner.ProcessId
$oldBinary = [System.IO.Path]::GetFullPath([string]$owner.ExecutablePath)
$preferredPath = Join-Path $resolvedRuntime 'preferred-app-server-bundle.json'
$oldPreferred = Read-CodexBinaryRecord -Path $preferredPath
$failureStage = 'preflight'
$rollbackAttempted = $false
$rollbackSucceeded = $false
$oldStopped = $false
$healthyNewProcess = $false
$maintenancePath = Join-Path $resolvedRuntime 'gateway-maintenance.json'
$maintenanceOwned = $false
$maintenanceStream = $null
try {
  # Stop accepting mobile requests before the final idle probe. An existing
  # request must finish before its turn can be reliably observed as busy.
  $gateway = Get-Listener $GatewayPort
  if ($gateway) {
    $nonce = [Guid]::NewGuid().ToString()
    if (Test-Path -LiteralPath $maintenancePath) {
      # A live reload holds FileShare.Read, so Windows rejects deleting its gate.
      Remove-Item -LiteralPath $maintenancePath -ErrorAction Stop
    }
    $marker = [System.Text.Encoding]::UTF8.GetBytes((@{ version = 2; nonce = $nonce; ownerPid = $PID } | ConvertTo-Json -Compress))
    $maintenanceStream = [System.IO.File]::Open($maintenancePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    $maintenanceOwned = $true
    $maintenanceStream.Write($marker, 0, $marker.Length)
    $maintenanceStream.Flush()
    $drained = $false
    $drainDeadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 500
      try {
        $ack = Get-Content -LiteralPath (Join-Path $resolvedRuntime 'gateway-maintenance-status.json') -Raw | ConvertFrom-Json
        $ackAge = ([DateTime]::UtcNow - (ConvertTo-AppServerUtc $ack.updatedAt)).TotalSeconds
        $drained = $ack.nonce -eq $nonce -and [int]$ack.pid -eq [int]$gateway.OwningProcess -and [int]$ack.activeRequests -eq 0 -and $ackAge -ge 0 -and $ackAge -lt 3
      } catch { }
    } while (-not $drained -and (Get-Date) -lt $drainDeadline)
    if (-not $drained) { throw '手机网关未确认维护窗口或请求仍在执行；保留 4500，请先更新网关后重试。' }
    Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.gateway-drained' -Details @{ gatewayPid = [int]$gateway.OwningProcess; oldPid = $oldPid }
  }
  if (@(Get-ReloadBlockers).Count -gt 0) { $failureStage = 'clients-raced'; throw '重载暂停：客户端重新连接。' }
  $idleCheck = Get-AppServerIdleSnapshot -Url $ListenUrl
  if ($idleCheck.error -or $idleCheck.unknownCount -gt 0 -or -not $idleCheck.idle) { $failureStage = 'idle-raced'; throw '重载暂停：任务未明确空闲。' }
  $currentOwner = Get-VerifiedAppServerOwner
  if ([int]$currentOwner.ProcessId -ne $oldPid -or -not [string]::Equals([string]$currentOwner.CreationDate, $ownerStartedAt, [StringComparison]::Ordinal)) {
    $failureStage = 'process-raced'
    throw "重载暂停：等待期间 4500 进程身份已变化（原 PID $oldPid，当前 PID $($currentOwner.ProcessId)）。"
  }
  $failureStage = 'stop-old'
  Stop-Process -Id $oldPid -Force -ErrorAction Stop
  $oldStopped = $true
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do { Start-Sleep -Milliseconds 250; $listener = Get-Listener $url.Port } while ($listener -and (Get-Date) -lt $deadline)
  if ($listener) { throw "旧 app-server PID $oldPid 未在超时内释放端口 $($url.Port)。" }
  Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.old-stopped' -Details @{ oldPid = $oldPid }

  $failureStage = 'start-new'
  $ensureResult = Invoke-ReloadEnsure -ScriptPath (Join-Path $PSScriptRoot 'ensure-mobile-stack.ps1') -Arguments @('-HostAddress', $HostAddress, '-GatewayPort', [string]$GatewayPort, '-AppServerUrl', $ListenUrl, '-ApplyPendingSwitch') -OutputDirectory $resolvedRuntime
  $ensureExitCode = $ensureResult.ExitCode
  $ensureOutput = $ensureResult.Output
  if ($ensureExitCode -ne 0) { throw "启动新 app-server 失败（退出码 $ensureExitCode）：$([string]::Join('；', $ensureOutput))" }
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do { Start-Sleep -Milliseconds 250; $listener = Get-Listener $url.Port } while (-not $listener -and (Get-Date) -lt $deadline)
  if (-not $listener) { throw "新 app-server 未在超时内监听端口 $($url.Port)。" }
  $newOwner = Get-VerifiedAppServerOwner
  Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.new-started' -Details @{ oldPid = $oldPid; newPid = [int]$newOwner.ProcessId; targetVersion = [string]$pendingSwitch.version }
  if ([int]$newOwner.ProcessId -eq $oldPid) { throw 'app-server PID 未变化，重载验证失败。' }
  if ($pendingSwitch) {
    $newBinary = [System.IO.Path]::GetFullPath([string]$newOwner.ExecutablePath)
    if (-not [string]::Equals($newBinary, [System.IO.Path]::GetFullPath([string]$pendingSwitch.snapshotBinary), [StringComparison]::OrdinalIgnoreCase)) { throw "新 app-server 未使用待切换版本：$newBinary" }
    if ((Get-FileHash -LiteralPath $newBinary -Algorithm SHA256).Hash -ne [string]$pendingSwitch.codexSha256) { throw '新 app-server 程序哈希验证失败。' }
    if ($pendingSwitch.bundleSha256 -and (Get-CodexBundleContentFingerprint -BinaryPath $newBinary) -ne [string]$pendingSwitch.bundleSha256) { throw '新 app-server 完整 bundle 哈希验证失败。' }
    $newVersion = Get-CodexBinaryVersion -BinaryPath $newBinary
    if ($pendingSwitch.version -and $newVersion -ne [string]$pendingSwitch.version) { throw "新 app-server 版本验证失败：$newVersion" }
  }
  $failureStage = 'verify-protocol'
  $protocol = Assert-AppServerProtocol
  $healthyNewProcess = $true
  Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.verified' -Details @{ oldPid = $oldPid; newPid = [int]$newOwner.ProcessId; threadCount = $protocol.threadCount }
  $applied = Read-CodexConfigFingerprintRecord $statePath
  $current = Get-CodexConfigFingerprintRecord
  if (-not $applied -or $applied.fingerprint -ne $current.fingerprint) {
    Write-CodexConfigReloadMarker $markerPath $current 'reload-during-switch' | Out-Null
    Write-Output "新 app-server 协议验证通过；配置收尾待处理，已保留最新指纹：$($current.fingerprint)"
  }
  $failureStage = 'complete'
  Write-Output "app-server 受控重载完成：PID $oldPid -> $($newOwner.ProcessId)。"
  if ($pendingSwitch) { Write-Output "已切换版本：$(Get-CodexBinaryVersion -BinaryPath $newOwner.ExecutablePath)" }
  Write-Output "协议加载验证：initialize + thread/list 通过，任务数 $($protocol.threadCount)。"
  Write-Output "已应用指纹：$($applied.fingerprint)"
  if (Test-Path -LiteralPath $failurePath) { Remove-Item -LiteralPath $failurePath }
  Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.completed' -Details @{ oldPid = $oldPid; newPid = [int]$newOwner.ProcessId; configFingerprint = $applied.fingerprint; targetVersion = [string]$pendingSwitch.version }
} catch {
  $failure = $_.Exception.Message
  try { Write-CodexConfigReloadMarker $markerPath (Get-CodexConfigFingerprintRecord) 'reload-failed' | Out-Null } catch { }
  # Only restore the switch record this run may have consumed. A run refused
  # before stopping 4500 (e.g. losing to a concurrent reload) holds a stale copy.
  if ($pendingSwitch -and $oldStopped -and -not $healthyNewProcess) { Write-CodexBinaryRecord -Path $switchPath -Record $pendingSwitch }
  $rollbackAttempted = $oldStopped
  $rollbackError = $null
  if ($oldStopped -and -not $healthyNewProcess) {
    try {
      $rollbackListener = Get-Listener $url.Port
      if ($rollbackListener) {
        $rollbackOwner = Get-VerifiedAppServerOwner
        if ([int]$rollbackOwner.ProcessId -ne $oldPid) { Stop-Process -Id ([int]$rollbackOwner.ProcessId) -Force -ErrorAction Stop; Start-Sleep -Milliseconds 500 }
      }
      if (-not (Get-Listener $url.Port) -and (Test-CodexBundle -BinaryPath $oldBinary)) {
        & (Join-Path $PSScriptRoot 'start-shared-app-server.ps1') -Apply -Confirmation START_SHARED_APP_SERVER -ListenUrl $ListenUrl -CodexBinary $oldBinary -RuntimeDir $resolvedRuntime | Out-Null
        if ($oldPreferred -and $oldPreferred.sourceBinary) { Set-PreferredCodexBundle -RuntimeDir $resolvedRuntime -SourceBinary ([string]$oldPreferred.sourceBinary) -SnapshotBinary $oldBinary | Out-Null }
        if (-not (Wait-AppServerReady -Seconds 20)) { throw '原版本 app-server 未在 20 秒内通过 readyz。' }
        [void](Assert-AppServerProtocol)
        $rollbackSucceeded = $true
      }
    } catch { $rollbackError = $_.Exception.Message }
  }
  if ($Reason -eq 'watchdog-maintenance' -and -not $healthyNewProcess) {
    try {
      Write-AppServerReloadFailure -Path $failurePath -TargetKey $reloadTargetKey -Stage $failureStage -ExitCode 1 -Message $failure -SourceProcessId $oldPid -SourceProcessStartedAt $ownerStartedAt -RollbackAttempted $rollbackAttempted -RollbackSucceeded $rollbackSucceeded -TargetVersion ([string]$pendingSwitch.version) -TargetSha256 ([string]$pendingSwitch.codexSha256) | Out-Null
    } catch { }
  }
  Write-StackEvent -RuntimeDir $resolvedRuntime -Event 'reload.failed' -Details @{
    stage = $failureStage
    error = $failure
    oldPid = $oldPid
    oldStopped = $oldStopped
    newProcessVerified = $healthyNewProcess
    rollbackAttempted = $rollbackAttempted
    rollbackSucceeded = $rollbackSucceeded
    rollbackError = $rollbackError
    appServer = Get-StackPortSnapshot -Port $url.Port
  }
  if ($rollbackError) { throw "重载失败且原版本恢复验证也失败，待处理标记已保留：$failure；恢复错误：$rollbackError" }
  if ($healthyNewProcess) { throw "新 app-server 已通过协议验证，但收尾步骤异常；健康进程保持运行：$failure" }
  if (-not $oldStopped) { throw "重载在停止旧进程前暂停，原 4500 保持运行且待处理标记已保留：$failure" }
  if ($rollbackSucceeded) { throw "重载失败，原版本已恢复且待处理标记已保留：$failure" }
  throw "重载失败，原版本恢复状态未确认，待处理标记已保留：$failure"
} finally {
  if ($maintenanceStream) { $maintenanceStream.Dispose() }
  if ($maintenanceOwned -and (Test-Path -LiteralPath $maintenancePath)) {
    try {
      $currentGate = Get-Content -LiteralPath $maintenancePath -Raw | ConvertFrom-Json
      if ($currentGate.nonce -eq $nonce) { Remove-Item -LiteralPath $maintenancePath -ErrorAction Stop }
    } catch { Write-Warning '维护标记清理未完成；已释放文件锁，不会继续阻塞手机。' }
  }
}
