$TaskName = "Codex Mobile Console"
$PSNativeCommandUseErrorActionPreference = $false
. (Join-Path $PSScriptRoot 'codex-binary-update.ps1')
. (Join-Path $PSScriptRoot 'get-app-server-reload-state.ps1')
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$info = if ($task) { Get-ScheduledTaskInfo -TaskName $TaskName } else { $null }
$appServer = Get-NetTCPConnection -LocalPort 4500 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$gateway = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$appOwner = if ($appServer) { Get-CimInstance Win32_Process -Filter "ProcessId=$($appServer.OwningProcess)" -ErrorAction SilentlyContinue } else { $null }
$runningBinary = if ($appOwner) { [string]$appOwner.ExecutablePath } else { $null }
$runningVersion = if ($runningBinary) { Get-CodexBinaryVersion -BinaryPath $runningBinary } else { $null }
$installedBinary = try { Resolve-InstalledCodexBinary } catch { $null }
$installedVersion = if ($installedBinary) { Get-CodexBinaryVersion -BinaryPath $installedBinary } else { $null }
$pendingSwitchPath = Join-Path $PSScriptRoot '..\.runtime\pending-app-server-switch.json'
$pendingSwitchExists = Test-Path -LiteralPath $pendingSwitchPath -PathType Leaf
$pendingSwitch = Read-CodexBinaryRecord -Path $pendingSwitchPath
$versionMarkerSatisfied = $pendingSwitch -and $runningBinary -and (Test-CodexBinarySatisfiesPendingSwitch -Record $pendingSwitch -BinaryPath $runningBinary)
if ($versionMarkerSatisfied) { $pendingSwitch = $null; $pendingSwitchExists = $false }
$autoFailure = Read-AppServerReloadFailure -Path (Join-Path $PSScriptRoot '../.runtime/failed-auto-reload.json')
$protocol = $null
$protocolError = $null
if ($appServer) {
  $protocolEntry = Join-Path $PSScriptRoot '..\dist\server\probe\protocol-health-cli.js'
  try {
    if (-not (Test-Path -LiteralPath $protocolEntry -PathType Leaf)) { throw '协议检查程序尚未构建' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $protocolOutput = @(& $node $protocolEntry --url 'ws://127.0.0.1:4500' --timeout-ms 8000 2>&1)
    $protocol = ([string]::Join("`n", $protocolOutput)) | ConvertFrom-Json -ErrorAction Stop
  } catch { $protocolError = $_.Exception.Message }
}
$pendingReload = Join-Path $PSScriptRoot '..\.runtime\pending-app-server-reload.json'
$pendingRecord = if (Test-Path -LiteralPath $pendingReload -PathType Leaf) { try { Get-Content -LiteralPath $pendingReload -Raw -Encoding utf8 | ConvertFrom-Json } catch { $null } } else { $null }
$statePath = Join-Path $PSScriptRoot '..\.runtime\app-server-config-fingerprint.json'
$appliedRecord = if (Test-Path -LiteralPath $statePath -PathType Leaf) { try { Get-Content -LiteralPath $statePath -Raw -Encoding utf8 | ConvertFrom-Json } catch { $null } } else { $null }
$configFingerprintScript = Join-Path $PSScriptRoot 'codex-config-fingerprint.ps1'
if (Test-Path -LiteralPath $configFingerprintScript -PathType Leaf) { . $configFingerprintScript }
$currentRecord = $null
$currentReadError = $null
try { $currentRecord = Get-CodexConfigFingerprintRecord } catch { $currentReadError = $_.Exception.Message }
$changeSummary = if ($pendingRecord -and $appliedRecord -and $pendingRecord.components -and $appliedRecord.components) { Format-CodexConfigChangeSummary $appliedRecord $pendingRecord } else { $null }
$effectiveChangeSummary = if ($currentRecord -and $appliedRecord -and $currentRecord.components -and $appliedRecord.components) { Format-CodexConfigChangeSummary $appliedRecord $currentRecord } else { $null }
$watchdog = if ($task -and ($task.Actions.Arguments -match "watch-mobile-stack\.ps1")) { "已启用" } else { "未启用或旧版" }
$lastResult = if (-not $info) { "无" } elseif ($task.State -eq "Running") { "运行中（正常）" } elseif ($info.LastTaskResult -eq 0) { "成功" } else { "错误码 $($info.LastTaskResult)" }
$configMarkerSatisfied = Test-CodexConfigReloadMarkerSatisfied -Marker $pendingRecord -Applied $appliedRecord -Current $currentRecord
$configPending = (($pendingRecord -and -not $configMarkerSatisfied) -or ($effectiveChangeSummary -and $effectiveChangeSummary -ne '无变化'))
$gatewayPid = if ($gateway) { [int]$gateway.OwningProcess } else { 0 }
$desktopClients = if ($appServer) { @(Get-NetTCPConnection -RemotePort 4500 -State Established -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne $gatewayPid } | Select-Object -ExpandProperty OwningProcess -Unique) } else { @() }
$phoneConnections = if ($gateway) { @(Get-NetTCPConnection -LocalPort 4174 -State Established -ErrorAction SilentlyContinue) } else { @() }
$binaryDrift = if ($installedBinary -and $runningBinary) { try { (Get-FileHash -LiteralPath $installedBinary -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $runningBinary -Algorithm SHA256).Hash } catch { $installedVersion -ne $runningVersion } } else { $false }
$reloadWaitReason = if ($configPending -or $pendingSwitch) {
  $targetFingerprint = if ($currentRecord) { [string]$currentRecord.fingerprint } elseif ($pendingRecord) { [string]$pendingRecord.fingerprint } else { '' }
  $reloadTargetKey = "$targetFingerprint`:$($pendingSwitch.codexSha256)"
  $ownerStartedAt = if ($appOwner) { [string]$appOwner.CreationDate } else { $null }
  Get-AppServerReloadWaitReason -AppPort 4500 -GatewayPort 4174 -ListenUrl 'ws://127.0.0.1:4500' -Failure $autoFailure -TargetKey $reloadTargetKey -CurrentProcessId $(if ($appOwner) { [int]$appOwner.ProcessId } else { 0 }) -CurrentProcessStartedAt $ownerStartedAt
} elseif ($pendingSwitchExists) {
  '待切换标记无法解析；请执行 diagnose'
} elseif ($binaryDrift) {
  '等待看门连续两次确认完整安装 bundle'
} else {
  '无'
}
$switchWaitReason = if ($versionMarkerSatisfied) { '无（目标已运行）' } else { $reloadWaitReason }
$overall = if (-not $appServer) {
  '停止'
} elseif ($protocolError -or -not $protocol -or -not $protocol.ok) {
  '异常：4500 协议检查未通过'
} elseif ($configPending -or ($pendingSwitchExists -and -not ($pendingSwitch -and $runningBinary -and (Test-CodexBinarySatisfiesPendingSwitch -Record $pendingSwitch -BinaryPath $runningBinary))) -or $binaryDrift) {
  '需要维护：4500 协议可用，但配置或版本尚未应用'
} elseif (-not $gateway) {
  '部分可用：4500 正常，4174 未运行'
} else {
  '正常'
}

[pscustomobject]@{
  整体状态 = $overall
  自动启动任务 = if ($task) { "已安装" } else { "未安装" }
  运行中看门 = $watchdog
  任务状态 = if ($task) { [string]$task.State } else { "无" }
  上次执行结果 = $lastResult
  上次启动时间 = if ($info) { $info.LastRunTime } else { "无" }
  '4500进程' = if ($appServer) { "运行中，PID $($appServer.OwningProcess)" } else { "未运行" }
  '4500实际版本' = if ($runningVersion) { "$runningVersion（$runningBinary）" } else { '未运行或版本读取失败' }
  '已安装版本' = if ($installedVersion) { "$installedVersion（$installedBinary）" } else { '未发现完整安装 bundle' }
  '版本切换' = if ($versionMarkerSatisfied) { '目标已运行，旧标记不再触发重载' } elseif ($pendingSwitch) { "待处理：$($pendingSwitch.version) -> $($pendingSwitch.snapshotBinary)" } elseif ($pendingSwitchExists) { '待处理标记无法解析' } elseif ($binaryDrift) { '磁盘安装版本与 4500 不同，等待看门连续确认并登记' } else { '已一致' }
  '版本等待原因' = $switchWaitReason
  '重载等待' = $reloadWaitReason
  '自动切换策略' = if ($autoFailure) { '失败后按冷却时间有限重试；同一目标连续失败达到上限后暂停并要求手动处理。' } else { '关掉桌面和手机后，只有任务明确空闲约 1 分钟才自动重载；任务运行中或状态未知时继续等待。' }
  '4500协议' = if (-not $appServer) { '未检查' } elseif ($protocolError) { "检查失败：$protocolError" } elseif ($protocol.ok) { "正常（initialize + thread/list，任务数 $($protocol.threadCount)，$($protocol.durationMs)ms）" } else { "异常：$($protocol.error)" }
  手机网关 = if ($gateway) { "正常，PID $($gateway.OwningProcess)" } else { "未运行" }
  配置重载 = if ($currentReadError) { "无法确认（配置正在写入或解析失败）" } elseif ($configMarkerSatisfied) { '已应用（旧标记不再触发重载）' } elseif ($pendingRecord -and $changeSummary) { "待处理：$changeSummary" } elseif ($effectiveChangeSummary -and $effectiveChangeSummary -ne '无变化') { "磁盘配置已变化，待看门登记：$effectiveChangeSummary" } elseif ($pendingRecord) { "待处理（等待看门刷新变化分类）" } elseif (Test-Path -LiteralPath $pendingReload -PathType Leaf) { "待处理（标记无法解析）" } else { "已应用" }
  登录连接地址 = [Environment]::GetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", "User")
} | Format-List
