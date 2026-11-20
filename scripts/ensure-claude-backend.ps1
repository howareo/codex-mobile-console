function Get-ClaudeBackendState {
  try {
    $state = Invoke-RestMethod -Uri 'http://127.0.0.1:4600/healthz' -TimeoutSec 2
    if ($state.ok -ne $true -or $state.service -ne 'codex-mobile-claude' -or $state.readOnly -ne $true) { return $null }
    $listener = Get-NetTCPConnection -LocalPort 4600 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener -or $listener.LocalAddress -ne '127.0.0.1' -or [int]$listener.OwningProcess -ne [int]$state.pid) { return $null }
    return $state
  } catch { return $null }
}

function Ensure-ClaudeBackend([string]$ProjectRoot) {
  $runtime = Join-Path $ProjectRoot '.runtime'
  if (-not (Test-Path -LiteralPath (Join-Path $runtime 'claude-enabled'))) { return }
  $mutex = [Threading.Mutex]::new($false, 'Local\CodexMobileClaudeBackend')
  $locked = $false
  try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { return }
    if (Get-ClaudeBackendState) { return }
    if (Get-NetTCPConnection -LocalPort 4600 -State Listen -ErrorAction SilentlyContinue) { throw '4600 被其他服务占用，未启动 Claude 服务。' }
    $entry = Join-Path $ProjectRoot 'dist\server\server\claude-index.js'
    $secret = Join-Path $runtime 'private\pairing-secret.txt'
    foreach ($path in @($entry, $secret)) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Claude 启动缺少文件：$path" } }
    $oldSecret = $env:CODEX_MOBILE_PAIRING_SECRET_FILE
    try {
      $env:CODEX_MOBILE_PAIRING_SECRET_FILE = $secret
      $node = (Get-Command node.exe -ErrorAction Stop).Source
      $child = Start-Process -FilePath $node -ArgumentList @('"' + $entry + '"') -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtime 'claude-backend.stdout.log') -RedirectStandardError (Join-Path $runtime 'claude-backend.stderr.log') -PassThru
    } finally { $env:CODEX_MOBILE_PAIRING_SECRET_FILE = $oldSecret }
    $deadline = (Get-Date).AddSeconds(15)
    do {
      Start-Sleep -Milliseconds 500
      $state = Get-ClaudeBackendState
      if ($state -and [int]$state.pid -eq $child.Id) { return }
      $child.Refresh()
    } while (-not $child.HasExited -and (Get-Date) -lt $deadline)
    if (-not $child.HasExited) { $child.Kill() }
    throw 'Claude 服务启动失败，请查看 .runtime\claude-backend.stderr.log；未操作 Codex。'
  } finally {
    if ($locked) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
}
