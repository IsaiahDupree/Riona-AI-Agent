# Get the current directory
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$batchPath = Join-Path $scriptPath "start-instagram-bot.bat"

# Create the action to run our batch file
$Action = New-ScheduledTaskAction -Execute $batchPath -WorkingDirectory $scriptPath

# Run every 45 minutes
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 45)

# Run with highest privileges when user is logged on
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

# Stop the task if it runs longer than 5 minutes
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable

# Remove existing task if it exists
Unregister-ScheduledTask -TaskName "Instagram Bot" -Confirm:$false -ErrorAction SilentlyContinue

# Create the new task
Register-ScheduledTask `
    -TaskName "Instagram Bot" `
    -Action $Action `
    -Trigger $Trigger `
    -Principal $Principal `
    -Settings $Settings `
    -Description "Runs Instagram bot every 45 minutes for 5 minutes"

Write-Host "Task scheduled successfully. Running initial test..."

# Run the task immediately for testing
Start-ScheduledTask -TaskName "Instagram Bot"
