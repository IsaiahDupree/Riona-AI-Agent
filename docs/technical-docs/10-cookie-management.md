# Cookie Management

The bot persists Instagram login cookies to maintain sessions across runs.

## Where Cookies Live

- Active cookies file: `cookies.json` (project root)
- Account-specific or archived cookies may exist in `cookies/` (e.g., `cookies/Instagram_the_isaiah_dupree__cookies.json`).
- The runtime (`Instagram-AI.ts`) only reads the root `cookies.json` during startup.

## How Cookies Are Loaded

- `src/client/Instagram-AI.ts`
  - `loadCookies()` reads `cookies.json`, calls `page.setCookie(...cookies)`, then verifies by opening Instagram home.
  - If a login form is detected, the cookies are considered invalid and `login()` is executed.
  - `login()` saves fresh cookies back to `cookies.json` after a successful sign-in.

## Expected Cookie JSON Format (Puppeteer)

Each cookie object should look like this (fields commonly used by Puppeteer):

```json
{
  "name": "sessionid",
  "value": "...",
  "domain": ".instagram.com",
  "path": "/",
  "expires": 1789259633.305855,
  "httpOnly": true,
  "secure": true,
  "session": false,
  "sameSite": "Lax" | "None" | "Strict"
}
```

Notes:
- If importing from a browser export that uses `expirationDate`, map it to `expires`.
- Normalize `sameSite`: `no_restriction` → `None`, `lax` → `Lax`, `strict` → `Strict`.

## Ways to Update Cookies

- Use the built-in login flow
  - Start the bot, complete any challenges; new cookies are saved automatically to `cookies.json`.

- Use the test script (`test-instagram`)
  - `npm run test-instagram`
  - This logs in and saves to `cookies/Instagramcookies.json`. You can then copy it over:
    ```powershell
    Copy-Item -Force ".\cookies\Instagramcookies.json" ".\cookies.json"
    ```

- Import cookies from an external JSON file
  - Ensure the format matches Puppeteer's expectations (see above).
  - Back up current cookies first:
    ```powershell
    Copy-Item ".\cookies.json" ".\cookies.backup.json"
    ```
  - Overwrite with your file (already normalized):
    ```powershell
    Copy-Item -Force "C:\path\to\instagram_cookies.json" ".\cookies.json"
    ```

## Validating Cookies

- Start the bot; if it does not show a login form and proceeds to home/feed, cookies are valid.
- Programmatically, `loadCookies()` checks for a login submit button; if present, it triggers `login()`.

## Tips

- Keep one canonical `cookies.json` at the project root; use the `cookies/` folder for archives and per-account stores.
- Back up before overwriting.
- If cookies frequently expire, consider longer `INSTAGRAM_TIMEOUT_MS` and ensure there are no typos in credentials.
