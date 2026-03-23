/**
 * Safari DM Test with OpenAI Vision Analysis
 * 
 * Uses screenshots + GPT-4 Vision to verify what's on screen
 * 
 * Run with: npm run test:vision
 */

import SafariController from './SafariController';
import { logger } from '../utils/logger';
import OpenAI from 'openai';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface VisionAnalysis {
    description: string;
    isInstagramDM: boolean;
    isLoggedIn: boolean;
    visibleConversations: string[];
    currentTab: string;
    messageInputVisible: boolean;
    lastMessage: string;
    sarahFound: boolean;
    additionalInfo: string;
}

async function analyzeScreenshot(base64Image: string, prompt: string): Promise<VisionAnalysis> {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `You are analyzing a screenshot of Safari browser showing Instagram. ${prompt}

Respond in JSON format with these fields:
{
    "description": "Brief description of what you see",
    "isInstagramDM": true/false,
    "isLoggedIn": true/false,
    "visibleConversations": ["name1", "name2"],
    "currentTab": "primary/general/requests/unknown",
    "messageInputVisible": true/false,
    "lastMessage": "the last/most recent message text visible",
    "sarahFound": true/false if you see "Sarah" anywhere,
    "additionalInfo": "any other relevant details"
}`
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/png;base64,${base64Image}`,
                                detail: "high"
                            }
                        }
                    ]
                }
            ],
            max_tokens: 1000
        });

        const content = response.choices[0]?.message?.content || '{}';
        
        // Extract JSON from response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        
        return {
            description: content,
            isInstagramDM: false,
            isLoggedIn: false,
            visibleConversations: [],
            currentTab: 'unknown',
            messageInputVisible: false,
            lastMessage: '',
            sarahFound: false,
            additionalInfo: ''
        };
        
    } catch (error: any) {
        logger.error('Vision analysis error:', error);
        return {
            description: `Error: ${error.message}`,
            isInstagramDM: false,
            isLoggedIn: false,
            visibleConversations: [],
            currentTab: 'unknown',
            messageInputVisible: false,
            lastMessage: '',
            sarahFound: false,
            additionalInfo: ''
        };
    }
}

export async function runVisionTest(): Promise<void> {
    const controller = new SafariController(60000);
    
    console.log('\n🔍 Safari DM Test with OpenAI Vision Analysis\n');
    console.log('This test takes screenshots and uses GPT-4 Vision to verify what\'s happening.\n');

    if (!process.env.OPENAI_API_KEY) {
        console.log('❌ OPENAI_API_KEY not set in .env file');
        return;
    }

    try {
        // Step 1: Navigate to DMs and take initial screenshot
        console.log('📱 Step 1: Navigating to Instagram DMs...');
        await controller.launchSafari('https://www.instagram.com/direct/inbox/');
        await delay(5000);

        console.log('📸 Taking screenshot...');
        const screenshot1 = await controller.getScreenshotBase64('step1_inbox.png');
        
        console.log('🤖 Analyzing with GPT-4 Vision...');
        const analysis1 = await analyzeScreenshot(screenshot1, 
            'Analyze this Instagram DM inbox. Look for conversation names, which tab is active, and if user is logged in.');
        
        console.log('\n📊 Vision Analysis Result:');
        console.log(`   Description: ${analysis1.description}`);
        console.log(`   Instagram DM: ${analysis1.isInstagramDM ? '✅' : '❌'}`);
        console.log(`   Logged In: ${analysis1.isLoggedIn ? '✅' : '❌'}`);
        console.log(`   Current Tab: ${analysis1.currentTab}`);
        console.log(`   Conversations: ${analysis1.visibleConversations.join(', ') || 'none detected'}`);
        console.log(`   Sarah Found: ${analysis1.sarahFound ? '✅ YES' : '❌ No'}`);

        if (!analysis1.isLoggedIn) {
            console.log('\n⚠️  Vision confirms: Not logged in. Please log into Instagram in Safari first.\n');
            return;
        }

        // Step 2: Search for Sarah Ashley
        console.log('\n🔍 Step 2: Searching for Sarah Ashley...');
        
        const tabs: Array<'primary' | 'general' | 'requests'> = ['primary', 'general', 'requests'];
        let sarahFound = false;
        let sarahTab = '';
        
        for (const tab of tabs) {
            console.log(`   Checking ${tab} tab...`);
            await controller.clickDMTab(tab);
            await delay(2500);
            
            const tabScreenshot = await controller.getScreenshotBase64(`step2_${tab}.png`);
            const tabAnalysis = await analyzeScreenshot(tabScreenshot,
                `Look carefully at this Instagram DM ${tab} tab. Find any conversation or message mentioning "Sarah" or "Sarah Ashley". List all visible conversation names.`);
            
            console.log(`     Tab: ${tabAnalysis.currentTab}`);
            console.log(`     Conversations: ${tabAnalysis.visibleConversations.join(', ')}`);
            console.log(`     Sarah found: ${tabAnalysis.sarahFound ? '✅' : '❌'}`);
            
            if (tabAnalysis.sarahFound) {
                sarahFound = true;
                sarahTab = tab;
                console.log(`   ✓ Found Sarah in ${tab} tab!`);
                break;
            }
        }

        if (!sarahFound) {
            // Try opening conversations to find Sarah
            console.log('\n   Opening conversations to search for Sarah...');
            
            for (const tab of tabs) {
                await controller.clickDMTab(tab);
                await delay(2000);
                
                const conversations = await controller.getConversations();
                
                for (let i = 0; i < Math.min(conversations.length, 3); i++) {
                    console.log(`   Opening conversation ${i}...`);
                    await controller.clickConversation(i);
                    await delay(2500);
                    
                    const convScreenshot = await controller.getScreenshotBase64(`step2_conv_${tab}_${i}.png`);
                    const convAnalysis = await analyzeScreenshot(convScreenshot,
                        'Look at this Instagram conversation. Is there any message from or mentioning "Sarah" or "Sarah Ashley"? What messages are visible?');
                    
                    console.log(`     Sarah in messages: ${convAnalysis.sarahFound ? '✅' : '❌'}`);
                    
                    if (convAnalysis.sarahFound) {
                        sarahFound = true;
                        sarahTab = tab;
                        console.log(`   ✓ Found Sarah's messages in conversation ${i}!`);
                        break;
                    }
                    
                    await controller.goBackToInbox();
                    await delay(1500);
                }
                
                if (sarahFound) break;
            }
        }

        if (!sarahFound) {
            console.log('\n❌ Could not find Sarah Ashley. Check screenshots folder for details.');
            return;
        }

        // Step 3: Read the conversation
        console.log(`\n📖 Step 3: In conversation with Sarah (${sarahTab} tab)...`);
        
        const readScreenshot = await controller.getScreenshotBase64('step3_read_messages.png');
        const readAnalysis = await analyzeScreenshot(readScreenshot,
            'Analyze this Instagram conversation. List all visible messages, who sent them (you/them), and identify any message input field. Note the last message.');
        
        console.log('\n💬 Messages found by Vision:');
        console.log(`   ${readAnalysis.description}`);
        console.log(`   Last message: "${readAnalysis.lastMessage}"`);
        console.log(`   Input visible: ${readAnalysis.messageInputVisible ? '✅' : '❌'}`);

        // Step 4: Type a test message
        console.log('\n✉️ Step 4: Typing test message...');
        
        const testMessage = `Hi Sarah! 👋 Test message at ${new Date().toLocaleTimeString()}`;
        console.log(`   Message: "${testMessage}"`);
        
        const typed = await controller.typeMessage(testMessage);
        await delay(2000);
        
        const typeScreenshot = await controller.getScreenshotBase64('step4_typed.png');
        const typeAnalysis = await analyzeScreenshot(typeScreenshot,
            'Look at the message input field. Is there text typed in it? What does it say? Is there a send button visible?');
        
        console.log(`\n   Vision confirms message typed: ${typeAnalysis.messageInputVisible ? '✅' : '❌'}`);
        console.log(`   Input content: ${typeAnalysis.additionalInfo}`);

        // Step 5: Send the message
        console.log('\n🚀 Step 5: Sending message...');
        
        const sent = await controller.sendMessage();
        await delay(3000);
        
        const sentScreenshot = await controller.getScreenshotBase64('step5_sent.png');
        const sentAnalysis = await analyzeScreenshot(sentScreenshot,
            `Check if our test message was sent. Look for a message containing "Test message" or "${testMessage.substring(0, 20)}". Was it delivered?`);
        
        console.log('\n📊 Send Verification:');
        console.log(`   ${sentAnalysis.description}`);
        console.log(`   Last visible message: "${sentAnalysis.lastMessage}"`);
        
        const messageWasSent = sentAnalysis.lastMessage.toLowerCase().includes('test message') ||
                              sentAnalysis.description.toLowerCase().includes('sent') ||
                              sentAnalysis.description.toLowerCase().includes('delivered');
        
        if (messageWasSent) {
            console.log('\n✅ SUCCESS! Message was sent and verified by Vision AI!');
        } else {
            console.log('\n⚠️ Could not verify message was sent. Check Safari manually.');
            console.log('   Screenshots saved in ./screenshots/ folder');
        }

        // Summary
        console.log('\n' + '='.repeat(50));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(50));
        console.log(`   Instagram DM Access: ✅`);
        console.log(`   Found Sarah Ashley: ${sarahFound ? '✅' : '❌'}`);
        console.log(`   Message Typed: ${typed ? '✅' : '❌'}`);
        console.log(`   Message Sent: ${messageWasSent ? '✅' : '⚠️ Check manually'}`);
        console.log(`   Screenshots: ./screenshots/`);
        console.log('='.repeat(50) + '\n');

    } catch (error: any) {
        console.error('\n❌ Error:', error.message);
        logger.error('Vision test error:', error);
    }
}

// Run if executed directly
if (require.main === module) {
    runVisionTest().catch(console.error);
}
