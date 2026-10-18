import { InstagramDM } from './src/client/Instagram-DM';

(async () => {
    console.log('[dm-test] Starting Instagram DM test...');
    const dm = new InstagramDM();

    try {
        await dm.initialize();
        console.log('[dm-test] Browser initialized, sending DM to sarah ashley...');

        const result = await dm.sendDM('sarah ashley', 'Hey! Just testing something on my end, you can ignore this lol 😄');

        console.log('[dm-test] RESULT:', JSON.stringify(result, null, 2));

        if (result.success) {
            console.log('[dm-test] ✅ DM sent successfully!');
            console.log(`[dm-test] Verified: ${result.verified}`);
        } else {
            console.log(`[dm-test] ❌ DM failed: ${result.error}`);
        }
    } catch (e: any) {
        console.error('[dm-test] FATAL:', e.message);
    } finally {
        await dm.close();
        process.exit(0);
    }
})();
