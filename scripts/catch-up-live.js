/**
 * Live catch-up: scans inbox for missed replies, generates AI responses,
 * and schedules them via VI delays for actual sending.
 */
require('dotenv').config();
const { InstagramDM } = require('../build/client/Instagram-DM');
const { DMPipeline } = require('../build/client/Instagram-DM-Pipeline');

(async () => {
    const dm = new InstagramDM();
    try {
        console.log('\n🚀 Initializing browser...\n');
        await dm.initialize();

        const pipeline = new DMPipeline(dm, { autoApprove: true, maxDMsPerDay: 20 });
        console.log('🚀 Running catch-up LIVE — replies will be scheduled via VI delays...\n');

        const result = await pipeline.catchUpMissedReplies({ maxConversations: 20 });

        console.log('\n═══════════════════════════════════════════════');
        console.log('  CATCH-UP LIVE RESULTS');
        console.log('═══════════════════════════════════════════════');
        console.log(`  Processed:  ${result.processed}`);
        console.log(`  Scheduled:  ${result.replied}`);
        console.log(`  Skipped:    ${result.skipped}`);
        console.log(`  Failed:     ${result.failed}`);
        console.log('───────────────────────────────────────────────');

        for (const d of result.details) {
            const icon = d.action === 'replied' ? '✅' : d.action === 'skipped' ? '⏭️' : '❌';
            console.log(`  ${icon} @${d.username}: ${d.action} — ${d.reason || ''}`);
        }

        console.log('\n═══════════════════════════════════════════════');

        if (result.replied > 0) {
            console.log(`\n⏳ ${result.replied} replies scheduled. Run the DM scheduler to send them when ready.`);
            console.log('   Start with: pm2 start build/dm-scheduler.js --name dm-scheduler\n');
        }

        // Now process any ready delayed replies immediately
        console.log('📤 Checking for ready delayed replies to send now...');
        const sendResult = await pipeline.processDelayedReplies();
        if (sendResult.sent > 0) {
            console.log(`✅ Sent ${sendResult.sent} delayed reply(ies)!`);
        } else {
            console.log('⏳ No replies ready yet (still in VI delay window).');
        }

        console.log('');
    } catch (e) {
        console.error('Error:', e);
    } finally {
        await dm.close();
    }
})();
