/**
 * Live DM Pipeline Test
 * Exercises the full pipeline: profile scrape → categorize → AI message → approval queue
 * Also syncs data to Supabase
 */

import { InstagramDM } from './src/client/Instagram-DM';
import { scrapeProfile, scrapeOurProfile } from './src/client/Instagram-Profile';
import {
    generateDMMessage, categorizeContact, loadRelationship, saveRelationship,
    getFeedbackStats
} from './src/client/Instagram-DM-AI';
import {
    DMPipeline, loadConfig, saveConfig, loadOffers, loadPendingSends,
    matchOffer
} from './src/client/Instagram-DM-Pipeline';
import {
    getFullAnalytics, getConversionStats, isGoodSendingTime, getBestSendingHours,
    analyzeFeedbackAndLearn
} from './src/client/Instagram-DM-Analytics';
import { bulkSyncToSupabase } from './src/db/supabaseDM';
import { getTodayDMCount } from './src/tracking/dmTracker';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const TARGETS = (process.argv[2] || 'saraheashley').split(',');
const AUTO_SEND = process.argv.includes('--auto-send');

(async () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║       Riona DM Pipeline — Live Test                    ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  Targets:     ${TARGETS.join(', ').padEnd(40)}║`);
    console.log(`║  Auto-send:   ${AUTO_SEND ? 'YES' : 'NO (queue for approval)'}${' '.repeat(AUTO_SEND ? 24 : 9)}║`);
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');

    const dm = new InstagramDM();

    try {
        // ── Step 1: Initialize browser ──
        console.log('[1/8] Initializing browser...');
        await dm.initialize();
        const page = dm.getPage()!;
        console.log('      ✅ Browser ready\n');

        // ── Step 2: Scrape our profile ──
        console.log('[2/8] Scraping our profile...');
        const ourProfile = await scrapeOurProfile(page);
        console.log(`      ✅ @${ourProfile.username} | ${ourProfile.followerCount} followers`);
        console.log(`      Bio: "${ourProfile.bio?.slice(0, 80) || 'N/A'}"\n`);

        // ── Step 3: Scrape target profiles ──
        for (const target of TARGETS) {
            console.log(`[3/8] Scraping target: @${target}...`);
            const theirProfile = await scrapeProfile(page, target);
            console.log(`      ✅ @${theirProfile.username} (${theirProfile.fullName})`);
            console.log(`      Followers: ${theirProfile.followerCount} | Posts: ${theirProfile.postCount} | Verified: ${theirProfile.isVerified}`);
            console.log(`      Bio: "${theirProfile.bio?.slice(0, 80) || 'N/A'}"\n`);

            // ── Step 4: Auto-categorize ──
            console.log(`[4/8] Categorizing @${target}...`);
            const autoCategory = categorizeContact(theirProfile);
            console.log(`      Category: ${autoCategory.category}`);
            console.log(`      Tags: ${autoCategory.tags?.join(', ') || 'none'}`);

            // Load/create relationship
            let relationship = loadRelationship(target);
            if (relationship.warmth === 0 && relationship.stage === 'cold_outreach') {
                relationship.category = autoCategory.category || relationship.category;
                relationship.tags = autoCategory.tags || [];
                saveRelationship(target, relationship);
            }
            console.log(`      Relationship: warmth=${relationship.warmth}, stage=${relationship.stage}\n`);

            // ── Step 5: Check offer match ──
            console.log(`[5/8] Checking offer match for @${target}...`);
            const offers = loadOffers();
            const offer = matchOffer(theirProfile, relationship);
            if (offer) {
                console.log(`      ✅ Matched offer: "${offer.name}" (min warmth: ${offer.minWarmth})`);
            } else {
                console.log(`      ⏳ No offer match yet (warmth ${relationship.warmth} < thresholds)`);
            }
            console.log('');

            // ── Step 6: Generate AI message ──
            console.log(`[6/8] Generating AI message for @${target}...`);
            const message = await generateDMMessage({
                ourProfile,
                theirProfile,
                conversationHistory: [],
                relationship,
                objective: offer?.messageHint
            });
            console.log(`      ✅ Message: "${message}"\n`);

            // ── Step 7: Pipeline process ──
            console.log(`[7/8] Running pipeline for @${target}...`);
            const config = loadConfig();
            if (AUTO_SEND) {
                config.autoApprove = true;
                saveConfig(config);
            }

            const pipeline = new DMPipeline(dm, config);
            const result = await pipeline.processTarget(target);

            if (result) {
                console.log(`      Status: ${result.status}`);
                console.log(`      Message: "${result.message.slice(0, 80)}..."`);
                if (result.status === 'pending') {
                    console.log(`      ID: ${result.id} (approve via API)`);
                } else if (result.status === 'sent') {
                    console.log(`      ✅ DM sent successfully!`);
                }
            } else {
                console.log(`      ⏭️  Skipped (cooldown or max follow-ups)`);
            }
            console.log('');
        }

        // ── Step 8: Analytics + Supabase sync ──
        console.log('[8/8] Analytics & Supabase sync...');

        // Run learning analysis
        const learnings = analyzeFeedbackAndLearn();
        console.log(`      Learnings generated: ${learnings.length}`);

        // Timing check
        const timing = isGoodSendingTime();
        console.log(`      Current timing: ${timing.good ? '✅ Good' : '⏳ Not ideal'} — ${timing.reason}`);

        // Today stats
        const todayCount = getTodayDMCount();
        const pConfig = loadConfig();
        console.log(`      Today DMs: ${todayCount}/${pConfig.maxDMsPerDay}`);

        // Full analytics
        const analytics = getFullAnalytics();
        console.log(`      Feedback: ${analytics.feedback.totalSent} sent, ${analytics.feedback.gotReply} replied (${analytics.feedback.replyRate}%)`);
        console.log(`      Conversions: ${analytics.conversions.totalConversions}`);

        // Pending sends
        const pending = loadPendingSends().filter(s => s.status === 'pending');
        const approved = loadPendingSends().filter(s => s.status === 'approved');
        console.log(`      Pending approval: ${pending.length} | Approved (unsent): ${approved.length}`);

        // Supabase sync
        console.log('\n      Syncing to Supabase...');
        const syncResult = await bulkSyncToSupabase();
        if (syncResult.errors.length > 0 && syncResult.errors[0] === 'Supabase not configured') {
            console.log('      ⚠️  Supabase not configured — skipping sync');
        } else {
            console.log(`      ✅ Synced: ${syncResult.conversations} convos, ${syncResult.messages} msgs, ${syncResult.feedback} feedback`);
            if (syncResult.errors.length > 0) {
                console.log(`      ⚠️  ${syncResult.errors.length} sync error(s)`);
            }
        }

        // ── Summary ──
        console.log('\n╔══════════════════════════════════════════════════════════╗');
        console.log('║                    Pipeline Complete                    ║');
        console.log('╠══════════════════════════════════════════════════════════╣');
        for (const send of loadPendingSends().filter(s => s.status === 'pending')) {
            console.log(`║  📩 Pending: @${send.recipientUsername.padEnd(20)} ${send.id.slice(0, 15)}...  ║`);
        }
        console.log('╠══════════════════════════════════════════════════════════╣');
        console.log('║  Approve via:                                          ║');
        console.log('║  curl -X POST localhost:3000/api/dm/pipeline/          ║');
        console.log('║       pending/SEND_ID/approve                          ║');
        console.log('╚══════════════════════════════════════════════════════════╝');

    } catch (e: any) {
        console.error('\n❌ FATAL:', e.message);
        console.error(e.stack);
    } finally {
        await dm.close();
        process.exit(0);
    }
})();
