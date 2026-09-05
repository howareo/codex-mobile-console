[CmdletBinding()]
param(
  [string]$CandidatePath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-codex-binary.ps1')
$resolved = Resolve-CodexBinary -CandidatePath $CandidatePath
Assert-CodexBundle -BinaryPath $resolved
Write-Output "PASS: Codex complete bundle resolved to $resolved"

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codex-mobile-bundle-test-$PID-$([Guid]::NewGuid().ToString('N'))"
$fixtureBin = Join-Path $fixtureRoot 'bin'
$fixtureRuntime = Join-Path $fixtureRoot 'runtime'
try {
  $completeDirectory = Join-Path $fixtureBin 'complete-older'
  $incompleteDirectory = Join-Path $fixtureBin 'incomplete-newer'
  New-Item -ItemType Directory -Path $completeDirectory, $incompleteDirectory -Force | Out-Null
  foreach ($fileName in (Get-CodexBundleFileNames)) {
    Set-Content -LiteralPath (Join-Path $completeDirectory $fileName) -Value "fixture-$fileName" -Encoding ascii
  }
  Set-Content -LiteralPath (Join-Path $incompleteDirectory 'codex.exe') -Value 'incomplete' -Encoding ascii
  (Get-Item -LiteralPath (Join-Path $completeDirectory 'codex.exe')).LastWriteTimeUtc = [DateTime]::UtcNow.AddMinutes(-5)
  (Get-Item -LiteralPath (Join-Path $incompleteDirectory 'codex.exe')).LastWriteTimeUtc = [DateTime]::UtcNow

  $fixtureResolved = Resolve-CodexBinary -BinRoot $fixtureBin
  if ((Split-Path -Parent $fixtureResolved) -ne $completeDirectory) {
    throw "解析器选择了不完整目录：$fixtureResolved"
  }

  $snapshot = Copy-CodexBundleSnapshot -SourceBinary $fixtureResolved -RuntimeDir $fixtureRuntime
  Assert-CodexBundle -BinaryPath $snapshot
  foreach ($fileName in (Get-CodexBundleFileNames)) {
    $sourceHash = (Get-FileHash -LiteralPath (Join-Path $completeDirectory $fileName) -Algorithm SHA256).Hash
    $snapshotHash = (Get-FileHash -LiteralPath (Join-Path (Split-Path -Parent $snapshot) $fileName) -Algorithm SHA256).Hash
    if ($sourceHash -ne $snapshotHash) {
      throw "快照内容不一致：$fileName"
    }
  }
  Write-Output 'PASS: incomplete bundle skipped and complete bundle snapshot verified'

  $splitRoot = Join-Path $fixtureRoot 'npm-vendor\x86_64-pc-windows-msvc'
  $splitBin = Join-Path $splitRoot 'bin'
  $splitResources = Join-Path $splitRoot 'codex-resources'
  New-Item -ItemType Directory -Path $splitBin, $splitResources -Force | Out-Null
  foreach ($fileName in @('codex.exe', 'codex-code-mode-host.exe')) {
    Set-Content -LiteralPath (Join-Path $splitBin $fileName) -Value "npm-$fileName" -Encoding ascii
  }
  foreach ($fileName in @('codex-command-runner.exe', 'codex-windows-sandbox-setup.exe')) {
    Set-Content -LiteralPath (Join-Path $splitResources $fileName) -Value "npm-$fileName" -Encoding ascii
  }
  $splitBinary = Join-Path $splitBin 'codex.exe'
  Assert-CodexBundle -BinaryPath $splitBinary
  $splitSnapshot = Copy-CodexBundleSnapshot -SourceBinary $splitBinary -RuntimeDir $fixtureRuntime
  Assert-CodexBundle -BinaryPath $splitSnapshot
  foreach ($sourceFile in (Get-CodexBundleSourceFiles -BinaryPath $splitBinary)) {
    $sourceHash = (Get-FileHash -LiteralPath $sourceFile.Path -Algorithm SHA256).Hash
    $snapshotHash = (Get-FileHash -LiteralPath (Join-Path (Split-Path -Parent $splitSnapshot) $sourceFile.Name) -Algorithm SHA256).Hash
    if ($sourceHash -ne $snapshotHash) {
      throw "npm 分目录快照内容不一致：$($sourceFile.Name)"
    }
  }
  $preferencePath = Set-PreferredCodexBundle -RuntimeDir $fixtureRuntime -SourceBinary $splitBinary -SnapshotBinary $splitSnapshot
  $preferredBinary = Resolve-PreferredCodexBinary -RuntimeDir $fixtureRuntime
  if ($preferredBinary -ne $splitSnapshot -or -not (Test-Path -LiteralPath $preferencePath -PathType Leaf)) {
    throw '首选 bundle 没有持久化到 npm 快照。'
  }
  Write-Output 'PASS: npm split bundle snapshot and persistent preference verified'

  $desktopRoot = Join-Path $fixtureRoot 'OpenAI.Codex_26.999.1234.0_x64__fixture'
  $desktopResources = Join-Path $desktopRoot 'app\resources'
  New-Item -ItemType Directory -Path $desktopResources -Force | Out-Null
  foreach ($fileName in (Get-CodexBundleFileNames)) {
    Set-Content -LiteralPath (Join-Path $desktopResources $fileName) -Value "desktop-$fileName" -Encoding ascii
  }
  $desktopCandidate = Resolve-CodexDesktopBinary -InstallRoots @($desktopRoot)
  if (-not $desktopCandidate -or $desktopCandidate.Path -ne (Join-Path $desktopResources 'codex.exe') -or $desktopCandidate.Version -ne [Version]'26.999.1234.0') {
    throw 'WindowsApps Desktop bundle 未被正确发现或版本解析失败。'
  }
  Write-Output 'PASS: upgraded WindowsApps Desktop bundle discovery verified'
} finally {
  $resolvedFixtureRoot = [System.IO.Path]::GetFullPath($fixtureRoot)
  $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedFixtureRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedFixtureRoot)) {
    Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force
  }
}
