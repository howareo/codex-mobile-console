[CmdletBinding()]
param(
  [string]$HostAddress = '',
  [int]$Port = 4174,
  [string]$AppServerUrl = "ws://127.0.0.1:4500",
  [switch]$LegacySensitiveRuntime
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-mobile-host.ps1")
$HostAddress = Resolve-MobileHostAddress $HostAddress
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot ".runtime"
if (-not $LegacySensitiveRuntime) {
  & (Join-Path $PSScriptRoot "protect-sensitive-runtime.ps1") -Apply -RuntimeDir $RuntimeDir
}
$SensitiveRoot = if ($LegacySensitiveRuntime) { $RuntimeDir } else { Join-Path $RuntimeDir "private" }
$PairingSecret = Join-Path $SensitiveRoot "pairing-secret.txt"
$TlsCertificate = Join-Path $ProjectRoot ".runtime\tls\codex-mobile-server.crt"
$TlsKey = Join-Path $SensitiveRoot "tls\codex-mobile-server.key"
$LogFile = Join-Path $ProjectRoot ".runtime\gateway.ndjson"
$SessionStoreFile = Join-Path $SensitiveRoot "sessions.json"

foreach ($Path in @($PairingSecret, $TlsCertificate, $TlsKey)) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "缺少运行文件：$Path"
  }
}

Set-Location $ProjectRoot
$env:CODEX_MOBILE_HOST = $HostAddress
$env:CODEX_MOBILE_PORT = [string]$Port
$env:CODEX_MOBILE_APP_SERVER_URL = $AppServerUrl
$env:CODEX_MOBILE_PAIRING_SECRET_FILE = $PairingSecret
$env:CODEX_MOBILE_TLS_CERT = $TlsCertificate
$env:CODEX_MOBILE_TLS_KEY = $TlsKey
$env:CODEX_MOBILE_LOG_FILE = $LogFile
$env:CODEX_MOBILE_SESSION_STORE_FILE = $SessionStoreFile

Write-Host "手机网关：https://${HostAddress}:$Port/"
Write-Host "诊断日志：$LogFile"
Write-Host "按 Ctrl+C 停止手机网关；桌面端和 app-server 不会停止。"
& npm.cmd run gateway
exit $LASTEXITCODE
