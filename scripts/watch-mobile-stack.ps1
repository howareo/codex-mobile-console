[CmdletBinding()]
param(
  [string]$HostAddress = '',
  [int]$GatewayPort = 4174,
  [string]$AppServerUrl = "ws://127.0.0.1:4500",
  [int]$IntervalSeconds = 30,
  [int]$EnsureTimeoutSeconds = 240,
  [int]$ReloadQuietChecks = 2,
  [switch]$Once
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-codex-binary.ps1")
. (Join-Path $PSScriptRoot "resolve-powershell.ps1")
. (Join-Path $PSScriptRoot "codex-config-fingerprint.ps1")
. (Join-Path $PSScriptRoot "resolve-mobile-host.ps1")
. (Join-Path $PSScriptRoot "codex-binary-update.ps1")
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$HostAddress = Resolve-MobileHostAddress $HostAddress
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$LogPath = Join-Path $RuntimeDir "autostart.log"
$EnsureScript = Join-Path $PSScriptRoot "ensure-mobile-stack.ps1"
$ReloadScript = Join-Path $PSScriptRoot "request-app-server-reload.ps1"
$ConfigStatePath = Join-Path $RuntimeDir "app-server-config-fingerprint.json"
$PendingReloadPath = Join-Path $RuntimeDir "pending-app-server-reload.json"
$Mutex = [Threading.Mutex]::new($false, "Local\CodexMobileConsoleWatchdog")

if ($IntervalSeconds -lt 10 -or $IntervalSeconds -gt 600) {
  throw "检查间隔必须在 10 到 600 秒之间。"
}
if ($EnsureTimeoutSeconds -lt 30 -or $EnsureTimeoutSeconds -gt 900) {
  throw "启动检查超时必须在 30 到 900 秒之间。"
}
if ($ReloadQuietChecks -lt 2 -or $ReloadQuietChecks -gt 10) {
  throw "配置重载空闲检查次数必须在 2 到 10 次之间。"
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

function Test-GatewayEndpoint([string]$Address, [int]$Port) {
  try {
    $response = Invoke-WebRequest -Uri "https://${Address}:$Port/" -SkipCertificateCheck -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200 -and [string]$response.Content -match '(?i)Codex.*Console|Codex Mobile'
  } catch { return $false }
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
  $startedAt = try { ([Management.ManagementDateTimeConverter]::ToDateTime([string]$Owner.CreationDate)).ToUniversalTime().ToString('o') } catch { (Get-Date).ToUniversalTime().ToString('o') }
  $record = [ordered]@{ pid = [int]$Owner.ProcessId; binary = $binaryPath; sourceBinary = [System.IO.Path]::GetFullPath($sourceBinary); listenUrl = $AppServerUrl; startedAt = $startedAt }
  $tmp = "$statePath.$PID.tmp"
  $record | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding utf8
  Move-Item -LiteralPath $tmp -Destination $statePath -Force
  Write-WatchLog "已同步共享 app-server 运行记录：PID $($Owner.ProcessId)。"
}

function Test-AppServer([Uri]$Uri) {
  $listener = Get-Listener -Port $Uri.Port
  if (-not $listener -or $listener.LocalAddress -notin @("127.0.0.1", "::1")) { return $false }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not ($owner -and $owner.Name -ieq "codex.exe" -and $owner.CommandLine -match "\bapp-server\b" -and (Test-CodexBundle -BinaryPath $owner.ExecutablePath))) { return $false }
  try { return (Invoke-WebRequest -Uri "http://127.0.0.1:$($Uri.Port)/readyz" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}

function Test-Gateway([string]$Address, [int]$Port) {
  $listener = Get-Listener -Port $Port
  if (-not $listener -or $listener.LocalAddress -ne $Address) { return $false }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  return $owner -and $owner.Name -ieq "node.exe" -and (Test-GatewayEndpoint -Address $Address -Port $Port)
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
  $gatewayListener = Get-Listener $GatewayPort
  $gatewayProcessId = if ($gatewayListener) { [int]$gatewayListener.OwningProcess } else { 0 }
  $otherClients = @(
    Get-NetTCPConnection -RemotePort $Uri.Port -State Established -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -ne $gatewayProcessId } |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  $phoneConnections = @(Get-NetTCPConnection -LocalPort $GatewayPort -State Established -ErrorAction SilentlyContinue)
  $blockers = [System.Collections.Generic.List[string]]::new()
  if ($otherClients.Count -gt 0) { $blockers.Add("桌面端或其他客户端仍连接 4500（PID：$($otherClients -join ', ')）") }
  if ($phoneConnections.Count -gt 0) { $blockers.Add("手机端仍连接 $GatewayPort（连接数：$($phoneConnections.Count)）") }
  return @($blockers)
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
$lastBinaryStatus = $null

try {
  Write-WatchLog "手机控制台看门已启动，检查间隔 ${IntervalSeconds} 秒。"
  $configRecord = Get-CodexConfigFingerprintRecord
  $appliedRecord = Read-CodexConfigFingerprintRecord $ConfigStatePath
  if (-not $appliedRecord) {
    Write-CodexConfigFingerprintRecord $ConfigStatePath $configRecord
    Write-WatchLog "已记录 app-server 配置指纹：$($configRecord.fingerprint)。"
  } elseif ($appliedRecord.fingerprint -ne $configRecord.fingerprint) {
    $change = Get-CodexConfigChangeKinds $appliedRecord $configRecord
    $existing = Read-CodexConfigFingerprintRecord $PendingReloadPath
    if (-not $existing -or $existing.fingerprint -ne $configRecord.fingerprint) {
      Write-CodexConfigReloadMarker $PendingReloadPath $configRecord 'watchdog-startup' | Out-Null
      Write-WatchLog "检测到 app-server 配置指纹变化：$($appliedRecord.fingerprint) -> $($configRecord.fingerprint)（provider=$($change.providerChanged), credentials=$($change.credentialsChanged), catalogs=$($change.modelCatalogChanged), instructions=$($change.instructionsChanged), hooks=$($change.hooksChanged), deployment=$($change.deploymentManifestChanged)）。进入安全维护窗口。"
    }
  }
  do {
    try {
      $configRecord = Get-CodexConfigFingerprintRecord
      $appliedRecord = Read-CodexConfigFingerprintRecord $ConfigStatePath
      if ($appliedRecord -and $appliedRecord.fingerprint -ne $configRecord.fingerprint) {
        $existing = Read-CodexConfigFingerprintRecord $PendingReloadPath
        if (-not $existing -or $existing.fingerprint -ne $configRecord.fingerprint) {
          $change = Get-CodexConfigChangeKinds $appliedRecord $configRecord
          Write-CodexConfigReloadMarker $PendingReloadPath $configRecord 'watchdog' | Out-Null
          Write-WatchLog "检测到 app-server 配置指纹变化（provider=$($change.providerChanged), credentials=$($change.credentialsChanged), catalogs=$($change.modelCatalogChanged), instructions=$($change.instructionsChanged), hooks=$($change.hooksChanged), deployment=$($change.deploymentManifestChanged)）。已登记最新稳定配置。"
        }
      }
      $appServerHealthy = Test-AppServer -Uri $appServerUri
      $gatewayHealthy = Test-Gateway -Address $HostAddress -Port $GatewayPort
      if ($appServerHealthy) {
        $appListener = Get-Listener -Port $appServerUri.Port
        $appOwner = if ($appListener) { Get-CimInstance Win32_Process -Filter "ProcessId=$($appListener.OwningProcess)" -ErrorAction SilentlyContinue } else { $null }
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
            $lastBinaryStatus = $binaryStatus
          }
        }
      }
      $state = "app-server=" + $(if ($appServerHealthy) { "正常" } else { "缺失" }) + ", gateway=" + $(if ($gatewayHealthy) { "正常" } else { "缺失" })
      if ($state -ne $lastState) {
        Write-WatchLog "链路状态：$state。"
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

      if (-not $Once -and (Test-Path -LiteralPath $PendingReloadPath -PathType Leaf) -and -not (Test-Path -LiteralPath (Join-Path $RuntimeDir 'pending-app-server-switch.json') -PathType Leaf) -and $appServerHealthy) {
        $pending = Read-CodexConfigFingerprintRecord $PendingReloadPath
        if ($pending -and $pending.fingerprint -eq $configRecord.fingerprint) {
          if ($lastPendingFingerprint -ne $pending.fingerprint) {
            $lastPendingFingerprint = $pending.fingerprint
            $reloadQuietCount = 0
          }
          $blockers = @(Get-ReloadBlockers ([Uri]$AppServerUrl) $GatewayPort)
          if ($blockers.Count -eq 0) {
            $reloadQuietCount++
            if ($reloadQuietCount -ge $ReloadQuietChecks) {
              Write-WatchLog "配置指纹 $($pending.fingerprint) 已稳定且连续 $reloadQuietCount 个检查周期无客户端连接，开始受控自动重载。"
              $reloadArguments = @(
                "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                "-File", $ReloadScript,
                "-Apply", "-Confirmation", "RELOAD_SHARED_APP_SERVER",
                "-Reason", "watchdog-maintenance"
              )
              $reloadExit = Invoke-ReloadWithTimeout -Arguments $reloadArguments -TimeoutSeconds $EnsureTimeoutSeconds
              if ($reloadExit -ne 0) { throw "配置自动重载退出码：$reloadExit" }
              $reloadQuietCount = 0
              $lastPendingFingerprint = $null
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
