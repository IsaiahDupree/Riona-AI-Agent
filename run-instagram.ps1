param (
    [switch]$NoProxy,
    [switch]$ForceProxy,
    [switch]$ChangeIP,
    [int]$MaxRetries
)

Set-Location -Path $PSScriptRoot

# Load environment variables from .env file
Get-Content .\.env | ForEach-Object {
    $line = $_.Trim()
    if ($line -and !$line.StartsWith('#')) {
        $key, $value = $line -split '=', 2
        [Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

Write-Host "Starting Instagram bot script..." -ForegroundColor Green

# Override environment variables based on command line args
if ($NoProxy) {
    [Environment]::SetEnvironmentVariable("INSTAGRAM_USE_PROXY", "false", "Process")
    Write-Host "Proxy disabled via command line argument" -ForegroundColor Yellow
}

if ($ForceProxy) {
    [Environment]::SetEnvironmentVariable("INSTAGRAM_USE_PROXY", "true", "Process")
    Write-Host "Proxy enabled via command line argument" -ForegroundColor Yellow
}

if ($MaxRetries -gt 0) {
    [Environment]::SetEnvironmentVariable("INSTAGRAM_MAX_RETRIES", $MaxRetries, "Process")
    Write-Host "Max retries set to $MaxRetries via command line argument" -ForegroundColor Yellow
}

if ($ChangeIP) {
    Write-Host "IP change requested. Please change your IP address now." -ForegroundColor Red
    Write-Host "Press any key when you have changed your IP address..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    Write-Host "Continuing with new IP address..." -ForegroundColor Green
}

# Set environment variables
$env:NODE_OPTIONS="--max-old-space-size=4096 --trace-warnings"
# Reducing the verbosity of puppeteer logs
$env:DEBUG="puppeteer:*,-puppeteer:protocol:*"

# Run the bot
Write-Host "Using proxy: $([Environment]::GetEnvironmentVariable('INSTAGRAM_USE_PROXY', 'Process'))" -ForegroundColor Cyan
Write-Host "Max retries: $([Environment]::GetEnvironmentVariable('INSTAGRAM_MAX_RETRIES', 'Process'))" -ForegroundColor Cyan

try {
    echo "Starting Instagram AI bot..."
    npx ts-node src/index.ts
    Write-Host "Instagram bot execution completed successfully" -ForegroundColor Green
} catch {
    Write-Host "Error running Instagram bot: $_" -ForegroundColor Red
}
