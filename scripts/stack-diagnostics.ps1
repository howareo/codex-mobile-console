[CmdletBinding()]
param()

function Get-StackPortSnapshot {
  param([int]$Port)

  try {
    $connections = @(Get-NetTCPConnection -LocalPort $Port -ErrorAction Stop)
    $listeners = @(foreach ($connection in $connections) {
      if ($connection.State -ne 'Listen') { continue }
      $owner = if ($connection.OwningProcess -gt 0) {
        Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
      } else { $null }
      [ordered]@{
        address = [string]$connection.LocalAddress
        pid = [int]$connection.OwningProcess
        processName = if ($owner) { [string]$owner.Name } else { $null }
        processStartedAt = if ($owner) { [string]$owner.CreationDate } else { $null }
      }
    })
    $states = [ordered]@{}
    foreach ($group in @($connections | Group-Object State)) { $states[[string]$group.Name] = $group.Count }
    return [ordered]@{ port = $Port; listeners = $listeners; connectionStates = $states }
  } catch {
    return [ordered]@{ port = $Port; snapshotError = $_.Exception.Message }
  }
}

function Write-StackEvent {
  param([string]$RuntimeDir, [string]$Event, $Details = @{})

  try {
    $entry = [ordered]@{
      timestamp = [DateTime]::UtcNow.ToString('o')
      event = $Event
      loggerPid = $PID
      details = $Details
    }
    Add-Content -LiteralPath (Join-Path $RuntimeDir 'stack-events.ndjson') -Value ($entry | ConvertTo-Json -Compress -Depth 6) -Encoding utf8 -ErrorAction Stop
  } catch {
    Write-Warning "诊断事件日志写入失败：$($_.Exception.Message)"
  }
}
