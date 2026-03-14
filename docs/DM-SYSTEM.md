# Riona DM System

Autonomous Instagram DM outreach system with AI-powered messaging, relationship management, sales pipeline, and closed-loop feedback optimization.

## Architecture

```
                     ┌─────────────────────┐
                     │   dm-scheduler.ts    │  PM2 entry point
                     │  (Watcher + Pipeline)│
                     └─────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼──────┐  ┌─────▼──────┐  ┌──────▼───────┐
    │  DM Watcher    │  │  Pipeline  │  │  Analytics   │
    │  (Inbox poll)  │  │  (Outreach)│  │  (Feedback)  │
    └──────┬─────────┘  └─────┬──────┘  └──────┬───────┘
           │                  │                │
    ┌──────▼──────────────────▼────────────────▼──────┐
    │              Instagram-DM.ts                     │
    │         (Puppeteer browser automation)           │
    └──────────────────────┬──────────────────────────┘
                           │
    ┌──────────────────────▼──────────────────────────┐
    │           Storage Layer                          │
    │  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
    │  │ dmTracker│  │ JSON fs  │  │ Supabase sync │  │
    │  └──────────┘  └──────────┘  └───────────────┘  │
    └─────────────────────────────────────────────────┘
```

## Quick Start

### 1. Environment Variables

```env
# Required
INSTAGRAM_BOT_USERNAME=your_username
INSTAGRAM_BOT_PASSWORD=your_password
OPENAI_API_KEY=sk-...

# Notifications (recommended)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Optional - Supabase cloud sync
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJ...

# Scheduling
DM_CHECK_INTERVAL_MINUTES=5       # Inbox poll frequency
DM_PIPELINE_INTERVAL_MINUTES=30   # Outreach cycle frequency
ACTIVE_HOURS_START=9               # Don't send before this hour
ACTIVE_HOURS_END=22                # Don't send after this hour
```

### 2. Start with PM2

```bash
npm run build
pm2 start ecosystem.config.js --only riona-dm-watcher
```

### 3. Add Outreach Targets

```bash
curl -X POST http://localhost:3000/api/dm/pipeline/targets \
  -H "Content-Type: application/json" \
  -d '{"usernames": ["targetuser1", "targetuser2"]}'
```

### 4. Review & Approve Messages

```bash
# Check pending messages
curl http://localhost:3000/api/dm/pipeline/pending

# Approve (optionally edit message)
curl -X POST http://localhost:3000/api/dm/pipeline/pending/SEND_ID/approve \
  -H "Content-Type: application/json" \
  -d '{"message": "optional edited message"}'
```

## Components

### Instagram-DM.ts — Core Automation

Browser automation for Instagram DMs using Puppeteer.

| Method | Description |
|--------|-------------|
| `sendDM(recipient, message)` | Send DM to a user (searches by name) |
| `sendToExistingThread(username, message)` | Send to existing conversation |
| `scrapeInbox()` | List all conversations |
| `scrapeThread(username)` | Read messages from a thread |

### Instagram-DM-Watcher.ts — Inbox Monitoring

Polls the inbox for new messages and sends Telegram notifications.

| Function | Description |
|----------|-------------|
| `checkForNewDMs(dm)` | Compares inbox state to detect new messages |
| `scrapeFullInbox(dm)` | Full inbox scrape with scroll loading |
| `scrapeConversationThread(dm, username)` | Deep-scrape a single thread |
| `scrapeAllConversations(dm)` | Bulk deep-scrape multiple threads |

### Instagram-DM-AI.ts — Intelligence Layer

AI message generation and relationship tracking.

**Relationship Management:**
- Categories: `business_networking`, `personal`, `potential_client`, `collaborator`, `fan`
- Stages: `cold_outreach` → `initial_contact` → `building` → `warm` → `active`
- Warmth score: 0-100, auto-updated on interactions

**Warmth Events:**
| Event | Score Change |
|-------|-------------|
| `message_sent` | +5 |
| `reply_received` | +15 |
| `positive_reply` | +25 |
| `negative_reply` | -20 |
| `no_reply` | -5 |

**AI Generation:** Uses GPT-4o-mini with full context:
- Our profile (bio, follower count, niche)
- Their profile (bio, follower count, verified status)
- Conversation history (last 10 messages)
- Relationship state (category, warmth, stage, tags)
- Performance learnings from feedback data

### Instagram-DM-Pipeline.ts — Outreach Orchestration

End-to-end pipeline: target → scrape → categorize → AI message → approval → send → track.

**Pipeline Config:**
| Setting | Default | Description |
|---------|---------|-------------|
| `autoApprove` | `false` | Auto-send or require manual approval |
| `maxDMsPerDay` | `20` | Daily DM limit |
| `minDelayBetweenDMs` | `60000` | 1 minute between DMs |
| `cooldownHoursPerUser` | `48` | Don't DM same user within 48h |
| `maxFollowUps` | `3` | Max follow-ups per contact |
| `offerEnabled` | `true` | Include offers when warmth threshold met |

**Offer Matching:** Offers are presented when:
1. Relationship warmth >= offer's `minWarmth`
2. Relationship stage >= offer's `minStage`
3. Relationship category matches offer's `targetCategories`
4. Bio keywords match offer's `targetNiches`

### Instagram-DM-Analytics.ts — Feedback & Optimization

**Conversion Tracking:**
- Record conversions (sale, meeting, follow, collaboration, signup, referral)
- Stats: by type, by offer, conversion rate, avg DMs to convert

**AI Learning Loop:**
- `analyzeFeedbackAndLearn()` — Analyzes reply rates by category/stage
- Learnings injected into AI system prompt: "Based on past performance data: business_networking/warm: 45% reply rate..."
- Runs automatically each pipeline cycle

**Timing Optimization:**
- Tracks send-time vs reply-rate correlation
- `getBestSendingHours()` — Returns optimal hours sorted by reply rate
- Scheduler skips outreach during low-engagement hours

### Instagram-Profile.ts — Profile Scraping

Scrapes Instagram profiles for AI context. Cached for 24 hours.

Returns: username, fullName, bio, followerCount, followingCount, postCount, isVerified, category, externalUrl.

### Supabase Sync (Optional)

All data syncs to Supabase tables (see `supabase/migrations/007_dm_system.sql`):
- `dm_conversations` — Relationship data per contact
- `dm_messages` — All messages sent/received
- `dm_feedback` — Reply tracking and sentiment
- `dm_approvals` — Approval flow records
- `dm_templates` — Message templates with success rates

Sync is fire-and-forget — the system works fully offline with JSON files.

## API Reference

Base URL: `http://localhost:3000/api/dm`

### Stats & History

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/stats` | GET | DM statistics (total, today, verified) |
| `/conversations` | GET | List all stored conversations |
| `/conversations/:username` | GET | Get specific thread messages |
| `/history/:username` | GET | Get DM tracking history for user |
| `/inbox` | GET | Latest inbox snapshot |
| `/relationships` | GET | All relationship data |
| `/profiles` | GET | All cached profiles |
| `/feedback` | GET | Feedback loop stats |

### Approval Flow

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/approvals` | GET | List pending approvals |
| `/approvals` | POST | Create approval request |
| `/approvals/:id/approve` | POST | Approve a message |
| `/approvals/:id/reject` | POST | Reject a message |

### Pipeline Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/pipeline/status` | GET | Full pipeline status overview |
| `/pipeline/config` | GET | Get pipeline config |
| `/pipeline/config` | PUT | Update pipeline config |
| `/pipeline/offers` | GET | List all offers |
| `/pipeline/offers` | POST | Create new offer |
| `/pipeline/offers/:id` | PUT | Update offer |
| `/pipeline/offers/:id` | DELETE | Delete offer |
| `/pipeline/pending` | GET | List pending sends (`?status=pending\|approved\|all`) |
| `/pipeline/pending/:id/approve` | POST | Approve send (optional `{"message": "..."}` to edit) |
| `/pipeline/pending/:id/reject` | POST | Reject send |
| `/pipeline/targets` | GET | Get outreach target list |
| `/pipeline/targets` | POST | Add targets (`{"usernames": [...]}`) |
| `/pipeline/targets/:username` | DELETE | Remove target |

### Analytics & Conversions

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/analytics` | GET | Full analytics dashboard |
| `/analytics/conversions` | GET | Conversion statistics |
| `/analytics/conversions` | POST | Record a conversion |
| `/analytics/learnings` | GET | AI message learnings |
| `/analytics/learn` | POST | Trigger learning analysis |
| `/analytics/timing` | GET | Best sending hours |
| `/sync` | POST | Bulk sync local data to Supabase |

## Data Flow

1. **Watcher** polls inbox every 5 min → detects new DMs → stores locally → Telegram notification
2. **Pipeline** runs every 30 min:
   - Processes approved sends from the queue
   - Checks timing optimization → runs outreach on queued targets
   - Scrapes target profile → auto-categorizes → generates AI message
   - If `autoApprove`: sends immediately. Otherwise: queues for approval + Telegram alert
   - Checks for replies → records feedback → updates warmth
   - Runs learning analysis → updates AI prompts for next cycle
3. **API** provides dashboard access, manual approvals, offer management, analytics

## Safety

- Default `autoApprove: false` — all messages require manual approval
- 20 DMs/day limit (configurable)
- 48h cooldown per user
- Max 3 follow-ups if no reply
- Active hours enforcement (9 AM - 10 PM)
- Smart timing — skips low-engagement hours
- All outbound messages tracked and logged

## Testing

```bash
# Run DM system unit tests
npx jest tests/functional/dm-system.test.ts tests/functional/dm-routes.test.ts --verbose

# Run all tests
npm test
```

57 tests cover: categorization, warmth scoring, offer matching, pipeline config, pending sends CRUD, DM tracking, analytics, feedback stats, timing, and type validation.

## File Map

```
src/
├── client/
│   ├── Instagram-DM.ts           # Core DM automation
│   ├── Instagram-DM-Watcher.ts   # Inbox monitoring
│   ├── Instagram-DM-AI.ts        # AI messaging + relationships
│   ├── Instagram-DM-Pipeline.ts  # Outreach pipeline + offers
│   ├── Instagram-DM-Analytics.ts # Conversions + learnings + timing
│   └── Instagram-Profile.ts      # Profile scraping + cache
├── tracking/
│   └── dmTracker.ts              # File-based DM tracking
├── server/
│   └── dmRoutes.ts               # REST API (30+ endpoints)
├── db/
│   └── supabaseDM.ts             # Optional Supabase sync
├── types/
│   └── dm.ts                     # TypeScript interfaces
├── utils/
│   └── telegram.ts               # Notification helpers
└── dm-scheduler.ts               # PM2 entry point
```
