[CmdletBinding()]
param(
  [string]$Url = 'ws://127.0.0.1:4500',
  [int]$TimeoutMilliseconds = 8000,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entry = Join-Path $projectRoot 'dist\server\probe\protocol-health-cli.js'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
  throw "缺少协议检查程序：$entry。请先执行 npm run build:server。"
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$output = @(& $node $entry --url $Url --timeout-ms ([string]$TimeoutMilliseconds) 2>&1)
$exitCode = $LASTEXITCODE
$payload = [string]::Join("`n", $output)
try { $result = $payload | ConvertFrom-Json -ErrorAction Stop }
catch { throw "4500 协议检查输出无法解析：$payload" }

if ($Json) {
  $result | ConvertTo-Json -Depth 5 -Compress
} elseif ($result.ok) {
  Write-Output "4500 协议正常：initialize=通过，thread/list=通过，任务数=$($result.threadCount)，耗时=$($result.durationMs)ms。"
} else {
  Write-Output "4500 协议异常：initialize=$($result.initialize)，thread/list=$($result.threadList)，原因=$($result.error)"
}
if ($exitCode -ne 0) { exit $exitCode }
