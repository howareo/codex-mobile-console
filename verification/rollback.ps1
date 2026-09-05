param(
  [Parameter(Mandatory = $true)]
  [string]$Commit
)
$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not (git -C $root rev-parse --verify "$Commit^{commit}" 2>$null)) { throw "commit not found: $Commit" }
if (git -C $root status --porcelain) { throw 'working tree must be clean before rollback' }
git -C $root revert --no-edit $Commit
Write-Output "rollback commit created for $Commit"
