function Test-AppServerIdle([string]$Url) {
  $entry = Join-Path $PSScriptRoot '../dist/server/probe/idle-cli.js'
  try {
    $result = @(& node $entry $Url 2>$null)
    if ($LASTEXITCODE -ne 0) { return $false }
    return (([string]::Join("`n", $result) | ConvertFrom-Json).idle -eq $true)
  } catch { return $false }
}
