[CmdletBinding()]
param([ValidateSet('status', 'start', 'stop')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-claude-backend.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$marker = Join-Path $root '.runtime\claude-enabled'
switch ($Action) {
  'status' {
    $state = Get-ClaudeBackendState
    Write-Output "Claude 自动维护：$(if (Test-Path -LiteralPath $marker) { '已启用' } else { '未启用' })"
    Write-Output "Claude 服务 4600：$(if ($state) { "正常，PID $($state.pid)" } else { '未连接' })"
    if ($state -and $state.capabilities.control) { Write-Output '手机控制：发送、实时输出、停止和审批已开放。' }
    Write-Output '此操作不访问或重启 Codex 4500。'
  }
  'start' {
    New-Item -ItemType Directory -Path (Join-Path $root '.runtime') -Force | Out-Null
    'enabled' | Set-Content -LiteralPath $marker -Encoding utf8
    Ensure-ClaudeBackend -ProjectRoot $root
    Write-Output 'Claude 服务已启用，手机仍使用原来的 4174 网址。'
  }
  'stop' {
    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker }
    $state = Get-ClaudeBackendState
    if ($state) {
      $owner = Get-Process -Id $state.pid -ErrorAction Stop
      if ($owner.ProcessName -ine 'node') { throw '4600 进程身份不匹配，未停止进程。' }
      if ($state.capabilities.control) {
        $secret = (Get-Content -LiteralPath (Join-Path $root '.runtime\private\pairing-secret.txt') -Raw).Trim()
        $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($secret))
        try { $key = [Convert]::ToHexString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes('codex-mobile-claude-backend-v1'))).ToLowerInvariant() } finally { $hmac.Dispose() }
        Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:4600/shutdown' -Headers @{ 'x-codex-mobile-claude-key' = $key } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 | Out-Null
        if (-not $owner.WaitForExit(15000)) { throw 'Claude 服务仍在退出，已保留现场，请查看日志；未强杀进程。' }
      } else { Stop-Process -Id $owner.Id -Force }
    } elseif (Get-NetTCPConnection -LocalPort 4600 -State Listen -ErrorAction SilentlyContinue) {
      throw '4600 被非 Claude 服务占用，未停止任何进程。'
    }
    Write-Output 'Claude 服务及手机发起的任务已停止，Codex 4500、手机网关 4174 和独立 Claude 终端保持不变。'
  }
}
