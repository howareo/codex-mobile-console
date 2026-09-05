[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$rollbackScript = Join-Path $PSScriptRoot 'rollback.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codex-mobile-rollback-test-$PID-$([Guid]::NewGuid().ToString('N'))"
$runtimeDir = Join-Path $fixtureRoot 'runtime'
$currentInstall = Join-Path $fixtureRoot 'OpenAI.Codex_26.810.6296.0_x64__fixture'
$missingInstall = Join-Path $fixtureRoot 'OpenAI.Codex_99.999.9999.0_x64__missing'
$currentDesktop = Join-Path $currentInstall 'app\ChatGPT.exe'
$statePath = Join-Path $runtimeDir 'cutover-state.json'

function Get-ProcessSnapshot {
  return @(
    Get-CimInstance Win32_Process |
      Where-Object { $_.Name -ieq 'ChatGPT.exe' -or ($_.Name -ieq 'codex.exe' -and $_.CommandLine -match '\bapp-server\b') } |
      Select-Object -ExpandProperty ProcessId |
      Sort-Object
  )
}

try {
  New-Item -ItemType Directory -Path (Split-Path -Parent $currentDesktop), $runtimeDir, $missingInstall -Force | Out-Null
  Set-Content -LiteralPath $currentDesktop -Value 'fixture' -Encoding ascii
  [ordered]@{
    oldWs = $null
    oldForce = $null
    desktopExe = 'C:\Program Files\WindowsApps\OpenAI.Codex_0.0.0.0_x64__removed\app\ChatGPT.exe'
    listenUrl = 'ws://127.0.0.1:59999'
  } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

  $beforeProcesses = @(Get-ProcessSnapshot)
  $beforeUserWs = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User')
  $beforeProcessWs = [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Process')
  $dryRun = @(& $rollbackScript -RuntimeDir $runtimeDir -DesktopInstallRoots @($currentInstall))
  if ($dryRun -notcontains "当前桌面程序：$currentDesktop") {
    throw '旧 state.desktopExe 失效时未解析到当前桌面程序。'
  }
  if ($dryRun -notcontains 'DRY-RUN：未停止进程，未修改环境变量，未启动程序。') {
    throw '回滚 dry-run 未明确保持系统不变。'
  }
  if ((Compare-Object $beforeProcesses @(Get-ProcessSnapshot)).Count -ne 0) {
    throw '回滚 dry-run 改变了 Codex 相关进程。'
  }
  if ($beforeUserWs -ne [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User') -or
      $beforeProcessWs -ne [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Process')) {
    throw '回滚 dry-run 修改了环境变量。'
  }
  Write-Output 'PASS：旧 state.desktopExe 不存在时动态解析当前桌面，且 dry-run 无副作用。'

  $failedAsExpected = $false
  $mutationAttempted = $false
  function Stop-Process {
    $script:mutationAttempted = $true
    throw '测试拦截：不允许停止进程。'
  }
  function Start-Process {
    $script:mutationAttempted = $true
    throw '测试拦截：不允许启动进程。'
  }
  try {
    & $rollbackScript -Apply -Confirmation ROLLBACK_SHARED_APP_SERVER -RuntimeDir $runtimeDir -DesktopInstallRoots @($missingInstall) | Out-Null
  } catch {
    $failedAsExpected = $_.Exception.Message -match '未执行任何进程或环境修改'
  }
  if (-not $failedAsExpected) {
    throw '桌面解析失败没有在预检阶段明确退出。'
  }
  if ($mutationAttempted) {
    throw '桌面解析失败后进入了进程修改阶段。'
  }
  if ((Compare-Object $beforeProcesses @(Get-ProcessSnapshot)).Count -ne 0) {
    throw '桌面解析失败后 Codex 相关进程发生变化。'
  }
  if ($beforeUserWs -ne [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'User') -or
      $beforeProcessWs -ne [Environment]::GetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', 'Process')) {
    throw '桌面解析失败后环境变量发生变化。'
  }
  Write-Output 'PASS：桌面解析失败在停机前退出，进程和环境保持不变。'
} finally {
  $resolvedFixtureRoot = [System.IO.Path]::GetFullPath($fixtureRoot)
  $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedFixtureRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedFixtureRoot)) {
    Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force
  }
}
