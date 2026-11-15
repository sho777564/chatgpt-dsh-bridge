#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$ConfigPath = ""
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

try {
  $node = Resolve-Node
  & $node (Join-Path $scriptDir "revoke-write.mjs") --config $ConfigPath
  if ($LASTEXITCODE -ne 0) { throw "Revoke failed with exit code $LASTEXITCODE." }
  exit 0
} catch {
  Write-Host "REVOKE-WRITE FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
