[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$TaskName = 'Codex Mobile Console',
  [string]$HostAddress = '',
  [int]$GatewayPort = 4174,
  [string]$AppServerUrl = 'ws://127.0.0.1:4500',
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\.runtime')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-powershell.ps1')
. (Join-Path $PSScriptRoot 'resolve-mobile-host.ps1')
$HostAddress = Resolve-MobileHostAddress $HostAddress
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeDir)
$privateRoot = Join-Path $resolvedRuntime 'private'
$mappings = @(
  [pscustomobject]@{ Name = '配对密钥'; Source = (Join-Path $privateRoot 'pairing-secret.txt'); Destination = (Join-Path $resolvedRuntime 'pairing-secret.txt'); Required = $true },
  [pscustomobject]@{ Name = '移动会话'; Source = (Join-Path $privateRoot 'sessions.json'); Destination = (Join-Path $resolvedRuntime 'sessions.json'); Required = $false },
  [pscustomobject]@{ Name = '服务器私钥'; Source = (Join-Path $privateRoot 'tls\codex-mobile-server.key'); Destination = (Join-Path $resolvedRuntime 'tls\codex-mobile-server.key'); Required = $true },
  [pscustomobject]@{ Name = '本地 CA 私钥'; Source = (Join-Path $privateRoot 'tls\codex-mobile-ca.key'); Destination = (Join-Path $resolvedRuntime 'tls\codex-mobile-ca.key'); Required = $false }
)

if ($Apply -and $Confirmation -ne 'ROLLBACK_SENSITIVE_RUNTIME') {
  throw '需要确认词：ROLLBACK_SENSITIVE_RUNTIME'
}
foreach ($mapping in $mappings) {
  if ($mapping.Required -and -not (Test-Path -LiteralPath $mapping.Source -PathType Leaf)) {
    throw "缺少$($mapping.Name)：$($mapping.Source)；未执行回滚。"
  }
}

$appServerUri = [Uri]$AppServerUrl
$appListener = Get-NetTCPConnection -LocalPort $appServerUri.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $appListener -or $appListener.LocalAddress -notin @('127.0.0.1', '::1')) {
  throw "共享 app-server 未在回环端口 $($appServerUri.Port) 监听；未执行回滚。"
}
$appOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$($appListener.OwningProcess)"
if ($appOwner.Name -ine 'codex.exe' -or $appOwner.CommandLine -notmatch '\bapp-server\b') {
  throw '共享 app-server 身份校验失败；未执行回滚。'
}

$gatewayListener = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$gatewayOwner = $null
if ($gatewayListener) {
  $gatewayOwner = Get-CimInstance Win32_Process -Filter "ProcessId=$($gatewayListener.OwningProcess)"
  if ($gatewayListener.LocalAddress -ne $HostAddress -or $gatewayOwner.Name -ine 'node.exe' -or $gatewayOwner.CommandLine -notmatch 'dist/server/server/index\.js') {
    throw "端口 $GatewayPort 不是当前手机网关；未执行回滚。"
  }
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  $action = @($task.Actions)
  $watchScript = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'watch-mobile-stack.ps1'))
  if ($action.Count -ne 1 -or [string]$action[0].Arguments -notmatch [regex]::Escape($watchScript)) {
    throw "计划任务 $TaskName 不属于当前项目；未执行回滚。"
  }
}

Write-Output "敏感存储回滚预检通过；共享 app-server PID $($appOwner.ProcessId) 不会停止。"
Write-Output "手机网关：$(if ($gatewayOwner) { "PID $($gatewayOwner.ProcessId)" } else { '未运行' })"
if (-not $Apply) {
  Write-Output 'DRY-RUN：未停止任务或进程，未复制文件。'
  return
}

$mutex = [Threading.Mutex]::new($false, 'Local\CodexMobileConsoleAutostart')
if (-not $mutex.WaitOne([TimeSpan]::FromSeconds(30))) {
  $mutex.Dispose()
  throw '等待手机控制台启动检查互斥锁超过30秒，未执行回滚。'
}
if ($gatewayOwner) {
  Stop-Process -Id $gatewayOwner.ProcessId -Force -ErrorAction Stop
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-Process -Id $gatewayOwner.ProcessId -ErrorAction SilentlyContinue)) { break }
  }
}
if ((Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue)) {
  throw '手机网关未停止，尚未复制任何敏感文件。'
}

foreach ($mapping in $mappings) {
  if (-not (Test-Path -LiteralPath $mapping.Source -PathType Leaf)) { continue }
  New-Item -ItemType Directory -Path (Split-Path -Parent $mapping.Destination) -Force | Out-Null
  $temporaryPath = "$($mapping.Destination).rollback.$PID"
  try {
    Copy-Item -LiteralPath $mapping.Source -Destination $temporaryPath -Force
    if ((Get-FileHash -LiteralPath $mapping.Source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash) {
      throw "$($mapping.Name)回滚复制校验失败。"
    }
    Set-Acl -LiteralPath $temporaryPath -AclObject (Get-Acl -LiteralPath $mapping.Source)
    Move-Item -LiteralPath $temporaryPath -Destination $mapping.Destination -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
  }
}

$pwsh = Resolve-StablePowerShell
$gatewayScript = Join-Path $PSScriptRoot 'start-gateway.ps1'
$stdout = Join-Path $resolvedRuntime 'gateway-legacy-rollback.stdout.log'
$stderr = Join-Path $resolvedRuntime 'gateway-legacy-rollback.stderr.log'
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $gatewayScript, '-HostAddress', $HostAddress, '-Port', [string]$GatewayPort, '-AppServerUrl', $AppServerUrl, '-LegacySensitiveRuntime')
$hostProcess = Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 250
  $gatewayListener = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
} while (-not $gatewayListener -and -not $hostProcess.HasExited -and (Get-Date) -lt $deadline)
if (-not $gatewayListener) { throw "旧目录模式网关启动失败，请查看 $stderr。" }
if ((Get-NetTCPConnection -LocalPort $appServerUri.Port -State Listen).OwningProcess -ne $appOwner.ProcessId) {
  throw '共享 app-server PID 发生变化，请检查桌面端。'
}
$mutex.ReleaseMutex()
$mutex.Dispose()
Write-Output "敏感存储已回滚到旧目录，手机网关 PID $($gatewayListener.OwningProcess)；看门任务保持运行。"
