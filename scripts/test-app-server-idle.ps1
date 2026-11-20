. (Join-Path $PSScriptRoot 'get-app-server-reload-state.ps1')

function Test-AppServerIdle([string]$Url) {
  $snapshot = Get-AppServerIdleSnapshot -Url $Url
  return [bool]$snapshot.idle
}