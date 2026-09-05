[CmdletBinding()]
param(
  [string]$HostAddress = '',
  [int]$GatewayPort = 4174,
  [string]$AppServerUrl = "ws://127.0.0.1:4500",
  [int]$NetworkWaitSeconds = 180
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-codex-binary.ps1")
. (Join-Path $PSScriptRoot "resolve-powershell.ps1")
. (Join-Path $PSScriptRoot "codex-config-fingerprint.ps1")
. (Join-Path $PSScriptRoot "resolve-mobile-host.ps1")
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$HostAddress = Resolve-MobileHostAddress $HostAddress
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
$LogPath = Join-Path $RuntimeDir "autostart.log"
$GatewayStdout = Join-Path $RuntimeDir "gateway-host.stdout.log"
$GatewayStderr = Join-Path $RuntimeDir "gateway-host.stderr.log"
$ConfigStatePath = Join-Path $RuntimeDir "app-server-config-fingerprint.json"
$PendingReloadPath = Join-Path $RuntimeDir "pending-app-server-reload.json"
$Mutex = [Threading.Mutex]::new($false, "Local\CodexMobileConsoleAutostart")

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

function Write-AutostartLog([string]$Message) {
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

function Test-AppServerReady([int]$Port) {
  try { return (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}

function Write-AppServerState($Owner) {
  $binaryPath = [System.IO.Path]::GetFullPath([string]$Owner.ExecutablePath)
  $sourceBinary = $binaryPath
  $manifestPath = Join-Path (Split-Path -Parent $binaryPath) 'bundle.json'
  if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    try {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding utf8 | ConvertFrom-Json
      if ($manifest.sourceDirectory) { $sourceBinary = Join-Path ([string]$manifest.sourceDirectory) 'codex.exe' }
    } catch { }
  }
  $startedAt = try { ([Management.ManagementDateTimeConverter]::ToDateTime([string]$Owner.CreationDate)).ToUniversalTime().ToString('o') } catch { (Get-Date).ToUniversalTime().ToString('o') }
  $record = [ordered]@{ pid = [int]$Owner.ProcessId; binary = $binaryPath; sourceBinary = [System.IO.Path]::GetFullPath($sourceBinary); listenUrl = $AppServerUrl; startedAt = $startedAt }
  $statePath = Join-Path $RuntimeDir 'shared-app-server.json'
  $tmp = "$statePath.$PID.tmp"
  $record | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding utf8
  Move-Item -LiteralPath $tmp -Destination $statePath -Force
}

if (-not $Mutex.WaitOne(0)) {
  Write-AutostartLog "已有启动检查正在运行，本次退出。"
  exit 0
}

try {
  Write-AutostartLog "开始检查手机控制台运行环境。"
  [Environment]::SetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", $AppServerUrl, "User")

  $appServerUri = [Uri]$AppServerUrl
  if ($appServerUri.Scheme -ne "ws" -or $appServerUri.Host -notin @("127.0.0.1", "localhost", "::1")) {
    throw "共享 app-server 必须监听回环 ws:// 地址。"
  }

  $appListener = Get-Listener -Port $appServerUri.Port
  if ($appListener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($appListener.OwningProcess)"
    if ($appListener.LocalAddress -notin @("127.0.0.1", "::1") -or $owner.Name -ine "codex.exe" -or $owner.CommandLine -notmatch "\bapp-server\b") {
      throw "端口 $($appServerUri.Port) 已被其他程序占用，未启动第二个 app-server。"
    }
    Assert-CodexBundle -BinaryPath $owner.ExecutablePath
    Write-AppServerState $owner
    Write-AutostartLog "共享 app-server 已运行，PID $($owner.ProcessId)。"
  } else {
    $configRecord = Get-CodexConfigFingerprintRecord
    $appliedRecord = Read-CodexConfigFingerprintRecord $ConfigStatePath
    if ($appliedRecord -and $appliedRecord.fingerprint -ne $configRecord.fingerprint -and -not (Test-Path -LiteralPath $PendingReloadPath -PathType Leaf)) {
      Write-CodexConfigReloadMarker $PendingReloadPath $configRecord 'ensure' | Out-Null
      Write-AutostartLog "发现未应用的 app-server 配置变化，准备在当前进程已退出后重载。"
    }
    $reloadPending = Test-Path -LiteralPath $PendingReloadPath -PathType Leaf
    $startedWithConfigRecord = $configRecord
    $otherAppServers = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq "codex.exe" -and $_.CommandLine -match "\bapp-server\b" }
    if ($otherAppServers) {
      throw "检测到其他 app-server（PID：$($otherAppServers.ProcessId -join ', ')），未启动第二个实例。"
    }
    $statePath = Join-Path $RuntimeDir "shared-app-server.json"
    $stateBinary = $null
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
      try {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        if ($state.binary) { $stateBinary = [string]$state.binary }
      } catch {
        Write-AutostartLog "共享 app-server 记录无法读取，将跳过旧记录并重新发现 Codex 程序：$($_.Exception.Message)"
      }
    }
    $preferredRecordPath = Join-Path $RuntimeDir 'preferred-app-server-bundle.json'
    $preferredRecord = if (Test-Path -LiteralPath $preferredRecordPath -PathType Leaf) { try { Get-Content -LiteralPath $preferredRecordPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { $null } } else { $null }
    $preferredBinary = $null
    if ($preferredRecord) {
      try { $preferredBinary = Resolve-PreferredCodexBinary -RuntimeDir $RuntimeDir }
      catch { Write-AutostartLog "首选 Codex 快照失效，将重新发现当前完整运行时：$($_.Exception.Message)" }
    }
    $desktopBinary = Resolve-CodexDesktopBinary
    $managedRuntimePath = try { Resolve-CodexBinary } catch { $null }
    $runtimeBinary = if ($managedRuntimePath) { [pscustomobject]@{ Path = [string]$managedRuntimePath } } else { $desktopBinary }
    $desktopChanged = $false
    if ($runtimeBinary -and $preferredRecord -and $preferredRecord.sourceBinary -and ([string]$preferredRecord.sourceBinary -match '\\WindowsApps\\OpenAI\.Codex_') -and -not [string]::Equals([System.IO.Path]::GetFullPath([string]$preferredRecord.sourceBinary), [System.IO.Path]::GetFullPath([string]$runtimeBinary.Path), [StringComparison]::OrdinalIgnoreCase)) {
      $desktopChanged = $true
      $preferredBinary = $null
      Write-AutostartLog "检测到 Codex Desktop/primary runtime 已更新，首选运行时将从当前完整 bundle 重新生成。"
    }
    $codexBinary = if ($preferredBinary -and -not $desktopChanged) { $preferredBinary } elseif ($runtimeBinary) { [string]$runtimeBinary.Path } else { Resolve-CodexBinary -FallbackPath $stateBinary }
    Write-AutostartLog "将使用$(if ($preferredBinary -and -not $desktopChanged) { '首选快照' } elseif ($runtimeBinary) { '当前 Desktop primary runtime' } else { '动态发现' })的 Codex 程序：$codexBinary。"
    & (Join-Path $PSScriptRoot "start-shared-app-server.ps1") -Apply -Confirmation START_SHARED_APP_SERVER -ListenUrl $AppServerUrl -CodexBinary $codexBinary -RuntimeDir $RuntimeDir | ForEach-Object { Write-AutostartLog $_ }
    $deadline = (Get-Date).AddSeconds(20)
    $appReady = $false
    do {
      Start-Sleep -Milliseconds 250
      $appListener = Get-Listener -Port $appServerUri.Port
      if ($appListener) { $appReady = Test-AppServerReady -Port $appServerUri.Port }
    } while ((-not $appListener -or -not $appReady) -and (Get-Date) -lt $deadline)
    if (-not $appListener -or -not $appReady) { throw "共享 app-server 未在 20 秒内通过 readyz。" }
    $startedOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$($appListener.OwningProcess)"
    if ($runtimeBinary -and ($desktopChanged -or -not $preferredBinary)) {
      $snapshotBinary = [System.IO.Path]::GetFullPath([string]$startedOwner.ExecutablePath)
      Set-PreferredCodexBundle -RuntimeDir $RuntimeDir -SourceBinary ([string]$runtimeBinary.Path) -SnapshotBinary $snapshotBinary | Out-Null
    }
    Write-AppServerState $startedOwner
    $pendingSwitchPath = Join-Path $RuntimeDir 'pending-app-server-switch.json'
    if (Test-Path -LiteralPath $pendingSwitchPath -PathType Leaf) {
      $pendingSwitch = Get-Content -LiteralPath $pendingSwitchPath -Raw -Encoding utf8 | ConvertFrom-Json
      if ([string]::Equals([System.IO.Path]::GetFullPath([string]$startedOwner.ExecutablePath), [System.IO.Path]::GetFullPath([string]$pendingSwitch.snapshotBinary), [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $pendingSwitchPath -Force
        Write-AutostartLog "首选 app-server bundle 已生效，待切换标记已清除。"
      }
    }
    Write-CodexConfigFingerprintRecord $ConfigStatePath $startedWithConfigRecord
    $currentConfigRecord = Get-CodexConfigFingerprintRecord
    if ($currentConfigRecord.fingerprint -eq $startedWithConfigRecord.fingerprint) {
      if ($reloadPending -or (Test-Path -LiteralPath $PendingReloadPath -PathType Leaf)) {
        Remove-Item -LiteralPath $PendingReloadPath -Force
        Write-AutostartLog "app-server 配置已在新进程启动时应用，指纹：$($startedWithConfigRecord.fingerprint)。"
      }
    } else {
      Write-CodexConfigReloadMarker $PendingReloadPath $currentConfigRecord 'ensure-during-start' | Out-Null
      Write-AutostartLog "配置在 app-server 启动期间再次变化，保留最新待重载指纹：$($currentConfigRecord.fingerprint)。"
    }
  }

  $gatewayListener = Get-Listener -Port $GatewayPort
  if ($gatewayListener) {
    $gatewayOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$($gatewayListener.OwningProcess)"
    if ($gatewayListener.LocalAddress -ne $HostAddress -or $gatewayOwner.Name -ine "node.exe" -or -not (Test-GatewayEndpoint -Address $HostAddress -Port $GatewayPort)) {
      throw "端口 $GatewayPort 已被其他程序占用，未启动手机网关。"
    }
    Write-AutostartLog "手机网关已运行，PID $($gatewayListener.OwningProcess)。"
    exit 0
  }

  $deadline = (Get-Date).AddSeconds($NetworkWaitSeconds)
  do {
    $addressReady = Get-NetIPAddress -IPAddress $HostAddress -ErrorAction SilentlyContinue
    if ($addressReady) { break }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  if (-not $addressReady) { throw "等待 EasyTier 地址 $HostAddress 超过 $NetworkWaitSeconds 秒。" }

  $pwsh = Resolve-StablePowerShell
  $gatewayScript = Join-Path $PSScriptRoot "start-gateway.ps1"
  $arguments = @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $gatewayScript, "-HostAddress", $HostAddress, "-Port", [string]$GatewayPort, "-AppServerUrl", $AppServerUrl)
  $hostProcess = Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $GatewayStdout -RedirectStandardError $GatewayStderr -PassThru

  $deadline = (Get-Date).AddSeconds(30)
  do {
    Start-Sleep -Milliseconds 250
    $gatewayListener = Get-Listener -Port $GatewayPort
  } while (-not $gatewayListener -and -not $hostProcess.HasExited -and (Get-Date) -lt $deadline)
  if (-not $gatewayListener) { throw "手机网关启动失败，请查看 $GatewayStderr。" }
  Write-AutostartLog "手机网关已启动，PID $($gatewayListener.OwningProcess)，地址 https://${HostAddress}:$GatewayPort/。"
} catch {
  Write-AutostartLog "启动检查失败：$($_.Exception.Message)"
  throw
} finally {
  $Mutex.ReleaseMutex()
  $Mutex.Dispose()
}
