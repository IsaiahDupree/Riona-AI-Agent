# Scripts and Commands

This document lists the key scripts and commands to build, run, and monitor the bot.

## NPM Scripts (package.json)

- `npm start` → `tsc && node build/index.js`
- `npm run build` → `tsc`
- `npm run train-model` → `tsc && node build/Agent/training/Model.js`
- `npm run train:link` → `tsc && node build/Agent/training/WebsiteScraping.js`
- `npm run train:audio` → `tsc && node build/Agent/training/TrainWithAudio.js`
- `npm run scheduler` → `tsc && node build/scheduler.js`
- `npm run threads` → `tsc && node build/runThreads.js`
- `npm run test-instagram` → `tsc && node -e "require('./build/client/InstagramTest.js').runInstagramTest()"`

## Batch / PowerShell

- `start-instagram-bot.bat`
  - Installs dependencies (if missing), compiles TS, runs `npm start`.

- `run-instagram.ps1`
  - Loads `.env`, applies optional CLI toggles (e.g., `-NoProxy`), and runs `npx ts-node src/index.ts`.

- `start-agent.ps1`
  - Ensures `pm2` exists, compiles TS, and starts `ecosystem.config.js`.

- `setup-scheduler.ps1`
  - Registers Windows Task Scheduler job to run `start-instagram-bot.bat` every 45 minutes for 5 minutes.

## PM2 (24/7 Operation)

```bash
pm2 start ecosystem.config.js
pm2 logs instagram-scheduler
pm2 restart instagram-scheduler
pm2 stop instagram-scheduler
pm2 delete instagram-scheduler
pm2 save
pm2 startup
```

## Typical Workflows

- Development login with more time:
  ```powershell
  $env:INSTAGRAM_TIMEOUT_MS = "600000"
  npx ts-node src/index.ts
  ```

- Production-ish run:
  ```powershell
  npm start
  # or
  .\start-instagram-bot.bat
  ```

- Replace cookies after running the test script:
  ```powershell
  Copy-Item -Force ".\cookies\Instagramcookies.json" ".\cookies.json"
  ```

## Notes

- Avoid committing real `.env` to source control.
- Prefer per-run env overrides for experiments.
- Monitor logs in `logs/` and via PM2 commands above.
