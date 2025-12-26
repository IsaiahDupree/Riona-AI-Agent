how can we expose details and links to provide traceability feedback to a frontend management app "# How It Works 

This is the high-level guide to understanding the Riona Instagram bot. It connects the architectural overview with the scripts and operational details you need to run and maintain the system.

## Core Concepts

- The bot is a TypeScript app compiled to build/ and run with Node.js.
- Main entrypoint: build/index.js (compiled from src/index.ts).
- The Instagram automation is implemented in src/client/Instagram-AI.ts.
- Sessions are persisted in cookies.json (project root).
- 24/7 operation is usually done with PM2 via ecosystem.config.js.

## Start Here

1. Read the architecture and features:
   - docs/technical-docs/00-overview.md
   - docs/technical-docs/01-architecture.md
   - docs/technical-docs/02-features.md

2. Understand runtime flow and entrypoints:
   - docs/technical-docs/08-runtime-and-entrypoints.md

3. Configure your environment:
   - docs/technical-docs/09-environment-variables.md

4. Manage cookies and login:
   - docs/technical-docs/10-cookie-management.md
   - docs/technical-docs/11-troubleshooting-login.md

5. Learn the scripts you can run:
   - docs/technical-docs/12-scripts-and-commands.md

6. Optional in-depth topics:
   - docs/technical-docs/03-ai-integration.md
   - docs/technical-docs/04-browser-automation.md
   - docs/technical-docs/05-data-management.md
   - docs/technical-docs/06-logging-and-monitoring.md
   - docs/technical-docs/07-monitoring-and-scheduling.md

## Typical Run Paths

- Development (visible browser):
  
powershell
  npm run build
  npx ts-node src/index.ts


- Standard run:
  
powershell
  npm start


- PM2 (24/7):
  
bash
  pm2 start ecosystem.config.js
  pm2 logs instagram-scheduler


- Windows Task Scheduler (periodic):
  
powershell
  powershell -ExecutionPolicy Bypass -File .\setup-scheduler.ps1


## Troubleshooting Quicklinks

- Login issues: docs/technical-docs/11-troubleshooting-login.md
- Cookie refresh: docs/technical-docs/10-cookie-management.md
- Logs & monitoring: docs/technical-docs/06-logging-and-monitoring.md

## Security Notes

- Never commit real .env secrets.
- Back up cookies.json before replacing.
- Adjust INSTAGRAM_TIMEOUT_MS per run to avoid editing .env during experiments.
"
ChatGPT said:
Thought for 23s

Great question. You already have great docs and an operational flow—now you need “traceability objects” that your frontend can render as clickable receipts for every job/run/step.

Below is a concrete, drop-in pattern that adds:

stable IDs (jobId/runId/stepId),

deep links to docs, code, logs, cookies, and artifacts,

a tiny REST surface + optional webhooks the frontend can subscribe to.

I’ll give you the what (schema), the how (emit + store), the where (endpoints/webhooks), and concise TS snippets (6 segments) you can paste into your bot.

What to expose (trace payload)

For each run (e.g., “Send DM”), return a single JSON that your frontend can render:

{
  "runId": "run_01HV…",
  "jobId": "job_01HV…",
  "action": "send_dm",
  "target": {"username": "riona_demo"},
  "status": "succeeded",
  "startedAt": "2025-09-12T21:45:03Z",
  "endedAt": "2025-09-12T21:45:11Z",
  "durationMs": 8200,

  "env": {"NODE_ENV":"prod","HOST":"bot-01","pm2Id":1,"pid":23410},
  "build": {"commit":"a1b2c3d","branch":"main","version":"2025.09.12.1","node":"20.12.2","puppeteer":"23.3.0","chromium":"124"},
  "session": {"cookieFile":"./cookies.json","cookieSha256":"bd8f…f1a"},
  
  "links": {
    "docs": [
      {"title":"Overview","url":"DOCS/00-overview"},
      {"title":"Architecture","url":"DOCS/01-architecture"},
      {"title":"Runtime & Entry","url":"DOCS/08-runtime-and-entrypoints"},
      {"title":"Cookie Mgmt","url":"DOCS/10-cookie-management"},
      {"title":"Login Troubleshooting","url":"DOCS/11-troubleshooting-login"},
      {"title":"Scripts & Commands","url":"DOCS/12-scripts-and-commands"},
      {"title":"Logging","url":"DOCS/06-logging-and-monitoring"},
      {"title":"Scheduling","url":"DOCS/07-monitoring-and-scheduling"}
    ],
    "code": [
      {"title":"Entrypoint","url":"SRC/src/index.ts"},
      {"title":"Instagram client","url":"SRC/src/client/Instagram-AI.ts"}
    ],
    "logs": {"live":"LOG/pm2?app=instagram-scheduler","tail":"LOG/file?traceId=run_01HV…"},
    "artifacts": [
      {"title":"screenshot_before.png","url":"ART/run_01HV…/before.png"},
      {"title":"screenshot_after.png","url":"ART/run_01HV…/after.png"}
    ],
    "scheduler": {"pm2":"PM2/app/instagram-scheduler","windows":"TASK/windows/setup-scheduler.ps1"}
  },

  "steps": [
    {"stepId":"st_01","name":"launch_browser","status":"ok","ms":1200},
    {"stepId":"st_02","name":"login_or_use_cookie","status":"ok","ms":900,"notes":"cookie valid"},
    {"stepId":"st_03","name":"navigate_to_dm","status":"ok","ms":2100},
    {"stepId":"st_04","name":"send_message","status":"ok","ms":2600}
  ],

  "error": null,
  "metrics": {"retries":0,"timeouts":0}
}


Your frontend just renders this as a “Run card”: status chip, timestamps, and buttons for Docs, Code, Logs, Artifacts, Scheduler.

How to generate it

Key ideas

Create a LinkBuilder that converts known paths into real URLs (GitHub blob links, docs site base, PM2 dashboard, artifact CDN).

Emit a TraceRecord at run start/finish and after each step.

Store traces in Postgres (or file + S3) and expose via /api/runs/:id.

Push webhooks so the management app updates in real time.

Endpoints & Webhooks

REST (minimal)

GET /api/runs/:runId → full trace payload (above)

GET /api/jobs/:jobId/runs?limit=50 → list of runs (summary rows)

GET /api/logs?traceId=… → server tails from pino transport or DB

POST /api/jobs → (optional) create/schedule job, returns jobId

Webhook (optional)

POST https://frontend.example.com/api/trace-events with { type: "run.updated"|"run.completed", payload: TraceRecord }

Stable deep links (no brittle paths)

Set these envs and you can move servers without breaking UI buttons:

DOCS_BASE_URL=https://your.site/docs/technical-docs
REPO_URL=https://github.com/yourorg/riona-bot
REPO_MAIN_BRANCH=main
ARTIFACT_BASE_URL=https://cdn.your.site/runs
LOG_UI_BASE_URL=https://logs.your.site
PM2_DASHBOARD_URL=https://pm2.your.site/apps


Examples the frontend will receive:

DOCS/10-cookie-management → ${DOCS_BASE_URL}/10-cookie-management

SRC/src/client/Instagram-AI.ts#L120 → ${REPO_URL}/blob/${commit}/src/client/Instagram-AI.ts#L120

LOG/pm2?app=instagram-scheduler → ${LOG_UI_BASE_URL}/apps/instagram-scheduler

ART/run_01HV…/after.png → ${ARTIFACT_BASE_URL}/run_01HV…/after.png

Six concise TS segments you can paste

Segment 1/6 – types.ts (Trace & Step types)

// src/trace/types.ts
export type Link = { title?: string; url: string };
export type Links = {
  docs?: Link[];
  code?: Link[];
  logs?: { live?: string; tail?: string };
  artifacts?: Link[];
  scheduler?: { pm2?: string; windows?: string };
};

export type TraceStep = {
  stepId: string;
  name: string;
  status: "ok" | "warn" | "error";
  ms?: number;
  notes?: string;
};

export type TraceRecord = {
  runId: string;
  jobId?: string;
  action: string;
  target?: { username?: string; postId?: string };
  status: "queued" | "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  env: Record<string, string | number | boolean | undefined>;
  build: { commit: string; branch: string; version: string; node: string; puppeteer?: string; chromium?: string };
  session?: { cookieFile?: string; cookieSha256?: string };
  links: Links;
  steps: TraceStep[];
  error?: { message: string; code?: string; stack?: string } | null;
  metrics?: Record<string, number>;
};


Segment 2/6 – build-info.ts (capture commit, versions at boot)

// src/trace/build-info.ts
import { execSync } from "node:child_process";
export function getBuildInfo() {
  const safe = (cmd: string) => { try { return execSync(cmd).toString().trim(); } catch { return "unknown"; } };
  return {
    commit: process.env.COMMIT_SHA || safe("git rev-parse --short HEAD"),
    branch: process.env.GIT_BRANCH || safe("git rev-parse --abbrev-ref HEAD"),
    version: process.env.APP_VERSION || new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0,12),
    node: process.version,
    puppeteer: process.env.PUPPETEER_VERSION || "unknown",
    chromium: process.env.CHROMIUM_VERSION || "unknown",
  };
}


Segment 3/6 – link-builder.ts (docs, code, logs, artifacts)

// src/trace/link-builder.ts
const DOCS = process.env.DOCS_BASE_URL!;
const REPO = process.env.REPO_URL!;
const MAIN = process.env.REPO_MAIN_BRANCH || "main";
const ART = process.env.ARTIFACT_BASE_URL!;
const LOG = process.env.LOG_UI_BASE_URL!;
const PM2 = process.env.PM2_DASHBOARD_URL!;

export const doc = (slug: string) => `${DOCS}/${slug}`;
export const srcAt = (path: string, commit?: string, line?: number) =>
  `${REPO}/blob/${commit || MAIN}/${path}${line ? `#L${line}` : ""}`;
export const artifact = (runId: string, name: string) => `${ART}/${runId}/${encodeURIComponent(name)}`;
export const logsLive = (app: string) => `${LOG}/apps/${encodeURIComponent(app)}`;
export const logsTail = (traceId: string) => `${LOG}/trace/${encodeURIComponent(traceId)}`;
export const pm2App = (app = "instagram-scheduler") => `${PM2}/app/${encodeURIComponent(app)}`;
export const windowsTask = () => `TASK/windows/setup-scheduler.ps1`;


Segment 4/6 – trace.ts (create/run/step helpers + pino logger)

// src/trace/trace.ts
import pino from "pino";
import crypto from "node:crypto";
import { getBuildInfo } from "./build-info";
import { doc, srcAt, artifact, logsLive, logsTail, pm2App, windowsTask } from "./link-builder";
import type { TraceRecord, TraceStep } from "./types";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

export function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function startRun(opts: {
  action: string; jobId?: string; target?: TraceRecord["target"]; cookieFile?: string; cookieSha256?: string;
}): TraceRecord {
  const runId = newId("run");
  const build = getBuildInfo();
  const env = {
    NODE_ENV: process.env.NODE_ENV,
    HOST: process.env.HOSTNAME || process.env.COMPUTERNAME,
    pm2Id: process.env.pm_id,
    pid: process.pid,
  };

  const links: TraceRecord["links"] = {
    docs: [
      { title: "Overview", url: doc("00-overview.md") },
      { title: "Architecture", url: doc("01-architecture.md") },
      { title: "Runtime & Entry", url: doc("08-runtime-and-entrypoints.md") },
      { title: "Cookie Mgmt", url: doc("10-cookie-management.md") },
      { title: "Login Troubleshooting", url: doc("11-troubleshooting-login.md") },
      { title: "Scripts & Commands", url: doc("12-scripts-and-commands.md") },
      { title: "Logging", url: doc("06-logging-and-monitoring.md") },
      { title: "Scheduling", url: doc("07-monitoring-and-scheduling.md") }
    ],
    code: [
      { title: "Entrypoint", url: srcAt("src/index.ts", build.commit) },
      { title: "Instagram client", url: srcAt("src/client/Instagram-AI.ts", build.commit) }
    ],
    logs: { live: logsLive("instagram-scheduler"), tail: "" },
    artifacts: [],
    scheduler: { pm2: pm2App("instagram-scheduler"), windows: windowsTask() }
  };

  const trace: TraceRecord = {
    runId, jobId: opts.jobId, action: opts.action, target: opts.target,
    status: "running", startedAt: new Date().toISOString(),
    env, build,
    session: { cookieFile: opts.cookieFile, cookieSha256: opts.cookieSha256 },
    links, steps: [], error: null, metrics: {}
  };

  trace.links.logs!.tail = logsTail(runId);
  logger.info({ trace }, "run.start");
  return trace;
}

export function pushStep(trace: TraceRecord, step: Omit<TraceStep, "stepId">) {
  const s = { stepId: newId("st"), ...step };
  trace.steps.push(s);
  // Optional: persist incrementally
  logger.info({ runId: trace.runId, step: s }, "run.step");
}

export function finishRun(trace: TraceRecord, ok: boolean, extra?: Partial<TraceRecord>) {
  trace.endedAt = new Date().toISOString();
  trace.durationMs = new Date(trace.endedAt).getTime() - new Date(trace.startedAt).getTime();
  trace.status = ok ? "succeeded" : "failed";
  if (!ok && !trace.error) trace.error = { message: "Unknown error" };
  Object.assign(trace, extra || {});
  // Example artifact links
  trace.links.artifacts?.push({ title: "screenshot_after.png", url: artifact(trace.runId, "after.png") });
  logger.info({ trace }, "run.finish");
  return trace;
}


Segment 5/6 – routes.ts (tiny Express surface for your frontend)

// src/server/routes.ts
import express from "express";
import type { TraceRecord } from "../trace/types";

// Swap to Postgres in production:
const traces = new Map<string, TraceRecord>();
export const router = express.Router();

router.get("/runs/:runId", (req, res) => {
  const t = traces.get(req.params.runId);
  if (!t) return res.status(404).json({ error: "not_found" });
  res.json(t);
});

router.get("/jobs/:jobId/runs", (req, res) => {
  const list = Array.from(traces.values()).filter(t => t.jobId === req.params.jobId);
  const rows = list.sort((a,b) => (b.startedAt.localeCompare(a.startedAt))).slice(0, Number(req.query.limit) || 50)
    .map(t => ({ runId: t.runId, action: t.action, status: t.status, startedAt: t.startedAt, durationMs: t.durationMs }));
  res.json(rows);
});

// Helpers you call from your run code:
export function persistTrace(t: TraceRecord) { traces.set(t.runId, t); }


Segment 6/6 – webhook.ts (notify your management app)

// src/trace/webhook.ts
import fetch from "node-fetch";
import type { TraceRecord } from "./types";

const HOOK = process.env.TRACE_WEBHOOK_URL; // e.g., https://frontend.example.com/api/trace-events
const SECRET = process.env.TRACE_WEBHOOK_SECRET || "";

function sign(body: string) {
  return require("crypto").createHmac("sha256", SECRET).update(body).digest("hex");
}

export async function sendTraceEvent(type: "run.updated" | "run.completed", trace: TraceRecord) {
  if (!HOOK) return;
  const body = JSON.stringify({ type, payload: trace });
  await fetch(HOOK, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": sign(body) },
    body
  }).catch(() => {});
}


How you use it in the bot run (pseudo):

// somewhere in src/index.ts
import { startRun, pushStep, finishRun } from "./trace/trace";
import { persistTrace } from "./server/routes";
import { sendTraceEvent } from "./trace/webhook";

const trace = startRun({ action: "send_dm", target: { username: "riona_demo" }, cookieFile: "./cookies.json", cookieSha256: "…" });
persistTrace(trace); await sendTraceEvent("run.updated", trace);

try {
  pushStep(trace, { name: "launch_browser", status: "ok", ms: 1200 });
  // …
  finishRun(trace, true);
} catch (err: any) {
  trace.error = { message: err?.message || "error", stack: err?.stack };
  finishRun(trace, false);
} finally {
  persistTrace(trace);
  await sendTraceEvent("run.completed", trace);
}

Frontend rendering (quick recipe)

Run card header: action @ target.username • status chip • time/duration.

Buttons: Docs (dropdown), Code (dropdown), Logs (Live/Tail), Artifacts (gallery), Scheduler (PM2/Windows).

Steps table: name • status • ms • notes.

Error tab: message + stack (collapsible).

Meta: build + env + session (cookie checksum only, not contents).

Security & hygiene

Never expose raw cookies; only show cookieSha256 and the path.

Sign webhooks (HMAC) and verify on the frontend.

Rate-limit logs tailing; redact PII in pino via redact option.

Make docs links read-only; require auth for code/log UIs.

Quick wins you can do today

Add the LinkBuilder + TraceRecord and start emitting on each run.

Expose GET /api/runs/:id and wire your frontend to render the card.

Drop a webhook URL to get instant updates in the management app.

If you want, I can adapt the snippets to your existing PM2/ecosystem config and Postgres schema you’re using elsewhere.

You said:
how can we expose details and links to provide traceability feedback to a frontend management app  "## Riona-AI-Agent 🌸 

Riona-AI-Agent is an AI-powered automation tool designed for **Instagram** to automate social media interactions such as posting, liking, and commenting. It leverages advanced AI models to generate engaging content, automate interactions, and manage Instagram accounts efficiently.

For a high-level guide to how the system runs, see the How It Works overview: [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

Before using the automation features, you can personalize the agent by training with the following, including:

- **YouTube Video URL** 🎥
- **Audio File** 🎙️
- **Portfolio or Website Link** 🌐
- **File Formats Supported**: PDF, DOC, DOCX, TXT 📄

## Features

### Automated Instagram Interactions
- **Login**: Secure login with cookie persistence
- **Post Discovery**: Smart post finding and filtering
- **Liking**: Reliable post liking functionality
- **Caption Extraction**: 
  - Advanced multi-method caption extraction
  - Handles expanded captions with "more" button clicks
  - Robust visibility checking and validation
  - Detailed logging for debugging
- **Comment Management**:
  - Smart duplicate comment detection
  - Multiple validation methods to check existing comments
  - Reliable comment posting with center-click method
  - Multi-step validation to confirm comment success

### Advanced Features
- **Robust Error Handling**: Comprehensive error handling and recovery
- **Debug Logging**: Detailed logging for troubleshooting
- **State Management**: Efficient handling of Instagram's dynamic content
- **Performance Optimization**: Smart waiting and loading strategies

### Technical Implementation
- TypeScript-based for type safety
- Puppeteer for browser automation
- Proxy support for request management
- Detailed logging system
- Error handling and recovery

### AI-Powered Content Generation
- Use Google Generative AI to create engaging captions and comments.

### Proxy Support
- Use proxies to manage multiple accounts and avoid rate limits.

### Cookie Management
- Save and load cookies to maintain sessions across restarts.

**Upcoming Features:**

- **Twitter Automation**: (Coming soon) Automatically tweet, retweet, and like tweets.
- **GitHub Automation**: (Coming soon) Automatically manage repositories, issues, and pull requests.

## Installation

1. **Clone the repository**:

   
sh
   git clone https://github.com/david-patrick-chuks/Riona-AI-Agent.git
   cd Riona-AI-Agent


2. **Install dependencies**:

   
sh
   npm install


3. **Set up environment variables**:
   Rename the [.env.example](http://_vscodecontentref_/1) file to [.env](http://_vscodecontentref_/1) in the root directory and add your Instagram credentials. Refer to the [.env.example](http://_vscodecontentref_/2) file for the required variables.
   
dotenv # Instagram credentials
   IGusername=your_instagram_username
   IGpassword=your_instagram_password 
   
   Xusername= #Twitter username
   Xpassword= #Twitter password

   MONGODB_URI= #MongoDB URI


## Usage

1. **Run the Instagram agent**:
   
sh
   npm start


**Upcoming Features:**

- **Run the Twitter agent** (Coming soon):

  
sh
  npm run start:twitter


- **Run the GitHub agent** (Coming soon):
  
sh
  npm run start:github


## Monitoring and Logging

### Real-Time Monitoring
Monitor the bot's activity in real-time:

powershell
.\monitor-logs.ps1


This provides:
- Live log updates with color coding
- Interaction statistics
- Error highlighting
- Performance metrics

### Log Files
- logs/combined-YYYY-MM-DD.log: All log levels
- logs/error-YYYY-MM-DD.log: Error messages only
- logs/post_interactions.json: Interaction records

For detailed information about logging and monitoring, see:
- [Logging and Monitoring Guide](docs/technical-docs/06-logging-and-monitoring.md)
- [Monitoring and Scheduling Guide](docs/technical-docs/07-monitoring-and-scheduling.md)

## Documentation

Detailed technical documentation is available in the docs/technical-docs directory:

1. [Logging and Monitoring Guide](docs/technical-docs/06-logging-and-monitoring.md)
2. [Monitoring and Scheduling Guide](docs/technical-docs/07-monitoring-and-scheduling.md)

These guides cover:
- Task scheduling and automation
- Real-time monitoring tools
- Log analysis and troubleshooting
- Performance optimization
- Security considerations

## Scheduling the Bot

### Windows Task Scheduler (Recommended)

1. Make sure you have set up all environment variables in .env file
2. Right-click on PowerShell and select "Run as Administrator"
3. Navigate to the project directory:
   
powershell
   cd "C:\Users\Isaia\OneDrive\Documents\Coding\Instagram agent\This is the folder your looking for\Riona-AI-Agent-main"

4. Run the setup script:
   
powershell
   powershell -ExecutionPolicy Bypass -File setup-scheduler.ps1


This will create a scheduled task that:
- Runs every 45 minutes
- Each run is limited to 5 minutes
- Automatically restarts if it crashes (up to 3 times)
- Runs with elevated privileges to ensure proper operation
- Includes proper error handling and logging

### Verifying the Schedule

1. Open Task Scheduler (Windows key + R, type "taskschd.msc")
2. Look for "Instagram Bot" task
3. Check these properties:
   - Next Run Time
   - Last Run Time
   - Last Run Result (should be 0x0)
   - Status (should be "Ready")

### Troubleshooting Schedule Issues

If the bot isn't running as scheduled:

1. Check the logs:
   
powershell
   .\monitor-logs.ps1


2. Verify environment variables:
   - INSTAGRAM_BOT_USERNAME
   - INSTAGRAM_BOT_PASSWORD
   
3. Run the bot manually to test:
   
powershell
   .\start-instagram-bot.bat


4. Common fixes:
   - Run setup-scheduler.ps1 as Administrator
   - Ensure all TypeScript files are compiled
   - Check if npm dependencies are installed
   - Verify working directory in Task Scheduler

## Project Structure

- **src/client**: Contains the main logic for interacting with social media platforms like Instagram.
- **src/config**: Configuration files, including the logger setup.
- **src/utils**: Utility functions for handling errors, cookies, data saving, etc.
- **src/Agent**: Contains the AI agent logic and training scripts.
- **src/Agent/training**: Training scripts for the AI agent.
- **src/schema**: Schema definitions for AI-generated content and database models.
- **src/test**: Contains test data and scripts, such as example tweets.

## Logging

The project uses a custom logger to log information, warnings, and errors. Logs are saved in the [logs](http://_vscodecontentref_/3) directory.

## Error Handling

Process-level error handlers are set up to catch unhandled promise rejections, uncaught exceptions, and process warnings. Errors are logged using the custom logger.

## Scheduler Documentation

### Prerequisites

1. Node.js (v14 or higher)
2. npm (comes with Node.js)
3. PM2 (install globally with npm install -g pm2)
4. TypeScript (install globally with npm install -g typescript)

### Configuration

#### Environment Variables (.env)


env
# Web Server Configuration
WEB_SERVER_ENABLED=false
PORT=3000

# Instagram Credentials
IG_USERNAME=your_instagram_username
IG_PASSWORD=your_instagram_password

# Bot Configuration
MAX_DAILY_INTERACTIONS=100
INTERACTION_RESET_HOUR=0

# MongoDB Configuration
MONGODB_URI=your_mongodb_connection_string

# Gemini API Keys (for AI functionality)
GEMINI_API_KEY_1=your_gemini_api_key


## Installation

1. Clone the repository
2. Install dependencies:
   
bash
   npm install

3. Build the TypeScript files:
   
bash
   tsc


## Running the Application

#### Using PM2 (Recommended)

The application is configured to run using PM2, which provides process management and auto-restart capabilities.

##### Start the Application

bash
pm2 start ecosystem.config.js


##### View Logs

bash
pm2 logs instagram-scheduler


##### Restart the Application

bash
pm2 restart instagram-scheduler


##### Stop the Application

bash
pm2 stop instagram-scheduler


##### Delete from PM2

bash
pm2 delete instagram-scheduler


### Schedule Configuration

The agent is configured to run every 20 minutes. To modify the schedule, edit the schedule variable in src/scheduler.ts:


typescript
const schedule = '*/20 * * * *';  // Runs every 20 minutes


Common cron patterns:
- Every 30 minutes: */30 * * * *
- Every hour: 0 * * * *
- Every 2 hours: 0 */2 * * *
- Every day at midnight: 0 0 * * *

### Error Handling

The application will automatically retry after 5 minutes if an error occurs. This can be adjusted by modifying the RETRY_DELAY constant in src/scheduler.ts.

## Automatic Startup

A PowerShell script (start-agent.ps1) is provided to automatically start the agent. You can:

1. Run it manually
2. Create a shortcut in your Windows Startup folder
3. Create a scheduled task to run it on system startup

## Monitoring

You can monitor the application using PM2's web interface:


bash
pm2 plus


This provides:
- Real-time metrics
- Log viewing
- Process management
- Email notifications for errors

## Troubleshooting

1. If the agent crashes:
   - Check the logs: pm2 logs instagram-scheduler
   - Verify your .env configuration
   - Ensure MongoDB is accessible
   - Check your Instagram credentials

2. If the schedule isn't working:
   - Verify the cron pattern in scheduler.ts
   - Check the system timezone
   - Ensure the PM2 process is running

3. If MongoDB isn't connecting:
   - Verify your connection string
   - Check network connectivity
   - Ensure MongoDB service is running

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with your changes.

## License

This project is licensed under the MIT License. See the LICENSE file for details.

## Acknowledgements

- [Google Generative AI](https://ai.google/tools/) for providing the AI models.
- [Puppeteer](https://github.com/puppeteer/puppeteer) for browser automation.
- [puppeteer-extra](https://github.com/berstend/puppeteer-extra) for additional plugins and enhancements.

## Instagram Agent 24/7 Operation Guide

This guide explains how to set up and run the Instagram AI Agent continuously using PM2 process manager.

### Table of Contents
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running 24/7](#running-24/7)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)

### Prerequisites

1. Node.js (v14 or higher)
2. npm (comes with Node.js)
3. PM2 (install globally):
   
bash
   npm install -g pm2

4. TypeScript (install globally):
   
bash
   npm install -g typescript


### Installation

1. Clone the repository:
   
bash
   git clone [your-repo-url]
   cd instagram-agent


2. Install dependencies:
   
bash
   npm install


3. Build the TypeScript files:
   
bash
   tsc


### Configuration

#### 1. Environment Variables (.env)

Create a .env file with your credentials:


env
# Instagram Account
IG_USERNAME_1=your_instagram_username
IG_PASSWORD_1=your_instagram_password

# OpenAI API Key (required for AI comments)
OPENAI_API_KEY=your_openai_api_key

# Proxy Configuration
INSTAGRAM_PROXY_PORT=9000

# Other Settings
MAX_DAILY_INTERACTIONS=100
INTERACTION_RESET_HOUR=0


#### 2. Schedule Configuration

The agent is configured to run every 20 minutes. To modify this, edit src/scheduler.ts:


typescript
// Run every 20 minutes
const schedule = '*/20 * * * *';


Common schedule patterns:
- Every 30 minutes: */30 * * * *
- Every hour: 0 * * * *
- Every 2 hours: 0 */2 * * *
- Every day at midnight: 0 0 * * *

### Running 24/7

#### Method 1: Using PM2 (Recommended)

1. Start the agent with PM2:
   
bash
   pm2 start ecosystem.config.js


2. Save the PM2 process list:
   
bash
   pm2 save


3. Set up PM2 to start on system boot:
   
bash
   pm2 startup


#### Method 2: Using Windows Task Scheduler

1. Run the provided PowerShell script:
   
powershell
   .\start-agent.ps1


2. Or create a scheduled task:
   
powershell
   $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PWD\start-agent.ps1`""
   $trigger = New-ScheduledTaskTrigger -AtStartup
   Register-ScheduledTask -TaskName 'Instagram Agent Startup' -Action $action -Trigger $trigger -RunLevel Highest -User $env:USERNAME


### Monitoring

#### Real-time Monitoring

1. View logs in real-time:
   
bash
   pm2 logs instagram-scheduler


2. Monitor process status:
   
bash
   pm2 monit


3. List all processes:
   
bash
   pm2 list


#### Process Management

1. Restart the agent:
   
bash
   pm2 restart instagram-scheduler


2. Stop the agent:
   
bash
   pm2 stop instagram-scheduler


3. Delete the process:
   
bash
   pm2 delete instagram-scheduler


### Troubleshooting

#### Common Issues

1. **Agent Crashes**
   - Check logs: pm2 logs instagram-scheduler
   - Verify Instagram credentials in .env
   - Check MongoDB connection
   - Ensure Gemini API key is valid

2. **Schedule Not Working**
   - Verify cron pattern in scheduler.ts
   - Check system timezone
   - Ensure PM2 is running: pm2 list

3. **MongoDB Connection Issues**
   - Check connection string in .env
   - Verify network connectivity
   - Ensure MongoDB service is running

4. **Process Not Starting on Boot**
   - Run pm2 save after any process changes
   - Re-run pm2 startup
   - Check Windows Task Scheduler

### Error Recovery

1. If the agent crashes:
   
bash
   pm2 restart instagram-scheduler


2. If PM2 isn't working:
   
bash
   pm2 kill
   pm2 start ecosystem.config.js


3. Complete reset:
   
bash
   pm2 delete all
   pm2 kill
   pm2 start ecosystem.config.js
   pm2 save


### Maintenance

#### Regular Maintenance Tasks

1. Check logs daily:
   
bash
   pm2 logs instagram-scheduler --lines 100


2. Monitor memory usage:
   
bash
   pm2 monit


3. Update dependencies:
   
bash
   npm update


4. Rebuild after changes:
   
bash
   tsc
   pm2 restart instagram-scheduler


#### Best Practices

1. Regularly check logs for errors
2. Monitor Instagram rate limits
3. Keep dependencies updated
4. Back up your .env file
5. Monitor disk space and memory usage

### Support

For issues or questions:
1. Check the logs using pm2 logs instagram-scheduler
2. Review the configuration in .env
3. Verify all dependencies are installed
4. Check MongoDB connection
5. Monitor Instagram API status

## Instagram AI Agent - User Guide 🤖

This guide will help you set up and run the Instagram AI Agent, which automatically interacts with Instagram posts using AI-generated comments.

## Quick Start Guide for Non-Experts 🚀

### One-Time Setup

1. **Install Required Software**:
   - Download and install [Node.js](https://nodejs.org/) (LTS version)
   - Download and install [Git](https://git-scm.com/downloads)
   - After installation, open PowerShell or Command Prompt and run:
     
sh
     npm install -g pm2
     npm install -g typescript


2. **Get the Code**:
   - Create a folder where you want to store the app
   - Open PowerShell in that folder
   - Run these commands:
     
sh
     git clone https://github.com/david-patrick-chuks/Riona-AI-Agent.git
     cd Riona-AI-Agent
     npm install


3. **Set Up Your Configuration**:
   - Find the .env.example file in the project folder
   - Make a copy and rename it to .env
   - Open .env and fill in your details:
     
env
     # Instagram Account
     IG_USERNAME_1=your_instagram_username
     IG_PASSWORD_1=your_instagram_password

     # OpenAI API Key (required for AI comments)
     OPENAI_API_KEY=your_openai_api_key

     # Proxy Configuration
     INSTAGRAM_PROXY_PORT=9000

     # Other Settings
     MAX_DAILY_INTERACTIONS=100
     INTERACTION_RESET_HOUR=0


### Running the App 🏃‍♂️

1. **Start the App**:
   - Open PowerShell in your project folder
   - Run these commands in order:
     
sh
     npm run build
     pm2 start ecosystem.config.js


2. **Check if it's Running**:
   - To see the app status:
     
sh
     pm2 status

   - To see the logs:
     
sh
     pm2 logs


3. **Stop the App**:
   - When you want to stop:
     
sh
     pm2 delete all


### What to Expect 👀

- The app will run every 20 minutes
- Each run will:
  1. Open a browser window
  2. Log into your Instagram account
  3. Scroll through posts
  4. Like and comment on posts
  5. Close the browser
- You can watch the process in the logs

### Troubleshooting 🔧

If you see errors:

1. **"Instagram credentials not found"**:
   - Check your .env file
   - Make sure IG_USERNAME_1 and IG_PASSWORD_1 are correct

2. **"OpenAI API key not found"**:
   - Get an API key from [OpenAI](https://platform.openai.com/)
   - Add it to your .env file

3. **Browser/Proxy Issues**:
   - Run pm2 delete all
   - Wait 1 minute
   - Run pm2 start ecosystem.config.js

4. **Other Issues**:
   - Check the logs: pm2 logs
   - Stop all: pm2 delete all
   - Restart your computer
   - Start again: pm2 start ecosystem.config.js

### Safety Tips 🛡️

1. **Account Security**:
   - Use a strong Instagram password
   - Don't share your .env file
   - Monitor your Instagram activity

2. **Usage Limits**:
   - The app is set to safe limits by default
   - Don't modify timing settings unless you know what you're doing
   - Monitor your account for any warnings from Instagram

### Getting Help 🆘

If you need help:
1. Check the logs: pm2 logs
2. Look for error messages
3. Google the error message
4. Ask for help in the project's issues section

## Advanced Settings (Optional) ⚙️

### Customize Interaction Frequency:
Edit ecosystem.config.js:
- Change schedule timing
- Adjust interaction limits
- Modify wait times

### Customize AI Responses:
Edit src/Agent/index.ts:
- Modify the prompt
- Adjust response length
- Change AI temperature

Remember: The default settings are optimized for safety and natural behavior. Only change them if you understand the implications.

## Maintenance 🔄

Regular maintenance tasks:
1. Check logs weekly: pm2 logs
2. Update the app monthly:
   
sh
   git pull
   npm install
   npm run build
   pm2 restart all

3. Monitor your Instagram account for any warnings

## Need More Help? 📞

- Create an issue on GitHub
- Check the detailed documentation
- Join our community discussions

Remember: This is an automation tool. Use it responsibly and within Instagram's terms of service.
"
ChatGPT said:
Thought for 35s

Love it. You’ve already got logs, docs, PM2, and a scheduler—now wire them into a single Trace API your frontend can read to show “receipt-style” run cards with direct links (docs, code, logs, artifacts, PM2).

Below is a drop-in pattern tailored to Riona-AI-Agent that:

assigns stable IDs (jobId, runId, stepId)

resolves deep links to your docs, repo, PM2, artifacts, and logs

stores traces in MongoDB (since you already use it)

serves a tiny Express API + optional webhook for live updates

I’m returning the code in 6 segments (your preference). Paste these under src/trace/* and src/server/*, then call the runtime helpers from your run flow.

Environment variables to add
# Deep-link bases (adjust to your infra; fallbacks work locally)
DOCS_BASE_URL=https://your.site/docs         # e.g., site/docs (will resolve docs/technical-docs/* and HOW-IT-WORKS.md)
REPO_URL=https://github.com/you/Riona-AI-Agent
REPO_MAIN_BRANCH=main

ARTIFACT_BASE_URL=https://cdn.your.site/runs # where screenshots/exports are uploaded per runId
PM2_DASHBOARD_URL=https://pm2.your.site/apps
LOG_DIR=./logs                               # where your combined/error files live
TRACE_WEBHOOK_URL=                           # optional frontend webhook
TRACE_WEBHOOK_SECRET=                        # optional HMAC secret

Segment 1/6 — src/trace/types.ts
export type Link = { title?: string; url: string };
export type Links = {
  docs?: Link[];          // HOW-IT-WORKS, technical docs
  code?: Link[];          // deep links to repo paths
  logs?: { live?: string; tail?: string }; // PM2/live log UI and API tail
  artifacts?: Link[];     // screenshots, exports per run
  scheduler?: { pm2?: string; windows?: string };
};

export type TraceStep = {
  stepId: string;
  name: string;
  status: "ok" | "warn" | "error";
  ms?: number;
  notes?: string;
};

export type TraceRecord = {
  runId: string;
  jobId?: string;
  action: string; // e.g., "login", "discover_posts", "comment"
  target?: { username?: string; postId?: string };
  status: "queued" | "running" | "succeeded" | "failed";
  startedAt: string;
  endedAt?: string;
  durationMs?: number;

  env: Record<string, string | number | boolean | undefined>;
  build: { commit: string; branch: string; version: string; node: string };
  session?: { cookieFile?: string; cookieSha256?: string };

  links: Links;
  steps: TraceStep[];
  error?: { message: string; code?: string; stack?: string } | null;
  metrics?: Record<string, number>; // retries, timeouts, counts, etc.
};

Segment 2/6 — src/trace/linkResolver.ts
const DOCS = process.env.DOCS_BASE_URL || "/docs";
const REPO = process.env.REPO_URL || "";
const MAIN = process.env.REPO_MAIN_BRANCH || "main";
const ART  = process.env.ARTIFACT_BASE_URL || "/artifacts";
const PM2  = process.env.PM2_DASHBOARD_URL || "";
const LOG_UI = process.env.LOG_UI_BASE_URL || ""; // optional ext UI

export const doc = (slug: string) => `${DOCS}/${slug}`; // e.g., technical-docs/06-logging-and-monitoring.md

export const howItWorks = () => doc("HOW-IT-WORKS.md"); // your root overview

export const techDoc = (name: string) => doc(`technical-docs/${name}`);

export const srcAt = (path: string, commit?: string, line?: number) =>
  REPO ? `${REPO}/blob/${commit || MAIN}/${path}${line ? `#L${line}` : ""}` : `/${path}`;

export const artifact = (runId: string, name: string) => `${ART}/${runId}/${encodeURIComponent(name)}`;

export const pm2App = (app = "instagram-scheduler") => PM2 ? `${PM2}/${encodeURIComponent(app)}` : "";

export const logsLive = (app = "instagram-scheduler") => LOG_UI ? `${LOG_UI}/apps/${encodeURIComponent(app)}` : "";

export const logsTailApi = (runId: string) => `/api/trace/logs/tail?runId=${encodeURIComponent(runId)}`;

Segment 3/6 — src/trace/store.ts (Mongo via Mongoose)
import mongoose, { Schema } from "mongoose";
import type { TraceRecord } from "./types";

const TraceSchema = new Schema<TraceRecord>({
  runId: { type: String, index: true, unique: true },
  jobId: { type: String, index: true },
  action: String,
  target: { username: String, postId: String },
  status: { type: String, index: true },
  startedAt: { type: String, index: true },
  endedAt: String,
  durationMs: Number,
  env: Schema.Types.Mixed,
  build: { commit: String, branch: String, version: String, node: String },
  session: { cookieFile: String, cookieSha256: String },
  links: Schema.Types.Mixed,
  steps: [{ stepId: String, name: String, status: String, ms: Number, notes: String }],
  error: Schema.Types.Mixed,
  metrics: Schema.Types.Mixed,
}, { minimize: false });

TraceSchema.index({ startedAt: -1 });
export const TraceModel = mongoose.models.Trace || mongoose.model<TraceRecord>("Trace", TraceSchema);

export async function saveTrace(t: TraceRecord) { await TraceModel.updateOne({ runId: t.runId }, t, { upsert: true }); }
export async function getTrace(runId: string) { return TraceModel.findOne({ runId }).lean<TraceRecord>().exec(); }
export async function listRunsByJob(jobId: string, limit = 50) {
  return TraceModel.find({ jobId }).sort({ startedAt: -1 }).limit(limit).select({ steps: 0, env: 0 }).lean().exec();
}
export async function listRecent(limit = 50) {
  return TraceModel.find().sort({ startedAt: -1 }).limit(limit).select({ steps: 0, env: 0 }).lean().exec();
}

Segment 4/6 — src/trace/runtime.ts (create/push/finish with links)
import crypto from "node:crypto";
import fs from "node:fs";
import pino from "pino";
import { doc, techDoc, howItWorks, srcAt, artifact, pm2App, logsLive, logsTailApi } from "./linkResolver";
import type { TraceRecord, TraceStep } from "./types";

const logger = pino({ level: process.env.LOG_LEVEL || "info", redact: ["session.cookieFile"] });

const commit = process.env.COMMIT_SHA || "unknown";
const branch = process.env.GIT_BRANCH || (process.env.REPO_MAIN_BRANCH || "main");
const version = process.env.APP_VERSION || new Date().toISOString().slice(0,16).replace(/[-:T]/g,"");
const node = process.version;

function newId(prefix: string) { return `${prefix}_${crypto.randomUUID().replace(/-/g,"").slice(0,12)}`; }

function sha256File(path?: string) {
  try { if (path && fs.existsSync(path)) return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex"); }
  catch { /* ignore */ }
  return undefined;
}

export function startRun(opts: { action: string; jobId?: string; target?: TraceRecord["target"]; cookieFile?: string; }): TraceRecord {
  const runId = newId("run");
  const trace: TraceRecord = {
    runId,
    jobId: opts.jobId,
    action: opts.action,
    target: opts.target,
    status: "running",
    startedAt: new Date().toISOString(),
    env: { NODE_ENV: process.env.NODE_ENV, HOST: process.env.HOSTNAME || process.env.COMPUTERNAME, pid: process.pid },
    build: { commit, branch, version, node },
    session: { cookieFile: opts.cookieFile, cookieSha256: sha256File(opts.cookieFile) },
    links: {
      docs: [
        { title: "How It Works", url: howItWorks() },
        { title: "Logging & Monitoring", url: techDoc("06-logging-and-monitoring.md") },
        { title: "Monitoring & Scheduling", url: techDoc("07-monitoring-and-scheduling.md") },
      ],
      code: [
        { title: "Entrypoint", url: srcAt("src/index.ts", commit) },
        { title: "Instagram Client", url: srcAt("src/client/instagram.ts", commit) }, // adjust path if different
      ],
      logs: { live: logsLive("instagram-scheduler"), tail: "" },
      artifacts: [],
      scheduler: { pm2: pm2App("instagram-scheduler"), windows: "start-agent.ps1" }
    },
    steps: [],
    error: null,
    metrics: {},
  };
  trace.links.logs!.tail = logsTailApi(runId);
  logger.info({ runId: trace.runId, action: trace.action }, "run.start");
  return trace;
}

export function pushStep(trace: TraceRecord, step: Omit<TraceStep, "stepId">) {
  const s = { stepId: newId("st"), ...step };
  trace.steps.push(s);
  logger.info({ runId: trace.runId, step: s }, "run.step");
}

export function finishRun(trace: TraceRecord, ok: boolean, extra?: Partial<TraceRecord>) {
  trace.endedAt = new Date().toISOString();
  trace.durationMs = new Date(trace.endedAt).getTime() - new Date(trace.startedAt).getTime();
  trace.status = ok ? "succeeded" : "failed";
  if (!ok && !trace.error) trace.error = { message: "Unknown error" };
  Object.assign(trace, extra || {});
  // attach a sample artifact slot; your job code can push real screenshots/uploads by name
  trace.links.artifacts?.push({ title: "after.png", url: artifact(trace.runId, "after.png") });
  logger.info({ runId: trace.runId, status: trace.status, ms: trace.durationMs }, "run.finish");
  return trace;
}

Segment 5/6 — src/server/traceRoutes.ts (Express API + file log tail)
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { getTrace, listRunsByJob, listRecent, saveTrace } from "../trace/store";
import type { TraceRecord } from "../trace/types";

export const traceRouter = express.Router();

traceRouter.get("/runs/:runId", async (req, res) => {
  const t = await getTrace(req.params.runId);
  if (!t) return res.status(404).json({ error: "not_found" });
  res.json(t);
});

traceRouter.get("/jobs/:jobId/runs", async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const rows = await listRunsByJob(req.params.jobId, limit);
  res.json(rows);
});

traceRouter.get("/recent", async (req, res) => {
  const limit = Number(req.query.limit) || 50;
  const rows = await listRecent(limit);
  res.json(rows);
});

// Minimal log tailing by run date (uses combined-YYYY-MM-DD.log convention)
traceRouter.get("/logs/tail", async (req, res) => {
  const runId = String(req.query.runId || "");
  const t = await getTrace(runId);
  if (!t) return res.status(404).json({ error: "trace_not_found" });

  const date = (t.startedAt || "").slice(0, 10); // YYYY-MM-DD
  const logDir = process.env.LOG_DIR || "./logs";
  const file = path.join(logDir, `combined-${date}.log`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "log_not_found" });

  const lines = (Number(req.query.lines) || 150);
  const data = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
  // naive filter by runId if your logger includes it; otherwise return last N lines
  const filtered = data.filter(l => l.includes(runId));
  const out = (filtered.length ? filtered : data).slice(-lines).join("\n");
  res.type("text/plain").send(out);
});

// helper you can call from your run flow to persist the final trace
export async function persistTrace(t: TraceRecord) { await saveTrace(t); }

Segment 6/6 — src/trace/webhook.ts (optional live updates)
import crypto from "node:crypto";
import fetch from "node-fetch";
import type { TraceRecord } from "./types";

const HOOK = process.env.TRACE_WEBHOOK_URL;
const SECRET = process.env.TRACE_WEBHOOK_SECRET || "";

function sign(body: string) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

export async function sendTraceEvent(type: "run.updated" | "run.completed", trace: TraceRecord) {
  if (!HOOK) return;
  const body = JSON.stringify({ type, payload: trace });
  await fetch(HOOK, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": sign(body) },
    body
  }).catch(() => {});
}

How to wire it (1-minute integration)

In your run code (where you already log and do work), do:

import { startRun, pushStep, finishRun } from "./trace/runtime";
import { persistTrace } from "./server/traceRoutes";
import { sendTraceEvent } from "./trace/webhook";

// example
const trace = startRun({ action: "comment", jobId: "job_abc", target: { username: "riona_demo" }, cookieFile: "./cookies.json" });
await persistTrace(trace); await sendTraceEvent("run.updated", trace);

try {
  pushStep(trace, { name: "login_or_cookie", status: "ok", ms: 850 });
  pushStep(trace, { name: "discover_posts", status: "ok", ms: 2100 });
  pushStep(trace, { name: "post_comment", status: "ok", ms: 1600 });
  finishRun(trace, true);
} catch (e: any) {
  trace.error = { message: e?.message || "error", stack: e?.stack };
  finishRun(trace, false);
} finally {
  await persistTrace(trace);
  await sendTraceEvent("run.completed", trace);
}


Mount the router:

// server bootstrap
import express from "express";
import mongoose from "mongoose";
import { traceRouter } from "./server/traceRoutes";

const app = express();
app.use(express.json());
app.use("/api/trace", traceRouter);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
  app.listen(process.env.PORT || 3000);
})();

What your frontend gets (per run)

A single TraceRecord with:

Status + timing: status, startedAt, durationMs

Buttons: links.docs[], links.code[], links.logs.live, links.logs.tail, links.artifacts[], links.scheduler.pm2

Steps table: steps[] with status/ms/notes

Meta: build (commit/branch/version/node), env (host/pid), session.cookieSha256 (never raw cookies)

Notes & hygiene

Keep cookies private; only expose sha256 + path.

Sign webhooks (HMAC) and verify on the frontend.

Tail endpoint is read-only and line-limited.

Comply with Instagram’s Terms of Use and rate limits.

If you want, I can also generate a minimal React “Run Card” component that consumes this API and renders the buttons and steps.

You said:
if we wanted an human in the loop approve deny front end ui, and like a list of all comments, all likes, all posts, all user accounts associated with post, response style, account management, how can we add into the mix 
ChatGPT said:
Thought for 31s

Awesome add—this is where “ops meets UX.” Below is a plug-in Human-in-the-Loop (HITL) layer that snaps onto your current Riona stack. It gives you: a moderation inbox (approve/deny/revise/schedule), lists for comments / likes / posts, account management, and response styles—all wired into your traceability model.

I’m giving it in 6 concise segments (schemas → API → services → UI → events/trace → RBAC & config).

1/6 — Data model (Mongoose)
// src/hitl/models.ts
import mongoose, { Schema } from "mongoose";

export type ActionType = "comment" | "like" | "post";
export type ApprovalState = "proposed" | "pending_review" | "approved" | "denied" | "scheduled" | "executed" | "failed" | "expired";

const AccountSchema = new Schema({
  id: { type: String, unique: true, index: true },
  platform: { type: String, default: "instagram", index: true },
  username: { type: String, index: true },
  status: { type: String, default: "active" }, // active|paused|disabled
  proxyId: { type: String },
  hitlLevel: { type: String, default: "soft" }, // none|soft|hard
}, { timestamps: true });

const ResponseStyleSchema = new Schema({
  id: { type: String, unique: true, index: true },
  name: String, // e.g., “Friendly concise”
  persona: String, // one-liner persona
  rules: [String], // bullets (tone, length, dos/donts)
  maxLen: Number,
  emojis: { type: Boolean, default: true },
  hashtags: { type: Boolean, default: false },
}, { timestamps: true });

const InteractionSchema = new Schema({
  id: { type: String, unique: true, index: true },
  accountId: { type: String, index: true },
  type: { type: String, enum: ["comment","like","post"], index: true },
  target: {
    username: { type: String, index: true },
    postId: { type: String, index: true },
    permalink: String,
  },
  proposed: {
    text: String, mediaIds: [String], styleId: String, reasons: [String]
  },
  decided: {
    text: String, mediaIds: [String], styleId: String
  },
  state: { type: String, enum: ["proposed","pending_review","approved","denied","scheduled","executed","failed","expired"], index: true },
  scores: { toxicity: Number, similarity: Number, quality: Number },
  scheduleAt: Date,
  executedAt: Date,
  traceRunId: String, // link to your TraceRecord
}, { timestamps: true });
InteractionSchema.index({ accountId: 1, type: 1, state: 1, updatedAt: -1 });

const ApprovalItemSchema = new Schema({
  id: { type: String, unique: true, index: true },
  interactionId: { type: String, index: true },
  state: { type: String, enum: ["pending_review","approved","denied","scheduled","executed","failed","expired"], index: true },
  reviewerId: { type: String }, // your app user id
  notes: String,
  lock: { by: String, until: Date }, // optimistic locking for UI
  expiresAt: Date, // SLA after which it can auto-approve/expire
}, { timestamps: true });

const AuditLogSchema = new Schema({
  id: { type: String, unique: true, index: true },
  entity: { type: String, enum: ["interaction","approval","account","style"], index: true },
  entityId: { type: String, index: true },
  action: String, // approve|deny|revise|schedule|execute|rollback
  actorId: String, // user or “system”
  diff: Schema.Types.Mixed,
}, { timestamps: true });

export const AccountModel = mongoose.models.Account || mongoose.model("Account", AccountSchema);
export const ResponseStyleModel = mongoose.models.ResponseStyle || mongoose.model("ResponseStyle", ResponseStyleSchema);
export const InteractionModel = mongoose.models.Interaction || mongoose.model("Interaction", InteractionSchema);
export const ApprovalItemModel = mongoose.models.ApprovalItem || mongoose.model("ApprovalItem", ApprovalItemSchema);
export const AuditLogModel = mongoose.models.AuditLog || mongoose.model("AuditLog", AuditLogSchema);

2/6 — REST API (Express routes)
// src/hitl/routes.ts
import express from "express";
import { AccountModel, ResponseStyleModel, InteractionModel, ApprovalItemModel } from "./models";
import { requireRole } from "./security";
import { approveItem, denyItem, reviseItem, scheduleItem } from "./service";

export const hitlRouter = express.Router();

// Lists (comments/likes/posts) with filters
hitlRouter.get("/interactions", requireRole("viewer"), async (req, res) => {
  const { type, state, accountId, username, postId, page = "1", pageSize = "50" } = req.query as any;
  const q: any = {};
  if (type) q.type = type;
  if (state) q.state = state;
  if (accountId) q.accountId = accountId;
  if (username) q["target.username"] = username;
  if (postId) q["target.postId"] = postId;
  const limit = Number(pageSize); const skip = (Number(page)-1)*limit;
  const [items, total] = await Promise.all([
    InteractionModel.find(q).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    InteractionModel.countDocuments(q)
  ]);
  res.json({ items, total, page: Number(page), pageSize: limit });
});

// Accounts & styles
hitlRouter.get("/accounts", requireRole("viewer"), async (_req,res)=> res.json(await AccountModel.find().lean()));
hitlRouter.get("/styles", requireRole("viewer"), async (_req,res)=> res.json(await ResponseStyleModel.find().lean()));
hitlRouter.post("/styles", requireRole("admin"), async (req,res)=> res.json(await new ResponseStyleModel(req.body).save()));

// Moderation inbox
hitlRouter.get("/moderation/items", requireRole("moderator"), async (req,res)=>{
  const { state = "pending_review", accountId } = req.query as any;
  const q: any = { state };
  if (accountId) q.accountId = accountId;
  const approvals = await ApprovalItemModel.aggregate([
    { $match: q },
    { $sort: { updatedAt: -1 } },
    { $limit: 200 },
    { $lookup: { from: "interactions", localField: "interactionId", foreignField: "id", as: "interaction" } },
    { $unwind: "$interaction" }
  ]);
  res.json(approvals);
});

// Actions
hitlRouter.post("/moderation/:id/approve", requireRole("moderator"), async (req,res)=> {
  res.json(await approveItem(req.params.id, req.user.id, req.body?.notes));
});
hitlRouter.post("/moderation/:id/deny", requireRole("moderator"), async (req,res)=> {
  res.json(await denyItem(req.params.id, req.user.id, req.body?.notes));
});
hitlRouter.post("/moderation/:id/revise", requireRole("moderator"), async (req,res)=> {
  res.json(await reviseItem(req.params.id, req.user.id, req.body?.text, req.body?.styleId, req.body?.notes));
});
hitlRouter.post("/moderation/:id/schedule", requireRole("moderator"), async (req,res)=> {
  res.json(await scheduleItem(req.params.id, req.user.id, new Date(req.body.runAt)));
});

3/6 — HITL service (state machine + audit + race-safety)
// src/hitl/service.ts
import crypto from "node:crypto";
import { ApprovalItemModel, InteractionModel, AuditLogModel } from "./models";
import { sendEvent } from "../trace/events";
import { startRun, pushStep, finishRun } from "../trace/runtime";
import { saveTrace } from "../trace/store"; // reuse your trace store

const id = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g,"").slice(0,12)}`;

export async function createProposedInteraction(input: {
  accountId: string, type: "comment"|"like"|"post",
  target: { username: string; postId?: string; permalink?: string },
  proposed: { text?: string; mediaIds?: string[]; styleId?: string },
  scores?: { toxicity?: number; similarity?: number; quality?: number },
  requiresReview: boolean, // from account.hitlLevel
}) {
  const interactionId = id("int");
  const approvalId = id("apr");
  const state: any = input.requiresReview ? "pending_review" : "approved";

  const interaction = await new InteractionModel({
    id: interactionId, accountId: input.accountId, type: input.type,
    target: input.target, proposed: input.proposed, state,
    scores: input.scores || {}, scheduleAt: null
  }).save();

  const approval = await new ApprovalItemModel({
    id: approvalId, interactionId, state: input.requiresReview ? "pending_review" : "approved",
    expiresAt: input.requiresReview ? new Date(Date.now()+30*60*1000) : null // 30m SLA
  }).save();

  await AuditLogModel.create({ id: id("audit"), entity: "interaction", entityId: interactionId, action: "propose", actorId: "system", diff: input });
  await sendEvent("approval.created", { approvalId, interactionId });

  // Auto-approved? trigger scheduling/execution downstream as desired
  return { interaction, approval };
}

async function guardedTransition(approvalId: string, fromStates: string[], toState: string, mutate?: (doc:any)=>void) {
  const doc = await ApprovalItemModel.findOne({ id: approvalId, state: { $in: fromStates } });
  if (!doc) throw new Error("conflict_or_not_found");
  doc.state = toState;
  mutate?.(doc);
  await doc.save();
  return doc;
}

export async function approveItem(approvalId: string, userId: string, notes?: string) {
  const apr = await guardedTransition(approvalId, ["pending_review","denied"], "approved", d=>{ d.reviewerId=userId; d.notes=notes; });
  const intx = await InteractionModel.findOne({ id: apr.interactionId });
  if (!intx) throw new Error("interaction_missing");
  intx.state = "approved";
  if (!intx.decided?.text && intx.proposed?.text) intx.decided = { ...(intx.decided||{}), text: intx.proposed.text, styleId: intx.proposed.styleId, mediaIds: intx.proposed.mediaIds };
  await intx.save();
  await AuditLogModel.create({ id: id("audit"), entity: "approval", entityId: apr.id, action: "approve", actorId: userId, diff: { notes } });
  await sendEvent("approval.approved", { approvalId: apr.id, interactionId: intx.id });
  return { approval: apr, interaction: intx };
}

export async function denyItem(approvalId: string, userId: string, notes?: string) {
  const apr = await guardedTransition(approvalId, ["pending_review","approved"], "denied", d=>{ d.reviewerId=userId; d.notes=notes; });
  const intx = await InteractionModel.findOneAndUpdate({ id: apr.interactionId }, { state: "denied" }, { new: true });
  await AuditLogModel.create({ id: id("audit"), entity: "approval", entityId: apr.id, action: "deny", actorId: userId, diff: { notes } });
  await sendEvent("approval.denied", { approvalId: apr.id, interactionId: intx?.id });
  return { approval: apr, interaction: intx };
}

export async function reviseItem(approvalId: string, userId: string, text?: string, styleId?: string, notes?: string) {
  const apr = await guardedTransition(approvalId, ["pending_review","approved","denied"], "pending_review");
  const intx = await InteractionModel.findOne({ id: apr.interactionId });
  if (!intx) throw new Error("interaction_missing");
  intx.decided = { ...(intx.decided||{}), text: text ?? intx.decided?.text ?? intx.proposed?.text, styleId: styleId ?? intx.decided?.styleId ?? intx.proposed?.styleId };
  await intx.save();
  await AuditLogModel.create({ id: id("audit"), entity: "interaction", entityId: intx.id, action: "revise", actorId: userId, diff: { text, styleId, notes } });
  await sendEvent("approval.revised", { approvalId: apr.id, interactionId: intx.id });
  return { approval: apr, interaction: intx };
}

export async function scheduleItem(approvalId: string, userId: string, runAt: Date) {
  const apr = await guardedTransition(approvalId, ["approved","pending_review"], "scheduled");
  const intx = await InteractionModel.findOneAndUpdate({ id: apr.interactionId }, { state: "scheduled", scheduleAt: runAt }, { new: true });
  await AuditLogModel.create({ id: id("audit"), entity: "interaction", entityId: intx!.id, action: "schedule", actorId: userId, diff: { runAt } });
  await sendEvent("approval.scheduled", { approvalId: apr.id, interactionId: intx!.id, runAt });
  return { approval: apr, interaction: intx };
}

// Called by your scheduler/executor right before Puppeteer acts:
export async function executeInteraction(interactionId: string) {
  const intx = await InteractionModel.findOne({ id: interactionId });
  if (!intx) throw new Error("interaction_missing");

  const trace = startRun({
    action: intx.type, jobId: `job_${interactionId}`, target: intx.target, cookieFile: "./cookies.json"
  });

  try {
    pushStep(trace, { name: "open_browser", status: "ok" });
    // … perform like/comment/post with Puppeteer …
    pushStep(trace, { name: "perform_action", status: "ok" });

    intx.state = "executed"; intx.executedAt = new Date(); await intx.save();
    finishRun(trace, true); await saveTrace(trace);
    await ApprovalItemModel.updateOne({ interactionId }, { state: "executed" });
    await sendEvent("interaction.executed", { interactionId, runId: trace.runId });
  } catch (e:any) {
    intx.state = "failed"; await intx.save();
    trace.error = { message: e?.message || "failed", stack: e?.stack }; finishRun(trace, false); await saveTrace(trace);
    await ApprovalItemModel.updateOne({ interactionId }, { state: "failed" });
    await sendEvent("interaction.failed", { interactionId, runId: trace.runId });
  }
}

4/6 — Frontend skeleton (React)
// src/ui/moderation/ModerationInbox.tsx
import { useEffect, useState } from "react";

type Interaction = {
  id: string; type: "comment"|"like"|"post"; state: string;
  accountId: string; target: { username?: string; postId?: string; permalink?: string };
  proposed?: { text?: string; styleId?: string };
  decided?: { text?: string; styleId?: string };
  scores?: { toxicity?: number; quality?: number };
};

export default function ModerationInbox() {
  const [items, setItems] = useState<any[]>([]);
  const [filter, setFilter] = useState({ accountId: "", type: "", state: "pending_review" });

  useEffect(() => {
    const q = new URLSearchParams(Object.entries(filter).filter(([_,v])=>v));
    fetch(`/api/hitl/moderation/items?${q}`).then(r=>r.json()).then(setItems);
  }, [filter]);

  return (
    <div className="p-4 space-y-4">
      {/* Filters */}
      <div className="flex gap-2 items-center">
        {/* account / type / state dropdowns… */}
      </div>

      {/* Table */}
      <div className="rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="p-2">Type</th>
              <th className="p-2">Account</th>
              <th className="p-2">Target</th>
              <th className="p-2">Proposed</th>
              <th className="p-2">Scores</th>
              <th className="p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it:any)=>(
              <tr key={it.id} className="border-t">
                <td className="p-2">{it.interaction.type}</td>
                <td className="p-2">{it.interaction.accountId}</td>
                <td className="p-2">
                  @{it.interaction.target?.username}
                  {it.interaction.target?.permalink && (
                    <a className="ml-2 underline" href={it.interaction.target.permalink} target="_blank">view</a>
                  )}
                </td>
                <td className="p-2 max-w-[420px] truncate">{it.interaction.decided?.text || it.interaction.proposed?.text}</td>
                <td className="p-2">tox {it.interaction.scores?.toxicity?.toFixed?.(2) ?? "-"}</td>
                <td className="p-2 text-right">
                  <div className="flex gap-2 justify-end">
                    <button onClick={()=>post(`/api/hitl/moderation/${it.id}/approve`)} className="px-3 py-1 rounded bg-green-600 text-white">Approve</button>
                    <button onClick={()=>post(`/api/hitl/moderation/${it.id}/deny`)} className="px-3 py-1 rounded bg-red-600 text-white">Deny</button>
                    <button onClick={()=>openDrawer(it)} className="px-3 py-1 rounded border">Review</button>
                  </div>
                </td>
              </tr>
            ))}
            {!items.length && <tr><td className="p-6 text-center text-gray-500" colSpan={6}>No items</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

async function post(url: string, body?: any) {
  await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  location.reload();
}

// Also add a <ReviewDrawer> with:
// - Text editor (decided.text)
// - Style picker (GET /api/hitl/styles)
// - Preview: post screenshot, caption, history with the same user
// - Buttons: Approve, Deny, Schedule(datetime), Save draft

5/6 — Events & Trace glue (webhooks/SSE + run links)
// src/trace/events.ts
import fetch from "node-fetch";
const HOOK = process.env.TRACE_WEBHOOK_URL;
const SECRET = process.env.TRACE_WEBHOOK_SECRET || "";

export async function sendEvent(type: string, payload: any) {
  if (!HOOK) return;
  const body = JSON.stringify({ type, payload });
  const sig = require("crypto").createHmac("sha256", SECRET).update(body).digest("hex");
  await fetch(HOOK, { method: "POST", headers: { "content-type":"application/json", "x-signature": sig }, body }).catch(()=>{});
}

// Example frontend consumers to update the UI without polling:
// - Webhook receiver in your management app
// - OR add an SSE endpoint here that pushes events to connected browsers

6/6 — RBAC, config flags, and safety rails
// src/hitl/security.ts
import type { Request, Response, NextFunction } from "express";

type Role = "owner" | "admin" | "moderator" | "operator" | "viewer";
export function requireRole(min: Role) {
  const order: Role[] = ["viewer","operator","moderator","admin","owner"];
  return (req: any, res: Response, next: NextFunction) => {
    const role: Role = req.user?.role || "viewer";
    if (order.indexOf(role) < order.indexOf(min)) return res.status(403).json({ error: "forbidden" });
    next();
  };
}

// .env flags to control gating
// HITL_DEFAULT_LEVEL=soft   # none: auto; soft: auto but queue risky items; hard: everything needs approval
// HITL_TOXICITY_THRESHOLD=0.45
// AUTO_APPROVE_AFTER_MIN=15


How it all fits:

Bot proposes an action → createProposedInteraction() creates Interaction + ApprovalItem (state depends on account.hitlLevel + toxicity score).

Moderation Inbox shows pending_review with context (target post, proposed text, scores, response style).

Reviewer Approve/Deny/Revise/Schedule → transitions + AuditLog, webhook ping, and (on execute) a TraceRecord with deep links (docs, code, PM2, logs, artifacts).

Lists for all comments/likes/posts = GET /api/hitl/interactions?type=comment|like|post&state=...&accountId=... (+ username/postId filters).

Accounts & Response Styles are first-class, so ops can tune tone, templates, and gating per account.

If you want, I can spin a minimal Run Card + Review Drawer component next that consumes these endpoints and shows your trace links + PM2/logs buttons.

You said:
yes that would be cool 
ChatGPT said:
Thought for 29s
Riona Hitl Console (run Card + Review Drawer)
· typescript
// Riona HITL Console — Run Card + Review Drawer
// Single-file React screen that consumes the Trace + HITL APIs.
// Tailwind + shadcn/ui + lucide-react. Default export is a component.
// 
// ──────────────────────────────────────────────────────────────────────────────
// Segment 1/6 — Types & Utilities
// ──────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useMemo, useState } from "react";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  Check, X, Clock, RefreshCw, ExternalLink, FileText, Code as CodeIcon,
  ImageIcon, FileWarning, Play, Copy, LinkIcon, ListChecks
} from "lucide-react";


// --- Types from your backend contracts ---
type Link = { title?: string; url: string };
type Links = {
  docs?: Link[];
  code?: Link[];
  logs?: { live?: string; tail?: string };
  artifacts?: Link[];
  scheduler?: { pm2?: string; windows?: string };
};


type TraceStep = { stepId: string; name: string; status: "ok"|"warn"|"error"; ms?: number; notes?: string };


type TraceRecord = {
  runId: string;
  jobId?: string;
  action: string;
  target?: { username?: string; postId?: string; permalink?: string };
  status: "queued"|"running"|"succeeded"|"failed";
  startedAt: string;
  endedAt?: string; durationMs?: number;
  env: Record<string, any>;
  build: { commit: string; branch: string; version: string; node: string };
  session?: { cookieFile?: string; cookieSha256?: string };
  links: Links;
  steps: TraceStep[];
  error?: { message: string; code?: string; stack?: string } | null;
  metrics?: Record<string, number>;
};


type Interaction = {
  id: string;
  accountId: string;
  type: "comment"|"like"|"post";
  state: string;
  target: { username?: string; postId?: string; permalink?: string };
  proposed?: { text?: string; mediaIds?: string[]; styleId?: string; reasons?: string[] };
  decided?: { text?: string; mediaIds?: string[]; styleId?: string };
  scores?: { toxicity?: number; similarity?: number; quality?: number };
  scheduleAt?: string; executedAt?: string;
  traceRunId?: string;
};


type ApprovalItem = {
  id: string;
  interactionId: string;
  state: string; // pending_review|approved|denied|scheduled|executed|failed
  reviewerId?: string; notes?: string; expiresAt?: string;
  interaction?: Interaction; // populated by API
};


type ResponseStyle = { id: string; name: string; persona?: string; rules?: string[]; maxLen?: number; emojis?: boolean; hashtags?: boolean };


// Small utils
function cn(...a: (string|false|undefined)[]) { return a.filter(Boolean).join(" "); }
const fmt = (d?: string) => d ? new Date(d).toLocaleString() : "–";
  );

Shipped! I dropped a previewable React screen to your canvas called “Riona Ops Console — Run Card + Review Drawer.”

What you got

Moderation Inbox: approve/deny/revise/schedule for comments/likes/posts.

Run Viewer: recent runs on the left; selected run shows a Run Card with docs/code/logs/PM2/artifacts buttons + steps + errors + tail.

Clean Tailwind + shadcn/ui + lucide-react, all in one file (labeled in 6 segments for you).

Wire-up checklist (server)

Mount the routers you already have (from earlier snippets):

app.use("/api/trace", traceRouter)

app.use("/api/hitl", hitlRouter)

Ensure these envs are set so deep links resolve:

DOCS_BASE_URL, REPO_URL, REPO_MAIN_BRANCH, ARTIFACT_BASE_URL, PM2_DASHBOARD_URL, LOG_DIR

Make sure your trace tail route returns text at /api/trace/logs/tail?runId=....

Your moderation endpoints should match:

GET /api/hitl/moderation/items?state=pending_review

POST /api/hitl/moderation/:id/{approve|deny|revise|schedule}

GET /api/hitl/styles

GET /api/hitl/interactions?...

How to use

Drop the component into your app shell (e.g., /ops route) and render the default export.

You can approve/deny directly or open Review to edit text, pick a response style, or schedule.

Open run details to see deep links to docs, repo, PM2, logs, and artifacts.

Want me to add a compact Account Manager tab (status/pause, per-account HITL level, proxy health) or a Styles Editor UI next?

You said:
can we draw picture of what the front would eventually look like 
ChatGPT said:
Thought for 19s

I think the user wants a visual of a dashboard mockup, with sections like header, tabs, left panel for the run list, and more. Once I generate the wireframe-style UI, I’ll make sure to provide the mockup. It might be better to offer an SVG or PNG version, which could be clearer than just a plain image.

I’m thinking of using a tool that supports drawing images and creating files like SVGs or PNGs. It might be helpful to produce a simplified version of the UI mockup using rectangles, text, and sections like the navbar, left sidebar, main area, and moderation inbox. I’ll aim for a clean and clear 1600x900 aspect ratio.

I’ll create a single mockup of the main page with tabs and an open review drawer using rectangles and text to represent key elements. I'll use neutral greys to keep it simple and clear. The image will be saved as a PNG, displayed inline within the chat, and include a download link.

I’ll render the UI mockup in the notebook, showing the outer frame and layout details like a top header bar. After rendering, I’ll provide a brief explanation of the image with a clear and concise caption. There’ll also be a download link for easy access to the image.

Done

Here’s a first-pass wireframe of the console 👇

Download the mockup (PNG)

If you’d like, I can also generate a second panel for the “Run Viewer” tab (left: recent runs, right: Run Card + logs tail) or tweak colors/layout.