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
  if ($first.files.relativePath -join ',' -ne '.coldbrew-deploy-manifest.json,AGENTS.md,auth.json,config.toml,hooks.json') { throw "文件排序不稳定：$($first.files.relativePath -join ',')" }
  if (-not $first.components.credentialsSha256) { throw 'auth.json 未纳入凭据指纹。' }
  if (-not $first.components.instructionsSha256) { throw 'AGENTS.md 未纳入指令指纹。' }
  if (-not $first.components.hooksSha256) { throw 'hooks.json 未纳入挂钩指纹。' }
  if (-not $first.components.deploymentManifestSha256) { throw '部署清单未纳入指纹。' }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value @(
    'model = "beta"',
    "[projects.'C:\private\work']",
    'trust_level = "trusted"',
    '[model_providers.remote]',
    'api_key = "fixture-private-key"'
  ) -Encoding utf8
  $keyChange = Get-CodexConfigFingerprintRecord $fixture
  $changedKeys = Get-CodexConfigChangedKeys $first $keyChange
  if (-not $changedKeys.available -or $changedKeys.keys -join ',' -ne 'model,model_providers.*.api_key,projects.*.trust_level') { throw "键级差异错误：$($changedKeys.keys -join ',')" }
  $serialized = $keyChange | ConvertTo-Json -Depth 8
  if ($serialized.Contains('fixture-private-key') -or $serialized.Contains('C:\private\work') -or $serialized.Contains('fixture-secret')) { throw '键级摘要泄漏配置值或路径。' }
  if ((Format-CodexConfigChangeSummary $first $keyChange) -notmatch 'config.toml（变化键：model') { throw '状态摘要未显示真实配置键。' }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value @('model = "alpha"', '# comment only') -Encoding utf8
  $commentOnly = Get-CodexConfigFingerprintRecord $fixture
  if ($commentOnly.fingerprint -ne $first.fingerprint -or (Get-CodexConfigChangedKeys $first $commentOnly).keys.Count -ne 0) { throw '注释或格式改写不应触发重载。' }
  if (($commentOnly.files | Where-Object relativePath -eq 'config.toml').sha256 -eq ($first.files | Where-Object relativePath -eq 'config.toml').sha256) { throw '稳定性检查仍需保留原始文件字节哈希。' }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value @('model="alpha"', '[desktop]', 'appearanceTheme="dark"', 'codeFontSize=14') -Encoding utf8
  $appearance = Get-CodexConfigFingerprintRecord $fixture
  if ($appearance.fingerprint -ne $first.fingerprint -or (Get-CodexConfigChangeKinds $first $appearance).configTomlChanged) { throw '桌面外观变化不应触发共享后端重载。' }
  Add-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value 'unknown_future_setting=true' -Encoding utf8
  if ((Get-CodexConfigFingerprintRecord $fixture).fingerprint -eq $appearance.fingerprint) { throw '未知设置应保守保留变更检测。' }
  $runtimeConfig = @('model="alpha"', '[mcp_servers.capture.env]', 'SKY_CUA_NATIVE_PIPE_DIRECTORY="pipe-a"', 'OTHER_SETTING="value-a"', '[hooks.state.fixture]', 'trusted_hash="hash-a"')
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value $runtimeConfig -Encoding utf8
  $runtimeBefore = Get-CodexConfigFingerprintRecord $fixture
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value ($runtimeConfig -replace 'pipe-a', 'pipe-b') -Encoding utf8
  $pipeAfter = Get-CodexConfigFingerprintRecord $fixture
  if ($pipeAfter.fingerprint -ne $runtimeBefore.fingerprint -or (Get-CodexConfigChangeKinds $runtimeBefore $pipeAfter).configTomlChanged) { throw '桌面每次启动改写的 CUA 管道目录不应触发 4500 重载。' }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value ($runtimeConfig -replace 'value-a', 'value-b') -Encoding utf8
  if ((Get-CodexConfigFingerprintRecord $fixture).fingerprint -eq $runtimeBefore.fingerprint) { throw '其他 MCP 环境变量变化必须保留检测。' }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value ($runtimeConfig -replace 'hash-a', 'hash-b') -Encoding utf8
  if ((Get-CodexConfigFingerprintRecord $fixture).fingerprint -eq $runtimeBefore.fingerprint) { throw 'Hook 信任变化必须保留检测。' }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value @('[model_providers.one]', 'base_url="https://example.invalid"') -Encoding utf8
  $providerNameBefore = Get-CodexConfigFingerprintRecord $fixture
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value @('[model_providers.two]', 'base_url="https://example.invalid"') -Encoding utf8
  if ((Get-CodexConfigFingerprintRecord $fixture).fingerprint -eq $providerNameBefore.fingerprint) { throw '脱敏键名相同的 provider 重命名仍应触发重载。' }
  $legacy = $first | ConvertTo-Json -Depth 8 | ConvertFrom-Json
  $legacy.PSObject.Properties.Remove('configKeyDigests')
  if ((Get-CodexConfigChangedKeys $legacy $keyChange).available) { throw '旧指纹记录没有键级基线时不应猜测变化键。' }
  if ((Format-CodexConfigChangeSummary $legacy $keyChange) -notmatch '旧记录缺少键级基线') { throw '旧记录状态应说明缺少基线。' }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value "[mcp_servers.codex_app]`ntools = []" -Encoding utf8
  try { Get-CodexConfigFingerprintRecord $fixture | Out-Null; throw '缺少 command 的 codex_app 配置被错误接受。' } catch { if ($_.Exception.Message -notmatch 'codex_app.*command') { throw } }
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value "[mcp_servers.codex_app]`ncommand = 'codex-app-tools'" -Encoding utf8
  Get-CodexConfigFingerprintRecord $fixture | Out-Null
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value 'model = "alpha"' -Encoding utf8
  $second = Get-CodexConfigFingerprintRecord $fixture
  if ($first.fingerprint -ne $second.fingerprint) { throw '相同输入产生了不同指纹。' }
  Add-Content -LiteralPath (Join-Path $fixture 'model-catalogs\b.json') -Value ' ' -Encoding utf8
  if ((Get-CodexConfigFingerprintRecord $fixture).fingerprint -ne $first.fingerprint) { throw '未被配置引用的模型目录变化不应触发重载。' }
  Set-Content -LiteralPath (Join-Path $fixture 'profile-instructions.md') -Value 'profile instructions v1' -Encoding utf8
  Set-Content -LiteralPath (Join-Path $fixture 'config.toml') -Value @('model = "alpha"', 'model_catalog_json = "model-catalogs/a.json"', '[profiles.fixture]', 'model_instructions_file = "profile-instructions.md"') -Encoding utf8
  $referenced = Get-CodexConfigFingerprintRecord $fixture
  if ($referenced.files.relativePath -join ',' -ne '.coldbrew-deploy-manifest.json,AGENTS.md,auth.json,config.toml,hooks.json,model-catalogs/a.json,profile-instructions.md') { throw "引用文件集合错误：$($referenced.files.relativePath -join ',')" }
  Set-Content -LiteralPath (Join-Path $fixture 'profile-instructions.md') -Value 'profile instructions v2' -Encoding utf8
  $profileInstructions = Get-CodexConfigFingerprintRecord $fixture
  if ($referenced.fingerprint -eq $profileInstructions.fingerprint -or -not (Get-CodexConfigChangeKinds $referenced $profileInstructions).instructionsChanged) { throw 'profile 级 model_instructions_file 变化未被检测。' }
  Add-Content -LiteralPath (Join-Path $fixture 'model-catalogs\a.json') -Value ' ' -Encoding utf8
  $third = Get-CodexConfigFingerprintRecord $fixture
  if ($profileInstructions.fingerprint -eq $third.fingerprint -or -not (Get-CodexConfigChangeKinds $profileInstructions $third).modelCatalogChanged) { throw '被引用的模型目录变化未被检测。' }
  if ($first.fingerprint -eq $third.fingerprint) { throw '配置变化未改变指纹。' }
  $authBefore = $third
  Set-Content -LiteralPath (Join-Path $fixture 'auth.json') -Value '{"tokens":{"default":"changed-secret"}}' -Encoding utf8
  $authAfter = Get-CodexConfigFingerprintRecord $fixture
  $authChange = Get-CodexConfigChangeKinds $authBefore $authAfter
  if (-not $authChange.credentialsChanged -or $authChange.configTomlChanged) { throw 'auth.json 变化未被单独识别。' }
  Set-Content -LiteralPath (Join-Path $fixture 'hooks.json') -Value '{"hooks":["changed"]}' -Encoding utf8
  $hooksAfter = Get-CodexConfigFingerprintRecord $fixture
  $hooksChange = Get-CodexConfigChangeKinds $authAfter $hooksAfter
  if (-not $hooksChange.hooksChanged -or $hooksChange.configTomlChanged) { throw 'hooks.json 变化未被单独识别。' }
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
  if ($marker.schemaVersion -ne 2) { throw '新指纹记录应标识语义哈希版本，旧记录不得伪装成已加载。' }
  if ($marker.fingerprint -ne $third.fingerprint -or $marker.reason -ne 'verification') { throw '重载标记读写失败。' }
  if ($null -eq $marker.configKeyDigests) { throw '待重载标记没有保存键级摘要。' }
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
