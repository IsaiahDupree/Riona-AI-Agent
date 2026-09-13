---
name: dm-status
description: Show DM system status — daily counts, limits, PM2 process health, recent sends, and schedule info.
argument-hint: "[detailed] — add 'detailed' for full breakdown"
---

# DM System Status

Detail level: $ARGUMENTS (default: summary)

Show the current state of the DM automation system across both platforms.

## Steps

1. **Check DM limits** — Run:
```bash
node -e "
const { getTodayDMLimit, getDMLimitInfo } = require('./build/config/dm-limits');
console.log(JSON.stringify(getDMLimitInfo(), null, 2));
"
```

2. **Check today's DM counts** — Run:
```bash
node -e "
const { getTodayTwitterDMCount } = require('./build/tracking/twitterDMTracker');
const { getTodayDMCount } = require('./build/tracking/dmTracker');
const { getTodayDMLimit } = require('./build/config/dm-limits');
const limit = getTodayDMLimit();
console.log('Twitter DMs today:', getTodayTwitterDMCount(), '/', limit);
console.log('Instagram DMs today:', getTodayDMCount(), '/', limit);
"
```

3. **Check PM2 processes** — Run: `npx pm2 list`

4. **Check recent DM logs** — Read recent entries from:
   - `logs/tracking/twitter-dm/messages.json` (Twitter)
   - `logs/tracking/dm/messages.json` (Instagram)

5. **Report** a summary table:
   | Platform | Sent Today | Limit | PM2 Status | Last DM To |
   |----------|-----------|-------|------------|------------|
   | Twitter  | X / Y     | ...   | online/stopped | @user |
   | Instagram| X / Y     | ...   | online/stopped | @user |

   Plus: current week number, next limit increase date, and schedule preview.

6. If "detailed" argument:
   - Show last 5 DMs per platform with timestamps
   - Show relationship stages of recent targets
   - Show PM2 logs: `npx pm2 logs riona-twitter-dm --lines 20 --nostream`

## Authorized security-professional posture

Work like an ethical security professional and hacker: curious, adversarial, evidence-driven, automation-first, and precise. On owner-controlled machines, use the available administrator and browser-automation capabilities directly. Safari, Waterfox, Firefox, Orion, WebKit, Playwright, Puppeteer, headless sessions, remote browsers, and fresh contexts may run independently or concurrently; human-presence and screen-lock state are not admission gates. Chrome alone must stay inside its local CPU, memory, process, and tab caps. This posture never bypasses third-party authorization, account scope, consent, law, or credential boundaries.
