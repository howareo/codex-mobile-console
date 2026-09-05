$script:CodexBundleFileNames = @(
  'codex.exe',
  'codex-code-mode-host.exe',
  'codex-command-runner.exe',
  'codex-windows-sandbox-setup.exe'
)

function Get-CodexBinRoot {
  $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  }
  return Join-Path $localAppData 'OpenAI\Codex\bin'
}

function Get-CodexBundleFileNames {
  return @($script:CodexBundleFileNames)
}

function Get-CodexBundleSourceFiles {
  [CmdletBinding()]
  param([string]$BinaryPath)

  if ([string]::IsNullOrWhiteSpace($BinaryPath) -or -not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
    return @()
  }
  $resolvedBinary = [System.IO.Path]::GetFullPath($BinaryPath)
  if ([System.IO.Path]::GetFileName($resolvedBinary) -ine 'codex.exe') {
    return @()
  }

  $binaryDirectory = Split-Path -Parent $resolvedBinary
  $platformDirectory = Split-Path -Parent $binaryDirectory
  $resourceDirectory = Join-Path $platformDirectory 'codex-resources'
  $files = @(
    foreach ($fileName in (Get-CodexBundleFileNames)) {
      $candidates = if ($fileName -ieq 'codex.exe') {
        @($resolvedBinary)
      } else {
        @(
          Join-Path $binaryDirectory $fileName
          Join-Path $resourceDirectory $fileName
        )
      }
      $sourcePath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
      if ($sourcePath) {
        [pscustomobject]@{
          Name = $fileName
          Path = [System.IO.Path]::GetFullPath($sourcePath)
        }
      }
    }
  )
  return $files
}

function Test-CodexBundle {
  [CmdletBinding()]
  param([string]$BinaryPath)

  if ([string]::IsNullOrWhiteSpace($BinaryPath) -or -not (Test-Path -LiteralPath $BinaryPath -PathType Leaf)) {
    return $false
  }
  $files = @(Get-CodexBundleSourceFiles -BinaryPath $BinaryPath)
  return $files.Count -eq (Get-CodexBundleFileNames).Count
}

function Assert-CodexBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$BinaryPath
  )

  if (Test-CodexBundle -BinaryPath $BinaryPath) {
    return
  }

  $resolvedBinary = if ([string]::IsNullOrWhiteSpace($BinaryPath)) { $BinaryPath } else { [System.IO.Path]::GetFullPath($BinaryPath) }
  $available = @((Get-CodexBundleSourceFiles -BinaryPath $BinaryPath) | Select-Object -ExpandProperty Name)
  $missing = @((Get-CodexBundleFileNames) | Where-Object { $_ -notin $available })
  throw "Codex 程序包不完整：$resolvedBinary；缺少：$($missing -join ', ')"
}

function Get-CodexBinaryCandidates {
  [CmdletBinding()]
  param([string]$BinRoot = (Get-CodexBinRoot))

  if (-not (Test-Path -LiteralPath $BinRoot -PathType Container)) {
    return @()
  }

  $rows = @(
    foreach ($directory in (Get-ChildItem -LiteralPath $BinRoot -Directory -ErrorAction SilentlyContinue)) {
      $exePath = Join-Path $directory.FullName 'codex.exe'
      if (Test-CodexBundle -BinaryPath $exePath) {
        $exe = Get-Item -LiteralPath $exePath
        [pscustomobject]@{
          Path                   = [System.IO.Path]::GetFullPath($exe.FullName)
          ExeLastWriteTime       = $exe.LastWriteTimeUtc
          DirectoryLastWriteTime = $directory.LastWriteTimeUtc
        }
      }
    }
  )
  return $rows
}

function Get-CodexDesktopBinaryCandidates {
  [CmdletBinding()]
  param([string[]]$InstallRoots)

  $roots = if ($PSBoundParameters.ContainsKey('InstallRoots')) {
    @($InstallRoots)
  } else {
    @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | ForEach-Object { $_.InstallLocation })
  }
  $rows = @(
    foreach ($root in $roots) {
      if ([string]::IsNullOrWhiteSpace([string]$root)) { continue }
      $resources = Join-Path ([System.IO.Path]::GetFullPath([string]$root)) 'app\resources'
      $binary = Join-Path $resources 'codex.exe'
      if (-not (Test-CodexBundle -BinaryPath $binary)) { continue }
      $version = [Version]'0.0'
      $versionMatch = [regex]::Match((Split-Path -Leaf ([System.IO.Path]::GetFullPath([string]$root))), 'OpenAI\.Codex_(?<version>\d+(?:\.\d+){1,3})_')
      if ($versionMatch.Success) { $version = [Version]$versionMatch.Groups['version'].Value }
      [pscustomobject]@{
        Path = [System.IO.Path]::GetFullPath($binary)
        InstallRoot = [System.IO.Path]::GetFullPath([string]$root)
        Version = $version
        LastWriteTime = (Get-Item -LiteralPath $binary).LastWriteTimeUtc
      }
    }
  )
  return @($rows)
}

function Resolve-CodexDesktopBinary {
  [CmdletBinding()]
  param([string[]]$InstallRoots)

  $candidates = if ($PSBoundParameters.ContainsKey('InstallRoots')) {
    @(Get-CodexDesktopBinaryCandidates -InstallRoots $InstallRoots)
  } else {
    @(Get-CodexDesktopBinaryCandidates)
  }
  return $candidates |
    Sort-Object -Property @{ Expression = 'Version'; Descending = $true }, @{ Expression = 'LastWriteTime'; Descending = $true }, @{ Expression = 'Path'; Descending = $false } |
    Select-Object -First 1
}

function Resolve-CodexBinary {
  [CmdletBinding()]
  param(
    [string]$CandidatePath,
    [string]$FallbackPath,
    [string]$BinRoot = (Get-CodexBinRoot)
  )

  if (-not [string]::IsNullOrWhiteSpace($CandidatePath)) {
    Assert-CodexBundle -BinaryPath $CandidatePath
    return [System.IO.Path]::GetFullPath($CandidatePath)
  }

  $selected = Get-CodexBinaryCandidates -BinRoot $BinRoot |
    Sort-Object -Property @{ Expression = 'ExeLastWriteTime'; Descending = $true }, @{ Expression = 'DirectoryLastWriteTime'; Descending = $true }, @{ Expression = 'Path'; Descending = $false } |
    Select-Object -First 1
  if ($selected) {
    return [System.IO.Path]::GetFullPath($selected.Path)
  }

  if (-not [string]::IsNullOrWhiteSpace($FallbackPath) -and (Test-CodexBundle -BinaryPath $FallbackPath)) {
    return [System.IO.Path]::GetFullPath($FallbackPath)
  }

  $fallbackHint = if ([string]::IsNullOrWhiteSpace($FallbackPath)) { '' } else { "；回退目录也不完整：$FallbackPath" }
  throw "未找到完整的 Codex 程序目录。已检查：$BinRoot\*\codex.exe 及其配套工具$fallbackHint。"
}

function Get-CodexBundleSnapshotPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceBinary,
    [Parameter(Mandatory = $true)]
    [string]$RuntimeDir
  )

  Assert-CodexBundle -BinaryPath $SourceBinary
  $sourceDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($SourceBinary))
  $bundleId = Split-Path -Leaf $sourceDirectory
  $npmResourceDirectory = Join-Path (Split-Path -Parent $sourceDirectory) 'codex-resources'
  if ($bundleId -ieq 'bin' -and (Test-Path -LiteralPath $npmResourceDirectory -PathType Container)) {
    $bundleId = (Get-FileHash -LiteralPath $SourceBinary -Algorithm SHA256).Hash.Substring(0, 16).ToLowerInvariant()
  }
  $snapshotDirectory = Join-Path ([System.IO.Path]::GetFullPath($RuntimeDir)) "codex-bundles\$bundleId"
  return Join-Path $snapshotDirectory 'codex.exe'
}

function Copy-CodexBundleSnapshot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$SourceBinary,
    [Parameter(Mandatory = $true)]
    [string]$RuntimeDir
  )

  Assert-CodexBundle -BinaryPath $SourceBinary
  $sourceDirectory = Split-Path -Parent ([System.IO.Path]::GetFullPath($SourceBinary))
  $sourceFiles = @(Get-CodexBundleSourceFiles -BinaryPath $SourceBinary)
  $snapshotBinary = Get-CodexBundleSnapshotPath -SourceBinary $SourceBinary -RuntimeDir $RuntimeDir
  $snapshotDirectory = Split-Path -Parent $snapshotBinary
  New-Item -ItemType Directory -Path $snapshotDirectory -Force | Out-Null

  $copiedFiles = @()
  foreach ($sourceEntry in $sourceFiles) {
    $fileName = $sourceEntry.Name
    $sourcePath = $sourceEntry.Path
    $destinationPath = Join-Path $snapshotDirectory $fileName
    $sourceItem = Get-Item -LiteralPath $sourcePath
    $destinationFile = Get-Item -LiteralPath $destinationPath -ErrorAction SilentlyContinue
    if ($destinationFile -and $destinationFile.Length -eq $sourceItem.Length -and $destinationFile.LastWriteTimeUtc -eq $sourceItem.LastWriteTimeUtc) {
      continue
    }

    $temporaryPath = "$destinationPath.copying.$PID"
    try {
      Copy-Item -LiteralPath $sourcePath -Destination $temporaryPath -Force
      $temporaryFile = Get-Item -LiteralPath $temporaryPath
      if ($temporaryFile.Length -ne $sourceItem.Length) {
        throw "Codex 快照文件大小校验失败：$fileName"
      }
      Move-Item -LiteralPath $temporaryPath -Destination $destinationPath -Force
      (Get-Item -LiteralPath $destinationPath).LastWriteTimeUtc = $sourceItem.LastWriteTimeUtc
      $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
      $destinationHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash
      if ($sourceHash -ne $destinationHash) {
        throw "Codex 快照哈希校验失败：$fileName"
      }
      $copiedFiles += [ordered]@{ name = $fileName; length = $sourceItem.Length; sha256 = $sourceHash }
    } finally {
      if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryPath -Force
      }
    }
  }

  Assert-CodexBundle -BinaryPath $snapshotBinary
  if ($copiedFiles.Count -gt 0) {
    $manifest = [ordered]@{
      sourceDirectory = $sourceDirectory
      snapshotDirectory = $snapshotDirectory
      copiedAt = (Get-Date).ToUniversalTime().ToString('o')
      files = $copiedFiles
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $snapshotDirectory 'bundle.json') -Encoding utf8
  }
  return $snapshotBinary
}

function Set-PreferredCodexBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeDir,
    [Parameter(Mandatory = $true)]
    [string]$SourceBinary,
    [Parameter(Mandatory = $true)]
    [string]$SnapshotBinary
  )

  Assert-CodexBundle -BinaryPath $SnapshotBinary
  $resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeDir)
  $preferencePath = Join-Path $resolvedRuntime 'preferred-app-server-bundle.json'
  $temporaryPath = "$preferencePath.tmp.$PID"
  $record = [ordered]@{
    sourceBinary = [System.IO.Path]::GetFullPath($SourceBinary)
    snapshotBinary = [System.IO.Path]::GetFullPath($SnapshotBinary)
    codexSha256 = (Get-FileHash -LiteralPath $SnapshotBinary -Algorithm SHA256).Hash
    selectedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  try {
    $record | ConvertTo-Json | Set-Content -LiteralPath $temporaryPath -Encoding utf8
    Move-Item -LiteralPath $temporaryPath -Destination $preferencePath -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }
  return $preferencePath
}

function Resolve-PreferredCodexBinary {
  [CmdletBinding()]
  param([string]$RuntimeDir)

  $preferencePath = Join-Path ([System.IO.Path]::GetFullPath($RuntimeDir)) 'preferred-app-server-bundle.json'
  if (-not (Test-Path -LiteralPath $preferencePath -PathType Leaf)) {
    return $null
  }
  try {
    $preference = Get-Content -LiteralPath $preferencePath -Raw -Encoding utf8 | ConvertFrom-Json
    $snapshotBinary = [System.IO.Path]::GetFullPath([string]$preference.snapshotBinary)
    Assert-CodexBundle -BinaryPath $snapshotBinary
    $actualHash = (Get-FileHash -LiteralPath $snapshotBinary -Algorithm SHA256).Hash
    if ($preference.codexSha256 -and $actualHash -ne [string]$preference.codexSha256) {
      throw 'codex.exe 哈希与首选记录不一致'
    }
    return $snapshotBinary
  } catch {
    throw "首选 Codex bundle 无效：$preferencePath；$($_.Exception.Message)"
  }
}
