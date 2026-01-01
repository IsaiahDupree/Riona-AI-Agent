/**
 * Safari DM Test
 * 
 * Tests Instagram DM automation using the real Safari browser via AppleScript.
 * This uses your actual Safari session with existing cookies/login.
 * 
 * Run with: npm run test:safari:dm
 * 
 * Prerequisites:
 * 1. Safari Developer Menu enabled: Safari → Settings → Advanced → Show features for web developers
 * 2. Terminal/IDE has Automation permission: System Settings → Privacy & Security → Automation
 * 3. Already logged into Instagram in Safari
 */

import SafariController, { ConversationInfo, MessageInfo, NoteInfo } from './SafariController';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runSafariDMTest(): Promise<void> {
    const controller = new SafariController(60000); // 60s timeout

    console.log('\n🍎 Safari Instagram DM Test\n');
    console.log('This test uses your REAL Safari browser with existing login.\n');

    try {
        // Step 1: Launch Safari and navigate to Instagram DMs
        console.log('📱 Step 1: Navigating to Instagram DMs...');
        const launched = await controller.launchSafari('https://www.instagram.com/direct/inbox/');
        if (!launched) {
            throw new Error('Failed to launch Safari');
        }
        await delay(5000); // Wait for page to load

        // Step 2: Check page state
        console.log('🔍 Step 2: Checking page state...');
        const state = await controller.getPageState();
        console.log(`   URL: ${state.url}`);
        console.log(`   Logged in: ${state.loggedIn}`);
        console.log(`   DM Inbox: ${state.hasDMInbox}`);
        console.log(`   Conversations visible: ${state.conversationCount}`);

        if (!state.loggedIn) {
            console.log('\n⚠️  You need to be logged into Instagram in Safari first!');
            console.log('   1. Open Safari manually');
            console.log('   2. Go to instagram.com and log in');
            console.log('   3. Run this test again\n');
            return;
        }

        // Step 3: Check all DM tabs (Primary, General, Requests)
        console.log('\n📂 Step 3: Checking all DM tabs...');
        
        console.log('   → Checking Primary tab...');
        await controller.clickDMTab('primary');
        await delay(2000);
        const primaryConvs = await controller.getConversations();
        console.log(`   ✓ Primary: ${primaryConvs.length} conversations`);

        console.log('   → Checking General tab...');
        await controller.clickDMTab('general');
        await delay(2000);
        const generalConvs = await controller.getConversations();
        console.log(`   ✓ General: ${generalConvs.length} conversations`);

        console.log('   → Checking Requests tab...');
        await controller.clickDMTab('requests');
        await delay(2000);
        const requestConvs = await controller.getConversations();
        console.log(`   ✓ Requests: ${requestConvs.length} conversations`);

        // Go back to Primary
        await controller.clickDMTab('primary');
        await delay(2000);

        // Step 4: Scroll to load more conversations
        console.log('\n📜 Step 4: Scrolling to load more conversations...');
        let prevCount = 0;
        let currentCount = primaryConvs.length;
        let scrolls = 0;

        while (scrolls < 5) {
            prevCount = currentCount;
            currentCount = await controller.scrollConversationList('down');
            scrolls++;
            console.log(`   Scroll ${scrolls}: ${currentCount} conversations loaded`);
            await delay(1000);
            
            if (currentCount === prevCount) {
                console.log('   ✓ Reached end of conversation list');
                break;
            }
        }

        // Step 5: Get all conversation data
        console.log('\n💬 Step 5: Getting conversation details...');
        const allConversations = await controller.getConversations();
        
        console.log(`\n   Found ${allConversations.length} total conversations:\n`);
        
        const displayLimit = Math.min(10, allConversations.length);
        for (let i = 0; i < displayLimit; i++) {
            const conv = allConversations[i];
            const unreadIcon = conv.isUnread ? '🔵' : '  ';
            const groupIcon = conv.isGroup ? '👥' : '👤';
            console.log(`   ${unreadIcon} ${groupIcon} ${conv.username}`);
            if (conv.lastMessage) {
                console.log(`         "${conv.lastMessage.substring(0, 50)}${conv.lastMessage.length > 50 ? '...' : ''}"`);
            }
        }

        if (allConversations.length > displayLimit) {
            console.log(`\n   ... and ${allConversations.length - displayLimit} more conversations`);
        }

        // Step 6: Open first conversation and read messages
        if (allConversations.length > 0) {
            console.log('\n📖 Step 6: Opening first conversation to read messages...');
            
            const firstConv = allConversations[0];
            console.log(`   Opening conversation with: ${firstConv.username}`);
            
            const opened = await controller.clickConversation(0);
            if (opened) {
                await delay(3000);
                
                const messages = await controller.getMessagesFromConversation();
                console.log(`   ✓ Found ${messages.length} messages\n`);
                
                // Show last 5 messages
                const recentMessages = messages.slice(-5);
                for (const msg of recentMessages) {
                    const sender = msg.isFromMe ? 'You' : firstConv.username;
                    const typeIcon = msg.type === 'image' ? '🖼️' : 
                                    msg.type === 'video' ? '🎬' : 
                                    msg.type === 'link' ? '🔗' : '💬';
                    console.log(`   ${typeIcon} ${sender}: ${msg.content.substring(0, 60)}${msg.content.length > 60 ? '...' : ''}`);
                }

                // Go back to inbox
                console.log('\n   → Going back to inbox...');
                await controller.goBackToInbox();
            } else {
                console.log('   ✗ Could not open conversation');
            }
        }

        // Step 7: Iterate through multiple conversations (optional)
        const iterateAll = process.env.DM_ITERATE_ALL === 'true';
        if (iterateAll && allConversations.length > 1) {
            console.log('\n🔄 Step 7: Iterating through conversations...');
            
            const maxToProcess = Math.min(5, allConversations.length);
            const collectedData: { conv: ConversationInfo; messages: MessageInfo[] }[] = [];

            for (let i = 0; i < maxToProcess; i++) {
                const conv = allConversations[i];
                console.log(`\n   [${i + 1}/${maxToProcess}] ${conv.username}`);
                
                const opened = await controller.clickConversation(i);
                if (!opened) {
                    console.log('      ✗ Could not open');
                    continue;
                }

                await delay(2000);
                const messages = await controller.getMessagesFromConversation();
                console.log(`      ✓ ${messages.length} messages`);

                collectedData.push({ conv, messages });

                await controller.goBackToInbox();
                await delay(1500);
            }

            console.log(`\n   ✓ Collected data from ${collectedData.length} conversations`);
        }

        // Step 8: Check for Notes
        console.log('\n📝 Step 8: Checking for Notes...');
        await controller.navigateToDMs();
        await delay(2000);
        
        const notes = await controller.getNotes();
        console.log(`   Found ${notes.length} notes`);
        
        notes.forEach((note, idx) => {
            const ownIcon = note.isOwn ? '👤' : '👥';
            console.log(`   ${ownIcon} ${note.username}: "${note.content}"`);
        });

        console.log('\n✅ Safari DM Test Complete!\n');

        // Summary
        console.log('📊 Summary:');
        console.log(`   Primary conversations: ${primaryConvs.length}`);
        console.log(`   General conversations: ${generalConvs.length}`);
        console.log(`   Message requests: ${requestConvs.length}`);
        console.log(`   Total after scrolling: ${allConversations.length}`);
        console.log(`   Notes: ${notes.length}`);

    } catch (error: any) {
        console.error('\n❌ Error:', error.message);
        
        if (error.message.includes('not allowed assistive access')) {
            console.log('\n🔧 Fix: Grant automation permission');
            console.log('   System Settings → Privacy & Security → Automation');
            console.log('   Enable Terminal (or your IDE) to control Safari\n');
        }
        
        logger.error('Safari DM Test Error:', error);
    }
}

// Run if executed directly
if (require.main === module) {
    runSafariDMTest().catch(console.error);
}
