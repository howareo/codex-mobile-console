if (-not (Get-Command Get-AppServerReloadRetryDecision -ErrorAction SilentlyContinue)) {
  . (Join-Path $PSScriptRoot 'app-server-reload-retry.ps1')
}

function Get-AppServerProcessLabel {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return "未知进程（PID 0，可能未提权）" }
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if (-not $owner) { return "PID $ProcessId（已退出）" }
  $name = [string]$owner.Name
  if ($name -ieq 'ChatGPT.exe') { return "Codex Desktop（ChatGPT.exe PID $ProcessId）" }
  if ($name -ieq 'codex.exe') { return "codex.exe（PID $ProcessId）" }
  if ($name -ieq 'node.exe') { return "Node（PID $ProcessId）" }
  return "$name（PID $ProcessId）"
}

function Test-GatewayMaintenanceReady {
  param($Status, [int]$ProcessId)
  try {
    $age = ([DateTime]::UtcNow - (ConvertTo-AppServerUtc $Status.updatedAt)).TotalSeconds
    return $ProcessId -gt 0 -and [int]$Status.pid -eq $ProcessId -and $age -ge 0 -and $age -lt 30
  } catch { return $false }
}

function Get-AppServerClientBlockers {
  param(
    [int]$AppPort = 4500,
    [int]$GatewayPort = 4174
  )
  $gatewayListener = Get-NetTCPConnection -LocalPort $GatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  $gatewayProcessId = if ($gatewayListener) { [int]$gatewayListener.OwningProcess } else { 0 }
  $desktopPids = @(
    Get-NetTCPConnection -RemotePort $AppPort -State Established -ErrorAction SilentlyContinue |
      Where-Object { [int]$_.OwningProcess -ne $gatewayProcessId } |
      Select-Object -ExpandProperty OwningProcess -Unique
  )
  $phoneConnections = @(Get-NetTCPConnection -LocalPort $GatewayPort -State Established -ErrorAction SilentlyContinue)
  $desktopLabels = @($desktopPids | ForEach-Object { Get-AppServerProcessLabel -ProcessId ([int]$_) })
  $messages = [System.Collections.Generic.List[string]]::new()
  if ($desktopLabels.Count -gt 0) { $messages.Add("桌面端或其他客户端仍连接 4500：$($desktopLabels -join '，')") }
  # New gateways can pause requests and acknowledge a maintenance window.
  # Keep the old safety gate until that capability is observed for the live PID.
  $maintenanceReady = $false
  $statusPath = Join-Path $PSScriptRoot '../.runtime/gateway-maintenance-status.json'
  try {
    $status = Get-Content -LiteralPath $statusPath -Raw -ErrorAction Stop | ConvertFrom-Json
    $maintenanceReady = Test-GatewayMaintenanceReady -Status $status -ProcessId $gatewayProcessId
  } catch { }
  if ($phoneConnections.Count -gt 0 -and -not $maintenanceReady) { $messages.Add("手机页面仍连接 $GatewayPort（旧网关尚未启用维护握手，请先更新网关）") }
  return [pscustomobject]@{
    DesktopPids = @($desktopPids)
    DesktopLabels = @($desktopLabels)
    PhoneCount = @($phoneConnections).Count
    Messages = @($messages)
  }
}

function Get-AppServerIdleSnapshot {
  param([string]$Url = 'ws://127.0.0.1:4500')
  $entry = Join-Path $PSScriptRoot '../dist/server/probe/idle-cli.js'
  $empty = [pscustomobject]@{ idle = $false; loaded = 0; busyCount = 0; unknownCount = 0; busy = @(); unknown = @(); error = $null }
  if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    $empty.error = "缺少空闲检查程序：$entry"
    return $empty
  }
  try {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $output = @(& $node $entry $Url 2>$null)
    $parsed = ([string]::Join("`n", $output) | ConvertFrom-Json)
    return [pscustomobject]@{
      idle = [bool]$parsed.idle
      loaded = [int]$parsed.loaded
      busyCount = [int]$parsed.busyCount
      unknownCount = [int]$parsed.unknownCount
      busy = @($parsed.busy)
      unknown = @($parsed.unknown)
      error = [string]$parsed.error
    }
  } catch {
    $empty.error = $_.Exception.Message
    return $empty
  }
}

function Get-AppServerReloadWaitReason {
  param(
    [int]$AppPort = 4500,
    [int]$GatewayPort = 4174,
    [string]$ListenUrl = 'ws://127.0.0.1:4500',
    $Failure,
    [string]$TargetKey,
    [int]$CurrentProcessId = 0,
    [string]$CurrentProcessStartedAt,
    [int]$RetryCooldownSeconds = 300,
    [int]$RetryMaxAttempts = 3
  )
  if ($Failure -and $TargetKey) {
    $retry = Get-AppServerReloadRetryDecision -Failure $Failure -TargetKey $TargetKey -CurrentProcessId $CurrentProcessId -CurrentProcessStartedAt $CurrentProcessStartedAt -CooldownSeconds $RetryCooldownSeconds -MaxAttempts $RetryMaxAttempts
    if (-not $retry.Allowed) { return $retry.Reason }
  }
  $clients = Get-AppServerClientBlockers -AppPort $AppPort -GatewayPort $GatewayPort
  if ($clients.Messages.Count -gt 0) {
    return ($clients.Messages -join '；') + '。关掉这些窗口后，看门会自动重载；要立刻重载可先运行 restart-4500 -Wait。'
  }
  $idle = Get-AppServerIdleSnapshot -Url $ListenUrl
  if ($idle.error) { return "阻塞连接已释放，但任务空闲检查失败：$($idle.error)。为避免打断任务，自动重载保持暂停。" }
  if ($idle.unknownCount -gt 0) { return "阻塞连接已释放，但有 $($idle.unknownCount) 个任务状态未知。为避免打断任务，自动重载保持暂停。" }
  if ($idle.idle) { return '阻塞连接已释放且任务空闲，看门将在约 1 分钟内自动重载。' }
  $busyText = if ($idle.busyCount -gt 0) { "还有 $($idle.busyCount) 个任务在跑" } else { '任务尚未明确空闲' }
  return "阻塞连接已释放，$busyText。看门会等待任务明确空闲，不会强制重载 4500。"
}

function Format-AppServerReloadPreview {
  param(
    [int]$ProcessId,
    [string]$Fingerprint,
    $PendingSwitch,
    $Clients,
    $Idle,
    [switch]$Wait,
    [int]$WaitSeconds = 180
  )
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("预览：将为 PID $ProcessId 应用配置指纹 $Fingerprint。")
  if ($PendingSwitch) { $lines.Add("版本切换：$($PendingSwitch.version)，目标 $($PendingSwitch.snapshotBinary)。") }
  if ($Clients.Messages.Count -gt 0) { $lines.Add("当前连着：$($Clients.Messages -join '；')。") }
  else { $lines.Add('没有阻塞重载的桌面连接；新版手机网关将在维护窗口暂停请求，无需关闭手机页面。') }
  if ($Idle.error) { $lines.Add("任务空闲检查失败：$($Idle.error)") }
  elseif ($Idle.idle) { $lines.Add("已加载任务 $($Idle.loaded) 个，均为空闲。") }
  else { $lines.Add("已加载任务 $($Idle.loaded) 个，其中 $($Idle.busyCount) 个仍在跑。重载会等待任务明确空闲，不会打断这些任务。") }
  if ($Wait) {
    $lines.Add("等待模式：最多等 $WaitSeconds 秒，直到桌面断开且任务明确空闲后再重载；新版手机网关自动暂停请求。先运行带 -Apply 的命令，再关 Codex。")
  } else {
    $lines.Add('推荐：先执行下面这行，再退出 Codex Desktop；新版手机页面可保持打开。')
    $lines.Add('  .\scripts\codex-mobile.ps1 restart-4500 -Wait -Apply -Confirmation RELOAD_SHARED_APP_SERVER')
    $lines.Add('窗口已经关掉的话，直接执行：')
    $lines.Add('  .\scripts\codex-mobile.ps1 restart-4500 -Apply -Confirmation RELOAD_SHARED_APP_SERVER')
  }
  $lines.Add('预览不会写标记、停止进程或修改配置。确认词也可以写成 RESTART_4500。')
  return @($lines)
}
