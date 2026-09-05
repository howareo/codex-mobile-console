[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'codex-config-fingerprint.ps1')
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$fixture = [System.IO.Path]::GetFullPath((Join-Path $tempRoot "codex-config-fingerprint-$PID"))
if (-not $fixture.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "测试目录不在临时目录内：$fixture" }
try {
  New-Item -ItemType Directory -Path (Join-Path $fixture 'model-catalogs') -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value 'model = "alpha"' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $fixture 'auth.json') -Value '{"tokens":{"default":"fixture-secret"}}' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $fixture 'model-catalogs\b.json') -Value '{"id":"b"}' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $fixture 'model-catalogs\a.json') -Value '{"id":"a"}' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $fixture 'AGENTS.md') -Value 'fixture instructions' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $fixture 'hooks.json') -Value '{"hooks":[]}' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $fixture '.coldbrew-deploy-manifest.json') -Value '{"managed":true}' -Encoding utf8
  $first = Get-CodexConfigFingerprintRecord $fixture
  if ($first.files.relativePath -join ',' -ne '.coldbrew-deploy-manifest.json,AGENTS.md,auth.json,config.toml,hooks.json,model-catalogs/a.json,model-catalogs/b.json') { throw "文件排序不稳定：$($first.files.relativePath -join ',')" }
  if (-not $first.components.credentialsSha256) { throw 'auth.json 未纳入凭据指纹。' }
  if (-not $first.components.instructionsSha256) { throw 'AGENTS.md 未纳入指令指纹。' }
  if (-not $first.components.hooksSha256) { throw 'hooks.json 未纳入挂钩指纹。' }
  if (-not $first.components.deploymentManifestSha256) { throw '部署清单未纳入指纹。' }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value "[mcp_servers.codex_app]`ntools = []" -Encoding utf8
  try { Get-CodexConfigFingerprintRecord $fixture | Out-Null; throw '缺少 command 的 codex_app 配置被错误接受。' } catch { if ($_.Exception.Message -notmatch 'codex_app.*command') { throw } }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value "[mcp_servers.codex_app]`ncommand = 'codex-app-tools'" -Encoding utf8
  Get-CodexConfigFingerprintRecord $fixture | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value 'model = "alpha"' -Encoding utf8
  $second = Get-CodexConfigFingerprintRecord $fixture
  if ($first.fingerprint -ne $second.fingerprint) { throw '相同输入产生了不同指纹。' }
  Add-Content -LiteralPath (Join-Path $fixture 'model-catalogs\a.json') -Value ' ' -Encoding utf8
  $third = Get-CodexConfigFingerprintRecord $fixture
  if ($first.fingerprint -eq $third.fingerprint) { throw '配置变化未改变指纹。' }
  $authBefore = $third
  Set-Content -LiteralPath (Join-Path $fixture 'auth.json') -Value '{"tokens":{"default":"changed-secret"}}' -Encoding utf8
  $authAfter = Get-CodexConfigFingerprintRecord $fixture
  $authChange = Get-CodexConfigChangeKinds $authBefore $authAfter
  if (-not $authChange.credentialsChanged -or $authChange.providerChanged) { throw 'auth.json 变化未被单独识别。' }
  Set-Content -LiteralPath (Join-Path $fixture 'hooks.json') -Value '{"hooks":["changed"]}' -Encoding utf8
  $hooksAfter = Get-CodexConfigFingerprintRecord $fixture
  $hooksChange = Get-CodexConfigChangeKinds $authAfter $hooksAfter
  if (-not $hooksChange.hooksChanged -or $hooksChange.providerChanged) { throw 'hooks.json 变化未被单独识别。' }
  $statePath = Join-Path $fixture 'app-server-config-fingerprint.json'
  Write-CodexConfigFingerprintRecord $statePath $authBefore
  $diskState = Read-CodexConfigFingerprintRecord $statePath
  if ($diskState.fingerprint -eq $authAfter.fingerprint) { throw '测试前置状态未保持旧指纹。' }
  Set-Content -LiteralPath (Join-Path $fixture 'auth.json') -Value '{' -Encoding utf8
  try { Get-CodexConfigFingerprintRecord $fixture | Out-Null; throw '中间态 auth.json 被错误接受。' } catch { if ($_.Exception.Message -notmatch '解析|稳定性') { throw } }
  Set-Content -LiteralPath (Join-Path $fixture 'auth.json') -Value '{"tokens":{"default":"changed-secret"}}' -Encoding utf8
  $markerPath = Join-Path $fixture 'pending-app-server-reload.json'
  Write-CodexConfigReloadMarker $markerPath $third 'verification' | Out-Null
  $marker = Read-CodexConfigFingerprintRecord $markerPath
  if ($marker.fingerprint -ne $third.fingerprint -or $marker.reason -ne 'verification') { throw '重载标记读写失败。' }
  foreach ($scriptName in @('watch-mobile-stack.ps1', 'ensure-mobile-stack.ps1', 'request-app-server-reload.ps1', 'show-autostart-status.ps1', 'manage-shared-app-server.ps1', 'test-app-server-protocol.ps1', 'codex-mobile.ps1')) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $scriptName), [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw "脚本解析失败：$scriptName，$($errors[0].Message)" }
  }
  Write-Output "配置指纹测试通过（含 auth.json、解析稳定性和凭据变化识别）：$($first.fingerprint) -> $($third.fingerprint)"
} finally {
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction SilentlyContinue
}
