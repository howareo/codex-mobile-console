function Resolve-StablePowerShell {
  $appAlias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\pwsh.exe"
  if (Test-Path -LiteralPath $appAlias -PathType Leaf) {
    return $appAlias
  }
  return (Get-Command pwsh.exe -ErrorAction Stop).Source
}
