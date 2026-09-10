. (Join-Path $PSScriptRoot 'resolve-codex-binary.ps1')

function Get-CodexBinaryVersion {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$BinaryPath)

  try {
    $lines = @(& ([System.IO.Path]::GetFullPath($BinaryPath)) --version 2>$null)
    $value = ([string]::Join(' ', $lines)).Trim()
    if ($LASTEXITCODE -ne 0 -or $value -notmatch '^codex-cli\s+\S+') { return $null }
    return $value
  } catch {
    return $null
  }
}

function Get-CodexBundleMetadata {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$BinaryPath)

  Assert-CodexBundle -BinaryPath $BinaryPath
  $sourceFiles = @(Get-CodexBundleSourceFiles -BinaryPath $BinaryPath)
  $parts = @(
    foreach ($sourceFile in $sourceFiles | Sort-Object Name) {
      $item = Get-Item -LiteralPath $sourceFile.Path
      '{0}\t{1}\t{2}\t{3}' -f $sourceFile.Name, $item.Length, $item.LastWriteTimeUtc.Ticks, ([System.IO.Path]::GetFullPath($item.FullName))
    }
  )
  $payload = [string]::Join("`n", $parts)
  $sha = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($payload))
  [pscustomobject]@{
    sourceBinary = [System.IO.Path]::GetFullPath($BinaryPath)
    sourceFingerprint = [Convert]::ToHexString($sha).ToLowerInvariant()
    files = $parts
  }
}

function Get-CodexBundleContentFingerprint {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$BinaryPath)

  Assert-CodexBundle -BinaryPath $BinaryPath
  $parts = @(
    foreach ($sourceFile in @(Get-CodexBundleSourceFiles -BinaryPath $BinaryPath) | Sort-Object Name) {
      '{0}\t{1}' -f $sourceFile.Name, (Get-FileHash -LiteralPath $sourceFile.Path -Algorithm SHA256).Hash
    }
  )
  $payload = [string]::Join("`n", $parts)
  $sha = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($payload))
  return [Convert]::ToHexString($sha)
}

function Resolve-InstalledCodexBinary {
  [CmdletBinding()]
  param([string]$BinRoot)

  if ($PSBoundParameters.ContainsKey('BinRoot')) {
    return Resolve-CodexBinary -BinRoot $BinRoot
  }
  try {
    return Resolve-CodexBinary
  } catch {
    $desktop = Resolve-CodexDesktopBinary
    if ($desktop) { return [string]$desktop.Path }
    throw
  }
}

function Read-CodexBinaryRecord {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json } catch { return $null }
}

function Write-CodexBinaryRecord {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Record
  )

  $parent = Split-Path -Parent ([System.IO.Path]::GetFullPath($Path))
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporaryPath = "$Path.tmp.$PID"
  try {
    $Record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporaryPath -Encoding utf8
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
  }
}

function Test-CodexPendingBinarySwitch {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Record,
    [switch]$Full
  )

  if (-not $Record.snapshotBinary -or -not (Test-CodexBundle -BinaryPath ([string]$Record.snapshotBinary))) { return $false }
  if ($Full -and $Record.codexSha256) {
    $actualHash = (Get-FileHash -LiteralPath ([string]$Record.snapshotBinary) -Algorithm SHA256).Hash
    if ($actualHash -ne [string]$Record.codexSha256) { return $false }
  }
  if ($Full -and $Record.bundleSha256 -and (Get-CodexBundleContentFingerprint -BinaryPath ([string]$Record.snapshotBinary)) -ne [string]$Record.bundleSha256) { return $false }
  return $true
}

function Register-CodexBinaryUpdate {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeDir,
    [Parameter(Mandatory = $true)][string]$InstalledBinary,
    [string]$RunningBinary,
    [int]$RunningPid = 0,
    [ValidateRange(2, 10)][int]$StableChecks = 2,
    [string]$InstalledVersion
  )

  $resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeDir)
  $observationPath = Join-Path $resolvedRuntime 'installed-app-server-candidate.json'
  $pendingPath = Join-Path $resolvedRuntime 'pending-app-server-switch.json'
  $metadata = Get-CodexBundleMetadata -BinaryPath $InstalledBinary
  $pending = Read-CodexBinaryRecord -Path $pendingPath
  if ($pending -and $pending.sourceFingerprint -eq $metadata.sourceFingerprint -and (Test-CodexPendingBinarySwitch -Record $pending)) {
    return [pscustomobject]@{ status = 'pending'; record = $pending; changed = $false }
  }

  $observation = Read-CodexBinaryRecord -Path $observationPath
  if ($observation -and $observation.sourceFingerprint -eq $metadata.sourceFingerprint -and $observation.status -eq 'current' -and $RunningBinary -and $observation.runningBinary -and [string]::Equals([System.IO.Path]::GetFullPath($RunningBinary), [System.IO.Path]::GetFullPath([string]$observation.runningBinary), [StringComparison]::OrdinalIgnoreCase)) {
    return [pscustomobject]@{ status = 'current'; record = $observation; changed = $false }
  }
  $observations = if ($observation -and $observation.sourceFingerprint -eq $metadata.sourceFingerprint) { [int]$observation.stableObservations + 1 } else { 1 }
  $version = if ($InstalledVersion) { $InstalledVersion } elseif ($observation -and $observation.sourceFingerprint -eq $metadata.sourceFingerprint -and $observation.version) { [string]$observation.version } else { Get-CodexBinaryVersion -BinaryPath $metadata.sourceBinary }
  if (-not $version) { throw "候选 Codex 程序无法返回版本：$($metadata.sourceBinary)" }
  $observed = [ordered]@{
    status = 'observing'
    sourceBinary = $metadata.sourceBinary
    sourceFingerprint = $metadata.sourceFingerprint
    version = $version
    stableObservations = $observations
    observedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  Write-CodexBinaryRecord -Path $observationPath -Record $observed
  if ($observations -lt $StableChecks) {
    return [pscustomobject]@{ status = 'observing'; record = [pscustomobject]$observed; changed = $true }
  }

  $sourceHash = (Get-FileHash -LiteralPath $metadata.sourceBinary -Algorithm SHA256).Hash
  $sourceBundleHash = Get-CodexBundleContentFingerprint -BinaryPath $metadata.sourceBinary
  if (-not [string]::IsNullOrWhiteSpace($RunningBinary) -and (Test-Path -LiteralPath $RunningBinary -PathType Leaf)) {
    $runningHash = (Get-FileHash -LiteralPath $RunningBinary -Algorithm SHA256).Hash
    $runningBundleHash = Get-CodexBundleContentFingerprint -BinaryPath $RunningBinary
    if ($runningHash -eq $sourceHash -and $runningBundleHash -eq $sourceBundleHash) {
      $observed.status = 'current'
      $observed.codexSha256 = $sourceHash
      $observed.bundleSha256 = $sourceBundleHash
      $observed.runningBinary = [System.IO.Path]::GetFullPath($RunningBinary)
      Write-CodexBinaryRecord -Path $observationPath -Record $observed
      return [pscustomobject]@{ status = 'current'; record = [pscustomobject]$observed; changed = $true }
    }
  }

  $snapshotBinary = Copy-CodexBundleSnapshot -SourceBinary $metadata.sourceBinary -RuntimeDir $resolvedRuntime
  $metadataAfterCopy = Get-CodexBundleMetadata -BinaryPath $metadata.sourceBinary
  if ($metadataAfterCopy.sourceFingerprint -ne $metadata.sourceFingerprint) {
    $observed.sourceFingerprint = $metadataAfterCopy.sourceFingerprint
    $observed.stableObservations = 1
    $observed.status = 'observing'
    $observed.observedAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-CodexBinaryRecord -Path $observationPath -Record $observed
    return [pscustomobject]@{ status = 'changed-during-copy'; record = [pscustomobject]$observed; changed = $true }
  }
  $snapshotHash = (Get-FileHash -LiteralPath $snapshotBinary -Algorithm SHA256).Hash
  if ($snapshotHash -ne $sourceHash) { throw '候选 Codex 快照与安装文件哈希不一致。' }
  if ((Get-CodexBundleContentFingerprint -BinaryPath $snapshotBinary) -ne $sourceBundleHash) { throw '候选 Codex 快照的完整 bundle 哈希不一致。' }

  $record = [ordered]@{
    reason = 'installed-binary-changed'
    currentPid = $RunningPid
    currentBinary = if ($RunningBinary) { [System.IO.Path]::GetFullPath($RunningBinary) } else { $null }
    sourceBinary = $metadata.sourceBinary
    sourceFingerprint = $metadata.sourceFingerprint
    snapshotBinary = [System.IO.Path]::GetFullPath($snapshotBinary)
    codexSha256 = $sourceHash
    bundleSha256 = $sourceBundleHash
    version = $version
    stableObservations = $observations
    requestedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  Write-CodexBinaryRecord -Path $pendingPath -Record $record
  $observed.status = 'pending'
  $observed.codexSha256 = $sourceHash
  $observed.snapshotBinary = $record.snapshotBinary
  Write-CodexBinaryRecord -Path $observationPath -Record $observed
  return [pscustomobject]@{ status = 'staged'; record = [pscustomobject]$record; changed = $true }
}
