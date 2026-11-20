[CmdletBinding()]
param()

function Test-AppServerCommandLine {
  param([string]$CommandLine, [int]$Port = 4500)
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  if ($CommandLine -notmatch '(^|[\s"])app-server([\s"]|$)') { return $false }
  return $CommandLine -match [regex]::Escape(":$Port")
}

function Get-ManagedAppServerIdentity {
  param([string]$LocalAddress, [int]$OwningProcess = 0, [string]$ProcessName, [string]$CommandLine, [int]$Port = 4500)
  $address = [string]$LocalAddress
  if ($address -notin @('127.0.0.1', '::1')) { return [pscustomobject]@{ Ok = $false; Reason = "listen-address:$address" } }
  if ($OwningProcess -le 0) { return [pscustomobject]@{ Ok = $false; Reason = 'owner-pid-unavailable' } }
  if ($ProcessName -ine 'codex.exe') {
    $name = if ([string]::IsNullOrWhiteSpace($ProcessName)) { 'unknown' } else { $ProcessName }
    return [pscustomobject]@{ Ok = $false; Reason = "process-name:$name" }
  }
  if (-not (Test-AppServerCommandLine -CommandLine $CommandLine -Port $Port)) {
    return [pscustomobject]@{ Ok = $false; Reason = 'command-line' }
  }
  return [pscustomobject]@{ Ok = $true; Reason = 'ok' }
}

function Get-LoopbackListenConnection {
  param([int]$Port)
  $rows = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Where-Object { [string]$_.LocalAddress -in @('127.0.0.1', '::1') } |
      Sort-Object @{ Expression = { [int]$_.OwningProcess }; Descending = $true })
  return $rows | Select-Object -First 1
}

function Get-AppServerCandidateProcesses {
  param([int]$Port = 4500)
  return @(Get-CimInstance Win32_Process -Filter "Name='codex.exe'" -ErrorAction SilentlyContinue |
      Where-Object { Test-AppServerCommandLine -CommandLine ([string]$_.CommandLine) -Port $Port })
}

function Format-ManagedAppServerRefusal {
  param([int]$Port, [string]$Reason, [int]$ProcessId = 0, [string]$ProcessName, [string]$CommandLine)
  $name = if ([string]::IsNullOrWhiteSpace($ProcessName)) { 'unknown' } else { $ProcessName }
  $cmd = if ([string]::IsNullOrWhiteSpace($CommandLine)) { '空' } else { $CommandLine }
  $pidText = if ($ProcessId -gt 0) { [string]$ProcessId } else { '未知' }
  switch -Regex ($Reason) {
    '^listen-address:' { return "端口 $Port 不是受管 Codex app-server：监听地址不是 127.0.0.1/::1（$Reason）。" }
    '^process-name:' { return "端口 $Port 不是受管 Codex app-server：PID $pidText 进程=$name，不是 codex.exe。" }
    '^process-unqueryable$' { return "端口 $Port 的监听进程 PID $pidText 仍占用端口，但系统读不到进程名和命令行。已保留原进程。" }
    '^command-unavailable$' { return "端口 $Port 的 PID $pidText 命令行暂时不可读取，受管身份未确认。已保留原进程。" }
    '^command-line$' { return "端口 $Port 不是受管 Codex app-server：PID $pidText 进程=$name，命令行不含 app-server --listen :$Port。当前命令行：$cmd" }
    '^owner-pid-unavailable$' { return "端口 $Port 在监听，但系统没有返回进程 PID（OwningProcess=0）。请用管理员 PowerShell 运行 status / restart-4500。" }
    default { return "端口 $Port 不是受管 Codex app-server：PID $pidText 进程=$name，原因=$Reason，命令行：$cmd" }
  }
}

function Test-RecordedAppServerIdentity {
  param($Owner, $Record, [string]$RuntimeDir)
  if (-not $Owner -or -not $Record -or [int]$Owner.ProcessId -le 0 -or [int]$Owner.ProcessId -ne [int]$Record.pid) { return $false }
  if ([string]$Owner.Name -ine 'codex.exe' -or -not $Owner.ExecutablePath -or -not $Record.binary -or -not $Owner.CreationDate -or -not $Record.startedAt) { return $false }
  try {
    $binary = [IO.Path]::GetFullPath([string]$Owner.ExecutablePath)
    $recorded = [IO.Path]::GetFullPath([string]$Record.binary)
    $root = [IO.Path]::GetFullPath((Join-Path $RuntimeDir 'codex-bundles')) + [IO.Path]::DirectorySeparatorChar
    $startedAt = ([DateTime]$Owner.CreationDate).ToUniversalTime()
    $recordedAt = ([DateTime]$Record.startedAt).ToUniversalTime()
    return $binary.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and
      [string]::Equals($binary, $recorded, [StringComparison]::OrdinalIgnoreCase) -and
      [Math]::Abs(($startedAt - $recordedAt).TotalSeconds) -lt 1
  } catch { return $false }
}

function Resolve-ManagedAppServerOwner {
  param([int]$Port = 4500, [switch]$AllowMissing)
  $listener = Get-LoopbackListenConnection -Port $Port
  if (-not $listener) {
    $otherListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($otherListener) {
      throw (Format-ManagedAppServerRefusal -Port $Port -Reason "listen-address:$($otherListener.LocalAddress)" -ProcessId ([int]$otherListener.OwningProcess))
    }
    if ($AllowMissing) { return $null }
    throw "共享 app-server 未监听端口 $Port。"
  }
  $owningProcess = 0
  try { $owningProcess = [int]$listener.OwningProcess } catch { }
  if ($owningProcess -gt 0) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$owningProcess" -ErrorAction SilentlyContinue
    if (-not $owner) { throw (Format-ManagedAppServerRefusal -Port $Port -Reason 'process-unqueryable' -ProcessId $owningProcess) }
    $identity = Get-ManagedAppServerIdentity -LocalAddress ([string]$listener.LocalAddress) -OwningProcess $owningProcess -ProcessName ([string]$owner.Name) -CommandLine ([string]$owner.CommandLine) -Port $Port
    if ($identity.Ok) { return $owner }
    if ($identity.Reason -eq 'command-line' -and [string]::IsNullOrWhiteSpace([string]$owner.CommandLine)) {
      $runtimeDir = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.runtime'))
      $statePath = Join-Path $runtimeDir 'shared-app-server.json'
      $record = if (Test-Path -LiteralPath $statePath) { try { Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -DateKind String } catch { $null } } else { $null }
      if (Test-RecordedAppServerIdentity -Owner $owner -Record $record -RuntimeDir $runtimeDir) {
        try {
          $ready = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/readyz" -TimeoutSec 3 -UseBasicParsing
          if ($ready.StatusCode -eq 200) { return $owner }
        } catch { }
      }
      $identity.Reason = 'command-unavailable'
    }
    throw (Format-ManagedAppServerRefusal -Port $Port -Reason $identity.Reason -ProcessId $owningProcess -ProcessName ([string]$owner.Name) -CommandLine ([string]$owner.CommandLine))
  }
  $candidates = @(Get-AppServerCandidateProcesses -Port $Port)
  if ($candidates.Count -eq 1) { return $candidates[0] }
  if ($candidates.Count -gt 1) { throw "端口 $Port 无法读取所有者，且发现多个 app-server 候选（PID：$($candidates.ProcessId -join ', ')）。未操作任何进程。" }
  throw (Format-ManagedAppServerRefusal -Port $Port -Reason 'owner-pid-unavailable')
}
