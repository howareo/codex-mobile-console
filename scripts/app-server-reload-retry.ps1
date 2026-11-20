function ConvertTo-AppServerUtc {
  param([Parameter(Mandatory = $true)]$Value)
  if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
  return [DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
}

function Read-AppServerReloadFailure {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $record = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
    $item = Get-Item -LiteralPath $Path
    $targetKey = if ($record.targetKey) { [string]$record.targetKey } else { [string]$record.key }
    if (-not $targetKey) { return $null }
    return [pscustomobject]@{
      schemaVersion = if ($record.schemaVersion) { [int]$record.schemaVersion } else { 1 }
      targetKey = $targetKey
      failedAt = if ($record.failedAt) { (ConvertTo-AppServerUtc $record.failedAt).ToString('o') } else { $item.LastWriteTimeUtc.ToString('o') }
      stage = if ($record.stage) { [string]$record.stage } else { 'legacy-child-exit' }
      attempts = [Math]::Max(1, $(if ($record.attempts) { [int]$record.attempts } else { 1 }))
      exitCode = if ($null -ne $record.exitCode) { [int]$record.exitCode } else { $null }
      message = [string]$record.message
      sourceProcessId = if ($record.sourceProcessId) { [int]$record.sourceProcessId } else { 0 }
      sourceProcessStartedAt = [string]$record.sourceProcessStartedAt
      rollbackAttempted = [bool]$record.rollbackAttempted
      rollbackSucceeded = [bool]$record.rollbackSucceeded
      targetVersion = [string]$record.targetVersion
      targetSha256 = [string]$record.targetSha256
    }
  } catch { return $null }
}

function Get-AppServerReloadRetryDecision {
  param(
    $Failure,
    [Parameter(Mandatory = $true)][string]$TargetKey,
    [int]$CurrentProcessId = 0,
    [string]$CurrentProcessStartedAt,
    [DateTime]$NowUtc = [DateTime]::UtcNow,
    [int]$CooldownSeconds = 300,
    [int]$MaxAttempts = 3
  )
  if (-not $Failure -or $Failure.targetKey -ne $TargetKey) {
    return [pscustomobject]@{ Allowed = $true; State = 'ready'; Attempts = 0; RemainingSeconds = 0; Reason = $null }
  }
  $attempts = [Math]::Max(1, [int]$Failure.attempts)
  if ($attempts -ge $MaxAttempts) {
    return [pscustomobject]@{ Allowed = $false; State = 'paused'; Attempts = $attempts; RemainingSeconds = 0; Reason = "同一目标自动重载已失败 $attempts 次，已暂停；请运行 restart-4500 预览并手动处理。" }
  }
  $failedAt = [DateTime]::MinValue
  try { $failedAt = ConvertTo-AppServerUtc $Failure.failedAt } catch { }
  $normalizedNow = if ($NowUtc.Kind -eq [DateTimeKind]::Utc) { $NowUtc } else { $NowUtc.ToUniversalTime() }
  $elapsed = if ($failedAt -eq [DateTime]::MinValue) { $CooldownSeconds } else { [int][Math]::Floor(($normalizedNow - $failedAt).TotalSeconds) }
  $remaining = [Math]::Max(0, $CooldownSeconds - $elapsed)
  $preStopFailure = [string]$Failure.stage -in @('preflight', 'clients-raced', 'idle-raced', 'stop-old') -and -not [bool]$Failure.rollbackAttempted
  $processChanged = $Failure.sourceProcessId -gt 0 -and $CurrentProcessId -gt 0 -and [int]$Failure.sourceProcessId -ne $CurrentProcessId
  if (-not $processChanged -and $Failure.sourceProcessStartedAt -and $CurrentProcessStartedAt) {
    $processChanged = -not [string]::Equals([string]$Failure.sourceProcessStartedAt, $CurrentProcessStartedAt, [StringComparison]::Ordinal)
  }
  if ($remaining -gt 0 -and -not ($preStopFailure -and $processChanged)) {
    return [pscustomobject]@{ Allowed = $false; State = 'cooldown'; Attempts = $attempts; RemainingSeconds = $remaining; Reason = "上次自动重载在 $($Failure.stage) 阶段失败，冷却中（剩余约 $remaining 秒，第 $attempts/$MaxAttempts 次）。" }
  }
  return [pscustomobject]@{ Allowed = $true; State = 'retry'; Attempts = $attempts; RemainingSeconds = 0; Reason = $null }
}

function Write-AppServerReloadFailure {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TargetKey,
    [Parameter(Mandatory = $true)][string]$Stage,
    [int]$ExitCode = 1,
    [string]$Message,
    [int]$SourceProcessId = 0,
    [string]$SourceProcessStartedAt,
    [bool]$RollbackAttempted = $false,
    [bool]$RollbackSucceeded = $false,
    [string]$TargetVersion,
    [string]$TargetSha256
  )
  $previous = Read-AppServerReloadFailure -Path $Path
  $attempts = if ($previous -and $previous.targetKey -eq $TargetKey) { [int]$previous.attempts + 1 } else { 1 }
  $record = [ordered]@{
    schemaVersion = 2; targetKey = $TargetKey; failedAt = [DateTime]::UtcNow.ToString('o')
    stage = $Stage; attempts = $attempts; exitCode = $ExitCode; message = $Message
    sourceProcessId = $SourceProcessId; sourceProcessStartedAt = $SourceProcessStartedAt
    rollbackAttempted = $RollbackAttempted; rollbackSucceeded = $RollbackSucceeded
    targetVersion = $TargetVersion; targetSha256 = $TargetSha256
  }
  $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $tmp = "$Path.tmp.$PID"
  try {
    $record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $tmp -Encoding utf8
    Move-Item -LiteralPath $tmp -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $tmp -PathType Leaf) { Remove-Item -LiteralPath $tmp -Force }
  }
  return [pscustomobject]$record
}
