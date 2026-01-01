/**
 * Safari DM Full Test
 * 
 * Comprehensive test that:
 * 1. Iterates through ALL conversations
 * 2. Scrolls to load more conversations
 * 3. Extracts data from each conversation
 * 4. Navigates Primary, General, and Requests tabs
 * 
 * Run with: npm run test:safari:dm:full
 */

import SafariController, { ConversationInfo, MessageInfo } from './SafariController';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

interface ConversationData {
    tab: string;
    conversation: ConversationInfo;
    messages: MessageInfo[];
    timestamp: string;
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runFullDMTest(): Promise<void> {
    const controller = new SafariController(60000);
    const allData: ConversationData[] = [];
    
    console.log('\n🍎 Safari Instagram DM Full Extraction Test\n');
    console.log('This test will iterate through ALL conversations in all tabs.\n');

    try {
        // Launch Safari
        console.log('📱 Launching Safari and navigating to DMs...');
        await controller.launchSafari('https://www.instagram.com/direct/inbox/');
        await delay(5000);

        // Check login state
        const state = await controller.getPageState();
        if (!state.loggedIn) {
            console.log('\n⚠️  Not logged in! Please log into Instagram in Safari first.\n');
            return;
        }
        console.log('✅ Logged in successfully\n');

        // Process each tab
        const tabs: Array<'primary' | 'general' | 'requests'> = ['primary', 'general', 'requests'];
        
        for (const tab of tabs) {
            console.log(`\n${'='.repeat(50)}`);
            console.log(`📂 Processing ${tab.toUpperCase()} tab`);
            console.log('='.repeat(50));

            // Click on tab
            await controller.clickDMTab(tab);
            await delay(3000);

            // Scroll to load all conversations
            console.log('\n📜 Scrolling to load all conversations...');
            let prevCount = 0;
            let currentCount = 0;
            let scrollAttempts = 0;
            const maxScrolls = 10;

            do {
                prevCount = currentCount;
                currentCount = await controller.scrollConversationList('down');
                scrollAttempts++;
                
                if (currentCount > prevCount) {
                    console.log(`   Scroll ${scrollAttempts}: Loaded ${currentCount} conversations`);
                }
                await delay(1500);
            } while (currentCount > prevCount && scrollAttempts < maxScrolls);

            // Get all conversations in this tab
            const conversations = await controller.getConversations();
            console.log(`\n✓ Found ${conversations.length} conversations in ${tab} tab\n`);

            if (conversations.length === 0) {
                console.log(`   No conversations in ${tab} tab`);
                continue;
            }

            // Iterate through each conversation
            const maxToProcess = Math.min(conversations.length, 20); // Limit for testing
            
            for (let i = 0; i < maxToProcess; i++) {
                const conv = conversations[i];
                console.log(`\n[${i + 1}/${maxToProcess}] Opening: ${conv.username || 'Unknown'}`);
                
                // Click to open conversation
                const opened = await controller.clickConversation(i);
                if (!opened) {
                    console.log('   ✗ Could not open conversation');
                    continue;
                }
                
                await delay(2500);

                // Read messages
                const messages = await controller.getMessagesFromConversation();
                console.log(`   ✓ Found ${messages.length} messages`);

                // Show preview of last message
                if (messages.length > 0) {
                    const lastMsg = messages[messages.length - 1];
                    const preview = lastMsg.content.substring(0, 50);
                    console.log(`   Last: "${preview}${lastMsg.content.length > 50 ? '...' : ''}"`);
                }

                // Store data
                allData.push({
                    tab: tab,
                    conversation: conv,
                    messages: messages,
                    timestamp: new Date().toISOString()
                });

                // Go back to inbox
                await controller.goBackToInbox();
                await delay(2000);

                // Re-click the tab to ensure we're in the right place
                if (i < maxToProcess - 1) {
                    await controller.clickDMTab(tab);
                    await delay(1500);
                }
            }
        }

        // Summary
        console.log('\n' + '='.repeat(50));
        console.log('📊 EXTRACTION COMPLETE');
        console.log('='.repeat(50));

        const primaryData = allData.filter(d => d.tab === 'primary');
        const generalData = allData.filter(d => d.tab === 'general');
        const requestsData = allData.filter(d => d.tab === 'requests');

        console.log(`\nPrimary: ${primaryData.length} conversations processed`);
        console.log(`General: ${generalData.length} conversations processed`);
        console.log(`Requests: ${requestsData.length} conversations processed`);
        console.log(`Total: ${allData.length} conversations`);

        const totalMessages = allData.reduce((sum, d) => sum + d.messages.length, 0);
        console.log(`Total messages extracted: ${totalMessages}`);

        // Save data to file
        const outputPath = path.join(process.cwd(), 'dm_extraction_data.json');
        fs.writeFileSync(outputPath, JSON.stringify(allData, null, 2));
        console.log(`\n💾 Data saved to: ${outputPath}`);

        // Print sample data
        console.log('\n📝 Sample Conversations:');
        allData.slice(0, 5).forEach((d, idx) => {
            console.log(`\n${idx + 1}. [${d.tab}] ${d.conversation.username}`);
            console.log(`   Messages: ${d.messages.length}`);
            if (d.messages.length > 0) {
                const lastMsg = d.messages[d.messages.length - 1];
                console.log(`   Last: "${lastMsg.content.substring(0, 60)}..."`);
            }
        });

    } catch (error: any) {
        console.error('\n❌ Error:', error.message);
        logger.error('Full DM Test Error:', error);
        
        // Still save partial data
        if (allData.length > 0) {
            const outputPath = path.join(process.cwd(), 'dm_extraction_partial.json');
            fs.writeFileSync(outputPath, JSON.stringify(allData, null, 2));
            console.log(`\n💾 Partial data saved to: ${outputPath}`);
        }
    }

    console.log('\n✅ Test complete!\n');
}

// Run if executed directly
if (require.main === module) {
    runFullDMTest().catch(console.error);
}
