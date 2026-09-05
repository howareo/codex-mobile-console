[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) "codex-node-repl-test-$PID-$([Guid]::NewGuid().ToString('N'))"
$windowsAppsRoot = Join-Path $fixtureRoot 'WindowsApps'
$runtimeRoot = Join-Path $fixtureRoot 'runtimes\cua_node'
$preferredBin = Join-Path $fixtureRoot 'preferred\bin'
$fallbackBin = Join-Path $runtimeRoot 'fallback\bin'
$projectRoot = $fixtureRoot
$stableBundle = Join-Path $fixtureRoot 'runtime\codex-bundles\stable'
$statePath = Join-Path $fixtureRoot '.runtime\shared-app-server.json'
$missingCliPath = Join-Path $fixtureRoot 'old\missing\codex.exe'
$launcher = Join-Path $PSScriptRoot 'start-codex-node-repl.ps1'
$child = Join-Path $fixtureRoot 'child.js'
$result = Join-Path $fixtureRoot 'result.json'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source

function New-FakeRuntime {
  param([Parameter(Mandatory)][string]$BinPath)
  New-Item -ItemType Directory -Path (Join-Path $BinPath 'node_modules\@oai\sky\bin\windows') -Force | Out-Null
  Copy-Item -LiteralPath $node -Destination (Join-Path $BinPath 'node_repl.exe')
  Copy-Item -LiteralPath $node -Destination (Join-Path $BinPath 'node.exe')
  Copy-Item -LiteralPath $node -Destination (Join-Path $BinPath 'node_modules\@oai\sky\bin\windows\codex-computer-use.exe')
}

function New-FakeCodexBundle {
  param([Parameter(Mandatory)][string]$BundlePath)
  New-Item -ItemType Directory -Path $BundlePath -Force | Out-Null
  foreach ($fileName in @('codex.exe', 'codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe')) {
    New-Item -ItemType File -Path (Join-Path $BundlePath $fileName) -Force | Out-Null
  }
}

try {
  New-FakeRuntime -BinPath $preferredBin
  New-FakeRuntime -BinPath $fallbackBin
  New-FakeCodexBundle -BundlePath $stableBundle
  New-Item -ItemType Directory -Path (Split-Path -Parent $statePath) -Force | Out-Null
  @{ binary = (Join-Path $stableBundle 'codex.exe') } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
  New-Item -ItemType Directory -Path $windowsAppsRoot -Force | Out-Null
  Set-Content -LiteralPath $child -Encoding utf8 -Value @'
const fs = require('fs');
const [resultPath, exitCode, ...args] = process.argv.slice(2);
fs.writeFileSync(resultPath, JSON.stringify({
  NodePath: process.env.NODE_REPL_NODE_PATH,
  CodexCliPath: process.env.CODEX_CLI_PATH,
  ModuleDirs: process.env.NODE_REPL_NODE_MODULE_DIRS,
  Trusted: process.env.NODE_REPL_TRUSTED_CODE_PATHS,
  Args: args
}));
process.exit(Number(exitCode));
'@

  $env:CODEX_NODE_REPL_WINDOWS_APPS_ROOT = $windowsAppsRoot
  $env:CODEX_NODE_REPL_RUNTIME_ROOT = $runtimeRoot
  $env:CODEX_NODE_REPL_PROJECT_ROOT = $projectRoot
  $env:CODEX_CLI_PATH = $missingCliPath
  $env:NODE_REPL_NODE_PATH = Join-Path $preferredBin 'node.exe'
  $firstArgs = @($child, $result, '17', 'alpha', 'beta')
  & $pwsh -NoProfile -File $launcher -Mode NodeRepl @firstArgs
  if ($LASTEXITCODE -ne 17) { throw "优先 runtime 退出码错误：$LASTEXITCODE" }
  $first = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
  if ($first.NodePath -ne (Join-Path $preferredBin 'node.exe')) { throw '未优先使用配置传入的完整 runtime' }
  if ($first.CodexCliPath -ne (Join-Path $stableBundle 'codex.exe')) { throw '旧 CODEX_CLI_PATH 缺失后未使用稳定假 bundle' }
  if (($first.Args -join '|') -ne 'alpha|beta') { throw "参数未透传：$($first.Args -join '|')" }
  Write-Output 'PASS: preferred runtime and NodeRepl args/exit code'

  Remove-Item -LiteralPath $preferredBin -Recurse -Force
  $secondArgs = @($child, $result, '23', 'fallback')
  & $pwsh -NoProfile -File $launcher -Mode NodeRepl @secondArgs
  if ($LASTEXITCODE -ne 23) { throw "回退 runtime 退出码错误：$LASTEXITCODE" }
  $second = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
  if ($second.NodePath -ne (Join-Path $fallbackBin 'node.exe')) { throw '首选 runtime 缺失后未选择回退 runtime' }
  if (($second.Args -join '|') -ne 'fallback') { throw "回退参数未透传：$($second.Args -join '|')" }
  Write-Output 'PASS: missing preferred runtime fallback and exit code'

  $notifyArgs = @($child, $result, '29', 'notify')
  & $pwsh -NoProfile -File $launcher -Mode Notify @notifyArgs
  if ($LASTEXITCODE -ne 29) { throw "Notify 退出码错误：$LASTEXITCODE" }
  $notify = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
  if ($notify.NodePath -ne (Join-Path $fallbackBin 'node.exe')) { throw 'Notify 未复用回退 runtime' }
  if ($notify.CodexCliPath -ne (Join-Path $stableBundle 'codex.exe')) { throw 'Notify 未覆盖为稳定假 bundle' }
  if (($notify.Args -join '|') -ne 'notify') { throw "Notify 参数未透传：$($notify.Args -join '|')" }
  Write-Output 'PASS: Notify runtime and args/exit code'
} finally {
  Remove-Item Env:CODEX_NODE_REPL_WINDOWS_APPS_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_NODE_REPL_RUNTIME_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_NODE_REPL_PROJECT_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:CODEX_CLI_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_REPL_NODE_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_REPL_NODE_MODULE_DIRS -ErrorAction SilentlyContinue
  Remove-Item Env:NODE_REPL_TRUSTED_CODE_PATHS -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}
