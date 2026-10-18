# Get today's date in the format used by log files
$date = Get-Date -Format "yyyy-MM-dd"
$logPath = ".\logs\combined-$date.log"
$errorLogPath = ".\logs\error-$date.log"
$interactionLogPath = ".\logs\post_interactions.json"

function Format-LogMessage {
    param (
        [string]$line
    )
    try {
        $json = $line | ConvertFrom-Json
        $timestamp = $json.timestamp
        $level = $json.level -replace '\u001b\[[0-9;]*m', '' # Remove ANSI color codes
        $message = $json.message -replace '\u001b\[[0-9;]*m', '' # Remove ANSI color codes
        
        # Color based on log level
        $color = switch ($level) {
            "error" { "Red" }
            "warn"  { "Yellow" }
            "info"  { "Green" }
            default { "White" }
        }
        
        Write-Host "[$timestamp]" -NoNewline
        Write-Host " [$level]" -NoNewline -ForegroundColor $color
        Write-Host " $message"
    } catch {
        Write-Host $line
    }
}

function Show-Stats {
    if (Test-Path $interactionLogPath) {
        $interactions = Get-Content $interactionLogPath | ConvertFrom-Json
        $totalInteractions = $interactions.Length
        $successfulLikes = ($interactions | Where-Object { $_.likeMethod -ne $null }).Length
        $successfulComments = ($interactions | Where-Object { $_.commentMethod -ne $null }).Length
        
        Write-Host "`n=== Statistics ===" -ForegroundColor Cyan
        Write-Host "Total Interactions: $totalInteractions"
        Write-Host "Successful Likes: $successfulLikes"
        Write-Host "Successful Comments: $successfulComments"
        Write-Host "================`n"
    }
}

Clear-Host
Write-Host "Starting log monitor..." -ForegroundColor Cyan
Write-Host "Watching files:" -ForegroundColor Cyan
Write-Host "- $logPath"
Write-Host "- $errorLogPath"
Write-Host "- $interactionLogPath`n"

# Initial statistics
Show-Stats

# Monitor both log files
Get-Content -Path $logPath -Wait | ForEach-Object {
    Format-LogMessage $_
    if ($_ -match "error" -or $_ -match "warn") {
        Show-Stats
    }
}
