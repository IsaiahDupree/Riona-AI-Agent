# Monitoring and Scheduling Guide

## Task Scheduler Configuration

### Setting Up the Schedule
1. Open PowerShell as Administrator
2. Navigate to the project directory:
   ```powershell
   cd "C:\Users\Isaia\OneDrive\Documents\Coding\Instagram agent\This is the folder your looking for\Riona-AI-Agent-main"
   ```
3. Run the scheduler setup:
   ```powershell
   powershell -ExecutionPolicy Bypass -File setup-scheduler.ps1
   ```

### Schedule Details
- Runs every 45 minutes
- Maximum runtime of 5 minutes per session
- Automatic retry on failure (up to 3 times)
- Only runs when user is logged in
- Uses elevated privileges for reliable operation

## Monitoring Tools

### 1. Task Scheduler Status
Check the scheduled task status:
```powershell
schtasks /query /tn "Instagram Bot" /fo list /v
```

This shows:
- Next Run Time
- Last Run Time
- Last Result (0 = success)
- Current Status
- Task Settings

### 2. Real-time Log Monitor
Monitor bot activity in real-time:
```powershell
.\monitor-logs.ps1
```

Features:
- Color-coded log levels:
  - 🟢 Green: Info messages
  - 🟡 Yellow: Warnings
  - 🔴 Red: Errors
- Live interaction statistics
- Performance metrics
- Error tracking

### Log File Locations
- Combined Logs: `logs/combined-YYYY-MM-DD.log`
- Error Logs: `logs/error-YYYY-MM-DD.log`
- Interaction Records: `logs/post_interactions.json`

## Authentication and Session Management

### Cookie Management
- Location: `cookies.json` in project root
- Auto-refreshed when expired
- Secure storage of session data

### Login Process
The bot automatically handles authentication:
1. Tries to use existing cookies
2. Validates cookie freshness
3. Performs fresh login if needed
4. Handles common dialogs:
   - Cookie consent
   - Save login info
   - Notifications

## Troubleshooting

### Common Issues and Solutions

1. Task Not Running
   ```powershell
   # Check task status
   schtasks /query /tn "Instagram Bot" /fo list /v
   
   # Force run the task
   schtasks /run /tn "Instagram Bot"
   ```

2. Login Issues
   - Verify credentials in `.env`
   - Delete `cookies.json` for fresh login
   - Check logs for error messages

3. Performance Issues
   ```powershell
   # View recent logs
   Get-Content ".\logs\combined-$(Get-Date -Format 'yyyy-MM-dd').log" -Tail 50
   ```

### Error Recovery
The bot includes automatic recovery mechanisms:
- Session timeout handling
- Network error retry logic
- Rate limiting protection
- Graceful shutdown on errors

## Maintenance Tasks

### Daily Checks
1. Monitor task scheduler status
2. Review error logs
3. Check interaction success rates

### Weekly Tasks
1. Review performance metrics
2. Clean old log files
3. Verify cookie validity

### Monthly Tasks
1. Update dependencies
2. Review scheduling settings
3. Backup important data

## Security Considerations

### Credential Management
- Credentials stored in `.env`
- Cookies stored locally
- No plaintext passwords in logs

### Access Control
- Task runs with user privileges
- Requires admin for setup only
- Secure cookie storage

## Performance Monitoring

### Key Metrics
1. Interaction Success Rate
   - Like success percentage
   - Comment success percentage
   - Overall engagement rate

2. Runtime Statistics
   - Average session duration
   - Time between actions
   - Error frequency

3. Resource Usage
   - CPU utilization
   - Memory consumption
   - Network activity

### Monitoring Commands Quick Reference

```powershell
# Task Status
schtasks /query /tn "Instagram Bot" /fo list /v

# Live Monitoring
.\monitor-logs.ps1

# Recent Errors
Get-Content ".\logs\error-$(Get-Date -Format 'yyyy-MM-dd').log" -Tail 20

# Interaction Stats
Get-Content ".\logs\post_interactions.json" | ConvertFrom-Json | Measure-Object

# Force Run Task
schtasks /run /tn "Instagram Bot"

# Stop Task
schtasks /end /tn "Instagram Bot"
```
