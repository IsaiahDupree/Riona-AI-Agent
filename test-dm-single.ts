/**
 * Test: Send 1 DM on Instagram and 1 DM on Twitter via the full pipeline.
 * Usage: npm run build && node build/test-dm-single.js
 */

import dotenv from 'dotenv';
dotenv.config();

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function testTwitterDM() {
    console.log('\n═══ TWITTER DM TEST ═══');
    const { TwitterDM } = await import('./build/client/Twitter-DM');
    const { TwitterDMPipeline } = await import('./build/client/Twitter-DM-Pipeline');
    const { hasSentTwitterDMTo } = await import('./src/tracking/twitterDMTracker');

    const dm = new TwitterDM();
    try {
        await dm.initialize();
        const pipeline = new TwitterDMPipeline(dm, { autoApprove: true });

        // Get targets from today's Twitter reply list (people we've engaged with)
        const { safeReadJSON } = await import('./src/utils/errors');
        const path = await import('path');

        // First try outreach_targets
        const targetsFile = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'outreach_targets.json');
        let targets = safeReadJSON<string[]>(targetsFile, [], 'tw_targets');

        // Fallback: use today's replied users
        if (targets.length === 0) {
            const twStats = safeReadJSON<any>(
                path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'daily_stats.json'),
                null, 'tw_daily'
            );
            targets = twStats?.uniqueUsersReplied || [];
        }

        // Find first target not on cooldown
        let target: string | undefined;
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

        console.log(`Sending DM to Twitter user: @${target}`);
        const result = await pipeline.processTarget(target);

        if (result) {
            console.log(`✓ Twitter DM result:`, {
                recipient: result.recipientUsername,
                status: result.status,
                message: result.message?.slice(0, 80) + '...',
            });
        } else {
            console.log('✗ Pipeline returned null (user may be on cooldown or max follow-ups reached)');
        }
    } catch (err) {
        console.error('Twitter DM test failed:', err);
    } finally {
        await dm.close();
    }
}

async function testInstagramDM() {
    console.log('\n═══ INSTAGRAM DM TEST ═══');
    const { InstagramDM } = await import('./src/client/Instagram-DM');
    const { DMPipeline } = await import('./src/client/Instagram-DM-Pipeline');

    const dm = new InstagramDM();
    try {
        await dm.initialize();
        const pipeline = new DMPipeline(dm, { autoApprove: true });

        // Pick a target
        const { safeReadJSON } = await import('./src/utils/errors');
        const path = await import('path');
        const targetsFile = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'outreach_targets.json');
        const targets = safeReadJSON<string[]>(targetsFile, [], 'ig_targets');

        // Combine outreach targets with today's commenters
        if (targets.length === 0) {
            console.log('No IG outreach targets found. Using recent commenters...');
            const commentsFile = path.join(process.cwd(), 'logs', 'tracking', 'daily_stats.json');
            const stats = safeReadJSON<any>(commentsFile, null, 'ig_daily');
            targets = stats?.uniqueUsersCommented || [];
        }

        // Find first target not on cooldown
        const { hasSentDMTo } = await import('./src/tracking/dmTracker');
        let target: string | undefined;
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
            console.log(`✓ Instagram DM result:`, {
                recipient: result.recipientUsername,
                status: result.status,
                message: result.message?.slice(0, 80) + '...',
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
