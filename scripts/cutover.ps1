param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$ListenUrl = 'ws://127.0.0.1:4500',
  [string]$CodexBinary = '',
  [string]$BaselinePath,
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\.runtime')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-codex-binary.ps1')
. (Join-Path $PSScriptRoot 'resolve-codex-desktop.ps1')
$project = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$statePath = Join-Path $RuntimeDir 'cutover-state.json'
$desktopExe = Resolve-CodexDesktopExecutable
$oldWs = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
$oldForce = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_FORCE_CLI', 'User')
if (-not $Apply) {
  Write-Output 'DRY-RUN: stop Codex Desktop, start one loopback app-server, set CODEX_APP_SERVER_WS_URL, restart Desktop, then run only read-only probe.'
  Write-Output "DRY-RUN: desktop=$desktopExe"
  Write-Output "DRY-RUN: url=$ListenUrl"
  Write-Output 'DRY-RUN: no task, process, or environment changes'
  exit 0
}
if ($Confirmation -ne 'SWITCH_SHARED_APP_SERVER') { throw 'confirmation required: SWITCH_SHARED_APP_SERVER' }
if (-not $BaselinePath) { throw 'BaselinePath is required for a read-only cutover verification' }
New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null
$state = [ordered]@{ oldWs = $oldWs; oldForce = $oldForce; desktopExe = $desktopExe; listenUrl = $ListenUrl; startedAt = (Get-Date).ToUniversalTime().ToString('o') }
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
$desktop = Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'ChatGPT.exe' }
foreach ($process in $desktop) { Stop-Process -Id $process.ProcessId -Force }
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 250
  if (-not (Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'codex.exe' -and $_.CommandLine -match 'app-server' })) { break }
}
if (Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'codex.exe' -and $_.CommandLine -match 'app-server' }) { throw 'old app-server did not exit; no shared instance started' }
[Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $ListenUrl, 'User')
$env:CODEX_APP_SERVER_WS_URL = $ListenUrl
& (Join-Path $PSScriptRoot 'start-shared-app-server.ps1') -Apply -Confirmation START_SHARED_APP_SERVER -ListenUrl $ListenUrl -CodexBinary $CodexBinary -RuntimeDir $RuntimeDir
Start-Process -FilePath $desktopExe -WindowStyle Hidden | Out-Null
$port = ([Uri]$ListenUrl).Port
$connected = $false
for ($i = 0; $i -lt 80; $i++) {
  Start-Sleep -Milliseconds 500
  $desktopPid = (Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | Select-Object -First 1).Id
  if ($desktopPid -and (Get-NetTCPConnection -State Established -RemotePort $port -OwningProcess $desktopPid -ErrorAction SilentlyContinue)) { $connected = $true; break }
}
if (-not $connected) { throw 'desktop did not establish a WebSocket connection to the shared app-server' }
$out = Join-Path $RuntimeDir 'phase1'
$tsx = Join-Path $project 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path -LiteralPath $tsx)) { throw "tsx runner not found: $tsx" }
& $tsx (Join-Path $project 'src\probe\cli.ts') --url $ListenUrl --baseline ([System.IO.Path]::GetFullPath($BaselinePath)) --out $out
if ($LASTEXITCODE -ne 0) { throw 'phase1 probe failed; use rollback.ps1 to restore stdio' }
Write-Output 'shared app-server cutover and read-only probe passed; topology left active'
