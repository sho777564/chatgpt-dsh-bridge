<#
.SYNOPSIS
  Install the ChatGPT-DSH Bridge into the current user's personal ChatGPT/Codex
  plugin marketplace. It never writes to ~/.dsh and never overwrites DSH files.

.DESCRIPTION
  - Installs production Node dependencies.
  - Copies the plugin to %USERPROFILE%\.codex\plugins\chatgpt-dsh-bridge.
  - Writes bridge.config.json with the detected DSH CLI path.
  - Registers a personal marketplace at %USERPROFILE%\.agents\plugins\marketplace.json.
  - Runs a no-model MCP health smoke test by default.

.PARAMETER EnableWriteMode
  Enable workspace-write in the installed config and create the local HMAC
  authorizer key. A separate local approval (approve-write.ps1) is still
  required for each workspace. Read-only remains the default for every task.

.PARAMETER AllowedRoots
  Optional absolute directories that tasks must stay inside. Recommended:
  -AllowedRoots "G:\projects","G:\work".
#>
#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $HOME ".codex\plugins\chatgpt-dsh-bridge"),
  [string]$MarketplaceName = "chatgpt-dsh-local",
  [string]$DshCliPath = "",
  [string[]]$AllowedRoots = @(),
  [switch]$EnableWriteMode,
  [switch]$SkipTests,
  [switch]$SkipVerify,
  [switch]$SkipNpmInstall
)

$ErrorActionPreference = "Stop"
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:PluginName = "chatgpt-dsh-bridge"
$script:MarketplacePath = Join-Path $HOME ".agents\plugins\marketplace.json"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
  Write-Host "    OK  $Message" -ForegroundColor Green
}

function Write-Warn([string]$Message) {
  Write-Host "    !!  $Message" -ForegroundColor Yellow
}

function Resolve-Node {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command node -ErrorAction SilentlyContinue }
  if (-not $command) {
    throw "Node.js was not found on PATH. Install Node.js 20+ and reopen the terminal."
  }
  return $command.Source
}

function Resolve-Npm {
  $command = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $command) { $command = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $command) { throw "npm was not found on PATH." }
  return $command.Source
}

function Find-DshCli {
  param([string]$ExplicitPath)

  $candidates = New-Object System.Collections.Generic.List[string]
  foreach ($candidate in @($ExplicitPath, $env:DSH_BRIDGE_DSH_CLI, $env:DSH_CLI_PATH, $env:DSH_CLI)) {
    if (-not [string]::IsNullOrWhiteSpace($candidate)) { $candidates.Add($candidate) }
  }

  $running = Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($running -and $running.Path) {
    $appRoot = Split-Path -Parent $running.Path
    $candidates.Add((Join-Path $appRoot "resources\runtime\cli\bin\dsh.cmd"))
  }

  $localAppData = $env:LOCALAPPDATA
  if (-not $localAppData) { $localAppData = Join-Path $HOME "AppData\Local" }
  $candidates.Add((Join-Path $localAppData "Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"))
  $candidates.Add((Join-Path $env:ProgramFiles "DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"))
  if (${env:ProgramFiles(x86)}) {
    $candidates.Add((Join-Path ${env:ProgramFiles(x86)} "DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"))
  }

  $registryRoots = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($root in $registryRoots) {
    try {
      Get-ItemProperty $root -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like "*DeepSeek Harness*" -and $_.InstallLocation } |
        ForEach-Object {
          $candidates.Add((Join-Path $_.InstallLocation "resources\runtime\cli\bin\dsh.cmd"))
        }
    } catch { }
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  throw "DeepSeek Harness CLI (dsh.cmd) was not found. Pass -DshCliPath '...\resources\runtime\cli\bin\dsh.cmd'."
}

function Assert-InstallTarget {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  $allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $HOME ".codex\plugins")) + [System.IO.Path]::DirectorySeparatorChar
  $parent = Split-Path -Parent $full
  if (-not [string]::Equals(($parent + [System.IO.Path]::DirectorySeparatorChar), $allowedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "InstallDir must be a direct child of $allowedRoot (got $full)."
  }
  foreach ($candidate in @($full, $parent, (Split-Path -Parent $parent))) {
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Refusing to install through a symlink or junction: $candidate"
    }
  }
  if (Test-Path -LiteralPath $full) {
    $manifestPath = Join-Path $full "plugin.json"
    if (Test-Path -LiteralPath $manifestPath) {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($manifest.name -ne $script:PluginName) {
        throw "Refusing to overwrite $full because its plugin.json name is '$($manifest.name)', not '$($script:PluginName)'."
      }
    } else {
      $items = @(Get-ChildItem -LiteralPath $full -Force -ErrorAction SilentlyContinue)
      if ($items.Count -gt 0) {
        throw "Refusing to overwrite non-empty directory without a matching plugin.json: $full"
      }
    }
  }
  return $full
}

try {
  Write-Host "ChatGPT-DSH Bridge installer" -ForegroundColor White
  Write-Host "Project: $script:ProjectRoot"

  if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "This installer targets Windows 11."
  }

  Write-Step "Checking Node.js and project files"
  $nodePath = Resolve-Node
  $npmPath = Resolve-Npm
  $nodeVersion = (& $nodePath --version).Trim()
  $nodeMajor = [int](($nodeVersion.TrimStart("v").Split(".")[0]))
  if ($nodeMajor -lt 20) { throw "Node.js 20+ is required; found $nodeVersion." }
  Write-Ok "Node $nodeVersion at $nodePath"
  foreach ($required in @("package.json", "plugin.json", "mcp.json", "server\index.js")) {
    if (-not (Test-Path -LiteralPath (Join-Path $script:ProjectRoot $required))) {
      throw "Project file missing: $required"
    }
  }

  Write-Step "Detecting DeepSeek Harness"
  $dshCli = Find-DshCli -ExplicitPath $DshCliPath
  Write-Ok "DSH CLI: $dshCli"

  if (-not $SkipNpmInstall) {
    Write-Step "Installing production dependencies"
    Push-Location $script:ProjectRoot
    try {
      & $npmPath ci --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    } finally {
      Pop-Location
    }
    Write-Ok "Dependencies installed"
  } elseif (-not (Test-Path -LiteralPath (Join-Path $script:ProjectRoot "node_modules\@modelcontextprotocol\sdk"))) {
    throw "node_modules is missing and -SkipNpmInstall was specified."
  }

  if (-not $SkipTests) {
    Write-Step "Running unit tests"
    Push-Location $script:ProjectRoot
    try {
      & $npmPath run test:unit
      if ($LASTEXITCODE -ne 0) { throw "Unit tests failed with exit code $LASTEXITCODE." }
    } finally {
      Pop-Location
    }
    Write-Ok "Unit tests passed"
  }

  Write-Step "Preparing personal plugin directory"
  $target = Assert-InstallTarget -Path $InstallDir
  $pluginDirName = Split-Path -Leaf $target
  $oldConfig = $null
  $oldConfigPath = Join-Path $target "bridge.config.json"
  if (Test-Path -LiteralPath $oldConfigPath) {
    $oldConfig = Get-Content -LiteralPath $oldConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  $stage = Join-Path (Split-Path -Parent $target) (".dsh-bridge-stage-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  $copyItems = @(
    "assets", "server", "skills", "scripts", "docs",
    ".codex-plugin",
    "plugin.json", "mcp.json", ".mcp.json",
    "package.json", "package-lock.json",
    "README.md", "README.en.md", "LICENSE",
    "bridge.config.example.json"
  )
  foreach ($item in $copyItems) {
    $source = Join-Path $script:ProjectRoot $item
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination $stage -Recurse -Force
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $script:ProjectRoot "node_modules"))) {
    throw "node_modules is missing; dependencies must be installed before copying."
  }
  Copy-Item -LiteralPath (Join-Path $script:ProjectRoot "node_modules") -Destination $stage -Recurse -Force

  Write-Step "Writing bridge configuration"
  $resolvedRoots = @()
  if ($AllowedRoots -and $AllowedRoots.Count -gt 0) {
    foreach ($root in $AllowedRoots) {
      if ($root -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2})') { throw "Allowed root must be absolute: $root" }
      $resolvedRoots += [System.IO.Path]::GetFullPath($root)
    }
  } elseif ($oldConfig -and $oldConfig.allowedRoots) {
    $resolvedRoots = @($oldConfig.allowedRoots)
  }

  $dataDir = Join-Path $env:LOCALAPPDATA "ChatGPT-DSH-Bridge"
  $keyFile = Join-Path $dataDir "write-authorizer.key"
  $grantFile = Join-Path $dataDir "write-grant.json"
  $enableWrites = [bool]$EnableWriteMode
  if (-not $enableWrites -and $oldConfig -and $oldConfig.writeModeEnabled -eq $true) {
    $enableWrites = $true
  }

  if ($enableWrites -and $resolvedRoots.Count -eq 0) {
    throw "Workspace-write requires at least one -AllowedRoots directory."
  }
  if ($enableWrites) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    Write-Ok "Workspace-write will be enabled with a local signed write grant (no token)"
  } else {
    Write-Ok "Workspace-write disabled (read-only only)"
  }

  $config = [ordered]@{
    dshCliPath = $dshCli
    dshProfile = "headless"
    dshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" })
    allowedRoots = @($resolvedRoots)
    maxTasks = 20
    maxConcurrentTasks = 2
    maxTaskChars = 12000
    maxLogBytes = 1000000
    maxResultChars = 12000
    defaultTimeoutSeconds = 600
    maxTimeoutSeconds = 1800
    writeModeEnabled = $enableWrites
    writeAuthorizerKeyFile = $keyFile
    writeGrantFile = $grantFile
    runtimeStatusFile = (Join-Path $dataDir "runtime-status.json")
  }
  if ($oldConfig) {
    foreach ($property in $oldConfig.PSObject.Properties) {
      if ($property.Name -notin @("dshCliPath", "allowedRoots", "writeModeEnabled", "writeTokenFile")) {
        $config[$property.Name] = $property.Value
      }
    }
  }
  $configJson = $config | ConvertTo-Json -Depth 10
  $installedConfigPath = Join-Path $target "bridge.config.json"
  $stagedConfigPath = Join-Path $stage "bridge.config.json"
  [System.IO.File]::WriteAllText($stagedConfigPath, $configJson, $script:Utf8NoBom)

  if ($enableWrites) {
    & $nodePath (Join-Path $stage "scripts\ensure-write-key.mjs") --config $stagedConfigPath
    if ($LASTEXITCODE -ne 0) { throw "Authorizer key setup failed with exit code $LASTEXITCODE." }
    Write-Ok "Local write authorizer key ready"
  }

  Write-Step "Pinning the Node executable in installed MCP manifests"
  foreach ($manifestName in @("mcp.json", ".mcp.json")) {
    $manifestPath = Join-Path $stage $manifestName
    if (Test-Path -LiteralPath $manifestPath) {
      $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $manifest.mcpServers.dsh_bridge.command = $nodePath
      [System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 20), $script:Utf8NoBom)
    }
  }
  Write-Ok "MCP command: $nodePath"

  if (-not $SkipVerify) {
    Write-Step "Verifying staged MCP server (no model call)"
    $previousConfig = $env:DSH_BRIDGE_CONFIG
    $previousStatus = $env:DSH_BRIDGE_RUNTIME_STATUS_FILE
    try {
      $env:DSH_BRIDGE_CONFIG = $stagedConfigPath
      $env:DSH_BRIDGE_RUNTIME_STATUS_FILE = Join-Path $stage ".bridge-install-check.json"
      & $nodePath (Join-Path $stage "scripts\mcp-smoke.mjs")
      if ($LASTEXITCODE -ne 0) { throw "Staged MCP verification failed with exit code $LASTEXITCODE." }
    } finally {
      $env:DSH_BRIDGE_CONFIG = $previousConfig
      $env:DSH_BRIDGE_RUNTIME_STATUS_FILE = $previousStatus
      $checkFile = Join-Path $stage ".bridge-install-check.json"
      if (Test-Path -LiteralPath $checkFile) { Remove-Item -LiteralPath $checkFile -Force }
    }
  }

  $installBackup = $null
  if (Test-Path -LiteralPath $target) {
    $installBackup = "$target.bak-$([guid]::NewGuid().ToString('N'))"
    Move-Item -LiteralPath $target -Destination $installBackup
    Write-Ok "Previous plugin preserved at $installBackup"
  }
  try {
    Move-Item -LiteralPath $stage -Destination $target
  } catch {
    if ($installBackup -and -not (Test-Path -LiteralPath $target)) {
      Move-Item -LiteralPath $installBackup -Destination $target
    }
    throw
  }

  Write-Step "Registering personal plugin marketplace"
  $marketplaceDir = Split-Path -Parent $script:MarketplacePath
  New-Item -ItemType Directory -Path $marketplaceDir -Force | Out-Null
  $marketplace = $null
  if (Test-Path -LiteralPath $script:MarketplacePath) {
    $backup = "$($script:MarketplacePath).bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $script:MarketplacePath -Destination $backup -Force
    $marketplace = Get-Content -LiteralPath $script:MarketplacePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $marketplace.name) { $marketplace | Add-Member -NotePropertyName name -NotePropertyValue $MarketplaceName }
    if (-not $marketplace.interface) {
      $marketplace | Add-Member -NotePropertyName interface -NotePropertyValue ([pscustomobject]@{ displayName = "ChatGPT-DSH Local" })
    }
    Write-Ok "Backed up existing marketplace to $backup"
  } else {
    $marketplace = [pscustomobject]@{
      name = $MarketplaceName
      interface = [pscustomobject]@{ displayName = "ChatGPT-DSH Local" }
      plugins = @()
    }
  }

  $entry = [pscustomobject]@{
    name = $script:PluginName
    source = [pscustomobject]@{
      source = "local"
      path = "./.codex/plugins/$pluginDirName"
    }
    policy = [pscustomobject]@{
      installation = "AVAILABLE"
      authentication = "ON_INSTALL"
    }
    category = "Developer Tools"
  }

  $plugins = @()
  if ($marketplace.plugins) {
    $plugins = @($marketplace.plugins | Where-Object { $_.name -ne $script:PluginName })
  }
  $plugins += $entry
  $marketplace.plugins = @($plugins)
  $marketplace | Add-Member -NotePropertyName plugins -NotePropertyValue @($plugins) -Force
  [System.IO.File]::WriteAllText($script:MarketplacePath, ($marketplace | ConvertTo-Json -Depth 20), $script:Utf8NoBom)
  Write-Ok "Marketplace: $script:MarketplacePath"
  Write-Ok "Marketplace name: $($marketplace.name)"
  Write-Ok "Plugin source: $target"

  Write-Host ""
  Write-Host "Installation complete." -ForegroundColor Green
  Write-Host ""
  Write-Host "Next steps:"
  Write-Host "  1. Fully quit ChatGPT (including the tray icon) and reopen it."
  Write-Host "  2. Open Plugins -> Personal -> ChatGPT-DSH Local, install/enable the plugin."
  Write-Host "  3. Start a Work (Local) or Codex thread, type @ and select ChatGPT-DSH Bridge."
  Write-Host "  4. Ask: 'Call dsh_health_check and report the DSH version.'"
  Write-Host ""
  Write-Host "Important: ordinary ChatGPT Chat may list the plugin but not expose local MCP tools."
  Write-Host "See docs\COMPATIBILITY.md before treating the ChatGPT side as verified."
  Write-Host ""
  if ($enableWrites) {
    Write-Host "Write mode is ENABLED. If no workspace grant is currently active, approve the test workspace locally (no token is sent to ChatGPT):"
    Write-Host "  Run scripts\approve-write.ps1 with the installed config and the exact path of your project."
    Write-Host "Permanent approval is interactive only; it cannot be combined with -Yes."
  } else {
    Write-Host "Write mode is DISABLED. Read-only tasks require a project directory in allowedRoots."
  }
  Write-Host ""
  exit 0
} catch {
  Write-Host ""
  Write-Host "INSTALL FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray
  exit 1
}
