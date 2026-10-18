# Changelog


## 2026-05-12 — ad1ebb7

feat: instagram/twitter DM pipelines, niche performance tracking, scheduler updates

Files changed:
   riona.bat                                 | 145 +++++
   scripts/check-recent-activity.js          | 171 ++++++
   src/browser/BrowserPool.ts                |   1 +
   src/client/Instagram-Core.ts              |  47 +-
   src/client/Instagram-DM-Pipeline.ts       |   5 +-
   src/client/Instagram-DM.ts                |  16 +-
   src/client/Threads-AI.ts                  | 214 +++++++-
   src/client/Twitter-Core.ts                |  95 +++-
   src/client/Twitter-DM-Pipeline.ts         |   5 +-
   src/client/Twitter-DM.ts                  |  72 ++-
   src/client/Twitter-Reply-Handler.ts       |  22 +
   src/client/Twitter.ts                     |   1 +
   src/scheduler.ts                          |  66 ++-
   src/tracking/commentTracker.ts            |  89 +++
   src/tracking/nichePerformance.ts          | 149 +++++
   src/twitter-scheduler.ts                  |   6 +-
   src/utils/ai.ts                           | 124 +++--
   tests/functional/bot-improvements.test.ts | 882 ++++++++++++++++++++++++++++++
   18 files changed, 2000 insertions(+), 110 deletions(-)
