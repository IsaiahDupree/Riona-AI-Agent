import { InstagramDM } from './src/client/Instagram-DM';
import { scrapeProfile, scrapeOurProfile } from './src/client/Instagram-Profile';
import { generateDMMessage, categorizeContact, loadRelationship, saveRelationship } from './src/client/Instagram-DM-AI';
import { StoredConversation } from './src/client/Instagram-DM-Watcher';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
    const dm = new InstagramDM();
    try {
        await dm.initialize();
        const page = dm.getPage()!;

        // 1. Scrape our profile
        console.log('[test] Scraping our profile...');
        const ourProfile = await scrapeOurProfile(page);
        console.log(`[test] Us: @${ourProfile.username}, ${ourProfile.followerCount} followers`);
        console.log(`[test] Bio: ${ourProfile.bio?.slice(0, 80)}`);

        // 2. Scrape a target profile
        const target = process.argv[2] || 'saraheashley';
        console.log(`\n[test] Scraping target: @${target}...`);
        const theirProfile = await scrapeProfile(page, target);
        console.log(`[test] Them: @${theirProfile.username} (${theirProfile.fullName})`);
        console.log(`[test] Followers: ${theirProfile.followerCount}, Posts: ${theirProfile.postCount}`);
        console.log(`[test] Bio: ${theirProfile.bio?.slice(0, 80)}`);
        console.log(`[test] Verified: ${theirProfile.isVerified}`);

        // 3. Auto-categorize
        const autoCategory = categorizeContact(theirProfile);
        console.log(`\n[test] Auto-category: ${autoCategory.category}`);
        console.log(`[test] Tags: ${autoCategory.tags?.join(', ') || 'none'}`);

        // 4. Load/create relationship
        let relationship = loadRelationship(target);
        if (relationship.warmth === 0 && relationship.stage === 'cold_outreach') {
            // First time — apply auto-categorization
            relationship.category = autoCategory.category || relationship.category;
            relationship.tags = autoCategory.tags || [];
            saveRelationship(target, relationship);
        }
        console.log(`[test] Relationship: ${relationship.category}, warmth=${relationship.warmth}, stage=${relationship.stage}`);

        // 5. Generate AI message
        console.log('\n[test] Generating AI message...');
        const message = await generateDMMessage({
            ourProfile,
            theirProfile,
            conversationHistory: [],
            relationship
        });
        console.log(`[test] Generated message: "${message}"`);

        // 6. Generate for different scenarios
        console.log('\n[test] Generating for business networking scenario...');
        const bizMessage = await generateDMMessage({
            ourProfile,
            theirProfile,
            conversationHistory: [],
            relationship: { ...relationship, category: 'business_networking', stage: 'cold_outreach' }
        });
        console.log(`[test] Business message: "${bizMessage}"`);

        console.log('\n[test] Generating follow-up (warm stage)...');
        const warmMessage = await generateDMMessage({
            ourProfile,
            theirProfile,
            conversationHistory: [
                { sender: ourProfile.username, text: 'Hey! Love your content, especially the recent stuff on growth strategies.', timestamp: '', isOurs: true },
                { sender: target, text: 'Thanks! Yeah I\'ve been really focused on that lately. What do you do?', timestamp: '', isOurs: false },
                { sender: ourProfile.username, text: 'I\'m building AI-powered tools for content creators. Would love to chat more about it!', timestamp: '', isOurs: true },
                { sender: target, text: 'That sounds interesting! Tell me more', timestamp: '', isOurs: false }
            ],
            relationship: { ...relationship, category: 'potential_client', warmth: 65, stage: 'warm' }
        });
        console.log(`[test] Warm follow-up: "${warmMessage}"`);

    } catch (e: any) {
        console.error('[test] FATAL:', e.message);
    } finally {
        await dm.close();
        process.exit(0);
    }
})();
