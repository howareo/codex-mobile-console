$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-powershell.ps1')
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'request-app-server-reload.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$fn = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-ReloadEnsure' }, $true)
if (-not $fn) { throw 'Missing reload ensure function' }
. ([scriptblock]::Create($fn.Extent.Text))
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('mobile-reload-ensure-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
  $script = Join-Path $fixture 'fake ensure.ps1'
  Set-Content -LiteralPath $script -Value @'
$child = Start-Process -FilePath (Join-Path $PSHOME 'pwsh.exe') -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 20' -WindowStyle Hidden -PassThru
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'descendant.pid') -Value $child.Id
Write-Output 'started'
exit 7
'@
  $result = Invoke-ReloadEnsure -ScriptPath $script -Arguments @() -OutputDirectory $fixture -TimeoutMilliseconds 5000
  if ($result.ExitCode -ne 7 -or $result.Output -notcontains 'started') { throw 'Process exit/output was not preserved' }
  $descendant = [int](Get-Content -LiteralPath (Join-Path $fixture 'descendant.pid'))
  if (-not (Get-Process -Id $descendant -ErrorAction SilentlyContinue)) { throw 'Fixture descendant exited before the parent result' }
  Stop-Process -Id $descendant -Force
  Set-Content -LiteralPath $script -Value "Set-Content -LiteralPath (Join-Path `$PSScriptRoot 'timeout.pid') -Value `$PID; Start-Sleep -Seconds 20"
  $timedOut = $false
  try { $null = Invoke-ReloadEnsure -ScriptPath $script -Arguments @() -OutputDirectory $fixture -TimeoutMilliseconds 1000 }
  catch { if ($_.Exception.Message -notmatch '1000') { throw }; $timedOut = $true }
  if (-not $timedOut) { throw 'A stuck ensure process did not time out' }
  $timedPid = [int](Get-Content -LiteralPath (Join-Path $fixture 'timeout.pid'))
  if (Get-Process -Id $timedPid -ErrorAction SilentlyContinue) { throw 'Timed-out fixture is still running' }
  Write-Output 'PASS: ensure process exit, descendant isolation, nonzero status and bounded timeout'
} finally {
  foreach ($name in @('descendant.pid', 'timeout.pid')) {
    $path = Join-Path $fixture $name
    if (Test-Path -LiteralPath $path) { Stop-Process -Id ([int](Get-Content -LiteralPath $path)) -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
