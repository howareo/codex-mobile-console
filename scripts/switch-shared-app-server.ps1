[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$ListenUrl = 'ws://127.0.0.1:4500',
  [string]$CodexBinary = '',
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\.runtime')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-codex-binary.ps1')
$resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeDir)
$logPath = Join-Path $resolvedRuntime 'cutover.log'
$url = [Uri]$ListenUrl
if ($url.Scheme -ne 'ws' -or $url.Host -notin @('127.0.0.1', 'localhost', '::1')) {
  throw '共享 app-server 必须使用回环 ws:// 地址。'
}

function Write-CutoverLog([string]$Message) {
  New-Item -ItemType Directory -Path $resolvedRuntime -Force | Out-Null
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}

function Get-AppServerListener {
  return Get-NetTCPConnection -LocalPort $url.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-VerifiedAppServerOwner($Listener) {
  if (-not $Listener) { return $null }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($Listener.OwningProcess)"
  if ($Listener.LocalAddress -notin @('127.0.0.1', '::1') -or $owner.Name -ine 'codex.exe' -or $owner.CommandLine -notmatch '\bapp-server\b') {
    throw "端口 $($url.Port) 不是共享 Codex app-server，已停止切换。"
  }
  return $owner
}

$sourceBinary = Resolve-CodexBinary -CandidatePath $CodexBinary
$snapshotBinary = Get-CodexBundleSnapshotPath -SourceBinary $sourceBinary -RuntimeDir $resolvedRuntime
$currentListener = Get-AppServerListener
$currentOwner = Get-VerifiedAppServerOwner -Listener $currentListener

if (-not $Apply) {
  Write-Output 'DRY-RUN: stage the complete bundle without stopping a running app-server; the watchdog applies it after the current process exits normally'
  Write-Output "DRY-RUN: currentBinary=$($currentOwner.ExecutablePath)"
  Write-Output "DRY-RUN: sourceBinary=$sourceBinary"
  Write-Output "DRY-RUN: snapshotBinary=$snapshotBinary"
  Write-Output "DRY-RUN: preference=$(Join-Path $resolvedRuntime 'preferred-app-server-bundle.json')"
  Write-Output 'DRY-RUN: no process or file changes'
  exit 0
}
if ($Confirmation -ne 'SWITCH_SHARED_APP_SERVER') {
  throw 'confirmation required: SWITCH_SHARED_APP_SERVER'
}

try {
  Write-CutoverLog "开始预存共享 app-server 版本，当前程序 $($currentOwner.ExecutablePath)，目标快照 $snapshotBinary。"
  $snapshotBinary = Copy-CodexBundleSnapshot -SourceBinary $sourceBinary -RuntimeDir $resolvedRuntime
  $preferencePath = Set-PreferredCodexBundle -RuntimeDir $resolvedRuntime -SourceBinary $sourceBinary -SnapshotBinary $snapshotBinary
  Write-CutoverLog "已将共享 app-server 首选 bundle 设为 $snapshotBinary；记录 $preferencePath。"
  if ($currentOwner -and $currentOwner.ExecutablePath -ieq $snapshotBinary -and (Test-CodexBundle -BinaryPath $currentOwner.ExecutablePath)) {
    Write-CutoverLog "共享 app-server 已从稳定快照运行，PID $($currentOwner.ProcessId)。"
    Write-Output "shared app-server already uses stable snapshot: PID $($currentOwner.ProcessId)"
    return
  }

  if ($currentOwner) {
    $pendingPath = Join-Path $resolvedRuntime 'pending-app-server-switch.json'
    $pending = [ordered]@{
      currentPid = $currentOwner.ProcessId
      currentBinary = $currentOwner.ExecutablePath
      sourceBinary = $sourceBinary
      snapshotBinary = $snapshotBinary
      preferencePath = $preferencePath
      requestedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    $pending | ConvertTo-Json | Set-Content -LiteralPath $pendingPath -Encoding utf8
    Write-CutoverLog "目标快照已预存；保留当前 PID $($currentOwner.ProcessId)，等待其正常退出后由 watchdog 启动新快照。"
    Write-Output "shared app-server snapshot staged without interrupting PID $($currentOwner.ProcessId)"
    return
  }

  & (Join-Path $PSScriptRoot 'start-shared-app-server.ps1') -Apply -Confirmation START_SHARED_APP_SERVER -ListenUrl $ListenUrl -CodexBinary $sourceBinary -RuntimeDir $resolvedRuntime | ForEach-Object { Write-CutoverLog $_ }
  $startDeadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $newListener = Get-AppServerListener
  } while (-not $newListener -and (Get-Date) -lt $startDeadline)
  if (-not $newListener) {
    throw '稳定快照 app-server 未在 20 秒内开始监听。'
  }

  $newOwner = Get-VerifiedAppServerOwner -Listener $newListener
  if ($newOwner.ExecutablePath -ine $snapshotBinary) {
    throw "监听进程未使用稳定快照：$($newOwner.ExecutablePath)"
  }
  Assert-CodexBundle -BinaryPath $newOwner.ExecutablePath
  Write-CutoverLog "稳定快照切换完成，PID $($newOwner.ProcessId)，程序 $($newOwner.ExecutablePath)。"
  Write-Output "shared app-server switched to stable snapshot: PID $($newOwner.ProcessId)"
} catch {
  Write-CutoverLog "稳定快照预存或启动失败：$($_.Exception.Message)"
  throw
}
