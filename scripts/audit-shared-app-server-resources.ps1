[CmdletBinding()]
param(
  [int]$AppServerPort = 4500,
  [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'

if ($AppServerPort -lt 1 -or $AppServerPort -gt 65535) {
  throw 'AppServerPort must be between 1 and 65535.'
}

function Get-DescendantProcesses {
  param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [Parameter(Mandatory = $true)][object[]]$Processes
  )

  $children = @($Processes | Where-Object { $_.ParentProcessId -eq $ParentProcessId })
  foreach ($child in $children) {
    $child
    Get-DescendantProcesses -ParentProcessId $child.ProcessId -Processes $Processes
  }
}

function Get-WorkingSetMb {
  param([object[]]$Processes)
  if ($Processes.Count -eq 0) { return 0 }
  return [Math]::Round((($Processes | Measure-Object -Property WorkingSetSize -Sum).Sum / 1MB), 1)
}

$listener = Get-NetTCPConnection -LocalPort $AppServerPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $listener) {
  throw "No listening process was found on port $AppServerPort."
}
if ($listener.LocalAddress -notin @('127.0.0.1', '::1')) {
  throw "Port $AppServerPort is not loopback-only."
}

$allProcesses = @(Get-CimInstance Win32_Process)
$appServer = $allProcesses | Where-Object { $_.ProcessId -eq $listener.OwningProcess } | Select-Object -First 1
if (-not $appServer -or $appServer.Name -ine 'codex.exe' -or $appServer.CommandLine -notmatch '\bapp-server\b') {
  throw "Port $AppServerPort is not owned by a Codex app-server process."
}

$descendants = @(Get-DescendantProcesses -ParentProcessId $appServer.ProcessId -Processes $allProcesses)
$directChildren = @($descendants | Where-Object { $_.ParentProcessId -eq $appServer.ProcessId })
$chromeRoots = @($directChildren | Where-Object {
  $_.Name -ieq 'cmd.exe' -and $_.CommandLine -match '\bnpx\s+chrome-devtools-mcp(?:@[\w.-]+)?\b'
})
$chromeInstances = @(
  foreach ($root in $chromeRoots) {
    $tree = @($root) + @(Get-DescendantProcesses -ParentProcessId $root.ProcessId -Processes $allProcesses)
    [pscustomobject]@{
      launcherPid = $root.ProcessId
      startedAt = $root.CreationDate
      processCount = $tree.Count
      nodeProcessCount = @($tree | Where-Object { $_.Name -ieq 'node.exe' }).Count
      workingSetMb = Get-WorkingSetMb -Processes $tree
    }
  }
)
$nodeRepl = @($directChildren | Where-Object { $_.Name -ieq 'node_repl.exe' })
$sakuraMcp = @($directChildren | Where-Object {
  $_.Name -ieq 'python.exe' -and $_.CommandLine -match '\bsakura\.mcp_server\b'
})
$establishedConnections = @(Get-NetTCPConnection -LocalPort $AppServerPort -State Established -ErrorAction SilentlyContinue)
$warnings = @()
if ($chromeInstances.Count -gt 1) {
  $warnings += "Detected $($chromeInstances.Count) Chrome DevTools MCP process trees. More than one indicates retained app-server task runtimes."
}
if ($descendants.Count -gt 80) {
  $warnings += "Detected $($descendants.Count) app-server descendant processes. Review retained task runtimes before any manual cleanup."
}

$report = [ordered]@{
  capturedAt = (Get-Date).ToUniversalTime().ToString('o')
  appServer = [ordered]@{
    pid = $appServer.ProcessId
    startedAt = $appServer.CreationDate
    listener = "ws://$($listener.LocalAddress):$AppServerPort"
    establishedConnections = $establishedConnections.Count
    directChildren = $directChildren.Count
    descendants = $descendants.Count
    descendantWorkingSetMb = Get-WorkingSetMb -Processes $descendants
  }
  resources = [ordered]@{
    chromeDevToolsMcpInstances = $chromeInstances.Count
    chromeDevToolsMcpProcessCount = @($chromeInstances | ForEach-Object { $_.processCount } | Measure-Object -Sum).Sum
    chromeDevToolsMcpWorkingSetMb = [Math]::Round((($chromeInstances | ForEach-Object { $_.workingSetMb } | Measure-Object -Sum).Sum), 1)
    nodeReplInstances = $nodeRepl.Count
    sakuraMcpInstances = $sakuraMcp.Count
  }
  chromeDevToolsMcp = $chromeInstances
  warnings = $warnings
}

$json = $report | ConvertTo-Json -Depth 6
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
  $resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
  $outputDirectory = Split-Path -Parent $resolvedOutputPath
  New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
  Set-Content -LiteralPath $resolvedOutputPath -Value $json -Encoding utf8
}

Write-Output $json
