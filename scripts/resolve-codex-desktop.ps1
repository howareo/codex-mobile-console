function Get-CodexDesktopExecutableCandidates {
  [CmdletBinding()]
  param([string[]]$InstallRoots)

  $rows = @()
  if ($PSBoundParameters.ContainsKey('InstallRoots')) {
    foreach ($installRoot in @($InstallRoots)) {
      if ([string]::IsNullOrWhiteSpace($installRoot)) { continue }
      $resolvedRoot = [System.IO.Path]::GetFullPath($installRoot)
      $executable = Join-Path $resolvedRoot 'app\ChatGPT.exe'
      if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { continue }
      $versionMatch = [regex]::Match((Split-Path -Leaf $resolvedRoot), 'OpenAI\.Codex_(?<version>\d+(?:\.\d+){1,3})_')
      $version = if ($versionMatch.Success) { [Version]$versionMatch.Groups['version'].Value } else { [Version]'0.0' }
      $rows += [pscustomobject]@{
        Path = [System.IO.Path]::GetFullPath($executable)
        Version = $version
        LastWriteTime = (Get-Item -LiteralPath $executable).LastWriteTimeUtc
      }
    }
  } else {
    foreach ($package in @(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue)) {
      if ([string]::IsNullOrWhiteSpace([string]$package.InstallLocation)) { continue }
      $executable = Join-Path ([string]$package.InstallLocation) 'app\ChatGPT.exe'
      if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { continue }
      $version = try { [Version]$package.Version } catch { [Version]'0.0' }
      $rows += [pscustomobject]@{
        Path = [System.IO.Path]::GetFullPath($executable)
        Version = $version
        LastWriteTime = (Get-Item -LiteralPath $executable).LastWriteTimeUtc
      }
    }
  }
  return @($rows)
}

function Resolve-CodexDesktopExecutable {
  [CmdletBinding()]
  param([string[]]$InstallRoots)

  $candidates = if ($PSBoundParameters.ContainsKey('InstallRoots')) {
    @(Get-CodexDesktopExecutableCandidates -InstallRoots $InstallRoots)
  } else {
    @(Get-CodexDesktopExecutableCandidates)
  }
  $selected = $candidates |
    Sort-Object -Property @{ Expression = 'Version'; Descending = $true }, @{ Expression = 'LastWriteTime'; Descending = $true }, @{ Expression = 'Path'; Descending = $false } |
    Select-Object -First 1
  if (-not $selected) {
    $scope = if ($PSBoundParameters.ContainsKey('InstallRoots')) { '指定的安装目录' } else { '当前用户已安装的 OpenAI.Codex 包' }
    throw "未在$scope 中找到可用的 app\\ChatGPT.exe；未执行任何进程或环境修改。"
  }
  return [System.IO.Path]::GetFullPath([string]$selected.Path)
}
