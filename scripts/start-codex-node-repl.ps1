param(
  [ValidateSet('NodeRepl', 'Notify')]
  [string]$Mode = 'NodeRepl'
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'codex-node-repl-common.ps1')
$ForwardArgs = @($args)

if ($Mode -eq 'Notify') {
  $exitCode = Invoke-CodexComputerUseLauncher -ForwardArgs $ForwardArgs
} else {
  $exitCode = Invoke-NodeReplLauncher -ForwardArgs $ForwardArgs
}
exit $exitCode
