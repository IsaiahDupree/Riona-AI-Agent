import { runThreadsBatch } from './src/client/Threads-AI';
import { runNicheBatch } from './src/client/Instagram-AI';

const platform = process.argv[2] || 'threads';

async function testThreads() {
    console.log('[test] Starting Threads test (3 posts)...');
    const result = await runThreadsBatch(process.env.THREADS_BOT_USERNAME || 'the_isaiah_dupree_', 3);
    console.log('[test] THREADS RESULT:', JSON.stringify({
        comments: result.commentsPosted,
        verified: result.session.commentsVerified,
        failed: result.session.commentsFailed,
        errors: result.session.errors.length
    }, null, 2));
}

async function testInstagram() {
    console.log('[test] Starting Instagram niche test (3 posts)...');
    const result = await runNicheBatch('artificialintelligence', 3);
    console.log('[test] INSTAGRAM RESULT:', JSON.stringify({
        comments: result.commentsPosted,
        verified: result.session.commentsVerified,
        failed: result.session.commentsFailed,
        errors: result.session.errors.length
    }, null, 2));
}

(async () => {
    try {
        if (platform === 'threads') await testThreads();
        else if (platform === 'instagram') await testInstagram();
        else console.log('[test] Unknown platform:', platform);
    } catch (e: any) {
        console.error('[test] FATAL:', e.message);
    }
    process.exit(0);
})();
