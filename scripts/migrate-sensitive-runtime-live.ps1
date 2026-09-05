[CmdletBinding()]
param(
  [string]$TaskName = 'Codex Mobile Console',
  [string]$HostAddress = '',
  [int]$GatewayPort = 4174,
  [string]$AppServerUrl = 'ws://127.0.0.1:4500',
  [string]$ResultPath = (Join-Path $PSScriptRoot '..\.runtime\sensitive-migration-result.json')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-powershell.ps1')
. (Join-Path $PSScriptRoot 'resolve-mobile-host.ps1')
$HostAddress = Resolve-MobileHostAddress $HostAddress
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $projectRoot '.runtime'
$resolvedResult = [System.IO.Path]::GetFullPath($ResultPath)
$startedAt = (Get-Date).ToUniversalTime().ToString('o')
$mutex = [Threading.Mutex]::new($false, 'Local\CodexMobileConsoleAutostart')
$mutexAcquired = $false

function Write-Result([string]$Status, [string]$Message, [hashtable]$Details) {
  $record = [ordered]@{
    status = $Status
    message = $Message
    startedAt = $startedAt
    finishedAt = (Get-Date).ToUniversalTime().ToString('o')
    details = $Details
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $resolvedResult) -Force | Out-Null
  $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resolvedResult -Encoding utf8
}

$appServerUri = [Uri]$AppServerUrl
$appBefore = $null
$gatewayBefore = $null
try {
  $appListener = Get-NetTCPConnection -LocalPort $appServerUri.Port -State Listen -ErrorAction Stop | Select-Object -First 1
  $appBefore = $appListener.OwningProcess
  $appOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$appBefore"
  if ($appListener.LocalAddress -notin @('127.0.0.1', '::1') -or $appOwner.Name -ine 'codex.exe' -or $appOwner.CommandLine -notmatch '\bapp-server\b') {
    throw '共享 app-server 身份校验失败。'
  }

  $gatewayListener = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction Stop | Select-Object -First 1
  $gatewayBefore = $gatewayListener.OwningProcess
  $gatewayOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$gatewayBefore"
  if ($gatewayListener.LocalAddress -ne $HostAddress -or $gatewayOwner.Name -ine 'node.exe' -or $gatewayOwner.CommandLine -notmatch 'dist/server/server/index\.js') {
    throw '手机网关身份校验失败。'
  }

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  $action = @($task.Actions)
  $watchScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'watch-mobile-stack.ps1'))
  if ($action.Count -ne 1 -or [string]$action[0].Arguments -notmatch [regex]::Escape($watchScript)) {
    throw "计划任务 $TaskName 不属于当前项目。"
  }

  $mutexAcquired = $mutex.WaitOne([TimeSpan]::FromSeconds(30))
  if (-not $mutexAcquired) { throw '等待手机控制台启动检查互斥锁超过30秒。' }

  Stop-Process -Id $gatewayBefore -Force -ErrorAction Stop
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Id $gatewayBefore -ErrorAction SilentlyContinue)) { break }
  }
  if (Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue) { throw '旧手机网关未停止。' }

  & (Join-Path $PSScriptRoot 'protect-sensitive-runtime.ps1') -Apply -RuntimeDir $runtime | Out-Null
  $pwsh = Resolve-StablePowerShell
  $gatewayScript = Join-Path $PSScriptRoot 'start-gateway.ps1'
  $stdout = Join-Path $runtime 'gateway-migration.stdout.log'
  $stderr = Join-Path $runtime 'gateway-migration.stderr.log'
  $arguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$gatewayScript,'-HostAddress',$HostAddress,'-Port',[string]$GatewayPort,'-AppServerUrl',$AppServerUrl)
  $gatewayHost = Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

  $deadline = (Get-Date).AddSeconds(60)
  do {
    Start-Sleep -Milliseconds 500
    $gatewayAfter = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  } while (-not $gatewayAfter -and -not $gatewayHost.HasExited -and (Get-Date) -lt $deadline)
  if (-not $gatewayAfter) { throw '新手机网关未在60秒内启动。' }
  $appAfter = (Get-NetTCPConnection -LocalPort $appServerUri.Port -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
  if ($appAfter -ne $appBefore) { throw "共享 app-server PID 发生变化：$appBefore -> $appAfter" }

  $legacyFiles = @(
    (Join-Path $runtime 'pairing-secret.txt'),
    (Join-Path $runtime 'sessions.json'),
    (Join-Path $runtime 'tls\codex-mobile-server.key'),
    (Join-Path $runtime 'tls\codex-mobile-ca.key')
  )
  $privateFiles = @(
    (Join-Path $runtime 'private\pairing-secret.txt'),
    (Join-Path $runtime 'private\sessions.json'),
    (Join-Path $runtime 'private\tls\codex-mobile-server.key'),
    (Join-Path $runtime 'private\tls\codex-mobile-ca.key')
  )
  Write-Result -Status 'success' -Message '敏感目录迁移与网关切换完成。' -Details @{
    appServerBefore = $appBefore
    appServerAfter = $appAfter
    gatewayBefore = $gatewayBefore
    gatewayAfter = $gatewayAfter.OwningProcess
    watchdogState = [string](Get-ScheduledTask -TaskName $TaskName).State
    legacyFilesRemaining = @($legacyFiles | Where-Object { Test-Path -LiteralPath $_ }).Count
    privateFilesPresent = @($privateFiles | Where-Object { Test-Path -LiteralPath $_ }).Count
  }
  $mutex.ReleaseMutex()
  $mutexAcquired = $false
} catch {
  $failure = $_.Exception.Message
  if ($mutexAcquired) {
    $mutex.ReleaseMutex()
    $mutexAcquired = $false
  }
  try {
    $privatePairing = Join-Path $runtime 'private\pairing-secret.txt'
    if (Test-Path -LiteralPath $privatePairing -PathType Leaf) {
      & (Join-Path $PSScriptRoot 'rollback-sensitive-runtime.ps1') -Apply -Confirmation ROLLBACK_SENSITIVE_RUNTIME -TaskName $TaskName -HostAddress $HostAddress -GatewayPort $GatewayPort -AppServerUrl $AppServerUrl -RuntimeDir $runtime | Out-Null
    } elseif (-not (Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue)) {
      $pwsh = Resolve-StablePowerShell
      $gatewayScript = Join-Path $PSScriptRoot 'start-gateway.ps1'
      Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$gatewayScript,'-HostAddress',$HostAddress,'-Port',[string]$GatewayPort,'-AppServerUrl',$AppServerUrl,'-LegacySensitiveRuntime') -WorkingDirectory $projectRoot -WindowStyle Hidden | Out-Null
    }
  } catch {
    $failure = "$failure；自动回滚也失败：$($_.Exception.Message)"
  }
  Write-Result -Status 'failed' -Message $failure -Details @{
    appServerBefore = $appBefore
    gatewayBefore = $gatewayBefore
  }
  $mutex.Dispose()
  exit 1
}
$mutex.Dispose()
