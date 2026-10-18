# Logging and Monitoring Guide

## Log Types and Locations

The Instagram bot maintains several types of logs:

1. **Combined Logs** (`logs/combined-YYYY-MM-DD.log`):
   - All log levels (info, warn, error)
   - Includes detailed operation information
   - Daily rotation with date-based filenames
   - JSON format for structured logging

2. **Error Logs** (`logs/error-YYYY-MM-DD.log`):
   - Only error-level messages
   - Contains stack traces and detailed error information
   - Helpful for debugging issues

3. **Interaction Logs** (`logs/post_interactions.json`):
   - Records of all Instagram post interactions
   - Includes success/failure status
   - Tracks like and comment methods used
   - Contains post captions and timestamps

## Real-Time Monitoring

### Using the Monitor Script

1. Open PowerShell and navigate to the project directory
2. Run the monitoring script:
   ```powershell
   .\monitor-logs.ps1
   ```

The script provides:
- Real-time log updates with color coding
- Interaction statistics
- Automatic error highlighting
- JSON log formatting for readability

### Log Color Codes
- 🟢 Green: Info messages (normal operation)
- 🟡 Yellow: Warnings (potential issues)
- 🔴 Red: Errors (requires attention)

## Common Issues and Monitoring Points

### Critical Areas to Monitor

1. **Login Process**:
   - Cookie loading/saving
   - Credential authentication
   - Session maintenance

2. **Post Discovery**:
   - Article selector timeouts
   - Post content loading
   - Caption extraction issues

3. **Interaction Mechanisms**:
   - Like button detection
   - Comment box interaction
   - UI element selection

4. **Rate Limiting**:
   - Batch processing delays
   - Instagram throttling responses
   - Session timeouts

### Error Patterns to Watch

1. **Selector Issues**:
   ```
   Invalid selector error: 'div[role="button"]:has-text("more")'
   Article selector timeout: Waiting for 'article'
   ```

2. **Comment Validation**:
   ```
   Reference error: 'logger_1 is not defined'
   Comment selectors not finding any comments
   ```

3. **General Timeouts**:
   ```
   Post content waiting timeouts
   Selector compatibility issues
   ```

## Performance Metrics

The bot tracks several key metrics:

1. **Success Rates**:
   - Like success percentage
   - Comment success percentage
   - Overall interaction success

2. **Timing Metrics**:
   - Average interaction time
   - Wait times between actions
   - Session duration

3. **Error Metrics**:
   - Error frequency
   - Common error types
   - Recovery success rate

## Troubleshooting Guide

### Common Issues and Solutions

1. **Selector Timeouts**:
   - Check network connectivity
   - Verify Instagram's HTML structure hasn't changed
   - Adjust timeout values if needed

2. **Authentication Failures**:
   - Verify environment variables
   - Check cookie validity
   - Ensure account isn't locked/limited

3. **Rate Limiting**:
   - Monitor interaction frequency
   - Adjust delay times
   - Check for Instagram warnings

### Recovery Procedures

1. **Session Recovery**:
   - Bot automatically attempts to relogin
   - Cookies are refreshed if needed
   - Multiple retry attempts with increasing delays

2. **Error Recovery**:
   - Automatic retry for transient errors
   - Session restart for persistent issues
   - Graceful shutdown if unrecoverable

## Maintenance Tasks

### Daily Checks
1. Review error logs for patterns
2. Monitor interaction success rates
3. Verify scheduled task execution

### Weekly Tasks
1. Analyze performance metrics
2. Clean up old log files
3. Update selectors if needed

### Monthly Tasks
1. Review overall performance
2. Update documentation
3. Adjust scheduling if needed
