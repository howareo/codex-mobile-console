Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'resolve-codex-binary.ps1')

function Get-StablePowerShellPath {
  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'
  if (Test-Path -LiteralPath $alias -PathType Leaf) {
    return [System.IO.Path]::GetFullPath($alias)
  }
  return (Get-Command pwsh.exe -ErrorAction Stop).Source
}

function Get-NodeReplRequiredRelativePaths {
  return @(
    'node_repl.exe',
    'node.exe',
    'node_modules',
    'node_modules\@oai\sky\bin\windows\codex-computer-use.exe'
  )
}

function Test-NodeReplRuntime {
  param([Parameter(Mandatory)][string]$BinPath)

  if (-not (Test-Path -LiteralPath $BinPath -PathType Container)) {
    return $false
  }
  foreach ($relativePath in (Get-NodeReplRequiredRelativePaths)) {
    $candidate = Join-Path $BinPath $relativePath
    if ($relativePath -eq 'node_modules') {
      if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { return $false }
    } elseif (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return $false
    }
  }
  return $true
}

function Get-NodeReplProjectRoot {
  $configuredRoot = $env:CODEX_NODE_REPL_PROJECT_ROOT
  if (-not [string]::IsNullOrWhiteSpace($configuredRoot)) {
    return [System.IO.Path]::GetFullPath($configuredRoot)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

function Resolve-NodeReplCodexCliPath {
  $configuredPath = $env:CODEX_CLI_PATH
  if (-not [string]::IsNullOrWhiteSpace($configuredPath) -and (Test-CodexBundle -BinaryPath $configuredPath)) {
    return [System.IO.Path]::GetFullPath($configuredPath)
  }

  $statePath = Join-Path (Get-NodeReplProjectRoot) '.runtime\shared-app-server.json'
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    try {
      $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
      $stablePath = [string]$state.binary
      if (-not [string]::IsNullOrWhiteSpace($stablePath) -and (Test-CodexBundle -BinaryPath $stablePath)) {
        return [System.IO.Path]::GetFullPath($stablePath)
      }
    } catch {
      # An unreadable or incomplete state record is handled by the local bundle fallback.
    }
  }

  $selected = Get-CodexBinaryCandidates -BinRoot (Get-CodexBinRoot) |
    Sort-Object -Property @{ Expression = 'ExeLastWriteTime'; Descending = $true }, @{ Expression = 'DirectoryLastWriteTime'; Descending = $true }, @{ Expression = 'Path'; Descending = $false } |
    Select-Object -First 1
  if ($selected) {
    return [System.IO.Path]::GetFullPath($selected.Path)
  }

  throw '未找到完整的 Codex CLI bundle（已检查 CODEX_CLI_PATH、项目稳定快照和 LOCALAPPDATA bundle）。'
}

function Get-NodeReplRuntimeCandidates {
  $candidates = [System.Collections.Generic.List[object]]::new()
  $preferredNodePath = $env:NODE_REPL_NODE_PATH
  if ($preferredNodePath) {
    $preferredBin = Split-Path -Parent ([System.IO.Path]::GetFullPath($preferredNodePath))
    if (Test-NodeReplRuntime -BinPath $preferredBin) {
      $candidates.Add([pscustomobject]@{ Path = $preferredBin; Priority = 0; SortTime = [DateTime]::MaxValue })
    }
  }

  $windowsAppsRoot = if ($env:CODEX_NODE_REPL_WINDOWS_APPS_ROOT) {
    $env:CODEX_NODE_REPL_WINDOWS_APPS_ROOT
  } else {
    'C:\Program Files\WindowsApps'
  }
  if (Test-Path -LiteralPath $windowsAppsRoot -PathType Container) {
    foreach ($package in @(Get-ChildItem -LiteralPath $windowsAppsRoot -Directory -Filter 'OpenAI.Codex_*' -ErrorAction SilentlyContinue)) {
      $bin = Join-Path $package.FullName 'app\resources\cua_node\bin'
      if (Test-NodeReplRuntime -BinPath $bin) {
        $candidates.Add([pscustomobject]@{ Path = [System.IO.Path]::GetFullPath($bin); Priority = 1; SortTime = $package.LastWriteTimeUtc })
      }
    }
  }

  $runtimeRoot = if ($env:CODEX_NODE_REPL_RUNTIME_ROOT) {
    $env:CODEX_NODE_REPL_RUNTIME_ROOT
  } else {
    Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\runtimes\cua_node'
  }
  if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
    foreach ($runtime in @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue)) {
      $bin = Join-Path $runtime.FullName 'bin'
      if (Test-NodeReplRuntime -BinPath $bin) {
        $candidates.Add([pscustomobject]@{ Path = [System.IO.Path]::GetFullPath($bin); Priority = 1; SortTime = $runtime.LastWriteTimeUtc })
      }
    }
  }

  return @($candidates | Sort-Object Priority, @{ Expression = 'SortTime'; Descending = $true } | Select-Object -ExpandProperty Path -Unique)
}

function Resolve-NodeReplRuntime {
  $candidates = @(Get-NodeReplRuntimeCandidates)
  if ($candidates.Count -eq 0) {
    throw '未找到完整的 NodeRepl runtime（需要 node_repl.exe、node.exe、node_modules 和 codex-computer-use.exe）。'
  }
  return $candidates[0]
}

function Set-NodeReplRuntimeEnvironment {
  param([Parameter(Mandatory)][string]$BinPath)

  $moduleDir = Join-Path $BinPath 'node_modules'
  $trustedPaths = @(
    (Join-Path $env:USERPROFILE '.codex'),
    $moduleDir
  ) -join ';'
  $env:NODE_REPL_NODE_PATH = Join-Path $BinPath 'node.exe'
  $env:NODE_REPL_NODE_MODULE_DIRS = $moduleDir
  $env:NODE_REPL_TRUSTED_CODE_PATHS = $trustedPaths
}

function Invoke-NodeReplLauncher {
  param([Parameter()][string[]]$ForwardArgs = @())

  $bin = Resolve-NodeReplRuntime
  $env:CODEX_CLI_PATH = Resolve-NodeReplCodexCliPath
  Set-NodeReplRuntimeEnvironment -BinPath $bin
  $executable = Join-Path $bin 'node_repl.exe'
  & $executable @ForwardArgs
  return $LASTEXITCODE
}

function Invoke-CodexComputerUseLauncher {
  param([Parameter()][string[]]$ForwardArgs = @())

  $bin = Resolve-NodeReplRuntime
  $env:CODEX_CLI_PATH = Resolve-NodeReplCodexCliPath
  Set-NodeReplRuntimeEnvironment -BinPath $bin
  $executable = Join-Path $bin 'node_modules\@oai\sky\bin\windows\codex-computer-use.exe'
  & $executable @ForwardArgs
  return $LASTEXITCODE
}

function Assert-TomlConfigReadable {
  param([Parameter(Mandatory)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "配置不存在：$Path"
  }
  $python = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $python) { $python = Get-Command py.exe -ErrorAction SilentlyContinue }
  if (-not $python) { throw '需要 Python 3.11+ 的 tomllib 解析器来校验 config.toml。' }
  $code = 'import sys,tomllib; tomllib.load(open(sys.argv[1], "rb"))'
  & $python.Source -c $code $Path
  if ($LASTEXITCODE -ne 0) { throw "TOML 配置解析失败：$Path" }
}
