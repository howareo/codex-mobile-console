$TaskName = "Codex Mobile Console"
$PSNativeCommandUseErrorActionPreference = $false
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$info = if ($task) { Get-ScheduledTaskInfo -TaskName $TaskName } else { $null }
$appServer = Get-NetTCPConnection -LocalPort 4500 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$gateway = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
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
$changeKinds = if ($pendingRecord -and $appliedRecord -and $pendingRecord.components -and $appliedRecord.components) {
  [ordered]@{
    provider = ([string]$pendingRecord.components.providerConfigSha256 -ne [string]$appliedRecord.components.providerConfigSha256)
    credentials = ([string]$pendingRecord.components.credentialsSha256 -ne [string]$appliedRecord.components.credentialsSha256)
    catalogs = ([string]$pendingRecord.components.modelCatalogSha256 -ne [string]$appliedRecord.components.modelCatalogSha256)
    instructions = ([string]$pendingRecord.components.instructionsSha256 -ne [string]$appliedRecord.components.instructionsSha256)
    hooks = ([string]$pendingRecord.components.hooksSha256 -ne [string]$appliedRecord.components.hooksSha256)
    deployment = ([string]$pendingRecord.components.deploymentManifestSha256 -ne [string]$appliedRecord.components.deploymentManifestSha256)
  }
} else { $null }
$effectiveChangeKinds = if ($currentRecord -and $appliedRecord -and $currentRecord.components -and $appliedRecord.components) {
  [ordered]@{
    provider = ([string]$currentRecord.components.providerConfigSha256 -ne [string]$appliedRecord.components.providerConfigSha256)
    credentials = ([string]$currentRecord.components.credentialsSha256 -ne [string]$appliedRecord.components.credentialsSha256)
    catalogs = ([string]$currentRecord.components.modelCatalogSha256 -ne [string]$appliedRecord.components.modelCatalogSha256)
    instructions = ([string]$currentRecord.components.instructionsSha256 -ne [string]$appliedRecord.components.instructionsSha256)
    hooks = ([string]$currentRecord.components.hooksSha256 -ne [string]$appliedRecord.components.hooksSha256)
    deployment = ([string]$currentRecord.components.deploymentManifestSha256 -ne [string]$appliedRecord.components.deploymentManifestSha256)
  }
} else { $null }
$watchdog = if ($task -and ($task.Actions.Arguments -match "watch-mobile-stack\.ps1")) { "已启用" } else { "未启用或旧版" }
$lastResult = if (-not $info) { "无" } elseif ($task.State -eq "Running") { "运行中（正常）" } elseif ($info.LastTaskResult -eq 0) { "成功" } else { "错误码 $($info.LastTaskResult)" }
$configPending = $pendingRecord -or ($effectiveChangeKinds -and ($effectiveChangeKinds.provider -or $effectiveChangeKinds.credentials -or $effectiveChangeKinds.catalogs -or $effectiveChangeKinds.instructions -or $effectiveChangeKinds.hooks -or $effectiveChangeKinds.deployment))
$overall = if (-not $appServer) {
  '停止'
} elseif ($protocolError -or -not $protocol -or -not $protocol.ok) {
  '异常：4500 协议检查未通过'
} elseif ($configPending) {
  '需要维护：4500 协议可用，但磁盘配置尚未应用'
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
  '4500协议' = if (-not $appServer) { '未检查' } elseif ($protocolError) { "检查失败：$protocolError" } elseif ($protocol.ok) { "正常（initialize + thread/list，任务数 $($protocol.threadCount)，$($protocol.durationMs)ms）" } else { "异常：$($protocol.error)" }
  手机网关 = if ($gateway) { "正常，PID $($gateway.OwningProcess)" } else { "未运行" }
  配置重载 = if ($currentReadError) { "无法确认（配置正在写入或解析失败）" } elseif ($pendingRecord -and $changeKinds) { "待处理（provider=$($changeKinds.provider), credentials=$($changeKinds.credentials), catalogs=$($changeKinds.catalogs), instructions=$($changeKinds.instructions), hooks=$($changeKinds.hooks), deployment=$($changeKinds.deployment)）" } elseif ($effectiveChangeKinds -and ($effectiveChangeKinds.provider -or $effectiveChangeKinds.credentials -or $effectiveChangeKinds.catalogs -or $effectiveChangeKinds.instructions -or $effectiveChangeKinds.hooks -or $effectiveChangeKinds.deployment)) { "磁盘配置已变化，待看门登记（provider=$($effectiveChangeKinds.provider), credentials=$($effectiveChangeKinds.credentials), catalogs=$($effectiveChangeKinds.catalogs), instructions=$($effectiveChangeKinds.instructions), hooks=$($effectiveChangeKinds.hooks), deployment=$($effectiveChangeKinds.deployment)）" } elseif ($pendingRecord) { "待处理（等待看门刷新变化分类）" } elseif (Test-Path -LiteralPath $pendingReload -PathType Leaf) { "待处理（标记无法解析）" } else { "已应用" }
  登录连接地址 = [Environment]::GetEnvironmentVariable("CODEX_APP_SERVER_WS_URL", "User")
} | Format-List
