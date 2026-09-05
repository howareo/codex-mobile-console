[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\.runtime'),
  [string[]]$DesktopInstallRoots,
  [string]$WatchdogTaskName = 'Codex Mobile Console'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-codex-desktop.ps1')

if ($Apply -and $Confirmation -ne 'ROLLBACK_SHARED_APP_SERVER') {
  throw '需要确认词：ROLLBACK_SHARED_APP_SERVER'
}

$resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeDir)
$statePath = Join-Path $resolvedRuntime 'cutover-state.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
  throw "缺少切换状态文件：$statePath；未执行任何进程或环境修改。"
}
try {
  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -ErrorAction Stop
} catch {
  throw "切换状态文件无法解析：$statePath；未执行任何进程或环境修改。原因：$($_.Exception.Message)"
}
foreach ($propertyName in @('oldWs', 'oldForce')) {
  $property = $state.PSObject.Properties[$propertyName]
  if ($property -and $null -ne $property.Value -and $property.Value -isnot [string]) {
    throw "切换状态字段 $propertyName 必须是字符串或 null；未执行任何进程或环境修改。"
  }
}

$listenUrlText = if ($state.PSObject.Properties['listenUrl']) { [string]$state.listenUrl } else { '' }
$listenUri = $null
if (-not [Uri]::TryCreate($listenUrlText, [UriKind]::Absolute, [ref]$listenUri) -or
    $listenUri.Scheme -ne 'ws' -or
    $listenUri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
  throw "切换状态中的 listenUrl 不是回环 ws:// 地址：$listenUrlText；未执行任何进程或环境修改。"
}

$desktopExe = if ($PSBoundParameters.ContainsKey('DesktopInstallRoots')) {
  Resolve-CodexDesktopExecutable -InstallRoots $DesktopInstallRoots
} else {
  Resolve-CodexDesktopExecutable
}
$recordedDesktopExe = if ($state.PSObject.Properties['desktopExe']) { [string]$state.desktopExe } else { '' }

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$watchScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'watch-mobile-stack.ps1'))
$watchdogTasks = @(Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue)
if ($watchdogTasks.Count -gt 1) {
  throw "存在多个同名看门任务：$WatchdogTaskName；未执行任何进程或环境修改。"
}
$watchdogTask = $watchdogTasks | Select-Object -First 1
if ($watchdogTask) {
  $watchdogActions = @($watchdogTask.Actions)
  $workingDirectory = [string]($watchdogActions | Select-Object -First 1).WorkingDirectory
  if ($watchdogActions.Count -ne 1 -or
      [string]$watchdogActions[0].Arguments -notmatch [regex]::Escape($watchScript) -or
      [string]::IsNullOrWhiteSpace($workingDirectory) -or
      -not [string]::Equals([System.IO.Path]::GetFullPath($workingDirectory), $projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "计划任务 $WatchdogTaskName 不属于当前项目；未执行任何进程或环境修改。"
  }
}

$listeners = @(Get-NetTCPConnection -LocalPort $listenUri.Port -State Listen -ErrorAction SilentlyContinue)
$sharedProcess = $null
if ($listeners.Count -gt 0) {
  if (@($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count -gt 0) {
    throw "端口 $($listenUri.Port) 存在非回环监听；未执行任何进程或环境修改。"
  }
  $ownerIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($ownerIds.Count -ne 1) {
    throw "端口 $($listenUri.Port) 存在多个监听进程；未执行任何进程或环境修改。"
  }
  $sharedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($ownerIds[0])" -ErrorAction SilentlyContinue
  if (-not $sharedProcess -or $sharedProcess.Name -ine 'codex.exe' -or $sharedProcess.CommandLine -notmatch '\bapp-server\b') {
    throw "端口 $($listenUri.Port) 不是 Codex app-server；未执行任何进程或环境修改。"
  }
}

$desktopProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'ChatGPT.exe' })
Write-Output '回滚预检通过。'
Write-Output "当前桌面程序：$desktopExe"
if ($recordedDesktopExe) { Write-Output "历史状态记录：$recordedDesktopExe（仅供审计，不用于启动）" }
Write-Output "共享 app-server：$(if ($sharedProcess) { "PID $($sharedProcess.ProcessId)，端口 $($listenUri.Port)" } else { '未监听，无需停止' })"
Write-Output "Codex Desktop 进程数：$($desktopProcesses.Count)"
Write-Output "手机看门任务：$(if ($watchdogTask) { "$($watchdogTask.State)，正式回滚时将停止并禁用" } else { '未安装' })"
if (-not $Apply) {
  Write-Output 'DRY-RUN：未停止进程，未修改环境变量，未启动程序。'
  return
}

$watchdogWasEnabled = $watchdogTask -and $watchdogTask.State -ne 'Disabled'
if ($watchdogTask) {
  try {
    Disable-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction Stop | Out-Null
    if ($watchdogTask.State -eq 'Running') {
      Stop-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction Stop
    }
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 250
      $currentWatchdog = Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue
      if (-not $currentWatchdog -or $currentWatchdog.State -ne 'Running') { break }
    }
    $currentWatchdog = Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue
    if ($currentWatchdog -and $currentWatchdog.State -eq 'Running') {
      throw "看门任务 $WatchdogTaskName 未在 10 秒内停止。"
    }
  } catch {
    if ($watchdogWasEnabled) {
      Enable-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue | Out-Null
    }
    throw "看门任务未能安全停止；桌面端和共享 app-server 保持不变。原因：$($_.Exception.Message)"
  }
}

$plannedDesktopIds = @($desktopProcesses | Select-Object -ExpandProperty ProcessId | Sort-Object)
$currentDesktopIds = @(
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -ieq 'ChatGPT.exe' } |
    Select-Object -ExpandProperty ProcessId |
    Sort-Object
)
if ((Compare-Object $plannedDesktopIds $currentDesktopIds).Count -ne 0) {
  if ($watchdogWasEnabled) { Enable-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue | Out-Null }
  throw 'Codex Desktop 进程在预检后发生变化；未执行任何进程或环境修改，请重新运行预检。'
}
if ($sharedProcess) {
  $currentSharedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($sharedProcess.ProcessId)" -ErrorAction SilentlyContinue
  if (-not $currentSharedProcess -or $currentSharedProcess.Name -ine 'codex.exe' -or $currentSharedProcess.CommandLine -notmatch '\bapp-server\b') {
    if ($watchdogWasEnabled) { Enable-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue | Out-Null }
    throw '共享 app-server 在预检后发生变化；未执行任何进程或环境修改，请重新运行预检。'
  }
}

foreach ($process in $desktopProcesses) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
}
if ($sharedProcess) {
  Stop-Process -Id $sharedProcess.ProcessId -Force -ErrorAction Stop
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Id $sharedProcess.ProcessId -ErrorAction SilentlyContinue)) { break }
  }
  if (Get-Process -Id $sharedProcess.ProcessId -ErrorAction SilentlyContinue) {
    throw "共享 app-server PID $($sharedProcess.ProcessId) 未在 10 秒内退出。"
  }
}

$oldWs = if ($state.PSObject.Properties['oldWs']) { $state.oldWs } else { $null }
$oldForce = if ($state.PSObject.Properties['oldForce']) { $state.oldForce } else { $null }
[Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_WS_URL', $oldWs, 'User')
[Environment]::SetEnvironmentVariable('CODEX_APP_SERVER_FORCE_CLI', $oldForce, 'User')
if ($null -eq $oldWs) { Remove-Item Env:CODEX_APP_SERVER_WS_URL -ErrorAction SilentlyContinue } else { $env:CODEX_APP_SERVER_WS_URL = [string]$oldWs }
if ($null -eq $oldForce) { Remove-Item Env:CODEX_APP_SERVER_FORCE_CLI -ErrorAction SilentlyContinue } else { $env:CODEX_APP_SERVER_FORCE_CLI = [string]$oldForce }
Start-Process -FilePath $desktopExe -WindowStyle Hidden | Out-Null
Write-Output '已恢复切换前环境，并使用当前已安装的 Codex Desktop 启动。手机看门任务保持禁用，避免重新拉起共享 app-server。'
Write-Output '确认需要重新启用手机控制台后，运行 scripts\install-autostart.ps1 的正式安装命令。'
