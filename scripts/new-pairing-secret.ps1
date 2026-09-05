param(
  [string]$Path = (Join-Path $PSScriptRoot '..\.runtime\private\pairing-secret.txt')
)
$ErrorActionPreference = 'Stop'
$runtimeDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.runtime'))
& (Join-Path $PSScriptRoot 'protect-sensitive-runtime.ps1') -Apply -AllowIncomplete -RuntimeDir $runtimeDir
$resolved = [System.IO.Path]::GetFullPath($Path)
New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($resolved)) -Force | Out-Null
$bytes = [byte[]]::new(32)
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes) | Set-Content -LiteralPath $resolved -NoNewline -Encoding ascii
$acl = Get-Acl -LiteralPath $resolved
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
  'FullControl',
  'Allow'
)
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $resolved -AclObject $acl
& (Join-Path $PSScriptRoot 'protect-sensitive-runtime.ps1') -Apply -AllowIncomplete -RuntimeDir $runtimeDir | Out-Null
Write-Output "pairing secret created: $resolved"
