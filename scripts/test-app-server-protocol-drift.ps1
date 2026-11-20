[CmdletBinding()]
param(
  [string]$CodexPath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if ([string]::IsNullOrWhiteSpace($CodexPath)) {
  . (Join-Path $PSScriptRoot 'get-managed-app-server.ps1')
  $CodexPath = [string](Resolve-ManagedAppServerOwner -Port 4500).ExecutablePath
}
if (-not (Test-Path -LiteralPath $CodexPath -PathType Leaf)) { throw "找不到 codex.exe：$CodexPath" }

# 网关实际调用的方法：CLIENT_METHODS 是 AppServerClient.request 的运行时白名单，未列入的方法会直接抛错，
# 因此它就是唯一事实来源，比脚本内另存一份数组不易漂移；initialize 走 requestInternal，单独补上。
$clientSource = Get-Content -LiteralPath (Join-Path $projectRoot 'src\protocol\app-server-client.ts') -Raw -Encoding utf8
$listMatch = [regex]::Match($clientSource, 'CLIENT_METHODS\s*=\s*new Set\(\[(?<list>[^\]]*)\]')
if (-not $listMatch.Success) { throw '无法在 app-server-client.ts 中找到 CLIENT_METHODS。' }
$used = @('initialize') + @([regex]::Matches($listMatch.Groups['list'].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value }) | Sort-Object -Unique

$version = (& $CodexPath --version | Select-Object -First 1)
$outDir = Join-Path $env:TEMP "codex-schema-drift-$([guid]::NewGuid().ToString('N'))"
try {
  & $CodexPath app-server generate-json-schema --out $outDir | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "generate-json-schema 失败，退出码 $LASTEXITCODE" }
  $request = Get-Content -LiteralPath (Join-Path $outDir 'ClientRequest.json') -Raw -Encoding utf8 | ConvertFrom-Json
  $available = @($request.oneOf | ForEach-Object { $_.properties.method.enum } | Where-Object { $_ })
} finally {
  if (Test-Path -LiteralPath $outDir) { Remove-Item -LiteralPath $outDir -Recurse -Force }
}
if ($available.Count -eq 0) { throw 'ClientRequest.json 中没有解析到任何请求方法。' }

$missing = @($used | Where-Object { $_ -notin $available })
Write-Output "$version：协议提供 $($available.Count) 个请求方法，网关使用 $($used.Count) 个。"
if ($missing.Count -gt 0) {
  Write-Output "缺失的方法：$($missing -join ', ')"
  exit 1
}
Write-Output '网关使用的方法全部存在。'
