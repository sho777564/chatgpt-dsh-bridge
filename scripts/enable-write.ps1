#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$ConfigPath = "",
  [string[]]$AllowedRoots = @()
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
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

try {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw "Bridge config not found: $ConfigPath"
  }

  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $config | Add-Member -NotePropertyName writeModeEnabled -NotePropertyValue $true -Force

  if ($AllowedRoots.Count -gt 0) {
    $roots = @()
    foreach ($root in $AllowedRoots) {
      if ($root -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2})') {
        throw "Allowed root must be absolute: $root"
      }
      $roots += [System.IO.Path]::GetFullPath($root)
    }
    $config | Add-Member -NotePropertyName allowedRoots -NotePropertyValue @($roots) -Force
  }
  if (-not $config.allowedRoots -and -not $env:DSH_BRIDGE_ALLOWED_ROOTS) {
    throw "Set -AllowedRoots to your project directories before enabling writes."
  }

  $dataDir = Join-Path $env:LOCALAPPDATA "ChatGPT-DSH-Bridge"
  if (-not $config.writeAuthorizerKeyFile) {
    $config | Add-Member -NotePropertyName writeAuthorizerKeyFile -NotePropertyValue (Join-Path $dataDir "write-authorizer.key") -Force
  }
  if (-not $config.writeGrantFile) {
    $config | Add-Member -NotePropertyName writeGrantFile -NotePropertyValue (Join-Path $dataDir "write-grant.json") -Force
  }

  [System.IO.File]::WriteAllText($ConfigPath, ($config | ConvertTo-Json -Depth 20), $Utf8NoBom)

  $node = Resolve-Node
  & $node (Join-Path $scriptDir "ensure-write-key.mjs") --config $ConfigPath
  if ($LASTEXITCODE -ne 0) { throw "Authorizer key setup failed with exit code $LASTEXITCODE." }

  Write-Host ""
  Write-Host "workspace-write is enabled in config, but no workspace is approved yet." -ForegroundColor Green
  Write-Host "Approve the exact test workspace locally:"
  Write-Host "  Run approve-write.ps1 with this config and the absolute path of your project."
  Write-Host ""
  Write-Host "No token is used or printed. The grant is signed locally and expires automatically."
  exit 0
} catch {
  Write-Host "ENABLE-WRITE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
