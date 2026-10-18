/**
 * Test: Send 1 DM on Instagram and 1 DM on Twitter via the full pipeline.
 * Usage: npm run build && node test-dm-single.js
 */

require('dotenv').config();

const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function testTwitterDM() {
    console.log('\n═══ TWITTER DM TEST ═══');
    const { TwitterDM } = require('./build/client/Twitter-DM');
    const { TwitterDMPipeline } = require('./build/client/Twitter-DM-Pipeline');
    const { hasSentTwitterDMTo } = require('./build/tracking/twitterDMTracker');
    const { safeReadJSON } = require('./build/utils/errors');
    const path = require('path');

    const dm = new TwitterDM();
    try {
        await dm.initialize();
        const pipeline = new TwitterDMPipeline(dm, { autoApprove: true });

        // First try outreach_targets
        const targetsFile = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'outreach_targets.json');
        let targets = safeReadJSON(targetsFile, [], 'tw_targets');

        // Fallback 1: existing DM contacts from previous conversations
        if (targets.length === 0) {
            // These are known contacts who accept DMs (from existing inbox)
            targets = ['saraheashley', 'maxecc', 'Zephyr_hg', 'lukepierceops', 'eliobldr', 'ognjengatalo'];
        }

        // Fallback 2: use today's replied users
        if (targets.length === 0) {
            const twStats = safeReadJSON(
                path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'daily_stats.json'),
                null, 'tw_daily'
            );
            targets = (twStats && twStats.uniqueUsersReplied) || [];
        }

        // Find first target not on cooldown
        // Prioritize users with open DMs (verified accounts, larger followings)
        let target;
        for (const t of targets) {
            if (!hasSentTwitterDMTo(t, 48)) {
                target = t;
                break;
            }
        }

        if (!target) {
            console.log('No eligible Twitter DM targets found (all on cooldown). Exiting.');
            return;
        }

        console.log(`Selected target: @${target} (first non-cooldown from ${targets.length} candidates)`);

        // Try up to 5 targets in case some don't accept DMs
        const candidates = targets.filter(t => !hasSentTwitterDMTo(t, 48)).slice(0, 5);
        let sent = false;

        for (const candidate of candidates) {
            console.log(`Trying DM to Twitter user: @${candidate}...`);
            const result = await pipeline.processTarget(candidate);

            if (result && result.status === 'sent') {
                console.log('✓ Twitter DM result:', {
                    recipient: result.recipientUsername,
                    status: result.status,
                    message: (result.message || '').slice(0, 80) + '...',
                });
                sent = true;
                break;
            } else if (result) {
                console.log(`  ↳ @${candidate}: ${result.status} — ${result.error || 'trying next...'}`);
            } else {
                console.log(`  ↳ @${candidate}: skipped by pipeline`);
            }
        }

        if (!sent) {
            console.log('✗ Could not send DM to any of the candidates (DMs may be restricted)');
        }
    } catch (err) {
        console.error('Twitter DM test failed:', err);
    } finally {
        await dm.close();
    }
}

async function testInstagramDM() {
    console.log('\n═══ INSTAGRAM DM TEST ═══');
    const { InstagramDM } = require('./build/client/Instagram-DM');
    const { DMPipeline } = require('./build/client/Instagram-DM-Pipeline');
    const { hasSentDMTo } = require('./build/tracking/dmTracker');
    const { safeReadJSON } = require('./build/utils/errors');
    const path = require('path');

    const dm = new InstagramDM();
    try {
        await dm.initialize();
        const pipeline = new DMPipeline(dm, { autoApprove: true });

        // Pick targets
        const targetsFile = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'outreach_targets.json');
        let targets = safeReadJSON(targetsFile, [], 'ig_targets');

        // Fallback: today's commenters
        if (targets.length === 0) {
            console.log('No IG outreach targets found. Using recent commenters...');
            const stats = safeReadJSON(
                path.join(process.cwd(), 'logs', 'tracking', 'daily_stats.json'),
                null, 'ig_daily'
            );
            targets = (stats && stats.uniqueUsersCommented) || [];
        }

        // Find first target not on cooldown
        let target;
        for (const t of targets) {
            if (!hasSentDMTo(t, 48)) {
                target = t;
                break;
            }
        }

        if (!target) {
            console.log('No eligible IG DM targets (all on cooldown). Exiting.');
            return;
        }

        console.log(`Sending DM to Instagram user: @${target}`);
        const result = await pipeline.processTarget(target);

        if (result) {
            console.log('✓ Instagram DM result:', {
                recipient: result.recipientUsername,
                status: result.status,
                message: (result.message || '').slice(0, 80) + '...',
            });
        } else {
            console.log('✗ Pipeline returned null (user may be on cooldown or max follow-ups reached)');
        }
    } catch (err) {
        console.error('Instagram DM test failed:', err);
    } finally {
        await dm.close();
    }
}

async function main() {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  DM Test: 1 Instagram + 1 Twitter DM       ║');
    console.log('╚══════════════════════════════════════════════╝');

    // Run sequentially to avoid browser conflicts
    await testTwitterDM();
    await delay(3000);
    await testInstagramDM();

    console.log('\n═══ TEST COMPLETE ═══');
}

main().catch(console.error);
