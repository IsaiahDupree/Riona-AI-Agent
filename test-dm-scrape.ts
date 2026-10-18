import { InstagramDM } from './src/client/Instagram-DM';
import { scrapeFullInbox, scrapeConversationThread, checkForNewDMs } from './src/client/Instagram-DM-Watcher';

const action = process.argv[2] || 'inbox';  // inbox, thread, watch

(async () => {
    const dm = new InstagramDM();
    try {
        await dm.initialize();
        console.log('[test] Browser ready');

        if (action === 'inbox') {
            console.log('[test] Scraping inbox...');
            const conversations = await scrapeFullInbox(dm);
            console.log(`[test] Found ${conversations.length} conversations:`);
            for (const c of conversations.slice(0, 15)) {
                console.log(`  - ${c.username}: ${c.lastMessage.slice(0, 60)}`);
            }
        } else if (action === 'thread') {
            const username = process.argv[3] || 'sarah ashley';
            console.log(`[test] Scraping thread with "${username}"...`);
            const convo = await scrapeConversationThread(dm, username);
            console.log(`[test] ${convo.messages.length} messages:`);
            for (const m of convo.messages.slice(-10)) {
                const prefix = m.isOurs ? '→ YOU' : '← THEM';
                console.log(`  ${prefix}: ${m.text.slice(0, 80)}`);
            }
        } else if (action === 'watch') {
            console.log('[test] Checking for new DMs...');
            const result = await checkForNewDMs(dm);
            console.log(`[test] New messages: ${result.newMessages.length}`);
            for (const msg of result.newMessages) {
                console.log(`  📩 @${msg.from}: ${msg.preview.slice(0, 60)}`);
            }
        }
    } catch (e: any) {
        console.error('[test] FATAL:', e.message);
    } finally {
        await dm.close();
        process.exit(0);
    }
})();
