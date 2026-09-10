[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'codex-binary-update.ps1')

function New-FixtureBundle([string]$Directory, [string]$Label) {
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  foreach ($fileName in (Get-CodexBundleFileNames)) {
    Set-Content -LiteralPath (Join-Path $Directory $fileName) -Value "$Label-$fileName" -Encoding ascii
  }
  return Join-Path $Directory 'codex.exe'
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -ne $Expected) { throw "$Message；期望=$Expected，实际=$Actual" }
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codex-mobile-update-test-$PID-$([Guid]::NewGuid().ToString('N'))"
try {
  $runtime = Join-Path $fixtureRoot 'runtime'
  $oldBinary = New-FixtureBundle (Join-Path $fixtureRoot 'installed\old') 'old'
  $newBinary = New-FixtureBundle (Join-Path $fixtureRoot 'installed\new') 'new'
  $oldSnapshot = Copy-CodexBundleSnapshot -SourceBinary $oldBinary -RuntimeDir $runtime
  $preferencePath = Set-PreferredCodexBundle -RuntimeDir $runtime -SourceBinary $oldBinary -SnapshotBinary $oldSnapshot
  $oldPreferenceHash = (Get-FileHash -LiteralPath $preferencePath -Algorithm SHA256).Hash

  $first = Register-CodexBinaryUpdate -RuntimeDir $runtime -InstalledBinary $newBinary -RunningBinary $oldBinary -RunningPid 123 -InstalledVersion 'codex-cli 2.0.0'
  Assert-Equal $first.status 'observing' '首次观察不应登记切换'
  if (Test-Path -LiteralPath (Join-Path $runtime 'pending-app-server-switch.json')) { throw '首次观察错误地写入 pending。' }

  $second = Register-CodexBinaryUpdate -RuntimeDir $runtime -InstalledBinary $newBinary -RunningBinary $oldBinary -RunningPid 123 -InstalledVersion 'codex-cli 2.0.0'
  Assert-Equal $second.status 'staged' '连续稳定两次后应预存候选'
  $pendingPath = Join-Path $runtime 'pending-app-server-switch.json'
  $pending = Read-CodexBinaryRecord -Path $pendingPath
  Assert-Equal $pending.version 'codex-cli 2.0.0' 'pending 应记录目标版本'
  if (-not (Test-CodexPendingBinarySwitch -Record $pending -Full)) { throw '预存快照没有通过完整性校验。' }
  Assert-Equal (Get-FileHash -LiteralPath $preferencePath -Algorithm SHA256).Hash $oldPreferenceHash '预存候选前不应覆盖已验证首选记录'
  Write-Output 'PASS: healthy old app-server detects and stages a stable installed upgrade'

  $newerBinary = New-FixtureBundle (Join-Path $fixtureRoot 'installed\newer') 'newer'
  $third = Register-CodexBinaryUpdate -RuntimeDir $runtime -InstalledBinary $newerBinary -RunningBinary $oldBinary -RunningPid 123 -InstalledVersion 'codex-cli 3.0.0'
  Assert-Equal $third.status 'observing' '快速连续升级应重新开始稳定观察'
  $stillPending = Read-CodexBinaryRecord -Path $pendingPath
  Assert-Equal $stillPending.version 'codex-cli 2.0.0' '新候选未稳定前应保留上一个完整 pending'
  $fourth = Register-CodexBinaryUpdate -RuntimeDir $runtime -InstalledBinary $newerBinary -RunningBinary $oldBinary -RunningPid 123 -InstalledVersion 'codex-cli 3.0.0'
  Assert-Equal $fourth.status 'staged' '最新候选稳定后应覆盖 pending'
  $latestPending = Read-CodexBinaryRecord -Path $pendingPath
  Assert-Equal $latestPending.version 'codex-cli 3.0.0' 'pending 未更新为最新稳定版本'
  Write-Output 'PASS: rapid consecutive upgrades retain the last good target until the newest is stable'

  $invalidRecord = [ordered]@{ snapshotBinary = (Join-Path $fixtureRoot 'missing\codex.exe'); codexSha256 = 'BAD' }
  if (Test-CodexPendingBinarySwitch -Record $invalidRecord -Full) { throw '缺失 bundle 被错误接受。' }
  Write-Output 'PASS: incomplete or missing pending bundles are rejected'

  $watchSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'watch-mobile-stack.ps1') -Raw
  foreach ($guard in @('Test-AppServerIdle $AppServerUrl', '$reloadQuietCount -ge $ReloadQuietChecks', 'failed-auto-reload.json', '$versionPending')) {
    if (-not $watchSource.Contains($guard)) { throw "Missing automatic reload guard: $guard" }
  }
  $reloadSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'request-app-server-reload.ps1') -Raw
  foreach ($required in @('Get-ReloadBlockers', 'pending-app-server-switch.json', 'Get-CodexBinaryVersion', 'Assert-AppServerProtocol', '待处理标记已保留')) {
    if (-not $reloadSource.Contains($required)) { throw "维护重载缺少保护：$required" }
  }
  $statusSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'show-autostart-status.ps1') -Raw
  foreach ($required in @('4500实际版本', '已安装版本', '版本切换', '版本等待原因')) {
    if (-not $statusSource.Contains($required)) { throw "状态输出缺少字段：$required" }
  }
  $ensureSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'ensure-mobile-stack.ps1') -Raw
  if ($ensureSource.IndexOf("if (`$pendingBinary)", [StringComparison]::Ordinal) -gt $ensureSource.IndexOf("elseif (`$preferredBinary)", [StringComparison]::Ordinal)) { throw '启动选择没有优先消费待切换版本。' }
  if (-not $ensureSource.Contains('Remove-Item -LiteralPath $pendingSwitchPath')) { throw '成功启动后没有消费版本 pending。' }
  if (-not $ensureSource.Contains('[switch]$ApplyPendingSwitch') -or -not $ensureSource.Contains('$ApplyPendingSwitch -and $pendingSwitch')) { throw '普通故障自愈没有与维护窗口版本切换隔离。' }
  if (-not $reloadSource.Contains('-ApplyPendingSwitch')) { throw '维护重载没有明确授权消费版本 pending。' }
  if (-not $reloadSource.Contains('Write-CodexBinaryRecord -Path $switchPath -Record $pendingSwitch')) { throw '重载失败时没有恢复版本 pending。' }
  $switchSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'switch-shared-app-server.ps1') -Raw
  if ($switchSource.IndexOf('Set-PreferredCodexBundle', [StringComparison]::Ordinal) -lt $switchSource.IndexOf("if (`$currentOwner", [StringComparison]::Ordinal)) { throw '旧切换入口仍在验证前覆盖首选快照。' }
  Write-Output 'PASS: automatic switching requires quiet clients and idle tasks; failed target retries are blocked'
} finally {
  $resolvedFixture = [System.IO.Path]::GetFullPath($fixtureRoot)
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedFixture.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedFixture)) {
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
  }
}
