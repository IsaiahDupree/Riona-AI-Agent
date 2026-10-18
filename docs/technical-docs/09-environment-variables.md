# Environment Variables

Configuration is managed via a root `.env` file. You can also override any value for a single run using PowerShell environment variables.

## Core Variables

- `INSTAGRAM_BOT_USERNAME` (string)
- `INSTAGRAM_BOT_PASSWORD` (string)
- `INSTAGRAM_PROXY_HOST` (string, optional)
- `INSTAGRAM_PROXY_PORT` (number/string, optional)
- `INSTAGRAM_USE_PROXY` ("true" | "false")
- `INSTAGRAM_MAX_RETRIES` (number, default 3)
- `INSTAGRAM_TIMEOUT_MS` (number, default 30000)
  - Used for login page rendering and waits; can be set to `600000` (10 min) for slow networks or manual login steps.
- `INSTAGRAM_NETWORK_IDLE_TIME` (number, optional)
- `OPENAI_API_KEY` (string)
- `MONGODB_URI` (string)
- `PROXY_ENABLED`, `PROXY_HOST`, `PROXY_PORT` (optional proxy toggles)
- `WEB_SERVER_ENABLED`, `PORT` (if you enable the optional web server)

## Single-Run Overrides (PowerShell)

```powershell
# Example: extend login timeout to 10 minutes for this session only
$env:INSTAGRAM_TIMEOUT_MS = "600000"

# Then start the app
npm start
# or
.\start-instagram-bot.bat
# or
npx ts-node src/index.ts
```

## Best Practices

- Do not commit real secrets to version control.
- Avoid trailing spaces in secrets. A trailing space in `INSTAGRAM_BOT_PASSWORD` will cause login failures.
- Prefer per-run overrides for experimentation, keep `.env` conservative for production.
