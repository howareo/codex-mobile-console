[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'app-server-reload-retry.ps1')
. (Join-Path $PSScriptRoot 'codex-config-fingerprint.ps1')

function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }

$root = Join-Path ([System.IO.Path]::GetTempPath()) "codex-mobile-retry-test-$PID-$([Guid]::NewGuid().ToString('N'))"
try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $path = Join-Path $root 'failed.json'
  $now = [DateTime]::UtcNow
  $legacy = @{ key = 'legacy-target'; exitCode = 124 }
  $legacy | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding utf8
  (Get-Item -LiteralPath $path).LastWriteTimeUtc = $now.AddMinutes(-10)
  $loadedLegacy = Read-AppServerReloadFailure -Path $path
  Assert-True ($loadedLegacy.targetKey -eq 'legacy-target' -and $loadedLegacy.attempts -eq 1) '旧失败标记迁移失败'
  $legacyDecision = Get-AppServerReloadRetryDecision -Failure $loadedLegacy -TargetKey 'legacy-target' -NowUtc $now
  Assert-True ($legacyDecision.Allowed -and $legacyDecision.State -eq 'retry') '旧失败标记冷却后应允许一次受控重试'

  $first = Write-AppServerReloadFailure -Path $path -TargetKey 'new-target' -Stage 'verify-protocol' -Message 'bad target' -SourceProcessId 10 -RollbackAttempted $true -RollbackSucceeded $true
  $cooldown = Get-AppServerReloadRetryDecision -Failure $first -TargetKey 'new-target' -NowUtc ([DateTime]::Parse($first.failedAt).AddSeconds(10))
  Assert-True (-not $cooldown.Allowed -and $cooldown.State -eq 'cooldown') '失败后必须进入冷却'
  $diskFirst = Read-AppServerReloadFailure -Path $path
  $diskCooldown = Get-AppServerReloadRetryDecision -Failure $diskFirst -TargetKey 'new-target' -NowUtc ((ConvertTo-AppServerUtc $first.failedAt).AddSeconds(10))
  Assert-True ($diskCooldown.State -eq 'cooldown' -and $diskCooldown.RemainingSeconds -eq 290) '从磁盘JSON读取后仍应冷却290秒，不能丢失UTC时区'
  $second = Write-AppServerReloadFailure -Path $path -TargetKey 'new-target' -Stage 'verify-protocol' -Message 'bad target again'
  $third = Write-AppServerReloadFailure -Path $path -TargetKey 'new-target' -Stage 'verify-protocol' -Message 'bad target third'
  $paused = Get-AppServerReloadRetryDecision -Failure $third -TargetKey 'new-target' -NowUtc ([DateTime]::Parse($third.failedAt).AddHours(1))
  Assert-True (-not $paused.Allowed -and $paused.State -eq 'paused' -and $paused.Attempts -eq 3) '达到次数上限后必须暂停同一目标'

  $preStop = [pscustomobject]@{ targetKey='race'; failedAt=$now.ToString('o'); stage='clients-raced'; attempts=1; sourceProcessId=10; sourceProcessStartedAt='old'; rollbackAttempted=$false }
  $changed = Get-AppServerReloadRetryDecision -Failure $preStop -TargetKey 'race' -CurrentProcessId 11 -CurrentProcessStartedAt 'new' -NowUtc $now
  Assert-True ($changed.Allowed -and $changed.State -eq 'retry') '进程变化后应解除 pre-stop 暂态失败'
  $badTarget = [pscustomobject]@{ targetKey='bad'; failedAt=$now.AddHours(-1).ToString('o'); stage='verify-protocol'; attempts=3; sourceProcessId=10; rollbackAttempted=$true }
  $stillPaused = Get-AppServerReloadRetryDecision -Failure $badTarget -TargetKey 'bad' -CurrentProcessId 11 -NowUtc $now
  Assert-True (-not $stillPaused.Allowed -and $stillPaused.State -eq 'paused') '回滚后的坏目标不得因进程变化自动解禁'
  $marker = [pscustomobject]@{ fingerprint = 'same' }
  $applied = [pscustomobject]@{ fingerprint = 'same' }
  $current = [pscustomobject]@{ fingerprint = 'same' }
  Assert-True (Test-CodexConfigReloadMarkerSatisfied -Marker $marker -Applied $applied -Current $current) '已应用且当前一致的配置 marker 应视为满足'
  $current.fingerprint = 'new'
  Assert-True (-not (Test-CodexConfigReloadMarkerSatisfied -Marker $marker -Applied $applied -Current $current)) '当前配置变化时 marker 不应视为满足'
  Write-Output 'PASS: reload failures migrate safely, cool down, retry finitely, and keep bad targets paused'
} finally {
  if ((Test-Path -LiteralPath $root) -and ([System.IO.Path]::GetFullPath($root)).StartsWith([System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $root -Recurse -Force
  }
}
