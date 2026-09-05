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
if (-not (Test-Path -LiteralPath $resolvedBackup -PathType Leaf)) { throw "缺少配置备份：$resolvedBackup" }
if (-not (Test-Path -LiteralPath $backupHashPath -PathType Leaf)) { throw "缺少备份哈希：$backupHashPath" }
if (-not (Test-Path -LiteralPath $appliedHashPath -PathType Leaf)) { throw "缺少应用后哈希：$appliedHashPath" }
Assert-TomlConfigReadable -Path $resolvedBackup
$expectedBackupHash = (Get-Content -LiteralPath $backupHashPath -Raw).Trim().ToUpperInvariant()
$actualBackupHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedBackup).Hash
if ($actualBackupHash -ne $expectedBackupHash) { throw "备份哈希不匹配：期望 $expectedBackupHash，实际 $actualBackupHash" }
$expectedAppliedHash = (Get-Content -LiteralPath $appliedHashPath -Raw).Trim().ToUpperInvariant()
Assert-TomlConfigReadable -Path $resolvedConfig
$currentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedConfig).Hash
if ($currentHash -ne $expectedAppliedHash) { throw "当前配置哈希不匹配，未回滚：期望 $expectedAppliedHash，实际 $currentHash" }

Write-Output "回滚预检通过：$resolvedConfig -> $resolvedBackup"
Write-Output 'DRY-RUN：未修改配置、未停止或重启任何进程。'
if (-not $Apply) { return }
if ($Confirmation -ne 'ROLLBACK_CODEX_NODE_REPL_STABILITY') { throw '需要确认词：ROLLBACK_CODEX_NODE_REPL_STABILITY' }

$temporaryPath = "$resolvedConfig.$PID.rollback.tmp"
try {
  Copy-Item -LiteralPath $resolvedBackup -Destination $temporaryPath -Force
  Assert-TomlConfigReadable -Path $temporaryPath
  Move-Item -LiteralPath $temporaryPath -Destination $resolvedConfig -Force
} finally {
  if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) { Remove-Item -LiteralPath $temporaryPath -Force }
}
Assert-TomlConfigReadable -Path $resolvedConfig
$restoredHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedConfig).Hash
if ($restoredHash -ne $expectedBackupHash) { throw "回滚后哈希校验失败：$restoredHash" }
Write-Output "回滚完成：配置哈希 $restoredHash"
