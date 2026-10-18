/**
 * Test: Send 1 DM on Twitter via the full pipeline.
 */
require('dotenv').config();

async function testTwitterDM() {
    console.log('=== TWITTER DM TEST ===');
    const { TwitterDM } = require('./build/client/Twitter-DM');
    const { TwitterDMPipeline } = require('./build/client/Twitter-DM-Pipeline');
    const { hasSentTwitterDMTo } = require('./build/tracking/twitterDMTracker');
    const { safeReadJSON } = require('./build/utils/errors');
    const path = require('path');

    const dm = new TwitterDM();
    try {
        await dm.initialize();
        console.log('Browser initialized.');

        const pipeline = new TwitterDMPipeline(dm, { autoApprove: true });

        // Get targets
        const targetsFile = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'outreach_targets.json');
        let targets = safeReadJSON(targetsFile, [], 'tw_targets');

        // Fallback: known contacts who accept DMs
        if (targets.length === 0) {
            targets = ['saraheashley', 'maxecc', 'Zephyr_hg', 'lukepierceops', 'eliobldr', 'ognjengatalo'];
        }

        // Find candidates not on cooldown
        const candidates = targets.filter(t => {
            const onCooldown = hasSentTwitterDMTo(t, 48);
            return !onCooldown;
        }).slice(0, 5);

        console.log('Candidates (' + candidates.length + '):', candidates);

        if (candidates.length === 0) {
            console.log('No eligible targets (all on cooldown)');
            return;
        }

        let sent = false;
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
                    sent = true;
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

        if (!sent) {
            console.log('\nCould not send DM to any candidate');
        }
    } catch (err) {
        console.error('Test failed:', err.message);
        console.error(err.stack);
    } finally {
        await dm.close();
    }
}

testTwitterDM().catch(console.error);
