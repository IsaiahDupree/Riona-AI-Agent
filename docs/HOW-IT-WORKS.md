# How It Works

This is the high-level guide to understanding the Riona Instagram bot. It connects the architectural overview with the scripts and operational details you need to run and maintain the system.

## Core Concepts

- The bot is a TypeScript app compiled to `build/` and run with Node.js.
- Main entrypoint: `build/index.js` (compiled from `src/index.ts`).
- The Instagram automation is implemented in `src/client/Instagram-AI.ts`.
- Sessions are persisted in `cookies.json` (project root).
- 24/7 operation is usually done with PM2 via `ecosystem.config.js`.

## Start Here

1. Read the architecture and features:
   - `docs/technical-docs/00-overview.md`
   - `docs/technical-docs/01-architecture.md`
   - `docs/technical-docs/02-features.md`

2. Understand runtime flow and entrypoints:
   - `docs/technical-docs/08-runtime-and-entrypoints.md`

3. Configure your environment:
   - `docs/technical-docs/09-environment-variables.md`

4. Manage cookies and login:
   - `docs/technical-docs/10-cookie-management.md`
   - `docs/technical-docs/11-troubleshooting-login.md`

5. Learn the scripts you can run:
   - `docs/technical-docs/12-scripts-and-commands.md`

6. Optional in-depth topics:
   - `docs/technical-docs/03-ai-integration.md`
   - `docs/technical-docs/04-browser-automation.md`
   - `docs/technical-docs/05-data-management.md`
   - `docs/technical-docs/06-logging-and-monitoring.md`
   - `docs/technical-docs/07-monitoring-and-scheduling.md`

## Typical Run Paths

- Development (visible browser):
  ```powershell
  npm run build
  npx ts-node src/index.ts
  ```

- Standard run:
  ```powershell
  npm start
  ```

- PM2 (24/7):
  ```bash
  pm2 start ecosystem.config.js
  pm2 logs instagram-scheduler
  ```

- Windows Task Scheduler (periodic):
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\setup-scheduler.ps1
  ```

## Troubleshooting Quicklinks

- Login issues: `docs/technical-docs/11-troubleshooting-login.md`
- Cookie refresh: `docs/technical-docs/10-cookie-management.md`
- Logs & monitoring: `docs/technical-docs/06-logging-and-monitoring.md`

## Security Notes

- Never commit real `.env` secrets.
- Back up `cookies.json` before replacing.
- Adjust `INSTAGRAM_TIMEOUT_MS` per run to avoid editing `.env` during experiments.
