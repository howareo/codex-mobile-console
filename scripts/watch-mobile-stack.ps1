[CmdletBinding()]
param(
  [string]$HostAddress = '',
  [int]$GatewayPort = 4174,
  [string]$AppServerUrl = "ws://127.0.0.1:4500",
  [int]$IntervalSeconds = 30,
  [int]$EnsureTimeoutSeconds = 240,
  # Must exceed the reload child's own worst case (drain 15 + stop 30 +
  # ensure 120 + listen 30 + verify, plus rollback readyz 20 + verify) so the
  # watchdog never kills it mid-rollback.
  [int]$ReloadTimeoutSeconds = 420,
  [int]$ReloadQuietChecks = 2,
  [int]$ReloadRetryCooldownSeconds = 300,
  [int]$ReloadMaxAttempts = 3,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot 'resolve-mobile-host.ps1')
$HostAddress = Resolve-MobileHostAddress $HostAddress
. (Join-Path $PSScriptRoot "resolve-codex-binary.ps1")
. (Join-Path $PSScriptRoot "resolve-powershell.ps1")
. (Join-Path $PSScriptRoot "ensure-claude-backend.ps1")
. (Join-Path $PSScriptRoot "codex-config-fingerprint.ps1")
. (Join-Path $PSScriptRoot "codex-binary-update.ps1")
. (Join-Path $PSScriptRoot 'test-app-server-idle.ps1')
. (Join-Path $PSScriptRoot 'get-managed-app-server.ps1')
. (Join-Path $PSScriptRoot 'stack-diagnostics.ps1')
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$LogPath = Join-Path $RuntimeDir "autostart.log"
$EnsureScript = Join-Path $PSScriptRoot "ensure-mobile-stack.ps1"
$ReloadScript = Join-Path $PSScriptRoot "request-app-server-reload.ps1"
$ConfigStatePath = Join-Path $RuntimeDir "app-server-config-fingerprint.json"
$PendingReloadPath = Join-Path $RuntimeDir "pending-app-server-reload.json"
$FailedReloadPath = Join-Path $RuntimeDir 'failed-auto-reload.json'
$Mutex = [Threading.Mutex]::new($false, "Local\CodexMobileConsoleWatchdog")

if ($IntervalSeconds -lt 10 -or $IntervalSeconds -gt 600) {
  throw "检查间隔必须在 10 到 600 秒之间。"
}
if ($EnsureTimeoutSeconds -lt 30 -or $EnsureTimeoutSeconds -gt 900) {
  throw "启动检查超时必须在 30 到 900 秒之间。"
}
if ($ReloadTimeoutSeconds -lt 300 -or $ReloadTimeoutSeconds -gt 900) {
  throw "配置重载超时必须在 300 到 900 秒之间。"
}
if ($ReloadQuietChecks -lt 2 -or $ReloadQuietChecks -gt 10) {
  throw "配置重载空闲检查次数必须在 2 到 10 次之间。"
}
if ($ReloadRetryCooldownSeconds -lt 60 -or $ReloadRetryCooldownSeconds -gt 3600) {
  throw "自动重载失败冷却必须在 60 到 3600 秒之间。"
}
if ($ReloadMaxAttempts -lt 1 -or $ReloadMaxAttempts -gt 10) {
  throw "同一目标自动重载最大尝试次数必须在 1 到 10 次之间。"
}
if (-not (Test-Path -LiteralPath $EnsureScript -PathType Leaf)) {
  throw "缺少启动检查脚本：$EnsureScript"
}

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

function Write-WatchLog([string]$Message) {
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $Message
  Add-Content -LiteralPath $LogPath -Value $line -Encoding utf8
}

function Get-Listener([int]$Port) {
  return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-GatewayHealthPayload([string]$Address, [int]$Port) {
  try {
    $response = Invoke-RestMethod -Uri "https://${Address}:$Port/api/healthz" -SkipCertificateCheck -TimeoutSec 3
    if ($response.ok -eq $true -and $response.service -eq 'codex-mobile-console') { return $response }
  } catch { }
  return $null
}

# Process alive is not the same as usable: report the gateway's own view of
# its upstream and maintenance gate separately (older gateways omit both).
function Format-GatewayState($Health) {
  if (-not $Health) { return '缺失' }
  if ($Health.maintenance -eq $true) { return '存活-维护中' }
  if ($Health.upstream -and [string]$Health.upstream -ne 'open') { return "存活-上游未连接($($Health.upstream))" }
  return '正常'
}

function Sync-AppServerState($Owner) {
  $binaryPath = [System.IO.Path]::GetFullPath([string]$Owner.ExecutablePath)
  $sourceBinary = $binaryPath
  $manifestPath = Join-Path (Split-Path -Parent $binaryPath) 'bundle.json'
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
      if ($manifest.sourceDirectory) { $sourceBinary = Join-Path ([string]$manifest.sourceDirectory) 'codex.exe' }
    } catch { }
  }
  $statePath = Join-Path $RuntimeDir 'shared-app-server.json'
  $existing = if (Test-Path -LiteralPath $statePath -PathType Leaf) { try { Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json } catch { $null } } else { $null }
  if ($existing -and [int]$existing.pid -eq [int]$Owner.ProcessId -and [string]::Equals([string]$existing.binary, $binaryPath, [StringComparison]::OrdinalIgnoreCase)) { return }
  $startedAt = try { ([DateTime]$Owner.CreationDate).ToUniversalTime().ToString('o') } catch { $null }
  $record = [ordered]@{ pid = [int]$Owner.ProcessId; binary = $binaryPath; sourceBinary = [System.IO.Path]::GetFullPath($sourceBinary); listenUrl = $AppServerUrl; startedAt = $startedAt }
  $tmp = "$statePath.$PID.tmp"
  $record | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding utf8
  Move-Item -LiteralPath $tmp -Destination $statePath -Force
  Write-WatchLog "已同步共享 app-server 运行记录：PID $($Owner.ProcessId)。"
}

function Test-AppServer([Uri]$Uri) {
  try {
    $owner = Resolve-ManagedAppServerOwner -Port $Uri.Port -AllowMissing
    if (-not $owner) { return $false }
    if (-not (Test-CodexBundle -BinaryPath $owner.ExecutablePath)) { return $false }
    return (Invoke-WebRequest -Uri "http://127.0.0.1:$($Uri.Port)/readyz" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200
  } catch { return $false }
}

function Get-GatewayHealth([string]$Address, [int]$Port) {
  $listener = Get-Listener -Port $Port
  if (-not $listener -or $listener.LocalAddress -ne $Address) { return $null }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $owner -or $owner.Name -ine "node.exe") { return $null }
  return Get-GatewayHealthPayload -Address $Address -Port $Port
}

function Invoke-EnsureWithTimeout([string[]]$Arguments, [int]$TimeoutSeconds) {
  $pwsh = Resolve-StablePowerShell
  $stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
  $stdoutPath = Join-Path $RuntimeDir "ensure-watch.$stamp.stdout.log"
  $stderrPath = Join-Path $RuntimeDir "ensure-watch.$stamp.stderr.log"
  $process = Start-Process -FilePath $pwsh -ArgumentList $Arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 1
    $process.Refresh()
  }
  if (-not $process.HasExited) {
    Write-WatchLog "启动检查超过 $TimeoutSeconds 秒，终止卡住的检查进程 PID $($process.Id)。"
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    return 124
  }
  $output = @()
  if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { $output += Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { $output += Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue }
  foreach ($line in $output) { Write-WatchLog "修复检查：$line" }
  return $process.ExitCode
}

function Get-ReloadBlockers([Uri]$Uri, [int]$GatewayPort) {
  return @((Get-AppServerClientBlockers -AppPort $Uri.Port -GatewayPort $GatewayPort).Messages)
}

function Invoke-ReloadWithTimeout([string[]]$Arguments, [int]$TimeoutSeconds) {
  $pwsh = Resolve-StablePowerShell
  $stamp = Get-Date -Format "yyyyMMdd-HHmmssfff"
  $stdoutPath = Join-Path $RuntimeDir "reload-watch.$stamp.stdout.log"
  $stderrPath = Join-Path $RuntimeDir "reload-watch.$stamp.stderr.log"
  $process = Start-Process -FilePath $pwsh -ArgumentList $Arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 1
    $process.Refresh()
  }
  if (-not $process.HasExited) {
    Write-WatchLog "配置自动重载超过 $TimeoutSeconds 秒，终止重载检查进程 PID $($process.Id)，保留待处理标记。"
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    return 124
  }
  $output = @()
  if (Test-Path -LiteralPath $stdoutPath -PathType Leaf) { $output += Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $stderrPath -PathType Leaf) { $output += Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue }
  foreach ($line in $output) { Write-WatchLog "配置重载：$line" }
  return $process.ExitCode
}

if (-not $Mutex.WaitOne(0)) {
  Write-Output "Codex Mobile 看门已经在运行，本次退出。"
  exit 0
}

$appServerUri = [Uri]$AppServerUrl
$lastState = $null
$lastHeartbeatAt = Get-Date
$failureCount = 0
$reloadQuietCount = 0
$lastPendingFingerprint = $null
$lastWaitReason = $null
$lastBinaryStatus = $null

try {
  Write-WatchLog "手机控制台看门已启动，检查间隔 ${IntervalSeconds} 秒。"
  $configRecord = Get-CodexConfigFingerprintRecord
  $appliedRecord = Read-CodexConfigFingerprintRecord $ConfigStatePath
  if (-not $appliedRecord) {
    Write-CodexConfigFingerprintRecord $ConfigStatePath $configRecord
    Write-WatchLog "已记录 app-server 配置指纹：$($configRecord.fingerprint)。"
  } elseif ($appliedRecord.fingerprint -ne $configRecord.fingerprint) {
    $existing = Read-CodexConfigFingerprintRecord $PendingReloadPath
    if (-not $existing -or $existing.fingerprint -ne $configRecord.fingerprint) {
      Write-CodexConfigReloadMarker $PendingReloadPath $configRecord 'watchdog-startup' | Out-Null
      Write-WatchLog "检测到 app-server 配置指纹变化：$($appliedRecord.fingerprint) -> $($configRecord.fingerprint)（$(Format-CodexConfigChangeSummary $appliedRecord $configRecord)）。进入安全维护窗口。"
    }
  }
  $lastObservedRecord = $configRecord
  do {
    try {
      $configRecord = Get-CodexConfigFingerprintRecord
      $appliedRecord = Read-CodexConfigFingerprintRecord $ConfigStatePath
      if ($appliedRecord -and $appliedRecord.fingerprint -ne $configRecord.fingerprint) {
        $existing = Read-CodexConfigFingerprintRecord $PendingReloadPath
        if (-not $existing -or $existing.fingerprint -ne $configRecord.fingerprint) {
          Write-CodexConfigReloadMarker $PendingReloadPath $configRecord 'watchdog' | Out-Null
          $baseline = if ($lastObservedRecord -and $lastObservedRecord.fingerprint -ne $configRecord.fingerprint) { $lastObservedRecord }
            elseif ($existing -and $existing.configKeyDigests) { $existing }
            else { $appliedRecord }
          Write-WatchLog "检测到 app-server 配置指纹变化（$(Format-CodexConfigChangeSummary $baseline $configRecord)）。已登记最新稳定配置。"
        }
      }
      $lastObservedRecord = $configRecord
      $appServerHealthy = Test-AppServer -Uri $appServerUri
      $gatewayHealth = Get-GatewayHealth -Address $HostAddress -Port $GatewayPort
      $gatewayHealthy = [bool]$gatewayHealth
      try { Ensure-ClaudeBackend -ProjectRoot $ProjectRoot } catch { Write-WatchLog "Claude 只读服务异常（Codex 不受影响）：$($_.Exception.Message)" }
      if ($appServerHealthy) {
        try { $appOwner = Resolve-ManagedAppServerOwner -Port $appServerUri.Port -AllowMissing } catch { $appOwner = $null }
        if ($appOwner) {
          Sync-AppServerState $appOwner
          $installedBinary = Resolve-InstalledCodexBinary
          $binaryUpdate = Register-CodexBinaryUpdate -RuntimeDir $RuntimeDir -InstalledBinary $installedBinary -RunningBinary ([string]$appOwner.ExecutablePath) -RunningPid ([int]$appOwner.ProcessId)
          $binaryStatus = "$($binaryUpdate.status):$($binaryUpdate.record.sourceFingerprint)"
          if ($binaryStatus -ne $lastBinaryStatus) {
            switch ($binaryUpdate.status) {
              'observing' { Write-WatchLog "发现 Codex 安装程序变化，正在等待完整 bundle 连续稳定：$($binaryUpdate.record.version)，第 $($binaryUpdate.record.stableObservations) 次。" }
              'changed-during-copy' { Write-WatchLog 'Codex 安装程序在快照期间仍有变化，放弃本次候选并重新观察。' }
              'staged' { Write-WatchLog "Codex 新版本已验证并预存：$($binaryUpdate.record.version)。当前 PID $($appOwner.ProcessId) 保持运行，等待用户维护窗口重载。" }
            }
            Write-StackEvent -RuntimeDir $RuntimeDir -Event 'upgrade.candidate' -Details @{
              status = $binaryUpdate.status
              version = $binaryUpdate.record.version
              stableObservations = $binaryUpdate.record.stableObservations
              runningPid = [int]$appOwner.ProcessId
            }
            $lastBinaryStatus = $binaryStatus
          }
        }
      }
      $state = "app-server=" + $(if ($appServerHealthy) { "正常" } else { "缺失" }) + ", gateway=" + (Format-GatewayState $gatewayHealth)
      $versionPending = Read-CodexBinaryRecord (Join-Path $RuntimeDir 'pending-app-server-switch.json')
      if ($versionPending -and $appOwner -and (Test-CodexBinarySatisfiesPendingSwitch -Record $versionPending -BinaryPath ([string]$appOwner.ExecutablePath))) { $versionPending = $null }
      $pendingRecord = Read-CodexConfigFingerprintRecord $PendingReloadPath
      $configMarkerSatisfied = Test-CodexConfigReloadMarkerSatisfied -Marker $pendingRecord -Applied $appliedRecord -Current $configRecord
      $pendingExists = (($pendingRecord -and -not $configMarkerSatisfied) -or $versionPending)
      if ($pendingExists -and $appServerHealthy) {
        $reloadKeyForStatus = "$($configRecord.fingerprint):$($versionPending.codexSha256)"
        $failureForStatus = Read-AppServerReloadFailure -Path $FailedReloadPath
        $ownerStartedAt = if ($appOwner) { [string]$appOwner.CreationDate } else { $null }
        $waitReason = Get-AppServerReloadWaitReason -AppPort $appServerUri.Port -GatewayPort $GatewayPort -ListenUrl $AppServerUrl -Failure $failureForStatus -TargetKey $reloadKeyForStatus -CurrentProcessId $(if ($appOwner) { [int]$appOwner.ProcessId } else { 0 }) -CurrentProcessStartedAt $ownerStartedAt -RetryCooldownSeconds $ReloadRetryCooldownSeconds -RetryMaxAttempts $ReloadMaxAttempts
        if ($waitReason -ne $lastWaitReason) {
          Write-WatchLog "待重载等待：$waitReason"
          Write-StackEvent -RuntimeDir $RuntimeDir -Event 'reload.waiting' -Details @{
            reason = $waitReason
            runningPid = if ($appOwner) { [int]$appOwner.ProcessId } else { 0 }
            configFingerprint = $configRecord.fingerprint
            targetVersion = [string]$versionPending.version
          }
          $lastWaitReason = $waitReason
        }
      } else {
        $lastWaitReason = $null
      }
      if ($state -ne $lastState) {
        Write-WatchLog "链路状态：$state。"
        Write-StackEvent -RuntimeDir $RuntimeDir -Event 'stack.state-changed' -Details @{
          appServerHealthy = [bool]$appServerHealthy
          gatewayHealthy = [bool]$gatewayHealthy
          gatewayUpstream = if ($gatewayHealth) { [string]$gatewayHealth.upstream } else { $null }
          gatewayMaintenance = if ($gatewayHealth) { $gatewayHealth.maintenance -eq $true } else { $null }
          appServer = if ($appServerHealthy) { $null } else { Get-StackPortSnapshot -Port $appServerUri.Port }
          gateway = if ($gatewayHealthy) { $null } else { Get-StackPortSnapshot -Port $GatewayPort }
        }
        $lastState = $state
        $lastHeartbeatAt = Get-Date
      } elseif (((Get-Date) - $lastHeartbeatAt).TotalSeconds -ge 300) {
        Write-WatchLog "看门心跳：$state。"
        $lastHeartbeatAt = Get-Date
      }

      if (-not $appServerHealthy -or -not $gatewayHealthy) {
        $pwsh = Resolve-StablePowerShell
        $ensureArguments = @(
          "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
          "-File", $EnsureScript,
          "-HostAddress", $HostAddress,
          "-GatewayPort", [string]$GatewayPort,
          "-AppServerUrl", $AppServerUrl
        )
        $exitCode = Invoke-EnsureWithTimeout -Arguments $ensureArguments -TimeoutSeconds $EnsureTimeoutSeconds
        if ($exitCode -ne 0) { throw "启动检查退出码：$exitCode" }
      }

      if (-not $Once -and $pendingExists -and $appServerHealthy) {
        $pending = Read-CodexConfigFingerprintRecord $PendingReloadPath
        $reloadKey = "$($configRecord.fingerprint):$($versionPending.codexSha256)"
        $failed = Read-AppServerReloadFailure -Path $FailedReloadPath
        $ownerStartedAt = if ($appOwner) { [string]$appOwner.CreationDate } else { $null }
        $retry = Get-AppServerReloadRetryDecision -Failure $failed -TargetKey $reloadKey -CurrentProcessId $(if ($appOwner) { [int]$appOwner.ProcessId } else { 0 }) -CurrentProcessStartedAt $ownerStartedAt -CooldownSeconds $ReloadRetryCooldownSeconds -MaxAttempts $ReloadMaxAttempts
        $candidate = Read-CodexBinaryRecord (Join-Path $RuntimeDir 'installed-app-server-candidate.json')
        $versionStable = -not $versionPending -or ($candidate.status -eq 'pending' -and $candidate.sourceFingerprint -eq $versionPending.sourceFingerprint)
        if ($versionStable -and (-not $pending -or $pending.fingerprint -eq $configRecord.fingerprint) -and $retry.Allowed) {
          if ($lastPendingFingerprint -ne $reloadKey) {
            $lastPendingFingerprint = $reloadKey
            $reloadQuietCount = 0
          }
          $blockers = @(Get-ReloadBlockers ([Uri]$AppServerUrl) $GatewayPort)
          if ($blockers.Count -eq 0) {
            $idle = Get-AppServerIdleSnapshot -Url $AppServerUrl
            if (-not $idle.error -and $idle.idle -and $idle.unknownCount -eq 0) { $reloadQuietCount++ } else { $reloadQuietCount = 0 }
            if ($reloadQuietCount -ge $ReloadQuietChecks) {
              $label = if ($pending -and $pending.fingerprint) { "配置 $($pending.fingerprint)" } elseif ($versionPending) { "版本 $($versionPending.version)" } else { '待重载目标' }
              Write-WatchLog "$label 已稳定且连续 $reloadQuietCount 个检查周期无客户端连接、任务明确空闲，开始受控自动重载。"
              $reloadArguments = @(
                "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", $ReloadScript,
                "-Apply", "-Confirmation", "RELOAD_SHARED_APP_SERVER",
                "-Reason", 'watchdog-maintenance',
                "-HostAddress", $HostAddress, "-GatewayPort", [string]$GatewayPort, "-ListenUrl", $AppServerUrl
              )
              $failureBeforeReload = Read-AppServerReloadFailure -Path $FailedReloadPath
              $reloadExit = Invoke-ReloadWithTimeout -Arguments $reloadArguments -TimeoutSeconds $ReloadTimeoutSeconds
              Write-StackEvent -RuntimeDir $RuntimeDir -Event 'reload.watchdog-result' -Details @{ exitCode = $reloadExit; previousPid = if ($appOwner) { [int]$appOwner.ProcessId } else { 0 } }
              if ($reloadExit -ne 0) {
                $failure = Read-AppServerReloadFailure -Path $FailedReloadPath
                $childRecordedFailure = $failure -and $failure.targetKey -eq $reloadKey -and (
                  -not $failureBeforeReload -or
                  $failureBeforeReload.targetKey -ne $reloadKey -or
                  [int]$failure.attempts -gt [int]$failureBeforeReload.attempts -or
                  -not [string]::Equals([string]$failure.failedAt, [string]$failureBeforeReload.failedAt, [StringComparison]::Ordinal)
                )
                if (-not $childRecordedFailure) {
                  $failure = Write-AppServerReloadFailure -Path $FailedReloadPath -TargetKey $reloadKey -Stage 'reload-child' -ExitCode $reloadExit -Message "重载子进程退出码 $reloadExit" -SourceProcessId $(if ($appOwner) { [int]$appOwner.ProcessId } else { 0 }) -SourceProcessStartedAt $ownerStartedAt -TargetVersion ([string]$versionPending.version) -TargetSha256 ([string]$versionPending.codexSha256)
                }
                throw "自动重载失败（第 $($failure.attempts)/$ReloadMaxAttempts 次），进入冷却后再评估：$reloadExit"
              }
              $reloadQuietCount = 0
              $lastPendingFingerprint = $null
              $lastWaitReason = $null
            }
          } else {
            if ($reloadQuietCount -gt 0) { Write-WatchLog "配置自动重载暂停：$($blockers -join '；')。" }
            $reloadQuietCount = 0
          }
        } else {
          $reloadQuietCount = 0
          $lastPendingFingerprint = $null
        }
      } else {
        $reloadQuietCount = 0
        $lastPendingFingerprint = $null
      }
      $failureCount = 0
    } catch {
      $failureCount++
      Write-WatchLog "看门修复失败（第 $failureCount 次）：$($_.Exception.Message)"
      if ($Once) { throw }
    }

    if ($Once) { break }
    $delay = if ($failureCount -gt 0) {
      [Math]::Min(300, $IntervalSeconds * [Math]::Pow(2, [Math]::Min(4, $failureCount - 1)))
    } else {
      $IntervalSeconds
    }
    Start-Sleep -Seconds ([int]$delay)
  } while ($true)
} finally {
  $Mutex.ReleaseMutex()
  $Mutex.Dispose()
}

Write-Output "Codex Mobile 链路检查正常。"
