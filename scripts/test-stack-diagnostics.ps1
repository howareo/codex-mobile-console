[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'stack-diagnostics.ps1')

function Get-NetTCPConnection {
  @(
    [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 4500; OwningProcess = 36668; State = 'Listen' },
    [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 4500; OwningProcess = 36668; State = 'CloseWait' }
  )
}
function Get-CimInstance { return $null }

$snapshot = Get-StackPortSnapshot -Port 4500
if ($snapshot.listeners.Count -ne 1 -or $snapshot.listeners[0].pid -ne 36668 -or $snapshot.listeners[0].processName) {
  throw '未保存进程不可查询的监听 PID'
}
if ($snapshot.connectionStates.Listen -ne 1 -or $snapshot.connectionStates.CloseWait -ne 1) {
  throw '未保存端口连接状态计数'
}

$watchSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'watch-mobile-stack.ps1') -Raw
$reloadSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'request-app-server-reload.ps1') -Raw
$ensureSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ensure-mobile-stack.ps1') -Raw
foreach ($eventName in @('upgrade.candidate', 'reload.waiting', 'stack.state-changed', 'reload.watchdog-result')) {
  if (-not $watchSource.Contains("'$eventName'")) { throw "看门未记录 $eventName" }
}
foreach ($eventName in @('reload.old-stopped', 'reload.new-started', 'reload.verified', 'reload.completed', 'reload.failed')) {
  if (-not $reloadSource.Contains("'$eventName'")) { throw "重载未记录 $eventName" }
}
if (-not $ensureSource.Contains("'ensure.failed'")) { throw '启动失败未记录端口快照' }

$runtime = Join-Path ([IO.Path]::GetTempPath()) ('codex-stack-diagnostic-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runtime | Out-Null
try {
  Write-StackEvent -RuntimeDir $runtime -Event 'ensure.failed' -Details @{ appServer = $snapshot }
  $event = Get-Content -LiteralPath (Join-Path $runtime 'stack-events.ndjson') -Raw | ConvertFrom-Json
  if ($event.event -ne 'ensure.failed' -or $event.details.appServer.listeners[0].pid -ne 36668) {
    throw '诊断事件未保留监听快照'
  }
  if ($event.details.appServer.listeners[0].PSObject.Properties.Name -contains 'commandLine') {
    throw '诊断事件不应记录命令行'
  }
} finally {
  Remove-Item -LiteralPath $runtime -Recurse -Force
}
Write-Output 'PASS: stack diagnostics capture orphaned listener without command line'
