[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'get-managed-app-server.ps1')

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message；期望=$Expected，实际=$Actual" }
}

function Assert-True($Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

$ok = Get-ManagedAppServerIdentity -LocalAddress '127.0.0.1' -OwningProcess 25948 -ProcessName 'codex.exe' -CommandLine '"C:\bundle\codex.exe" app-server --listen ws://127.0.0.1:4500'
Assert-True $ok.Ok '正常 app-server 命令行应通过'
Assert-Equal $ok.Reason 'ok' '正常身份原因'

$wordBoundary = Get-ManagedAppServerIdentity -LocalAddress '127.0.0.1' -OwningProcess 12 -ProcessName 'codex.exe' -CommandLine 'codex.exe app-server --listen ws://127.0.0.1:4500'
Assert-True $wordBoundary.Ok '连字符 app-server 不应被 \b 误判'

$desktop = Get-ManagedAppServerIdentity -LocalAddress '127.0.0.1' -OwningProcess 31976 -ProcessName 'ChatGPT.exe' -CommandLine '"C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe"'
Assert-True (-not $desktop.Ok) '桌面端进程不应被当成受管 app-server'
Assert-Equal $desktop.Reason 'process-name:ChatGPT.exe' '桌面端应报告进程名'

$emptyCmd = Get-ManagedAppServerIdentity -LocalAddress '127.0.0.1' -OwningProcess 99 -ProcessName 'codex.exe' -CommandLine ''
Assert-True (-not $emptyCmd.Ok) '空命令行不应通过'
Assert-Equal $emptyCmd.Reason 'command-line' '空命令行原因'

$noOwner = Get-ManagedAppServerIdentity -LocalAddress '127.0.0.1' -OwningProcess 0 -ProcessName 'codex.exe' -CommandLine '"C:\bundle\codex.exe" app-server --listen ws://127.0.0.1:4500'
Assert-True (-not $noOwner.Ok) 'OwningProcess=0 应单独识别'
Assert-Equal $noOwner.Reason 'owner-pid-unavailable' '应报告无法读取 PID'

$lan = Get-ManagedAppServerIdentity -LocalAddress '192.0.2.10' -OwningProcess 12 -ProcessName 'codex.exe' -CommandLine '"C:\bundle\codex.exe" app-server --listen ws://0.0.0.0:4500'
Assert-True (-not $lan.Ok) '非回环监听应拒绝'
Assert-True ($lan.Reason.StartsWith('listen-address:')) '应报告监听地址'

$msg = Format-ManagedAppServerRefusal -Port 4500 -Reason 'command-line' -ProcessId 88 -ProcessName 'codex.exe' -CommandLine 'codex.exe mcp'
Assert-True ($msg -match '命令行不含 app-server') '拒绝文案应包含具体原因'
Assert-True ($msg -match 'PID 88') '拒绝文案应包含 PID'

$ownerMsg = Format-ManagedAppServerRefusal -Port 4500 -Reason 'owner-pid-unavailable'
Assert-True ($ownerMsg -match 'OwningProcess=0') 'PID 读不到时应提示管理员权限'

$hiddenMsg = Format-ManagedAppServerRefusal -Port 4500 -Reason 'process-unqueryable' -ProcessId 29624
Assert-True ($hiddenMsg -match 'PID 29624') '读不到进程名时应保留 PID'
Assert-True ($hiddenMsg -match '读不到进程名') '读不到进程名时应说明原因'

$runtime = Join-Path $env:TEMP 'codex-mobile-identity-test'
$binary = Join-Path $runtime 'codex-bundles\snapshot\codex.exe'
$owner = [pscustomobject]@{ ProcessId = 29624; Name = 'codex.exe'; ExecutablePath = $binary; CreationDate = [DateTime]::UtcNow; CommandLine = $null }
$record = [pscustomobject]@{ pid = 29624; binary = $binary; startedAt = $owner.CreationDate.ToString('o') }
Assert-True (Test-RecordedAppServerIdentity -Owner $owner -Record $record -RuntimeDir $runtime) '命令行不可读取时需匹配受管运行记录'
$diskRecord = ($record | ConvertTo-Json | ConvertFrom-Json -DateKind String)
Assert-True (Test-RecordedAppServerIdentity -Owner $owner -Record $diskRecord -RuntimeDir $runtime) 'JSON 往返必须保留启动时间的 UTC 时区'
$record.pid = 50
Assert-True (-not (Test-RecordedAppServerIdentity -Owner $owner -Record $record -RuntimeDir $runtime)) '不同 PID 必须拒绝'
$record.pid = 29624
$record.startedAt = $owner.CreationDate.AddMinutes(-1).ToString('o')
Assert-True (-not (Test-RecordedAppServerIdentity -Owner $owner -Record $record -RuntimeDir $runtime)) 'PID 复用但启动时间变化必须拒绝'
$record.startedAt = $owner.CreationDate.ToString('o')
$owner.ExecutablePath = 'C:\Windows\System32\codex.exe'
Assert-True (-not (Test-RecordedAppServerIdentity -Owner $owner -Record $record -RuntimeDir $runtime)) '非受管路径必须拒绝'
Assert-True (-not (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ensure-mobile-stack.ps1') -Raw).Contains('Stop-HiddenProcess')) '启动检查不得强制结束身份未知的 4500'

function Get-LoopbackListenConnection { return [pscustomobject]@{ LocalAddress = '127.0.0.1'; OwningProcess = 0 } }
function Get-AppServerCandidateProcesses { return @() }
$refused = $false
try { Resolve-ManagedAppServerOwner -Port 4500 -AllowMissing | Out-Null } catch { $refused = $_.Exception.Message -match 'OwningProcess=0' }
Assert-True $refused '端口被占用但 PID 未知时 -AllowMissing 必须拒绝启动第二个实例'
function Get-LoopbackListenConnection { return $null }
function Get-NetTCPConnection { return [pscustomobject]@{ LocalAddress = '0.0.0.0'; OwningProcess = 99 } }
$refused = $false
try { Resolve-ManagedAppServerOwner -Port 4500 -AllowMissing | Out-Null } catch { $refused = $_.Exception.Message -match 'listen-address:0.0.0.0' }
Assert-True $refused '非回环监听也不得被当成端口空闲'

$reloadSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'request-app-server-reload.ps1') -Raw
$manageSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manage-shared-app-server.ps1') -Raw
$ensureSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ensure-mobile-stack.ps1') -Raw
$watchSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'watch-mobile-stack.ps1') -Raw
$switchSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'switch-shared-app-server.ps1') -Raw
foreach ($pair in @(
  @{ Name = 'request-app-server-reload.ps1'; Source = $reloadSource },
  @{ Name = 'manage-shared-app-server.ps1'; Source = $manageSource },
  @{ Name = 'ensure-mobile-stack.ps1'; Source = $ensureSource },
  @{ Name = 'watch-mobile-stack.ps1'; Source = $watchSource },
  @{ Name = 'switch-shared-app-server.ps1'; Source = $switchSource }
)) {
  if ($pair.Source -notmatch "get-managed-app-server\.ps1") { throw "$($pair.Name) 没有接入共用身份判定。" }
  if ($pair.Source -notmatch 'Resolve-ManagedAppServerOwner') { throw "$($pair.Name) 没有调用 Resolve-ManagedAppServerOwner。" }
}

Write-Output 'PASS: managed app-server identity distinguishes desktop, empty command lines, and missing owner PID'
