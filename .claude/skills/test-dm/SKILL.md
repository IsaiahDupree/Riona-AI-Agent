---
name: test-dm
description: Send test DMs on Instagram and/or Twitter. Builds, picks targets, sends 1 DM per platform, and reports results.
argument-hint: "[twitter|instagram|both] — defaults to both"
---

# Test DM Sending

Platform: $ARGUMENTS (default: both)

Send 1 test DM on the specified platform(s) to verify the DM pipeline is working end-to-end.

## Steps

1. **Build** the project: `npm run build`
2. **Run** the test script: `node test-dm-single.js`
   - This sends 1 DM on Twitter and 1 on Instagram
   - Uses today's replied/commented users as targets (new people)
   - Falls back to known contacts if no new targets
   - Skips users on 48h cooldown
   - Tries up to 5 candidates per platform until one accepts DMs

3. If the user only wants one platform, create an inline test:
   - **Twitter only**: Run just the Twitter portion via `node -e` with `TwitterDM` + `TwitterDMPipeline`
   - **Instagram only**: Run just the Instagram portion via `node -e` with `InstagramDM` + `DMPipeline`

4. **Report results**:
   - Who received the DM (username)
   - Message preview (first 80 chars)
   - Whether it was verified (appeared in thread)
   - Any failures and why (DMs closed, cooldown, etc.)

## Key files
- `test-dm-single.js` — Main test script (both platforms)
- `src/client/Twitter-DM.ts` — Twitter DM automation
- `src/client/Twitter-DM-Pipeline.ts` — Twitter DM pipeline
- `src/client/Instagram-DM.ts` — Instagram DM automation
- `src/client/Instagram-DM-Pipeline.ts` — Instagram DM pipeline

## Troubleshooting
- If Twitter DMs fail with "no DM button on profile" — the target has DMs closed, try another user
- If Instagram says "all on cooldown" — wait 48h or clear `logs/tracking/dm/messages.json`
- If browser errors — check chrome-profile directory exists and session is logged in
