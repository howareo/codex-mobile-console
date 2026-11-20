param([switch]$Preview)
$ErrorActionPreference = 'Stop'
$names = @('查看运行状态','诊断问题','检查服务连接','启动看门','停止看门','启动共享服务 4500','停止共享服务 4500','重启共享服务 4500','重启手机网关 4174','开启登录自启动','关闭登录自启动','查看最近日志','查看 Claude 状态','启用 Claude 手机控制','停止 Claude 服务')
$actions = @('status','diagnose','check-4500','start','stop','start-4500','stop-4500','restart-4500','restart-gateway','install','uninstall','logs','claude-status','start-claude','stop-claude')
$confirmations = @{7='STOP_SHARED_APP_SERVER';8='RELOAD_SHARED_APP_SERVER';9='RESTART_MOBILE_GATEWAY';10='INSTALL_CODEX_MOBILE_AUTOSTART';11='REMOVE_CODEX_MOBILE_AUTOSTART'}
do {
  if (-not $Preview) { Clear-Host }
  Write-Host "`n  Codex 手机控制台" -ForegroundColor Cyan
  Write-Host '  ────────────────────────────' -ForegroundColor DarkGray
  for ($i=0; $i -lt $names.Count; $i++) {
    if ($i -in @(3,5,9)) { Write-Host '' }
    Write-Host ('  {0,2}  {1}' -f ($i+1), $names[$i])
  }
  Write-Host "`n   0  退出`n" -ForegroundColor DarkGray
  if ($Preview) { break }
  $number = 0
  $inputText = Read-Host '  请选择编号'
  if (-not [int]::TryParse($inputText,[ref]$number)) { continue }
  if ($number -eq 0) { break }
  if ($number -lt 1 -or $number -gt $names.Count) { continue }
  $arguments = @('-Action',$actions[$number-1])
  if ($confirmations.ContainsKey($number)) {
    if ($number -in @(7,8)) { Write-Host '  请先结束任务，关闭桌面端和手机页面。' -ForegroundColor Yellow }
    if ((Read-Host '  确认操作？输入“是”继续') -ne '是') { continue }
    $arguments += @('-Apply','-Confirmation',$confirmations[$number])
    if ($number -eq 8) { $arguments += '-Wait' }
  }
  try {
    if ($number -eq 12) { & pwsh.exe -NoLogo -NoProfile -File "$PSScriptRoot\show-gateway-logs.ps1" }
    else { & pwsh.exe -NoLogo -NoProfile -File "$PSScriptRoot\codex-mobile.ps1" @arguments }
    if ($LASTEXITCODE -ne 0) { Write-Host '  操作未完成，请查看上方原因。' -ForegroundColor Yellow }
  } catch { Write-Host $_.Exception.Message -ForegroundColor Red }
  $null = Read-Host '  按回车返回菜单'
} while ($true)
