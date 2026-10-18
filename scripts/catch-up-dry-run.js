/**
 * Dry-run catch-up: scans inbox for missed replies, generates AI responses,
 * but does NOT schedule or send anything.
 */
require('dotenv').config();
const { InstagramDM } = require('../build/client/Instagram-DM');
const { DMPipeline } = require('../build/client/Instagram-DM-Pipeline');

(async () => {
    const dm = new InstagramDM();
    try {
        console.log('\n🔍 Initializing browser...\n');
        await dm.initialize();

        const pipeline = new DMPipeline(dm, { autoApprove: true, maxDMsPerDay: 20 });
        console.log('🔍 Running catch-up in DRY RUN mode...\n');

        const result = await pipeline.catchUpMissedReplies({ dryRun: true, maxConversations: 20 });

        console.log('\n═══════════════════════════════════════════════');
        console.log('  CATCH-UP DRY RUN RESULTS');
        console.log('═══════════════════════════════════════════════');
        console.log(`  Processed:  ${result.processed}`);
        console.log(`  Replied:    ${result.replied}`);
        console.log(`  Skipped:    ${result.skipped}`);
        console.log(`  Failed:     ${result.failed}`);
        console.log('───────────────────────────────────────────────');

        for (const d of result.details) {
            const icon = d.action === 'replied' ? '✅' : d.action === 'skipped' ? '⏭️' : '❌';
            console.log(`  ${icon} @${d.username}: ${d.action} — ${d.reason || ''}`);
        }

        if (result.dryRunMessages && result.dryRunMessages.length > 0) {
            console.log('\n───────────────────────────────────────────────');
            console.log('  GENERATED REPLIES (not sent):');
            console.log('───────────────────────────────────────────────');
            for (const msg of result.dryRunMessages) {
                console.log(`\n  📩 @${msg.username} (delay: ${msg.delayMinutes}min${msg.isJackpot ? ' 🎰 JACKPOT' : ''}):`);
                console.log(`     "${msg.message}"`);
            }
        }

        console.log('\n═══════════════════════════════════════════════\n');
    } catch (e) {
        console.error('Error:', e);
    } finally {
        await dm.close();
    }
})();
