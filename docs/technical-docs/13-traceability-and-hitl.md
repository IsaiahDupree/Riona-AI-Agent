# 13 — Traceability and Human-in-the-Loop (HITL)

This document defines how we expose detailed run traceability (links to docs/code/logs/artifacts/scheduler) and add a Human‑in‑the‑Loop moderation layer (approve/deny/revise/schedule) for the Riona Instagram Agent.

Related docs:
- `docs/technical-docs/06-logging-and-monitoring.md`
- `docs/technical-docs/07-monitoring-and-scheduling.md`
- `docs/technical-docs/08-runtime-and-entrypoints.md`
- `docs/technical-docs/09-environment-variables.md`

Entrypoints and core client paths for reference:
- Entrypoint: `src/index.ts`
- Instagram client: `src/client/Instagram-AI.ts` (plus `src/client/Instagram.ts`, `src/client/InstagramEnhanced.ts` as needed)

---

## Objectives

- Provide a stable “receipt” for each automation run (trace) that the frontend can render as a Run Card.
- Include deep links to docs, code, logs (live/tail), artifacts (screenshots/exports), and schedulers (PM2/Windows).
- Add a HITL moderation console: approve/deny/revise/schedule for comments/likes/posts, with audit and state transitions.

---

## Traceability Model

A single payload per run (TraceRecord) encapsulates status, timing, context, and deep links.

Example shape (trimmed):
```json
{
  "runId": "run_01HV…",
  "jobId": "job_01HV…",
  "action": "comment",
  "target": { "username": "riona_demo", "postId": "…" },
  "status": "succeeded",
  "startedAt": "2025-09-12T21:45:03Z",
  "endedAt": "2025-09-12T21:45:11Z",
  "durationMs": 8200,
  "env": { "NODE_ENV": "prod", "HOST": "bot-01", "pid": 23410 },
  "build": { "commit": "a1b2c3d", "branch": "main", "version": "2025.09.12.1", "node": "v20.x" },
  "session": { "cookieFile": "./cookies.json", "cookieSha256": "bd8f…f1a" },
  "links": {
    "docs": [ { "title": "How It Works", "url": "…" } ],
    "code": [ { "title": "Entrypoint", "url": "…" } ],
    "logs": { "live": "…", "tail": "…" },
    "artifacts": [ { "title": "after.png", "url": "…" } ],
    "scheduler": { "pm2": "…", "windows": "…" }
  },
  "steps": [ { "stepId": "st_01", "name": "login_or_cookie", "status": "ok", "ms": 850 } ],
  "error": null,
  "metrics": { "retries": 0 }
}
```

### Implementation Files (to add)
- `src/trace/types.ts` — Types for `TraceRecord`, `TraceStep`, and link groups
- `src/trace/build-info.ts` — Capture commit/branch/version/node from env/git
- `src/trace/link-builder.ts` or `src/trace/linkResolver.ts` — Build deep links from env bases
- `src/trace/trace.ts` or `src/trace/runtime.ts` — Start/push/finish helpers + logging
- `src/server/routes.ts` or `src/server/traceRoutes.ts` — Express routes to fetch traces and tail logs
- `src/trace/webhook.ts` — Optional webhooks to notify a frontend app of updates

### REST Endpoints (minimal)
- `GET /api/trace/runs/:runId` — Full trace payload
- `GET /api/trace/jobs/:jobId/runs?limit=50` — Summary list by job
- `GET /api/trace/recent?limit=50` — Recent runs (optional)
- `GET /api/trace/logs/tail?runId=…&lines=150` — Tail combined log; filter by `runId` if present

### Env Variables (deep-link bases)
Set these so buttons in the frontend remain stable even if infra moves:
- `DOCS_BASE_URL` — e.g., `https://your.site/docs/technical-docs`
- `REPO_URL` — e.g., `https://github.com/yourorg/riona-ai-agent`
- `REPO_MAIN_BRANCH` — e.g., `main`
- `ARTIFACT_BASE_URL` — e.g., `https://cdn.your.site/runs`
- `LOG_UI_BASE_URL` — e.g., `https://logs.your.site` (optional)
- `PM2_DASHBOARD_URL` — e.g., `https://pm2.your.site/apps`
- `LOG_DIR` — default `./logs`
- `TRACE_WEBHOOK_URL`, `TRACE_WEBHOOK_SECRET` — optional signed webhooks

### Integration (how to use in a run)
In your run flow (e.g., `src/index.ts`):
```ts
import { startRun, pushStep, finishRun } from "./trace/runtime";
import { persistTrace } from "./server/traceRoutes"; // or routes.ts
import { sendTraceEvent } from "./trace/webhook";

const trace = startRun({ action: "comment", jobId: "job_abc", target: { username: "riona_demo" }, cookieFile: "./cookies.json" });
await persistTrace(trace); await sendTraceEvent("run.updated", trace);

try {
  pushStep(trace, { name: "login_or_cookie", status: "ok", ms: 850 });
  // … perform work …
  finishRun(trace, true);
} catch (e: any) {
  trace.error = { message: e?.message || "error", stack: e?.stack };
  finishRun(trace, false);
} finally {
  await persistTrace(trace);
  await sendTraceEvent("run.completed", trace);
}
```

Security notes:
- Never expose raw cookies; only a checksum and path.
- Redact sensitive fields in logs; rate-limit tailing.

---

## Human-in-the-Loop (HITL) Layer

Adds a moderation inbox and state machine so a human can approve/deny/revise/schedule interactions.

### Data Models (Mongoose)
- `Account` — `{ id, platform, username, status, proxyId, hitlLevel }`
- `ResponseStyle` — `{ id, name, persona, rules[], maxLen, emojis, hashtags }`
- `Interaction` — `{ id, accountId, type(comment|like|post), target{username,postId,permalink}, proposed, decided, state, scores, scheduleAt, executedAt, traceRunId }`
- `ApprovalItem` — `{ id, interactionId, state, reviewerId, notes, lock{by,until}, expiresAt }`
- `AuditLog` — `{ id, entity, entityId, action, actorId, diff }`

Indexes:
- `Interaction`: `{ accountId: 1, type: 1, state: 1, updatedAt: -1 }`
- Others: unique `id`, common query fields indexed.

### HITL REST API
- `GET /api/hitl/interactions?type=&state=&accountId=&username=&postId=&page=&pageSize=` — List views
- `GET /api/hitl/accounts` — Accounts
- `GET /api/hitl/styles` — Response styles
- `POST /api/hitl/styles` — Create style (admin)
- `GET /api/hitl/moderation/items?state=pending_review&accountId=` — Moderation inbox
- Actions:
  - `POST /api/hitl/moderation/:id/approve`
  - `POST /api/hitl/moderation/:id/deny`
  - `POST /api/hitl/moderation/:id/revise` (body: `{ text?, styleId?, notes? }`)
  - `POST /api/hitl/moderation/:id/schedule` (body: `{ runAt }`)

### Service Logic (state machine)
- `createProposedInteraction()` — create `Interaction` + `ApprovalItem` with initial `state` based on `account.hitlLevel` and scores.
- `approveItem()` — transition to `approved`, copy `proposed.text` to `decided.text` if missing.
- `denyItem()` — transition to `denied`.
- `reviseItem()` — update `decided` and return to `pending_review`.
- `scheduleItem()` — set `scheduleAt` and transition to `scheduled`.
- `executeInteraction()` — called by scheduler/executor; performs IG action, writes a `TraceRecord`, and transitions to `executed` or `failed`.

### RBAC & Flags
- `requireRole(minRole)` middleware: roles `viewer < operator < moderator < admin < owner`.
- .env flags:
  - `HITL_DEFAULT_LEVEL=soft` — `none|soft|hard`
  - `HITL_TOXICITY_THRESHOLD=0.45`
  - `AUTO_APPROVE_AFTER_MIN=15`

---

## Frontend Management Console (Concept)

Screens:
- Moderation Inbox — filter by account/type/state, approve/deny/review/schedule.
- Run Viewer — recent runs list + selected run card with docs/code/logs/artifacts buttons and steps.
- Review Drawer — target preview, text editor, style picker, history, and actions.
- Future: Account Manager (status/pause/HITL level) and Styles Editor.

Deep links:
- Docs: `${DOCS_BASE_URL}/…`
- Code: `${REPO_URL}/blob/${commit}/${path}#L…`
- Logs UI: `${LOG_UI_BASE_URL}/apps/…` (optional)
- PM2: `${PM2_DASHBOARD_URL}/apps/…`
- Artifacts: `${ARTIFACT_BASE_URL}/${runId}/…`
- Tail API: `/api/trace/logs/tail?runId=…`

---

## Security & Ops

- Do not commit real `.env` secrets; use `.env.example` as a template.
- Back up `cookies.json` before replacement; only display `cookieSha256` in UIs.
- Rate-limit log tailing endpoints; redact PII in logger configuration.
- Prefer safe interaction pacing and follow Instagram Terms of Use.

---

## Implementation Roadmap

Phase 1 — Core (High Priority)
- Traceability system: types, build-info, link builder, runtime helpers, routes, webhook.
- HITL models and state machine; moderation endpoints.
- Wire trace events into the existing Instagram automation flow.

Phase 2 — UI (Medium Priority)
- Moderation Inbox UI and Run Viewer UI.
- Review Drawer with style picker and scheduling.
- Express server bootstrap and router mounting; env setup.
- MongoDB indexes for trace/HITL collections.

Phase 3 — Enhancements (Low Priority)
- Webhooks for live updates.
- Account management and response styles editor.
- Artifact storage and gallery links.
- Advanced monitoring and dashboards.

---

## Next Steps (Checklist)

- [ ] Add `src/trace/*` files and `src/server/traceRoutes.ts` per above.
- [ ] Add HITL `src/hitl/*` models, routes, and service.
- [ ] Mount routers in server bootstrap and connect to MongoDB.
- [ ] Configure envs: `DOCS_BASE_URL`, `REPO_URL`, `REPO_MAIN_BRANCH`, `ARTIFACT_BASE_URL`, `LOG_UI_BASE_URL`, `PM2_DASHBOARD_URL`, `LOG_DIR`, `TRACE_WEBHOOK_URL`, `TRACE_WEBHOOK_SECRET`.
- [ ] Integrate `startRun/pushStep/finishRun` in `src/index.ts` (and key flows in `src/client/Instagram-AI.ts`).
- [ ] Add indexes and test DB persistence of traces and interactions.
- [ ] Implement basic Moderation Inbox and Run Viewer pages.

---

## Notes

- Keep files small and focused (<200–300 lines) and reuse existing patterns.
- Avoid duplicating logging/HTTP server setup; extend the current Express and logging configs where possible.
- Do not mock production data paths; use real logging and MongoDB for persistence.
