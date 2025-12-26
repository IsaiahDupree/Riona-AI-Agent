# Riona Quick Start

This guide shows how to run the basic server, full API (with MongoDB), and the frontend. All commands are for Windows PowerShell.

## 1) Basic Server (port 3847)
Runs the minimal health/status server defined in `src/basic-index.ts` and `src/server/basic-app.ts`.

```powershell
npm run dev
```

- Health: http://localhost:3847/health
- API status: http://localhost:3847/api/status

## 2) Full API Server (Express, port 3849)
Starts the full Express API (`/api/hitl`, `/api/trace`) defined in `src/server/app.ts` with MongoDB.

```powershell
npm run dev:api
```

Notes:
- Uses `MONGODB_URI` from `.env`.
- Defaults to port 3849. To force the port explicitly:

```powershell
$env:PORT=3849; npm run dev:api
```

Quick API checks:
- HITL: http://localhost:3849/api/hitl/interactions
- HITL: http://localhost:3849/api/hitl/accounts
- HITL: http://localhost:3849/api/hitl/styles
- Trace: http://localhost:3849/api/trace/recent

## 3) Frontend (Vite, port 3001)
Starts the HITL console UI in `frontend/` with a proxy to the API on port 3849.

```powershell
cd frontend
npm run dev
```

Open the UI: http://localhost:3001

Proxy (`frontend/vite.config.ts`):
- `/api` -> `http://localhost:3849`

## Optional: Verify Database Connectivity
Build and run the DB test script:

```powershell
npm run build
node build/db-test.js
```

If it fails, check:
- Your MongoDB Atlas IP allowlist contains your current IP.
- `MONGODB_URI` in `.env` is correct.

## Troubleshooting
- EADDRINUSE (port in use):
  - The basic server uses port 3847.
  - The full API should use 3849. If you still see conflicts:
    - Stop conflicting processes (Ctrl+C) or set a different `PORT` at runtime.
    - Example: `$env:PORT=3850; npm run dev:api`
- Frontend not hitting API:
  - Ensure API is running on 3849.
  - Restart Vite after changing proxy settings.
- `.env` safety:
  - Avoid editing `.env` unless necessary. Prefer setting `PORT` at runtime as shown above.

## Scripts Reference (package.json)
- `dev`: Basic server (3847)
- `dev:api`: Full API server (defaults to 3849)
- `build`: TypeScript build
- `build:frontend`: Build frontend app
- `build:all`: Build backend + frontend

Happy building!
