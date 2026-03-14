---
name: dm-limits
description: View or adjust DM daily limits. Shows the weekly auto-increment schedule and allows manual overrides.
argument-hint: "[set N | reset | show] — 'set 25' overrides to 25/day, 'reset' resumes auto-increment, 'show' displays schedule"
---

# DM Limits Management

Action: $ARGUMENTS (default: show)

Manage the weekly auto-incrementing DM limit system. Both platforms (Twitter + Instagram) share the same daily limit.

## Commands

### `show` (default)
Display current limit, week number, and full 10-week schedule:
```bash
node -e "
const { getDMLimitInfo } = require('./build/config/dm-limits');
const info = getDMLimitInfo();
console.log('Current daily limit:', info.todayLimit, 'DMs/day');
console.log('Week:', info.weekNumber, '(started', info.startDate + ')');
console.log('Next increase:', info.nextIncrease);
console.log('Schedule:');
info.schedule.forEach(s => console.log('  Week ' + s.week + ':', s.limit + '/day' + (s.week === info.weekNumber ? ' ← current' : '')));
"
```

### `set N`
Override the daily limit to a fixed number (bypasses auto-increment):
```bash
node -e "
const { setManualOverride, getTodayDMLimit } = require('./build/config/dm-limits');
setManualOverride(N);
console.log('Daily limit set to:', getTodayDMLimit());
"
```

### `reset`
Remove the manual override and resume weekly auto-increment:
```bash
node -e "
const { setManualOverride, getTodayDMLimit } = require('./build/config/dm-limits');
setManualOverride(null);
console.log('Auto-increment resumed. Today limit:', getTodayDMLimit());
"
```

## After changing limits
Restart PM2 DM processes to pick up the new limits:
```bash
npx pm2 restart riona-twitter-dm riona-dm-watcher && npx pm2 save
```

## Config file
Stored at: `logs/config/dm-limits.json`
