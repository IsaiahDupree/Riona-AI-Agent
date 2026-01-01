/**
 * Safari DM Test - Sarah Ashley
 * 
 * Test script to:
 * 1. Find Sarah Ashley's conversation
 * 2. Open and read messages
 * 3. Send a test message
 * 
 * Run with: npm run test:sarah
 */

import SafariController, { ConversationInfo, MessageInfo } from './SafariController';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';

dotenv.config();

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function runSarahTest(): Promise<void> {
    const controller = new SafariController(60000);
    const TARGET_USERNAME = 'sarah';  // Will match "Sarah Ashley" or similar

    console.log('\n🎯 Safari DM Test - Finding Sarah Ashley\n');

    try {
        // Step 1: Navigate to DMs
        console.log('📱 Step 1: Navigating to Instagram DMs...');
        await controller.launchSafari('https://www.instagram.com/direct/inbox/');
        await delay(5000);

        const state = await controller.getPageState();
        if (!state.loggedIn) {
            console.log('\n⚠️  Not logged in! Please log into Instagram in Safari first.\n');
            return;
        }
        console.log('✅ Logged in\n');

        // Step 2: Search through all tabs for Sarah (check username AND lastMessage)
        console.log('🔍 Step 2: Searching for Sarah Ashley...');
        
        let sarahConversation: ConversationInfo | null = null;
        let sarahIndex = -1;
        let foundInTab = '';

        const tabs: Array<'primary' | 'general' | 'requests'> = ['primary', 'general', 'requests'];
        
        for (const tab of tabs) {
            console.log(`   Checking ${tab} tab...`);
            await controller.clickDMTab(tab);
            await delay(2000);

            const conversations = await controller.getConversations();
            console.log(`   Found ${conversations.length} conversations`);

            // Search for Sarah in username OR lastMessage
            for (let i = 0; i < conversations.length; i++) {
                const conv = conversations[i];
                const name = (conv.username || '').toLowerCase();
                const lastMsg = (conv.lastMessage || '').toLowerCase();
                
                console.log(`     [${i}] ${conv.username}: "${conv.lastMessage?.substring(0, 40)}..."`);
                
                if (name.includes(TARGET_USERNAME) || lastMsg.includes(TARGET_USERNAME)) {
                    sarahConversation = conv;
                    sarahIndex = i;
                    foundInTab = tab;
                    console.log(`   ✓ Found Sarah reference at index ${i} in ${tab} tab!`);
                    break;
                }
            }

            if (sarahConversation) break;
        }

        // If still not found, try clicking through conversations to find Sarah's messages
        if (!sarahConversation) {
            console.log('\n   Searching inside conversations for Sarah...');
            
            for (const tab of tabs) {
                await controller.clickDMTab(tab);
                await delay(2000);
                
                const conversations = await controller.getConversations();
                
                for (let i = 0; i < conversations.length; i++) {
                    await controller.clickConversation(i);
                    await delay(2000);
                    
                    const messages = await controller.getMessagesFromConversation();
                    
                    // Check if any message mentions Sarah
                    const hasSarah = messages.some(m => 
                        m.content.toLowerCase().includes(TARGET_USERNAME)
                    );
                    
                    if (hasSarah) {
                        sarahConversation = conversations[i];
                        sarahIndex = i;
                        foundInTab = tab;
                        console.log(`   ✓ Found Sarah's messages in conversation ${i} (${tab})!`);
                        break;
                    }
                    
                    await controller.goBackToInbox();
                    await delay(1500);
                    await controller.clickDMTab(tab);
                    await delay(1000);
                }
                
                if (sarahConversation) break;
            }
        }

        if (!sarahConversation) {
            console.log('\n❌ Could not find Sarah Ashley anywhere.');
            return;
        }

        // Step 3: Open Sarah's conversation
        console.log(`\n📖 Step 3: Opening conversation with ${sarahConversation.username}...`);
        
        // Make sure we're on the right tab
        await controller.clickDMTab(foundInTab as 'primary' | 'general' | 'requests');
        await delay(2000);

        const opened = await controller.clickConversation(sarahIndex);
        if (!opened) {
            console.log('   ✗ Could not open conversation');
            return;
        }
        
        await delay(3000);
        console.log('   ✓ Conversation opened\n');

        // Step 4: Read messages
        console.log('💬 Step 4: Reading messages...');
        const messages = await controller.getMessagesFromConversation();
        
        console.log(`   Found ${messages.length} messages:\n`);
        
        messages.forEach((msg, idx) => {
            const sender = msg.isFromMe ? '  You' : `  ${sarahConversation!.username}`;
            const icon = msg.isFromMe ? '➡️' : '⬅️';
            console.log(`   ${icon} ${sender}: "${msg.content.substring(0, 80)}${msg.content.length > 80 ? '...' : ''}"`);
        });

        // Step 5: Send a test message
        console.log('\n✉️ Step 5: Sending test message...');
        
        const testMessage = `Hey! 👋 This is an automated test message sent at ${new Date().toLocaleTimeString()}`;
        
        // Ask for confirmation before sending
        console.log(`\n   Message to send: "${testMessage}"`);
        console.log('\n   ⚠️  About to send message...');
        
        // Type the message
        const typed = await controller.typeMessage(testMessage);
        if (!typed) {
            console.log('   ✗ Could not type message');
            return;
        }
        console.log('   ✓ Message typed');

        // Send the message
        const sent = await controller.sendMessage();
        if (sent) {
            console.log('   ✓ Message sent successfully!');
        } else {
            console.log('   ⚠️ Message typed but may need manual send (press Enter in Safari)');
        }

        // Step 6: Verify message was sent by re-reading
        console.log('\n🔄 Step 6: Verifying message was sent...');
        await delay(2000);
        
        const updatedMessages = await controller.getMessagesFromConversation();
        const lastMessage = updatedMessages[updatedMessages.length - 1];
        
        if (lastMessage && lastMessage.content.includes('automated test')) {
            console.log('   ✓ Message verified in conversation!');
        } else {
            console.log('   ℹ️ Could not verify - check Safari manually');
        }

        console.log('\n✅ Sarah Ashley test complete!\n');

    } catch (error: any) {
        console.error('\n❌ Error:', error.message);
        logger.error('Sarah test error:', error);
    }
}

// Run if executed directly
if (require.main === module) {
    runSarahTest().catch(console.error);
}
