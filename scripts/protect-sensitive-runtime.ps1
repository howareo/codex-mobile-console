[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$AllowIncomplete,
  [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\.runtime')
)

$ErrorActionPreference = 'Stop'
$resolvedRuntime = [System.IO.Path]::GetFullPath($RuntimeDir)
$privateRoot = Join-Path $resolvedRuntime 'private'
$privateTls = Join-Path $privateRoot 'tls'
$currentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowedSids = @(
  $currentUserSid,
  [System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null),
  [System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
)

$mappings = @(
  [pscustomobject]@{ Name = '配对密钥'; Source = (Join-Path $resolvedRuntime 'pairing-secret.txt'); Destination = (Join-Path $privateRoot 'pairing-secret.txt'); Required = $true },
  [pscustomobject]@{ Name = '移动会话'; Source = (Join-Path $resolvedRuntime 'sessions.json'); Destination = (Join-Path $privateRoot 'sessions.json'); Required = $false },
  [pscustomobject]@{ Name = '服务器私钥'; Source = (Join-Path $resolvedRuntime 'tls\codex-mobile-server.key'); Destination = (Join-Path $privateTls 'codex-mobile-server.key'); Required = $true },
  [pscustomobject]@{ Name = '本地 CA 私钥'; Source = (Join-Path $resolvedRuntime 'tls\codex-mobile-ca.key'); Destination = (Join-Path $privateTls 'codex-mobile-ca.key'); Required = $false }
)

function Set-PrivateAcl {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][bool]$Directory
  )

  $acl = if ($Directory) {
    [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    [System.Security.AccessControl.FileSecurity]::new()
  }
  $acl.SetOwner($currentUserSid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $allowedSids) {
    $rule = if ($Directory) {
      [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
    } else {
      [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.AccessControlType]::Allow
      )
    }
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

foreach ($mapping in $mappings) {
  $sourceExists = Test-Path -LiteralPath $mapping.Source -PathType Leaf
  $destinationExists = Test-Path -LiteralPath $mapping.Destination -PathType Leaf
  if ($mapping.Required -and -not $AllowIncomplete -and -not $sourceExists -and -not $destinationExists) {
    throw "缺少$($mapping.Name)：$($mapping.Source) 或 $($mapping.Destination)"
  }
  if ($sourceExists -and $destinationExists) {
    $sourceHash = (Get-FileHash -LiteralPath $mapping.Source -Algorithm SHA256).Hash
    $destinationHash = (Get-FileHash -LiteralPath $mapping.Destination -Algorithm SHA256).Hash
    if ($sourceHash -ne $destinationHash) {
      throw "$($mapping.Name)的新旧文件内容不同；未执行迁移：$($mapping.Source)"
    }
  }
}

if (-not $Apply) {
  Write-Output "预览：敏感目录 $privateRoot"
  foreach ($mapping in $mappings) {
    Write-Output "预览：$($mapping.Source) -> $($mapping.Destination)"
  }
  Write-Output 'DRY-RUN：未复制、删除或修改 ACL。'
  return
}

New-Item -ItemType Directory -Path $privateRoot, $privateTls -Force | Out-Null
Set-PrivateAcl -Path $privateRoot -Directory $true
Set-PrivateAcl -Path $privateTls -Directory $true

$createdDestinations = @()
try {
  foreach ($mapping in $mappings) {
    $sourceExists = Test-Path -LiteralPath $mapping.Source -PathType Leaf
    $destinationExists = Test-Path -LiteralPath $mapping.Destination -PathType Leaf
    if ($sourceExists -and -not $destinationExists) {
      $temporaryPath = "$($mapping.Destination).migrating.$PID"
      try {
        Copy-Item -LiteralPath $mapping.Source -Destination $temporaryPath
        if ((Get-FileHash -LiteralPath $mapping.Source -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $temporaryPath -Algorithm SHA256).Hash) {
          throw "$($mapping.Name)复制校验失败。"
        }
        Move-Item -LiteralPath $temporaryPath -Destination $mapping.Destination
        $createdDestinations += $mapping.Destination
      } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
          Remove-Item -LiteralPath $temporaryPath -Force
        }
      }
    }
  }

  foreach ($mapping in $mappings) {
    if (Test-Path -LiteralPath $mapping.Destination -PathType Leaf) {
      Set-PrivateAcl -Path $mapping.Destination -Directory $false
    }
  }

  foreach ($mapping in $mappings) {
    if (Test-Path -LiteralPath $mapping.Source -PathType Leaf) {
      if (-not (Test-Path -LiteralPath $mapping.Destination -PathType Leaf)) {
        throw "$($mapping.Name)目标文件不存在，保留旧文件。"
      }
      if ((Get-FileHash -LiteralPath $mapping.Source -Algorithm SHA256).Hash -ne
          (Get-FileHash -LiteralPath $mapping.Destination -Algorithm SHA256).Hash) {
        throw "$($mapping.Name)最终校验失败，保留旧文件。"
      }
      Remove-Item -LiteralPath $mapping.Source -Force
    }
  }
} catch {
  foreach ($destination in $createdDestinations) {
    if (Test-Path -LiteralPath $destination -PathType Leaf) {
      Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
    }
  }
  throw
}

Set-PrivateAcl -Path $privateRoot -Directory $true
Set-PrivateAcl -Path $privateTls -Directory $true
Write-Output "敏感运行文件已迁移并保护：$privateRoot"
