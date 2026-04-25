# term-hub one-shot installer for Windows.
#
# Clones the repo, installs deps, and drops a Windows Terminal fragment that
# adds a "Hub Shell" profile (no edits to your main settings.json).
#
# Usage:
#   iwr -useb https://raw.githubusercontent.com/quake0day/term-hub/main/scripts/install-windows.ps1 -OutFile install-windows.ps1
#   .\install-windows.ps1                                      # defaults to http://termhub.local:7777
#   .\install-windows.ps1 -BrokerUrl http://192.168.1.10:7777  # explicit URL
#
# Prereqs: Node.js LTS, Git for Windows. Install via:
#   winget install OpenJS.NodeJS.LTS
#   winget install Git.Git
#
# After running: restart Windows Terminal, then Settings -> Startup ->
# Default profile -> "Hub Shell" so every new tab registers with the hub.

[CmdletBinding()]
param(
    [string]$BrokerUrl  = "http://termhub.local:7777",
    [string]$InstallDir = (Join-Path $env:USERPROFILE "term-hub"),
    [string]$RepoUrl    = "https://github.com/quake0day/term-hub.git"
)

$ErrorActionPreference = "Stop"

function Need($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

if (-not (Need node)) {
    throw "node not found. Install Node.js LTS first: winget install OpenJS.NodeJS.LTS (then reopen PowerShell)."
}
if (-not (Need git))  {
    throw "git not found. Install Git for Windows first: winget install Git.Git (then reopen PowerShell)."
}

# --- 1. Clone or update the repo ----------------------------------------------
if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Host "Updating $InstallDir" -ForegroundColor Cyan
    git -C $InstallDir pull --ff-only
} elseif (Test-Path $InstallDir) {
    throw "$InstallDir exists and is not a git checkout. Move it aside or pass -InstallDir <path>."
} else {
    Write-Host "Cloning into $InstallDir" -ForegroundColor Cyan
    git clone $RepoUrl $InstallDir
}

# --- 2. npm install -----------------------------------------------------------
Push-Location $InstallDir
try {
    Write-Host "Running npm install" -ForegroundColor Cyan
    npm install
} finally {
    Pop-Location
}

# --- 3. Drop a Windows Terminal fragment --------------------------------------
# Fragments live under %LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\<app>\
# and are merged into Windows Terminal at startup. This avoids touching the
# user's main settings.json. See:
#   https://learn.microsoft.com/windows/terminal/json-fragment-extensions
$fragDir  = Join-Path $env:LOCALAPPDATA "Microsoft\Windows Terminal\Fragments\term-hub"
$fragFile = Join-Path $fragDir "term-hub.json"
New-Item -ItemType Directory -Force -Path $fragDir | Out-Null

$nodeExe = (Get-Command node).Source
$agentJs = Join-Path $InstallDir "agent.js"
$cmdLine = '"{0}" "{1}" {2}' -f $nodeExe, $agentJs, $BrokerUrl

$fragment = [ordered]@{
    profiles = @(
        [ordered]@{
            guid              = "{6f3d5b2c-1c4f-4d27-9a3e-ab12cd34ef56}"
            name              = "Hub Shell"
            commandline       = $cmdLine
            startingDirectory = "%USERPROFILE%"
            hidden            = $false
        }
    )
}

$json = $fragment | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText(
    $fragFile,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
)

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Repo:     $InstallDir"
Write-Host "  Broker:   $BrokerUrl"
Write-Host "  Fragment: $fragFile"
Write-Host ""
Write-Host "Restart Windows Terminal. The 'Hub Shell' profile will appear in the"
Write-Host "dropdown. Set it as default in Settings -> Startup -> Default profile"
Write-Host "to register every new tab with the hub."
