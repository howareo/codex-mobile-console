[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$protectScript = Join-Path $PSScriptRoot 'protect-sensitive-runtime.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codex-mobile-sensitive-test-$PID-$([Guid]::NewGuid().ToString('N'))"
$runtimeDir = Join-Path $fixtureRoot 'runtime'
$legacyTls = Join-Path $runtimeDir 'tls'
$privateRoot = Join-Path $runtimeDir 'private'
$expectedSids = @(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  [System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null).Value,
  [System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null).Value
) | Sort-Object -Unique

function Assert-PrivateAcl([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { throw "ACL 仍继承父目录：$Path" }
  $actualSids = @($acl.Access | ForEach-Object {
    $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } | Sort-Object -Unique)
  if ((Compare-Object $expectedSids $actualSids).Count -ne 0) {
    throw "ACL 身份不符合预期：$Path"
  }
  if (@($acl.Access | Where-Object { $_.IsInherited -or $_.AccessControlType -ne 'Allow' -or ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl }).Count -gt 0) {
    throw "ACL 权限不符合预期：$Path"
  }
}

try {
  New-Item -ItemType Directory -Path $legacyTls -Force | Out-Null
  $legacyFiles = @{
    (Join-Path $runtimeDir 'pairing-secret.txt') = 'pairing-fixture'
    (Join-Path $runtimeDir 'sessions.json') = '{"version":1,"sessions":[]}'
    (Join-Path $legacyTls 'codex-mobile-server.key') = 'server-key-fixture'
    (Join-Path $legacyTls 'codex-mobile-ca.key') = 'ca-key-fixture'
  }
  foreach ($entry in $legacyFiles.GetEnumerator()) {
    Set-Content -LiteralPath $entry.Key -Value $entry.Value -NoNewline -Encoding ascii
  }
  $sourceHashes = @{}
  foreach ($path in $legacyFiles.Keys) { $sourceHashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }

  & $protectScript -RuntimeDir $runtimeDir | Out-Null
  if (Test-Path -LiteralPath $privateRoot) { throw 'dry-run 创建了敏感目录。' }

  & $protectScript -Apply -RuntimeDir $runtimeDir | Out-Null
  $destinations = @(
    (Join-Path $privateRoot 'pairing-secret.txt'),
    (Join-Path $privateRoot 'sessions.json'),
    (Join-Path $privateRoot 'tls\codex-mobile-server.key'),
    (Join-Path $privateRoot 'tls\codex-mobile-ca.key')
  )
  foreach ($source in $legacyFiles.Keys) {
    if (Test-Path -LiteralPath $source) { throw "迁移后仍保留旧文件：$source" }
  }
  foreach ($destination in $destinations) {
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) { throw "迁移目标缺失：$destination" }
    Assert-PrivateAcl $destination
  }
  Assert-PrivateAcl $privateRoot
  Assert-PrivateAcl (Join-Path $privateRoot 'tls')

  $expectedHashes = @($sourceHashes.Values | Sort-Object)
  $actualHashes = @($destinations | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash } | Sort-Object)
  if ((Compare-Object $expectedHashes $actualHashes).Count -ne 0) { throw '迁移前后文件哈希不一致。' }

  & $protectScript -Apply -RuntimeDir $runtimeDir | Out-Null
  Write-Output 'PASS：敏感文件迁移、哈希、受保护 ACL 和重复执行均通过。'

  $legacyPairing = Join-Path $runtimeDir 'pairing-secret.txt'
  Set-Content -LiteralPath $legacyPairing -Value 'conflicting-pairing' -NoNewline -Encoding ascii
  $privatePairing = Join-Path $privateRoot 'pairing-secret.txt'
  $privateHash = (Get-FileHash -LiteralPath $privatePairing -Algorithm SHA256).Hash
  $failedAsExpected = $false
  try { & $protectScript -Apply -RuntimeDir $runtimeDir | Out-Null } catch { $failedAsExpected = $_.Exception.Message -match '内容不同' }
  if (-not $failedAsExpected -or -not (Test-Path -LiteralPath $legacyPairing) -or (Get-FileHash -LiteralPath $privatePairing -Algorithm SHA256).Hash -ne $privateHash) {
    throw '冲突预检没有保留新旧文件。'
  }
  Write-Output 'PASS：新旧文件冲突在修改前退出并保留双方。'
} finally {
  $resolvedFixtureRoot = [System.IO.Path]::GetFullPath($fixtureRoot)
  $resolvedTempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  if ($resolvedFixtureRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedFixtureRoot)) {
    Remove-Item -LiteralPath $resolvedFixtureRoot -Recurse -Force
  }
}
