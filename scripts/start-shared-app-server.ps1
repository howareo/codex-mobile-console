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
$url = [Uri]$ListenUrl
if ($url.Scheme -ne 'ws' -or $url.Host -notin @('127.0.0.1', 'localhost', '::1')) { throw 'shared app-server must use a loopback ws:// URL' }
$SourceCodexBinary = Resolve-CodexBinary -CandidatePath $CodexBinary
$SnapshotCodexBinary = Get-CodexBundleSnapshotPath -SourceBinary $SourceCodexBinary -RuntimeDir $resolvedRuntime
if (-not $Apply) {
  Write-Output 'DRY-RUN: stage one complete Codex bundle and start exactly one loopback app-server from the stable snapshot'
  Write-Output "DRY-RUN: sourceBinary=$SourceCodexBinary"
  Write-Output "DRY-RUN: snapshotBinary=$SnapshotCodexBinary"
  Write-Output "DRY-RUN: url=$ListenUrl"
  Write-Output 'DRY-RUN: no process or file changes'
  exit 0
}
if ($Confirmation -ne 'START_SHARED_APP_SERVER') { throw 'confirmation required: START_SHARED_APP_SERVER' }
$existing = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'codex.exe' -and $_.CommandLine -match '\bapp-server\b' }
if ($existing) { throw "an app-server process already exists (PID(s): $($existing.ProcessId -join ', ')); refusing a second instance" }
New-Item -ItemType Directory -Path $resolvedRuntime -Force | Out-Null
$CodexBinary = Copy-CodexBundleSnapshot -SourceBinary $SourceCodexBinary -RuntimeDir $resolvedRuntime
$stdout = Join-Path $resolvedRuntime 'shared-app-server.stdout.log'
$stderr = Join-Path $resolvedRuntime 'shared-app-server.stderr.log'
$process = Start-Process -FilePath $CodexBinary -ArgumentList @('app-server', '--listen', $ListenUrl) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
Start-Sleep -Milliseconds 300
if ($process.HasExited) { throw "shared app-server exited during startup; see $stderr" }
$record = [ordered]@{ pid = $process.Id; binary = [System.IO.Path]::GetFullPath($CodexBinary); sourceBinary = [System.IO.Path]::GetFullPath($SourceCodexBinary); listenUrl = $ListenUrl; startedAt = (Get-Date).ToUniversalTime().ToString('o') }
$record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $resolvedRuntime 'shared-app-server.json') -Encoding utf8
Write-Output "shared app-server started: PID $($process.Id), $ListenUrl"
