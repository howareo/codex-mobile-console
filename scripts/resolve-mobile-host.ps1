function Resolve-MobileHostAddress {
  [CmdletBinding()]
  param([string]$Requested)

  if (-not [string]::IsNullOrWhiteSpace($Requested)) {
    return $Requested
  }

  foreach ($candidate in @(
      $env:CODEX_MOBILE_HOST,
      [Environment]::GetEnvironmentVariable('CODEX_MOBILE_HOST', 'User'),
      [Environment]::GetEnvironmentVariable('CODEX_MOBILE_HOST', 'Machine')
    )) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) {
      return $candidate.Trim()
    }
  }

  # A public checkout stays local until the deployer chooses a private address.
  return '127.0.0.1'
}
