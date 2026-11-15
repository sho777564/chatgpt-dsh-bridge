#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $HOME ".codex\plugins\chatgpt-dsh-bridge"),
  [switch]$RemoveWriteAuthorization,
  [switch]$RemoveWriteToken
)

$ErrorActionPreference = "Stop"
$PluginName = "chatgpt-dsh-bridge"
$MarketplacePath = Join-Path $HOME ".agents\plugins\marketplace.json"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "    !! $Message" -ForegroundColor Yellow }

try {
  $target = [System.IO.Path]::GetFullPath($InstallDir)
  $allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $HOME ".codex\plugins")) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $target.StartsWith($allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove a directory outside $allowedRoot"
  }

  if (Test-Path -LiteralPath $MarketplacePath) {
    Write-Step "Removing plugin entry from personal marketplace"
    $backup = "$MarketplacePath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $MarketplacePath -Destination $backup -Force
    $marketplace = Get-Content -LiteralPath $MarketplacePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($marketplace.plugins) {
      $remaining = @($marketplace.plugins | Where-Object { $_.name -ne $PluginName })
      $marketplace | Add-Member -NotePropertyName plugins -NotePropertyValue @($remaining) -Force
      [System.IO.File]::WriteAllText($MarketplacePath, ($marketplace | ConvertTo-Json -Depth 20), $Utf8NoBom)
      Write-Host "    Backup: $backup"
    }
  }

  if (Test-Path -LiteralPath $target) {
    $manifestPath = Join-Path $target "plugin.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
      throw "Refusing to remove ${target}: plugin.json is missing."
    }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.name -ne $PluginName) {
      throw "Refusing to remove ${target}: plugin name is '$($manifest.name)'."
    }
    Write-Step "Removing installed plugin"
    Remove-Item -LiteralPath $target -Recurse -Force
    Write-Host "    Removed $target"
  } else {
    Write-Warn "Plugin directory not found: $target"
  }

  if ($RemoveWriteAuthorization) {
    $dataDir = Join-Path $env:LOCALAPPDATA "ChatGPT-DSH-Bridge"
    foreach ($name in @("write-grant.json", "write-authorizer.key")) {
      $file = Join-Path $dataDir $name
      if (Test-Path -LiteralPath $file) {
        Remove-Item -LiteralPath $file -Force
        Write-Host "    Removed $file"
      }
    }
  }

  if ($RemoveWriteToken) {
    # Legacy cleanup only. This version never reads the old token.
    $tokenFile = Join-Path $env:LOCALAPPDATA "ChatGPT-DSH-Bridge\write-token"
    if (Test-Path -LiteralPath $tokenFile) {
      Remove-Item -LiteralPath $tokenFile -Force
      Write-Host "    Removed legacy token file $tokenFile"
    }
  }

  Write-Host ""
  Write-Host "Uninstall complete. ~/.dsh and all DSH profiles were not touched." -ForegroundColor Green
  Write-Host "Restart ChatGPT to refresh the plugin list."
  exit 0
} catch {
  Write-Host "UNINSTALL FAILED: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
