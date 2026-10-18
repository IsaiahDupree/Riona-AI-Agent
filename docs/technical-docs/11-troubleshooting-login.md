# Troubleshooting Login

Common issues and fixes when logging into Instagram with Puppeteer.

## Symptoms

- `Waiting for selector 'input[name="username"]' failed: Waiting failed: 30000ms exceeded`
- Browser opens but the login form never appears
- Cookies are loaded but Instagram still asks for login
- 2FA or challenge prompts block progress

## Quick Fixes

- Increase timeout for a single run:
  ```powershell
  $env:INSTAGRAM_TIMEOUT_MS = "600000"  # 10 minutes
  npm start
  ```
- Remove trailing spaces in `.env` values (especially `INSTAGRAM_BOT_PASSWORD`).
- Ensure network / proxy is reachable; try `INSTAGRAM_USE_PROXY=false`.

## Step-by-Step Diagnosis

1. Run a minimal debug
   - `node debug-instagram.js`
   - Confirms browser can reach instagram.com and saves a screenshot.

2. Run the focused login test
   - `node test-login.js`
   - Tries multiple selectors and human-like interactions; saves screenshots on success/failure.

3. Check selectors and consent banners
   - Cookie/consent banners may hide the form; the code tries to click them, but timing may vary.
   - With longer `INSTAGRAM_TIMEOUT_MS`, you get more time to resolve dialogs.

4. Validate credentials and region
   - Wrong password or a trailing whitespace causes silent failures.
   - Some regions/IPs receive more aggressive challenges; try changing IP or disabling proxy.

5. 2FA / Checkpoint
   - Complete the flow manually in the visible browser window.
   - On success, cookies will be saved to `cookies.json` for future runs.

## When Cookies Keep Failing

- Delete `cookies.json` (or back it up) and perform a fresh login.
- Reduce headless randomization (we already run `headless: false`).
- Slow down: increase `INSTAGRAM_TIMEOUT_MS` and allow the site to settle.

## Useful Commands

```powershell
# One-off longer timeout for login
$env:INSTAGRAM_TIMEOUT_MS = "600000"; npm start

# Run the batch used by the scheduler
.\start-instagram-bot.bat

# Copy cookies after test script
Copy-Item -Force ".\cookies\Instagramcookies.json" ".\cookies.json"
```
