[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$Confirmation,
  [string]$GlobalConfigPath = (Join-Path $HOME '.codex\config.toml'),
  [string]$BackupPath = (Join-Path $PSScriptRoot '..\.runtime\codex-node-repl\config.toml.before')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'codex-node-repl-common.ps1')

$resolvedConfig = [System.IO.Path]::GetFullPath($GlobalConfigPath)
$resolvedBackup = [System.IO.Path]::GetFullPath($BackupPath)
$backupHashPath = "$resolvedBackup.sha256"
$appliedHashPath = "$resolvedBackup.applied.sha256"
$launcher = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'start-codex-node-repl.ps1'))
$pwsh = Get-StablePowerShellPath
Assert-TomlConfigReadable -Path $resolvedConfig
$original = [System.IO.File]::ReadAllText($resolvedConfig)
$newline = if ($original.Contains("`r`n")) { "`r`n" } else { "`n" }
$pwshToml = $pwsh.Replace('\', '\\')
$launcherToml = $launcher.Replace('\', '\\')
$stableNotify = "notify = [ `"$pwshToml`", `"-NoProfile`", `"-ExecutionPolicy`", `"Bypass`", `"-File`", `"$launcherToml`", `"-Mode`", `"Notify`", `"turn-ended`" ]"
$stableCommand = "command = '$pwsh'"
$stableArgs = "args = [ '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '$launcher', '-Mode', 'NodeRepl' ]"

$notifyPattern = '(?m)^notify\s*=\s*\[[^\r\n]*\]\s*$'
if (-not [regex]::Match($original, $notifyPattern).Success) { throw '未找到根级 notify 配置行。' }
$updated = [regex]::Replace($original, $notifyPattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $stableNotify }, 1)
$nodeSectionPattern = '(?ms)^\[mcp_servers\.node_repl\][^\r\n]*(?:\r?\n|$).*?(?=^\[|\z)'
$nodeMatch = [regex]::Match($updated, $nodeSectionPattern)
if (-not $nodeMatch.Success) { throw '未找到 [mcp_servers.node_repl] 配置块。' }
$nodeSection = $nodeMatch.Value
if ([regex]::Matches($nodeSection, '(?m)^command\s*=\s*.*$').Count -ne 1) { throw '[mcp_servers.node_repl] 中 command 配置不唯一。' }
if ([regex]::Matches($nodeSection, '(?m)^args\s*=\s*.*$').Count -ne 1) { throw '[mcp_servers.node_repl] 中 args 配置不唯一。' }
$nodeSection = [regex]::Replace($nodeSection, '(?m)^command\s*=\s*.*$', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $stableCommand }, 1)
$nodeSection = [regex]::Replace($nodeSection, '(?m)^args\s*=\s*.*$', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $stableArgs }, 1)
$updated = $updated.Substring(0, $nodeMatch.Index) + $nodeSection + $updated.Substring($nodeMatch.Index + $nodeMatch.Length)

$envSectionPattern = '(?ms)^\[mcp_servers\.node_repl\.env\][^\r\n]*(?:\r?\n|$).*?(?=^\[|\z)'
$envMatch = [regex]::Match($updated, $envSectionPattern)
if (-not $envMatch.Success) { throw '未找到 [mcp_servers.node_repl.env] 配置块。' }
$envSection = $envMatch.Value
$envSection = [regex]::Replace($envSection, '(?m)^(?:CODEX_CLI_PATH|NODE_REPL_(?:NODE_PATH|NODE_MODULE_DIRS|TRUSTED_CODE_PATHS))\s*=\s*.*(?:\r?\n|$)', '')
$updated = $updated.Substring(0, $envMatch.Index) + $envSection + $updated.Substring($envMatch.Index + $envMatch.Length)
$previewPath = Join-Path ([System.IO.Path]::GetTempPath()) "codex-node-repl-config-preview-$PID-$([Guid]::NewGuid().ToString('N')).toml"
try {
  [System.IO.File]::WriteAllText($previewPath, $updated, [System.Text.UTF8Encoding]::new($false))
  Assert-TomlConfigReadable -Path $previewPath
} finally {
  if (Test-Path -LiteralPath $previewPath -PathType Leaf) { Remove-Item -LiteralPath $previewPath -Force }
}

Write-Output "配置：$resolvedConfig"
Write-Output "启动器：$launcher"
Write-Output "目标 NodeRepl command：$pwsh"
if (-not $Apply) {
  Write-Output 'DRY-RUN：未修改配置、未创建备份、未停止或重启任何进程。'
  return
}
if ($Confirmation -ne 'APPLY_CODEX_NODE_REPL_STABILITY') {
  throw '需要确认词：APPLY_CODEX_NODE_REPL_STABILITY'
}
$currentHashBeforeApply = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedConfig).Hash
$backupExists = Test-Path -LiteralPath $resolvedBackup -PathType Leaf
$appliedHashExists = Test-Path -LiteralPath $appliedHashPath -PathType Leaf
if ($backupExists) {
  if (-not (Test-Path -LiteralPath $backupHashPath -PathType Leaf) -or -not $appliedHashExists) {
    throw '已有配置备份但缺少 before.sha256 或 applied.sha256，未更新配置。'
  }
  $expectedAppliedHash = (Get-Content -LiteralPath $appliedHashPath -Raw).Trim().ToUpperInvariant()
  if ($currentHashBeforeApply -ne $expectedAppliedHash) {
    throw "当前配置哈希不匹配，未更新：期望 $expectedAppliedHash，实际 $currentHashBeforeApply"
  }
  $expectedBackupHash = (Get-Content -LiteralPath $backupHashPath -Raw).Trim().ToUpperInvariant()
  $actualBackupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedBackup).Hash
  if ($actualBackupHash -ne $expectedBackupHash) {
    throw "原始备份哈希不匹配，未更新：期望 $expectedBackupHash，实际 $actualBackupHash"
  }
  Assert-TomlConfigReadable -Path $resolvedBackup
} elseif ($appliedHashExists) {
  throw '缺少原始配置备份，未更新配置。'
}

if (-not $backupExists) {
  $backupDirectory = Split-Path -Parent $resolvedBackup
  New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
  Copy-Item -LiteralPath $resolvedConfig -Destination $resolvedBackup
  $beforeHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedBackup).Hash
  [System.IO.File]::WriteAllText($backupHashPath, "$beforeHash`n", [System.Text.UTF8Encoding]::new($false))
  Assert-TomlConfigReadable -Path $resolvedBackup
}

$temporaryPath = "$resolvedConfig.$PID.tmp"
try {
  [System.IO.File]::WriteAllText($temporaryPath, $updated, [System.Text.UTF8Encoding]::new($false))
  Assert-TomlConfigReadable -Path $temporaryPath
  Move-Item -LiteralPath $temporaryPath -Destination $resolvedConfig -Force
} finally {
  if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
}
Assert-TomlConfigReadable -Path $resolvedConfig
$afterHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedConfig).Hash
$appliedTemporaryPath = "$appliedHashPath.$PID.tmp"
try {
  [System.IO.File]::WriteAllText($appliedTemporaryPath, "$afterHash`n", [System.Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $appliedTemporaryPath -Destination $appliedHashPath -Force
} finally {
  if (Test-Path -LiteralPath $appliedTemporaryPath -PathType Leaf) { Remove-Item -LiteralPath $appliedTemporaryPath -Force }
}
Write-Output "APPLY 完成：配置哈希 $afterHash"
Write-Output "备份：$resolvedBackup（保持不变）"
Write-Output "备份哈希：$backupHashPath"
Write-Output "回滚：$(Join-Path $PSScriptRoot 'rollback-codex-node-repl-stability.ps1')"
