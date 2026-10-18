/**
 * Test: Multi-Niche Blitz — 10 replies across 10 niches
 *
 * Usage: npx ts-node test-multi-niche.ts
 *
 * Targets 1 reply per niche (10 total) across 10 different search terms.
 * Expected duration: ~5-8 minutes.
 *
 * For 10 replies per niche (100 total), change REPLIES_PER_NICHE to 10.
 * Expected duration: ~25-30 minutes.
 */

import dotenv from 'dotenv';
dotenv.config();

const NICHES = [
    'artificialintelligence',
    'machinelearning',
    'techstartups',
    'aitools',
    'deeplearning',
    'promptengineering',
    'futuretech',
    'automation',
    'digitalmarketing',
    'entrepreneurship',
];

const REPLIES_PER_NICHE = 1; // Change to 10 for full 100-reply blitz

async function main() {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║     Multi-Niche Blitz Test                         ║');
    console.log(`║     ${NICHES.length} niches x ${REPLIES_PER_NICHE} reply/niche = ${NICHES.length * REPLIES_PER_NICHE} target replies     ║`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('');

    const { runMultiNicheBlitz } = await import('./src/client/Twitter-AI');

    const result = await runMultiNicheBlitz(NICHES, REPLIES_PER_NICHE, {
        delayBetweenReplies: [3000, 5000],
        delayBetweenNiches: 2000,
        maxScrollsPerNiche: 3,
    });

    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`Total replies: ${result.totalReplies}/${NICHES.length * REPLIES_PER_NICHE}`);
    console.log(`Duration: ${result.durationSec}s (${(result.durationSec / 60).toFixed(1)} min)`);
    console.log('');
    console.log('Per-niche breakdown:');
    for (const [niche, count] of Object.entries(result.perNiche)) {
        console.log(`  ${count}/${REPLIES_PER_NICHE}  ${niche}`);
    }
    console.log('');
    console.log(`Session: ${result.session.sessionId}`);
    console.log(`Processed: ${result.session.tweetsProcessed} | Skipped: ${result.session.tweetsSkippedDuplicate} | Failed: ${result.session.repliesFailed}`);
    if (result.session.errors.length > 0) {
        console.log(`Errors: ${result.session.errors.length}`);
    }
    console.log('═══════════════════════════════════════════════════════');

    // Close browser
    if (result.twitterAI) {
        await result.twitterAI.close();
    }

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
