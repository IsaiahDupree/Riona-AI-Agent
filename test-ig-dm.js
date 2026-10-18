/**
 * Test: Send 1 DM on Instagram via the full pipeline (VPN test).
 */
require('dotenv').config();

async function testInstagramDM() {
    console.log('=== INSTAGRAM DM TEST ===');
    const { InstagramDM } = require('./build/client/Instagram-DM');
    const { DMPipeline } = require('./build/client/Instagram-DM-Pipeline');
    const { hasSentDMTo } = require('./build/tracking/dmTracker');
    const { safeReadJSON } = require('./build/utils/errors');
    const path = require('path');

    const dm = new InstagramDM();
    try {
        await dm.initialize();
        console.log('Browser initialized. Navigating to Instagram...');
        const pipeline = new DMPipeline(dm, { autoApprove: true });

        const targetsFile = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'outreach_targets.json');
        let targets = safeReadJSON(targetsFile, [], 'ig_targets');

        if (targets.length === 0) {
            const stats = safeReadJSON(path.join(process.cwd(), 'logs', 'tracking', 'daily_stats.json'), null, 'ig_daily');
            targets = (stats && stats.uniqueUsersCommented) || [];
        }

        // Find first 5 not on cooldown
        const candidates = targets.filter(t => {
            const onCooldown = hasSentDMTo(t, 48);
            return !onCooldown;
        }).slice(0, 5);
        console.log('Candidates (' + candidates.length + '):', candidates);

        if (candidates.length === 0) {
            console.log('No eligible targets (all on cooldown)');
            return;
        }

        for (const candidate of candidates) {
            console.log('\nTrying DM to: @' + candidate);
            try {
                const result = await pipeline.processTarget(candidate);
                if (result && result.status === 'sent') {
                    console.log('SUCCESS:', JSON.stringify({
                        recipient: result.recipientUsername,
                        status: result.status,
                        message: (result.message || '').slice(0, 100) + '...',
                    }, null, 2));
                    break;
                } else if (result) {
                    console.log('  Result: ' + result.status + ' ' + (result.error || ''));
                } else {
                    console.log('  Skipped (null result)');
                }
            } catch (e) {
                console.log('  Error: ' + e.message);
            }
        }
    } catch (err) {
        console.error('Test failed:', err.message);
        console.error(err.stack);
    } finally {
        await dm.close();
    }
}

testInstagramDM().catch(console.error);
