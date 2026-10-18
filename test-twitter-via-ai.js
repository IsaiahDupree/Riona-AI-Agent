/**
 * Test: Use TwitterAI (which works) to launch browser, then use TwitterDM.fromPage() for DMs
 * This is how the twitter-scheduler does it — single browser, shared page.
 */
require('dotenv').config();

async function test() {
    console.log('=== TWITTER TEST (via TwitterAI + shared page) ===');
    const { TwitterAI } = require('./build/client/Twitter-AI');
    const { TwitterDM } = require('./build/client/Twitter-DM');
    const { TwitterDMPipeline } = require('./build/client/Twitter-DM-Pipeline');
    const { hasSentTwitterDMTo } = require('./build/tracking/twitterDMTracker');
    const { safeReadJSON } = require('./build/utils/errors');
    const path = require('path');

    const ai = new TwitterAI();
    try {
        await ai.initialize();
        const page = ai.getPage();
        console.log('TwitterAI initialized. Logged in:', ai.isLoggedIn);
        console.log('URL:', page.url());

        // Create DM instance sharing the same page
        const dm = TwitterDM.fromPage(page);
        const pipeline = new TwitterDMPipeline(dm, { autoApprove: true });

        // Get targets
        const targetsFile = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'outreach_targets.json');
        let targets = safeReadJSON(targetsFile, [], 'tw_targets');

        if (targets.length === 0) {
            targets = ['saraheashley', 'maxecc', 'Zephyr_hg', 'lukepierceops', 'eliobldr', 'ognjengatalo'];
        }

        const candidates = targets.filter(t => {
            return !hasSentTwitterDMTo(t, 48);
        }).slice(0, 5);

        console.log('Candidates (' + candidates.length + '):', candidates);

        if (candidates.length === 0) {
            console.log('No eligible targets');
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
                    console.log('  Skipped (null)');
                }
            } catch (e) {
                console.log('  Error: ' + e.message);
            }
        }

        if (!sent) console.log('\nCould not send DM to any candidate');
    } catch (err) {
        console.error('Test failed:', err.message);
    } finally {
        await ai.close();
    }
}

test().catch(console.error);
