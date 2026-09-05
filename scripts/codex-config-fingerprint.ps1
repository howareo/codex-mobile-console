# Shared, deterministic fingerprinting for the configuration read by app-server.

function Resolve-CodexHome([string]$CodexHome = '') {
  if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = [Environment]::GetEnvironmentVariable('CODEX_HOME')
  }
  if ([string]::IsNullOrWhiteSpace($CodexHome)) {
    $CodexHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
  }
  return [System.IO.Path]::GetFullPath([Environment]::ExpandEnvironmentVariables($CodexHome))
}

function Get-CodexConfigFiles([string]$CodexHome = '') {
  $root = Resolve-CodexHome $CodexHome
  $paths = [System.Collections.Generic.List[string]]::new()
  $configPath = Join-Path $root 'config.toml'
  if (Test-Path -LiteralPath $configPath -PathType Leaf) { $paths.Add($configPath) }
  $authPath = Join-Path $root 'auth.json'
  if (Test-Path -LiteralPath $authPath -PathType Leaf) { $paths.Add($authPath) }
  $catalogDir = Join-Path $root 'model-catalogs'
  if (Test-Path -LiteralPath $catalogDir -PathType Container) {
    Get-ChildItem -LiteralPath $catalogDir -Filter '*.json' -File -ErrorAction Stop |
      ForEach-Object { $paths.Add($_.FullName) }
  }
  # ColdBrew/eni-solo changes these files outside config.toml.  They are read by
  # the same app-server process, so a profile switch must invalidate its
  # in-memory snapshot too.  Keep this list small to avoid hashing the whole
  # skills tree every watchdog tick.
  foreach ($managedName in @('AGENTS.md', 'hooks.json', '.coldbrew-deploy-manifest.json')) {
    $managedPath = Join-Path $root $managedName
    if (Test-Path -LiteralPath $managedPath -PathType Leaf) { $paths.Add($managedPath) }
  }
  # model_instructions_file is a supported root setting.  Resolve the common
  # CODEX_HOME-relative form used by ColdBrew without requiring a second
  # app-server or touching the session database.
  if (Test-Path -LiteralPath $configPath -PathType Leaf) {
    $instructionMatch = Select-String -LiteralPath $configPath -Pattern '^\s*model_instructions_file\s*=\s*["'']([^"'']+)["'']\s*$' -List -ErrorAction SilentlyContinue
    if ($instructionMatch) {
      $instructionName = $instructionMatch.Matches[0].Groups[1].Value
      $instructionPath = if ([System.IO.Path]::IsPathRooted($instructionName)) {
        [System.IO.Path]::GetFullPath($instructionName)
      } else {
        [System.IO.Path]::GetFullPath((Join-Path $root $instructionName))
      }
      if (Test-Path -LiteralPath $instructionPath -PathType Leaf) { $paths.Add($instructionPath) }
    }
  }
  $ordered = [string[]]@($paths)
  [Array]::Sort($ordered, [System.StringComparer]::Ordinal)
  return @($ordered)
}

function Assert-CodexConfigReadable([string]$Path) {
  $name = [System.IO.Path]::GetFileName($Path)
  if ($name -ieq 'auth.json' -or $name -ieq 'hooks.json' -or $name -ieq '.coldbrew-deploy-manifest.json') {
    try { $null = Get-Content -LiteralPath $Path -Raw -Encoding utf8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "JSON 配置解析失败：$Path" }
    return
  }
  if ($name -ieq 'config.toml') {
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if (-not $python) { $python = Get-Command py.exe -ErrorAction SilentlyContinue }
    if (-not $python) { throw '需要 Python 3.11+ 的 tomllib 解析器来校验 config.toml。' }
    & $python.Source -c 'import sys,tomllib; tomllib.load(open(sys.argv[1], "rb"))' $Path *> $null
    if ($LASTEXITCODE -ne 0) { throw "TOML 配置解析失败：$Path" }
    & $python.Source -c 'import sys,tomllib; d=tomllib.load(open(sys.argv[1], "rb")); s=d.get("mcp_servers", {}).get("codex_app"); raise SystemExit(0 if not s or (isinstance(s, dict) and s.get("command")) else 3)' $Path *> $null
    if ($LASTEXITCODE -ne 0) { throw "Codex 配置中的 mcp_servers.codex_app 缺少 command，app-server 会报 invalid transport：$Path" }
  }
}

function Get-CodexConfigFingerprintRecord([string]$CodexHome = '', [int]$StabilityAttempts = 3, [int]$StabilityDelayMilliseconds = 150) {
  if ($StabilityAttempts -lt 2 -or $StabilityAttempts -gt 5) { throw '配置稳定性检查次数必须在 2 到 5 次之间。' }
  if ($StabilityDelayMilliseconds -lt 50 -or $StabilityDelayMilliseconds -gt 2000) { throw '配置稳定性检查间隔必须在 50 到 2000 毫秒之间。' }
  $root = Resolve-CodexHome $CodexHome
  for ($attempt = 1; $attempt -le $StabilityAttempts; $attempt++) {
    $files = @(Get-CodexConfigFiles $root)
    $entries = @(
      foreach ($path in $files) {
        $relative = [System.IO.Path]::GetRelativePath($root, $path).Replace('\', '/')
        Assert-CodexConfigReadable $path
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        [ordered]@{ relativePath = $relative; sha256 = $hash }
      }
    )
    Start-Sleep -Milliseconds $StabilityDelayMilliseconds
    $currentFiles = @(Get-CodexConfigFiles $root)
    $currentEntries = @(
      foreach ($path in $currentFiles) {
        $relative = [System.IO.Path]::GetRelativePath($root, $path).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        [ordered]@{ relativePath = $relative; sha256 = $hash }
      }
    )
    $firstPayload = [string]::Join("`n", @($entries | ForEach-Object { "{0}`t{1}" -f $_.relativePath, $_.sha256 }))
    $secondPayload = [string]::Join("`n", @($currentEntries | ForEach-Object { "{0}`t{1}" -f $_.relativePath, $_.sha256 }))
    if ($firstPayload -ne $secondPayload) {
      if ($attempt -lt $StabilityAttempts) { continue }
      throw 'Codex 配置正在写入，稳定性检查未通过。'
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $fingerprint = ([BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($firstPayload)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $providerEntry = @($entries | Where-Object { [string]$_['relativePath'] -ieq 'config.toml' } | Select-Object -First 1)
    $credentialsEntry = @($entries | Where-Object { [string]$_['relativePath'] -ieq 'auth.json' } | Select-Object -First 1)
    $catalogEntries = @($entries | Where-Object { [string]$_['relativePath'] -like 'model-catalogs/*' })
    $components = [ordered]@{
      providerConfigSha256 = if ($providerEntry.Count -gt 0) { [string]$providerEntry[0]['sha256'] } else { $null }
      credentialsSha256 = if ($credentialsEntry.Count -gt 0) { [string]$credentialsEntry[0]['sha256'] } else { $null }
      modelCatalogSha256 = ([string]::Join("`n", @($catalogEntries | ForEach-Object { "{0}`t{1}" -f $_['relativePath'], $_['sha256'] })))
      instructionsSha256 = ([string]::Join("`n", @($entries | Where-Object { [string]$_['relativePath'] -like '*.md' } | ForEach-Object { "{0}`t{1}" -f $_['relativePath'], $_['sha256'] })))
      hooksSha256 = ([string]::Join("`n", @($entries | Where-Object { [string]$_['relativePath'] -ieq 'hooks.json' } | ForEach-Object { "{0}`t{1}" -f $_['relativePath'], $_['sha256'] })))
      deploymentManifestSha256 = ([string]::Join("`n", @($entries | Where-Object { [string]$_['relativePath'] -ieq '.coldbrew-deploy-manifest.json' } | ForEach-Object { "{0}`t{1}" -f $_['relativePath'], $_['sha256'] })))
    }
    return [pscustomobject]@{
      codexHome = $root
      fingerprint = $fingerprint
      files = @($entries)
      components = [pscustomobject]$components
      capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
  }
  throw 'Codex 配置稳定性检查失败。'
}

function Get-CodexConfigChangeKinds($Previous, $Current) {
  $old = if ($Previous.components) { $Previous.components } else { $Previous }
  $new = if ($Current.components) { $Current.components } else { $Current }
  return [pscustomobject][ordered]@{
    providerChanged = ([string]$old.providerConfigSha256 -ne [string]$new.providerConfigSha256)
    credentialsChanged = ([string]$old.credentialsSha256 -ne [string]$new.credentialsSha256)
    modelCatalogChanged = ([string]$old.modelCatalogSha256 -ne [string]$new.modelCatalogSha256)
    instructionsChanged = ([string]$old.instructionsSha256 -ne [string]$new.instructionsSha256)
    hooksChanged = ([string]$old.hooksSha256 -ne [string]$new.hooksSha256)
    deploymentManifestChanged = ([string]$old.deploymentManifestSha256 -ne [string]$new.deploymentManifestSha256)
  }
}

function Read-CodexConfigFingerprintRecord([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop }
  catch { return $null }
}

function Write-CodexConfigFingerprintRecord([string]$Path, $Record) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $tmp = "$Path.$PID.tmp"
  $Record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding utf8
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

function Write-CodexConfigReloadMarker([string]$Path, $Record, [string]$Reason = 'watchdog') {
  $marker = [ordered]@{
    reason = $Reason
    requestedAt = (Get-Date).ToUniversalTime().ToString('o')
    fingerprint = $Record.fingerprint
    codexHome = $Record.codexHome
    files = @($Record.files)
    components = $Record.components
  }
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $tmp = "$Path.$PID.tmp"
  $marker | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $tmp -Encoding utf8
  Move-Item -LiteralPath $tmp -Destination $Path -Force
  return [pscustomobject]$marker
}
