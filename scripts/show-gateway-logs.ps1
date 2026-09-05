[CmdletBinding()]
param(
  [ValidateRange(1, 1000)]
  [int]$Lines = 80,
  [switch]$Follow
)

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $ProjectRoot ".runtime\gateway.ndjson"
if (-not (Test-Path -LiteralPath $LogFile -PathType Leaf)) {
  Write-Host "还没有诊断日志。请先启动新版手机网关。"
  exit 1
}

$EventNames = @{
  "gateway.starting" = "网关启动中"
  "gateway.listening" = "网关开始监听"
  "gateway.stopped" = "网关已停止"
  "http.request" = "接口请求"
  "http.response" = "接口响应"
  "http.error" = "接口处理错误"
  "auth.rejected" = "登录状态失效"
  "auth.login_failed" = "配对密钥错误"
  "auth.login_succeeded" = "手机登录成功"
  "auth.logout" = "手机退出登录"
  "upstream.connected" = "上游已连接"
  "upstream.connect_failed" = "上游连接失败"
  "upstream.closed" = "上游连接关闭"
  "upstream.timeout" = "上游请求超时"
  "upstream.error" = "上游错误"
  "upstream.request" = "上游请求"
  "upstream.response" = "上游响应"
  "thread.resumed" = "网关订阅任务"
  "write.resume_after_thread_not_found" = "任务恢复后重试"
  "thread.unsubscribed" = "网关取消任务订阅"
  "thread.unsubscribe_deferred" = "任务仍在运行，暂缓取消订阅"
  "thread.unsubscribe_failed" = "取消任务订阅失败"
  "upstream.notification" = "上游状态通知"
  "upstream.server_request" = "上游审批请求"
  "snapshot.ok" = "实时快照正常"
  "snapshot.failed" = "实时快照失败"
  "snapshot.initial_failed" = "首次快照失败"
  "ws.open" = "手机实时连接建立"
  "ws.close" = "手机实时连接关闭"
  "ws.error" = "手机实时连接错误"
  "ws.subscribed" = "手机订阅任务"
  "ws.auth_rejected" = "手机实时登录失效"
  "ws.invalid_message" = "手机实时消息格式错误"
  "ws.invalid_subscription" = "手机订阅格式错误"
  "ws.broadcast_failed" = "实时事件发送失败"
  "client.ws.error" = "手机报告实时连接错误"
  "client.ws.closed" = "手机报告实时连接关闭"
  "client.ws.snapshot_stale" = "手机报告快照延迟"
  "client.api.network_error" = "手机报告网络错误"
  "client.api.response_error" = "手机报告接口错误"
}

function Format-LogLine([string]$Line) {
  try {
    $Entry = $Line | ConvertFrom-Json
    $Name = if ($EventNames.ContainsKey($Entry.event)) { $EventNames[$Entry.event] } else { $Entry.event }
    $LocalTime = ([datetime]$Entry.timestamp).ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
    $Level = switch ($Entry.level) { "error" { "错误" } "warn" { "警告" } default { "信息" } }
    $Details = [ordered]@{}
    foreach ($Property in $Entry.PSObject.Properties) {
      if ($Property.Name -notin @("timestamp", "level", "event")) { $Details[$Property.Name] = $Property.Value }
    }
    $DetailText = if ($Details.Count -gt 0) { $Details | ConvertTo-Json -Compress -Depth 6 } else { "" }
    "$LocalTime [$Level] $Name $DetailText".TrimEnd()
  } catch {
    "日志行格式错误：$Line"
  }
}

if ($Follow) {
  Get-Content -LiteralPath $LogFile -Tail $Lines -Wait | ForEach-Object { Format-LogLine $_ }
} else {
  Get-Content -LiteralPath $LogFile -Tail $Lines | ForEach-Object { Format-LogLine $_ }
}
