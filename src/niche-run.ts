import { runNicheBatch } from './client/Instagram-AI';
import { logger } from './utils/logger';
import dotenv from 'dotenv';

dotenv.config();

const args = process.argv.slice(2);
const niche = args[0];
const targetPosts = parseInt(args[1] || '150', 10);

if (!niche) {
    console.log('Usage: npx ts-node src/niche-run.ts <hashtag> [targetPosts]');
    console.log('  Example: npx ts-node src/niche-run.ts artificialintelligence 150');
    console.log('  Example: npx ts-node src/niche-run.ts fitness 200');
    process.exit(1);
}

async function main() {
    logger.info(`Starting niche run for #${niche} targeting ${targetPosts} posts`);
    console.log(`\n🎯 Niche: #${niche}`);
    console.log(`📊 Target: ${targetPosts} posts\n`);

    const startTime = Date.now();
    const result = await runNicheBatch(niche, targetPosts);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    console.log(`\n═══ Niche Batch Complete ═══`);
    console.log(`Hashtag:    #${niche}`);
    console.log(`Duration:   ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
    console.log(`Comments:   ${result.commentsPosted}`);
    console.log(`Verified:   ${result.session.commentsVerified}`);
    console.log(`Failed:     ${result.session.commentsFailed}`);
    console.log(`Duplicates: ${result.session.postsSkippedDuplicate}`);
    console.log(`Processed:  ${result.session.postsProcessed}`);
    if (result.session.errors.length > 0) {
        console.log(`Errors:     ${result.session.errors.length}`);
    }
    console.log(`═══════════════════════════\n`);
}

main().catch(err => {
    logger.error('Niche run failed:', err);
    process.exit(1);
});
