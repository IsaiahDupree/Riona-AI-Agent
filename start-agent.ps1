# Instagram Agent Startup Script

# Set error action preference to stop on any error
$ErrorActionPreference = "Stop"

# Function to check if a command exists
function Test-Command($CommandName) {
    return $null -ne (Get-Command $CommandName -ErrorAction SilentlyContinue)
}

# Function to write log messages
function Write-Log($Message) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Write-Host "[$timestamp] $Message"
    Add-Content -Path "agent-startup.log" -Value "[$timestamp] $Message"
}

# Check if Node.js is installed
if (-not (Test-Command "node")) {
    Write-Log "Error: Node.js is not installed. Please install Node.js first."
    exit 1
}

# Check if PM2 is installed
if (-not (Test-Command "pm2")) {
    Write-Log "PM2 is not installed. Installing PM2 globally..."
    npm install -g pm2
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Error: Failed to install PM2."
        exit 1
    }
}

# Navigate to the application directory
try {
    $scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
    Set-Location $scriptPath
    Write-Log "Changed directory to: $scriptPath"
} catch {
    Write-Log "Error: Failed to change directory. $_"
    exit 1
}

# Install dependencies if node_modules doesn't exist
if (-not (Test-Path "node_modules")) {
    Write-Log "Installing dependencies..."
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Log "Error: Failed to install dependencies."
        exit 1
    }
}

# Compile TypeScript
Write-Log "Compiling TypeScript..."
tsc
if ($LASTEXITCODE -ne 0) {
    Write-Log "Error: TypeScript compilation failed."
    exit 1
}

# Check if the process is already running
$running = pm2 list | Select-String "instagram-scheduler"
if ($running) {
    Write-Log "Instagram agent is already running. Restarting..."
    pm2 restart instagram-scheduler
} else {
    Write-Log "Starting Instagram agent..."
    pm2 start ecosystem.config.js
}

if ($LASTEXITCODE -ne 0) {
    Write-Log "Error: Failed to start/restart the Instagram agent."
    exit 1
}

# Save PM2 process list
Write-Log "Saving PM2 process list..."
pm2 save

# Setup PM2 to start on boot (if not already done)
$startup = pm2 startup | Select-String "already setup"
if (-not $startup) {
    Write-Log "Setting up PM2 startup..."
    pm2 startup
}

Write-Log "Instagram agent startup completed successfully!"
