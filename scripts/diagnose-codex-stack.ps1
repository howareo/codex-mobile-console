[CmdletBinding()]
param(
  [switch]$Json,
  [int]$LookbackLines = 300
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot 'resolve-codex-binary.ps1')
. (Join-Path $PSScriptRoot 'codex-config-fingerprint.ps1')
. (Join-Path $PSScriptRoot 'resolve-mobile-host.ps1')
. (Join-Path $PSScriptRoot 'codex-binary-update.ps1')
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$RuntimeDir = Join-Path $ProjectRoot '.runtime'
$GatewayHost = Resolve-MobileHostAddress ''

function Get-Listener([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-Health([int]$Port, [string]$Path) {
  try { return [int](Invoke-WebRequest -Uri "http://127.0.0.1:$Port$Path" -UseBasicParsing -TimeoutSec 3).StatusCode } catch { return $null }
}

function Get-GatewayHealth([string]$Address, [int]$Port) {
  try { return [int](Invoke-WebRequest -Uri "https://${Address}:$Port/" -SkipCertificateCheck -UseBasicParsing -TimeoutSec 3).StatusCode } catch { return $null }
}

function Get-PatternCounts([string[]]$Paths, [int]$MaxLines) {
  $lines = @()
  foreach ($path in $Paths) {
    $files = if ($path.Contains('*') -or $path.Contains('?')) { @(Get-ChildItem -Path $path -File -ErrorAction SilentlyContinue) } elseif (Test-Path -LiteralPath $path -PathType Leaf) { @(Get-Item -LiteralPath $path) } else { @() }
    foreach ($file in $files) {
      $lines += @(Get-Content -LiteralPath $file.FullName -TotalCount ([Math]::Min(1200, $MaxLines * 4)) -ErrorAction SilentlyContinue)
      $lines += @(Get-Content -LiteralPath $file.FullName -Tail $MaxLines -ErrorAction SilentlyContinue)
    }
  }
  [ordered]@{
    invalidTransport = @($lines | Where-Object { $_ -match 'invalid transport|mcp_servers\.codex_app' }).Count
    initializeTimeout = @($lines | Where-Object { $_ -match 'initialize.*tim(e|ed)out|handshake timed out' }).Count
    relativeUrl = @($lines | Where-Object { $_ -match 'relative URL without a base' }).Count
    runtimeInstall = @($lines | Where-Object { $_ -match 'primary_runtime_(bundle_)?install_(started|outcome|finished)' }).Count
    startupFailures = @($lines | Where-Object { $_ -match '启动检查失败|app_server_connection\.fail' }).Count
  }
}

$appListener = Get-Listener 4500
$appOwner = if ($appListener) { Get-CimInstance Win32_Process -Filter "ProcessId=$($appListener.OwningProcess)" -ErrorAction SilentlyContinue } else { $null }
$appVersion = if ($appOwner -and $appOwner.ExecutablePath) { try { (& $appOwner.ExecutablePath --version 2>$null | Select-Object -First 1) -join ' ' } catch { $null } } else { $null }
$protocol = $null
if ($appListener) {
  $protocolEntry = Join-Path $ProjectRoot 'dist\server\probe\protocol-health-cli.js'
  try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $protocolOutput = @(& $node $protocolEntry --url 'ws://127.0.0.1:4500' --timeout-ms 8000 2>&1)
    $protocol = ([string]::Join("`n", $protocolOutput)) | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $protocol = [pscustomobject]@{ ok = $false; initialize = $false; threadList = $false; error = $_.Exception.Message }
  }
}
$gatewayListener = Get-Listener 4174
$desktop = @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1 Name,Version,InstallLocation)
$preferredPath = Join-Path $RuntimeDir 'preferred-app-server-bundle.json'
$preferred = if (Test-Path -LiteralPath $preferredPath -PathType Leaf) { try { Get-Content -LiteralPath $preferredPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { $null } } else { $null }
$installedBinary = try { Resolve-InstalledCodexBinary } catch { $null }
$installedVersion = if ($installedBinary) { Get-CodexBinaryVersion -BinaryPath $installedBinary } else { $null }
$pendingSwitchPath = Join-Path $RuntimeDir 'pending-app-server-switch.json'
$pendingSwitch = Read-CodexBinaryRecord -Path $pendingSwitchPath
$config = $null
$configError = $null
try { $config = Get-CodexConfigFingerprintRecord } catch { $configError = $_.Exception.Message }
$pendingPath = Join-Path $RuntimeDir 'pending-app-server-reload.json'
$pending = if (Test-Path -LiteralPath $pendingPath -PathType Leaf) { try { Get-Content -LiteralPath $pendingPath -Raw -Encoding utf8 | ConvertFrom-Json } catch { $null } } else { $null }
$statePath = Join-Path $RuntimeDir 'app-server-config-fingerprint.json'
$applied = Read-CodexConfigFingerprintRecord $statePath
$patterns = Get-PatternCounts @(
  (Join-Path $RuntimeDir 'shared-app-server.stderr.log'),
  (Join-Path $RuntimeDir 'app-server.stderr.log'),
  (Join-Path $RuntimeDir 'autostart.log'),
  (Join-Path $env:LOCALAPPDATA 'Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\Codex\Logs\2026\08\27\*.log')
) $LookbackLines

$report = [ordered]@{
  capturedAt = (Get-Date).ToUniversalTime().ToString('o')
  appServer = [ordered]@{ listening = [bool]$appListener; pid = if ($appListener) { [int]$appListener.OwningProcess } else { $null }; binary = if ($appOwner) { $appOwner.ExecutablePath } else { $null }; version = $appVersion; healthz = Get-Health 4500 '/healthz'; readyz = Get-Health 4500 '/readyz'; protocol = $protocol }
  gateway = [ordered]@{ listening = [bool]$gatewayListener; pid = if ($gatewayListener) { [int]$gatewayListener.OwningProcess } else { $null }; health = Get-GatewayHealth $GatewayHost 4174 }
  desktop = $desktop
  installedRuntime = [ordered]@{ binary = $installedBinary; version = $installedVersion; completeBundle = [bool]($installedBinary -and (Test-CodexBundle -BinaryPath $installedBinary)) }
  preferredBundle = if ($preferred) { [ordered]@{ sourceBinary = $preferred.sourceBinary; snapshotBinary = $preferred.snapshotBinary; codexSha256 = $preferred.codexSha256 } } else { $null }
  pendingVersionSwitch = if ($pendingSwitch) { [ordered]@{ version = $pendingSwitch.version; sourceBinary = $pendingSwitch.sourceBinary; snapshotBinary = $pendingSwitch.snapshotBinary; requestedAt = $pendingSwitch.requestedAt; valid = Test-CodexPendingBinarySwitch -Record $pendingSwitch } } else { $null }
  config = [ordered]@{ readable = [bool]$config; error = $configError; fingerprint = if ($config) { $config.fingerprint } else { $null }; appliedFingerprint = if ($applied) { $applied.fingerprint } else { $null }; pendingFingerprint = if ($pending) { $pending.fingerprint } else { $null }; components = if ($config) { $config.components } else { $null } }
  logPatterns = $patterns
}

if ($Json) {
  $report | ConvertTo-Json -Depth 8
} else {
  $report | Format-List
  if ($protocol -and $protocol.ok) {
    Write-Output "4500 协议实测：正常（initialize + thread/list，任务数 $($protocol.threadCount)，耗时 $($protocol.durationMs)ms）。"
  } elseif ($appListener) {
    Write-Output "4500 协议实测：异常（initialize=$($protocol.initialize)，thread/list=$($protocol.threadList)，原因=$($protocol.error)）。"
  } else {
    Write-Output '4500 协议实测：未运行。'
  }
  Write-Output '该诊断为只读，不会停止进程、重载配置或修改 state_5.sqlite。'
}
