[CmdletBinding()]
param(
  [ValidateSet('help', 'status', 'diagnose', 'check-4500', 'start-4500', 'stop-4500', 'restart-4500', 'start', 'stop', 'restart', 'reload', 'install', 'uninstall', 'stop-gateway', 'restart-gateway')]
  [string]$Action = 'help',
  [switch]$Apply,
  [string]$Confirmation
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$HostResolver = Join-Path $PSScriptRoot 'resolve-mobile-host.ps1'
. $HostResolver
$GatewayHost = Resolve-MobileHostAddress ''
$TaskName = 'Codex Mobile Console'
$Pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($Pwsh)) { $Pwsh = (Get-Command powershell.exe -ErrorAction Stop).Source }

function Run-Script([string]$Name, [string[]]$Arguments = @()) {
  & $Pwsh -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $Name) @Arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Require-Confirmation([string]$Expected) {
  if (-not $Apply -or $Confirmation -ne $Expected) {
    throw "需要执行确认：-Apply -Confirmation $Expected"
  }
}

function Show-Help {
  @'
Codex 手机控制台统一管理入口

先进入项目目录：
  $ProjectRoot = 'C:\path\to\codex-mobile-console'  # 改成实际项目目录
  Set-Location $ProjectRoot

查看：
  .\scripts\codex-mobile.ps1 status       查看进程、协议、配置和连接状态
  .\scripts\codex-mobile.ps1 diagnose     查看版本、PID、readyz 和历史错误计数
  .\scripts\codex-mobile.ps1 check-4500   实测 initialize + thread/list

4500 App Server：
  .\scripts\codex-mobile.ps1 start-4500
  .\scripts\codex-mobile.ps1 stop-4500
  .\scripts\codex-mobile.ps1 stop-4500 -Apply -Confirmation STOP_SHARED_APP_SERVER
  .\scripts\codex-mobile.ps1 restart-4500
  .\scripts\codex-mobile.ps1 restart-4500 -Apply -Confirmation RELOAD_SHARED_APP_SERVER

日常启动/停止：
  .\scripts\codex-mobile.ps1 start        启动看门；不会重复启动 4500
  .\scripts\codex-mobile.ps1 stop         停止看门；不会停止桌面端、4500、4174
  .\scripts\codex-mobile.ps1 restart      重启看门；不会主动重启 4500

手机网关：
  .\scripts\codex-mobile.ps1 stop-gateway -Apply -Confirmation STOP_MOBILE_GATEWAY
  .\scripts\codex-mobile.ps1 restart-gateway -Apply -Confirmation RESTART_MOBILE_GATEWAY

配置重载（先预览，确认无活动连接后再执行）：
  .\scripts\codex-mobile.ps1 reload
  .\scripts\codex-mobile.ps1 reload -Apply -Confirmation RELOAD_SHARED_APP_SERVER

首次安装/取消登录自启动：
  .\scripts\codex-mobile.ps1 install -Apply -Confirmation INSTALL_CODEX_MOBILE_AUTOSTART
  .\scripts\codex-mobile.ps1 uninstall -Apply -Confirmation REMOVE_CODEX_MOBILE_AUTOSTART

部署/升级：
  npm ci
  npm run build
  .\scripts\codex-mobile.ps1 restart

升级或打不开时的顺序：status -> check-4500 -> diagnose；4500 未运行时用 start-4500，协议异常时在维护窗口用 restart-4500。不要编辑 state_5.sqlite，不要手动启动第二个 4500。
'@
}

switch ($Action) {
  'help' { Show-Help; break }
  'status' {
    Run-Script 'show-autostart-status.ps1'
    break
  }
  'diagnose' {
    Run-Script 'diagnose-codex-stack.ps1'
    break
  }
  'check-4500' {
    Run-Script 'test-app-server-protocol.ps1'
    break
  }
  'start-4500' {
    Run-Script 'manage-shared-app-server.ps1' @('-Action', 'Start')
    break
  }
  'stop-4500' {
    $args = @('-Action', 'Stop')
    if ($Apply) { $args += @('-Apply', '-Confirmation', $Confirmation) }
    Run-Script 'manage-shared-app-server.ps1' $args
    break
  }
  'restart-4500' {
    $args = @('-Reason', 'manual-restart')
    if ($Apply) { $args += @('-Apply', '-Confirmation', $Confirmation) }
    Run-Script 'request-app-server-reload.ps1' $args
    break
  }
  'start' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { throw "未安装登录自启动。先执行 install，或运行 .\scripts\ensure-mobile-stack.ps1 -Once。" }
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "看门已请求启动：$TaskName"
    break
  }
  'stop' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task -and $task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
    Write-Output '看门已停止；桌面端、4500 和 4174 保持不变。'
    break
  }
  'restart' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { throw '未安装登录自启动，不能重启看门。' }
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 1 }
    Start-ScheduledTask -TaskName $TaskName
    Write-Output '看门已重启；不会主动重启 4500。'
    break
  }
  'reload' {
    $args = @()
    if ($Apply) { $args += @('-Apply', '-Confirmation', $Confirmation) }
    Run-Script 'request-app-server-reload.ps1' $args
    break
  }
  'install' {
    Run-Script 'install-autostart.ps1' @('-Apply', '-Confirmation', $(if ($Confirmation) { $Confirmation } else { '' }))
    break
  }
  'uninstall' {
    Run-Script 'uninstall-autostart.ps1' @('-Apply', '-Confirmation', $(if ($Confirmation) { $Confirmation } else { '' }))
    break
  }
  'stop-gateway' {
    Require-Confirmation 'STOP_MOBILE_GATEWAY'
    $listener = Get-NetTCPConnection -LocalPort 4174 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) { Write-Output '4174 当前没有监听进程。'; break }
    try { $page = Invoke-WebRequest -Uri "https://${GatewayHost}:4174/" -SkipCertificateCheck -UseBasicParsing -TimeoutSec 3 } catch { throw '4174 不是可验证的手机网关，未停止任何进程。' }
    if ($page.StatusCode -ne 200 -or [string]$page.Content -notmatch '(?i)Codex.*Console|Codex Mobile') { throw '4174 身份校验失败，未停止任何进程。' }
    $owner = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
    if ($owner.ProcessName -ine 'node') { throw '4174 不是 Node 网关进程，未停止任何进程。' }
    Stop-Process -Id $owner.Id -Force
    Write-Output "手机网关已停止：PID $($owner.Id)。4500 和桌面端保持不变。"
    break
  }
  'restart-gateway' {
    Require-Confirmation 'RESTART_MOBILE_GATEWAY'
    & $PSCommandPath -Action stop-gateway -Apply -Confirmation STOP_MOBILE_GATEWAY
    Start-Sleep -Seconds 1
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Start-ScheduledTask -TaskName $TaskName; Write-Output '已请求看门重新启动手机网关。' }
    else { Run-Script 'start-gateway.ps1' }
    break
  }
}
