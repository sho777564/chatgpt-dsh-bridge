#requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Workspace,
  [int]$Minutes = 30,
  [string]$ConfigPath = "",
  [switch]$Permanent,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  if ($env:DSH_BRIDGE_CONFIG) { $ConfigPath = $env:DSH_BRIDGE_CONFIG }
  else { $ConfigPath = Join-Path $projectRoot "bridge.config.json" }
}
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)

function Resolve-Node {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
  if (-not $command) { throw "Node.js was not found on PATH." }
  return $command.Source
}

function Set-PrivateAcl {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $identity,
      [System.Security.AccessControl.FileSystemRights]"FullControl",
      [System.Security.AccessControl.AccessControlType]"Allow"
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  } catch {
    Write-Warning "Could not tighten ACL on ${Path}: $($_.Exception.Message)"
  }
}

try {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Bridge config not found: $ConfigPath"
  }
  if ($Permanent -and $Yes) {
    throw "Permanent grants require interactive local confirmation; -Yes is not allowed."
  }
  if (-not $Permanent -and ($Minutes -lt 1 -or $Minutes -gt 240)) {
    throw "Minutes must be between 1 and 240."
  }

  $resolvedWorkspace = (Resolve-Path -LiteralPath $Workspace).Path
  Write-Host ""
  Write-Host "LOCAL WRITE APPROVAL" -ForegroundColor Yellow
  Write-Host "  bridge config: $ConfigPath"
  Write-Host "  workspace:     $resolvedWorkspace"
  if ($Permanent) {
    Write-Host "  grant:         PERMANENT (until revoked locally)"
    Write-Host ""
    Write-Host "A permanent grant requires interactive confirmation in this terminal."
    Write-Host "It is bound to this exact normalized directory and its filesystem identity."
  } else {
    Write-Host "  duration:      $Minutes minutes"
    Write-Host ""
    Write-Host "This creates a short-lived, HMAC-signed local grant for this exact workspace."
  }
  Write-Host "No write token is sent to ChatGPT."
  Write-Host ""

  if (-not $Permanent -and -not $Yes) {
    $answer = Read-Host "Type YES to approve locally"
    if ($answer.Trim() -ne "YES") {
      Write-Host "Approval cancelled." -ForegroundColor Yellow
      exit 2
    }
  }

  $node = Resolve-Node
  $nodeArgs = @(
    (Join-Path $scriptDir "approve-write.mjs"),
    "--workspace", $resolvedWorkspace,
    "--config", $ConfigPath
  )
  if ($Permanent) {
    $nodeArgs += "--permanent"
  } else {
    $nodeArgs += @("--minutes", "$Minutes", "--yes")
  }

  & $node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "Local approval failed with exit code $LASTEXITCODE." }

  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $dataDir = Join-Path $env:LOCALAPPDATA "ChatGPT-DSH-Bridge"
  $keyFile = if ($config.writeAuthorizerKeyFile) { $config.writeAuthorizerKeyFile } else { Join-Path $dataDir "write-authorizer.key" }
  $grantFile = if ($config.writeGrantFile) { $config.writeGrantFile } else { Join-Path $dataDir "write-grant.json" }
  Set-PrivateAcl -Path $keyFile
  Set-PrivateAcl -Path $grantFile

  Write-Host ""
  Write-Host "Local approval active. No token was printed." -ForegroundColor Green
  Write-Host "Ask ChatGPT to retry dsh_start_task with permission_mode=workspace-write and allow_write=true." -ForegroundColor Green
  Write-Host "Revoke immediately with scripts\revoke-write.ps1 -ConfigPath `"$ConfigPath`"" -ForegroundColor DarkGray
  exit 0
} catch {
  Write-Host "APPROVE-WRITE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
