/**
 * Test: DM a new person on Twitter (someone we engaged with today)
 */
require('dotenv').config();

async function test() {
    console.log('═══ TWITTER DM — NEW PERSON TEST ═══');
    const { TwitterDM } = require('./build/client/Twitter-DM');
    const { TwitterDMPipeline } = require('./build/client/Twitter-DM-Pipeline');
    const dm = new TwitterDM();
    try {
        await dm.initialize();
        const pipeline = new TwitterDMPipeline(dm, { autoApprove: true });

        // Try several people we replied to today — many may have DMs closed
        const candidates = ['mattwelter', 'hasantoxr', 'thisdudelikesAI', 'justbyte_', 'natiakourdadze', 'ajikangelo'];
        let sent = false;

        for (const target of candidates) {
            console.log(`Trying DM to @${target}...`);
            const result = await pipeline.processTarget(target);
            if (result && result.status === 'sent') {
                console.log(`SUCCESS! DM sent to @${result.recipientUsername}`);
                console.log(`Message: ${(result.message || '').slice(0, 100)}`);
                sent = true;
                break;
            } else if (result) {
                console.log(`  => ${result.status}: ${result.error || ''}`);
            } else {
                console.log(`  => Pipeline returned null`);
            }
        }
        if (!sent) console.log('Could not DM any new candidates (DMs may be closed)');
    } catch (err) {
        console.error('Test failed:', err);
    } finally {
        await dm.close();
    }
}

test().catch(console.error);
