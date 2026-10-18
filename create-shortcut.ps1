# Script to create a desktop shortcut for Instagram Bot scheduler

# Check if running as admin, if not, restart with admin rights
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Warning "You need to run this script as Administrator. Restarting with elevated permissions..."
    Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    Exit
}

# Get the current directory where the bot is located
$botPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$setupScriptPath = Join-Path $botPath "setup-scheduler.ps1"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "Instagram Bot Scheduler.lnk"

# Create the shortcut
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-ExecutionPolicy Bypass -Command `"Start-Process powershell -ArgumentList '-ExecutionPolicy Bypass -File \`"$setupScriptPath\`"' -Verb RunAs`""
$Shortcut.IconLocation = "shell32.dll,76" # Instagram-like icon from Windows shell
$Shortcut.Description = "Set up and run the Instagram Bot scheduler with admin privileges"
$Shortcut.WorkingDirectory = $botPath
$Shortcut.Save()

# Create a README shortcut explanation file
$readmePath = Join-Path $botPath "SHORTCUT_INSTRUCTIONS.txt"
$readmeContent = @"
INSTAGRAM BOT SCHEDULER - INSTRUCTIONS

The desktop shortcut "Instagram Bot Scheduler" will:
1. Run with administrator privileges (required for scheduling tasks)
2. Set up the Instagram bot to run every 45 minutes
3. Start the first run immediately

IMPORTANT NOTES:
- The bot will continue to run in the background according to the schedule
- Each run is limited to 5 minutes maximum to prevent Instagram rate limits
- You can check the status anytime by running: schtasks /query /tn "Instagram Bot" /fo list
- To stop the scheduled task, run: schtasks /end /tn "Instagram Bot"
- To remove the scheduled task, run: schtasks /delete /tn "Instagram Bot" /f

If you want to modify the schedule, edit the setup-scheduler.ps1 file and run the shortcut again.
"@

Set-Content -Path $readmePath -Value $readmeContent

# Display success message
Write-Host "Shortcut created successfully on your desktop: 'Instagram Bot Scheduler'" -ForegroundColor Green
Write-Host "Instructions file created: $readmePath" -ForegroundColor Cyan
Write-Host "`nClick the shortcut to start the Instagram bot scheduler with admin privileges." -ForegroundColor Yellow
