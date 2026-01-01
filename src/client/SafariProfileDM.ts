/**
 * Safari Profile-to-DM Messaging System
 * 
 * Send messages directly from a user's Instagram profile URL.
 * Also includes conversation scrolling for history extraction.
 * 
 * Run with: npm run dm:profile
 */

import SafariController from './SafariController';
import { logger } from '../utils/logger';
import OpenAI from 'openai';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function analyzeScreenshot(base64: string, prompt: string): Promise<any> {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: `${prompt}\n\nRespond in JSON: {"success":true/false,"description":"","profileName":"","messageInputVisible":true/false,"messageSent":true/false}` },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${base64}`, detail: "high" } }
                ]
            }],
            max_tokens: 400
        });
        const content = response.choices[0]?.message?.content || '{}';
        const match = content.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : { description: content };
    } catch (e: any) {
        return { success: false, description: e.message };
    }
}

// Selectors for Profile-to-DM workflow
const PROFILE_SELECTORS = {
    // Message button on profile page
    messageButtonText: `
        (function() {
            var buttons = document.querySelectorAll('div[role="button"]');
            for (var i = 0; i < buttons.length; i++) {
                if (buttons[i].textContent.trim() === 'Message') {
                    buttons[i].click();
                    return 'clicked_message_btn';
                }
            }
            return 'message_btn_not_found';
        })()
    `,
    
    // Full CSS path for message button
    messageButtonCSS: `#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x17snn68.x6osk4m.x1porb0y.x8vgawa > section > main > div > div > header > section.x14vqqas.x172qv1o > div > div > div > div > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1n2onr6.x6ikm8r.x10wlt62.x1iyjqo2.x2lwn1j.xeuugli.xdt5ytf.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1 > div`,
    
    // Message input in popup (after clicking Message)
    popupInputCSS: `div.x1vjfegm div.notranslate[contenteditable="true"], div.x1vjfegm [role="textbox"]`,
    
    // Alternative popup input
    popupInputAlt: `div.xzsf02u.x1a2a7pz.x1n2onr6.x14wi4xw.x1iyjqo2.x1gh3ibb.xisnujt.xeuugli.x1odjw0f.notranslate`,
    
    // Send button in popup
    sendButtonPopup: `svg[aria-label="Send"]`
};

// Selectors for conversation scrolling
const SCROLL_SELECTORS = {
    // Message container
    messageContainer: `div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6`,
    
    // Scrollable area
    scrollArea: `div[role="main"] div[style*="overflow"]`,
    
    // Messages
    messages: `[id^="mid."]`
};

interface ProfileDMResult {
    profileUrl: string;
    username: string;
    messageSent: boolean;
    messageContent: string;
    verifiedInDM: boolean;
    screenshots: string[];
    chatHistory?: any[];
    error?: string;
}

export class ProfileDMController {
    private controller: SafariController;
    private screenshotsDir = './screenshots/profile_dm';

    constructor() {
        this.controller = new SafariController(60000);
        if (!fs.existsSync(this.screenshotsDir)) {
            fs.mkdirSync(this.screenshotsDir, { recursive: true });
        }
    }

    /**
     * Send a DM to a user from their profile URL
     */
    async sendMessageFromProfile(profileUrl: string, message: string): Promise<ProfileDMResult> {
        const result: ProfileDMResult = {
            profileUrl,
            username: this.extractUsername(profileUrl),
            messageSent: false,
            messageContent: message,
            verifiedInDM: false,
            screenshots: []
        };

        console.log('\n' + '='.repeat(60));
        console.log('📨 PROFILE-TO-DM MESSAGE SENDER');
        console.log('='.repeat(60));
        console.log(`\n   Profile: ${profileUrl}`);
        console.log(`   Username: ${result.username}`);
        console.log(`   Message: "${message.substring(0, 50)}..."\n`);

        try {
            // Step 1: Navigate to profile
            console.log('📱 STEP 1: Navigate to profile');
            await this.controller.launchSafari(profileUrl);
            await delay(4000);

            let ss = await this.controller.getScreenshotBase64(`profile_${result.username}_01.png`);
            result.screenshots.push(`profile_${result.username}_01.png`);
            
            let vision = await analyzeScreenshot(ss, 
                `Is this an Instagram profile page? What is the username shown? Is there a "Message" button visible?`);
            console.log(`   Vision: ${vision.description}`);
            console.log(`   Profile: ${vision.profileName || 'detected'}\n`);

            // Step 2: Click Message button
            console.log('💬 STEP 2: Click Message button');
            
            // Try text-based click first
            let clickResult = await this.controller.executeJS(PROFILE_SELECTORS.messageButtonText);
            console.log(`   Click result: ${clickResult}`);
            
            if (clickResult !== 'clicked_message_btn') {
                // Try CSS selector
                const cssClick = await this.controller.executeJS(`
                    var btn = document.querySelector("${PROFILE_SELECTORS.messageButtonCSS.replace(/"/g, '\\"')}");
                    if (btn) { btn.click(); 'clicked_css'; } else { 'css_not_found'; }
                `);
                console.log(`   CSS fallback: ${cssClick}`);
            }
            
            await delay(3000);
            
            ss = await this.controller.getScreenshotBase64(`profile_${result.username}_02_popup.png`);
            result.screenshots.push(`profile_${result.username}_02_popup.png`);
            
            vision = await analyzeScreenshot(ss, 
                `Is there a message popup/modal open? Is there a text input field visible for typing a message?`);
            console.log(`   Vision: ${vision.description}`);
            console.log(`   Input visible: ${vision.messageInputVisible ? '✅' : '❌'}\n`);

            // Step 3: Type message
            console.log('✏️ STEP 3: Type message');
            
            const typeCode = `
                (function() {
                    var input = document.querySelector('div.notranslate[contenteditable="true"]') ||
                               document.querySelector('[role="textbox"]') ||
                               document.querySelector('div[contenteditable="true"]');
                    if (input) {
                        input.focus();
                        input.textContent = "${message.replace(/"/g, '\\"')}";
                        input.dispatchEvent(new InputEvent('input', {bubbles: true, data: "${message.replace(/"/g, '\\"')}"}));
                        return 'typed';
                    }
                    return 'no_input_found';
                })()
            `;
            
            const typeResult = await this.controller.executeJS(typeCode);
            console.log(`   Type result: ${typeResult}`);
            
            await delay(1500);
            
            ss = await this.controller.getScreenshotBase64(`profile_${result.username}_03_typed.png`);
            result.screenshots.push(`profile_${result.username}_03_typed.png`);

            // Step 4: Send message
            console.log('\n🚀 STEP 4: Send message');
            
            const sendCode = `
                (function() {
                    // Try SVG send button
                    var svg = document.querySelector('svg[aria-label="Send"]');
                    if (svg) {
                        var btn = svg.closest('div[role="button"]') || svg.parentElement;
                        if (btn) { btn.click(); return 'sent_svg'; }
                    }
                    
                    // Try button with submit
                    var submit = document.querySelector('button[type="submit"]');
                    if (submit) { submit.click(); return 'sent_submit'; }
                    
                    // Try Enter key
                    var input = document.querySelector('div[contenteditable="true"]');
                    if (input) {
                        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, bubbles: true}));
                        return 'sent_enter';
                    }
                    
                    return 'send_failed';
                })()
            `;
            
            const sendResult = await this.controller.executeJS(sendCode);
            console.log(`   Send result: ${sendResult}`);
            result.messageSent = sendResult.includes('sent');
            
            await delay(3000);
            
            ss = await this.controller.getScreenshotBase64(`profile_${result.username}_04_sent.png`);
            result.screenshots.push(`profile_${result.username}_04_sent.png`);
            
            vision = await analyzeScreenshot(ss, 
                `Was a message sent? Can you see the message "${message.substring(0, 20)}" in the chat? Is it displayed as sent?`);
            console.log(`   Vision: ${vision.description}\n`);

            // Step 5: Verify in DM inbox
            console.log('✅ STEP 5: Verify in DM inbox');
            
            await this.controller.navigateTo('https://www.instagram.com/direct/inbox/');
            await delay(4000);
            
            ss = await this.controller.getScreenshotBase64(`profile_${result.username}_05_verify.png`);
            result.screenshots.push(`profile_${result.username}_05_verify.png`);
            
            vision = await analyzeScreenshot(ss, 
                `Is ${result.username} visible in the conversation list? What is their last message preview?`);
            console.log(`   Vision: ${vision.description}`);
            result.verifiedInDM = vision.description?.toLowerCase().includes(result.username.toLowerCase()) || 
                                  vision.success === true;
            console.log(`   Verified: ${result.verifiedInDM ? '✅' : '⚠️ Check manually'}\n`);

        } catch (error: any) {
            result.error = error.message;
            console.error(`\n❌ Error: ${error.message}`);
            logger.error('Profile DM error:', error);
        }

        // Summary
        console.log('='.repeat(60));
        console.log('📊 RESULT SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Username: ${result.username}`);
        console.log(`   Message sent: ${result.messageSent ? '✅' : '❌'}`);
        console.log(`   Verified in DM: ${result.verifiedInDM ? '✅' : '⚠️'}`);
        console.log(`   Screenshots: ${result.screenshots.length}`);
        console.log('='.repeat(60) + '\n');

        return result;
    }

    /**
     * Scroll conversation to load more history and extract messages
     */
    async scrollAndExtractHistory(username: string): Promise<any[]> {
        console.log('\n' + '='.repeat(60));
        console.log('📜 CONVERSATION HISTORY EXTRACTION');
        console.log('='.repeat(60));
        console.log(`\n   Target: ${username}\n`);

        const allMessages: any[] = [];

        try {
            // Navigate to DM inbox
            await this.controller.navigateTo('https://www.instagram.com/direct/inbox/');
            await delay(4000);

            // Click on the conversation
            const clickCode = `
                (function() {
                    var spans = document.querySelectorAll('span');
                    for (var i = 0; i < spans.length; i++) {
                        if (spans[i].textContent.toLowerCase().includes('${username.toLowerCase()}')) {
                            var parent = spans[i].closest('div[role="button"]') || 
                                        spans[i].closest('div').parentElement?.parentElement;
                            if (parent) { parent.click(); return 'clicked'; }
                        }
                    }
                    return 'not_found';
                })()
            `;
            
            const clickResult = await this.controller.executeJS(clickCode);
            console.log(`   Open conversation: ${clickResult}`);
            
            if (clickResult !== 'clicked') {
                console.log('   ⚠️ Could not find conversation');
                return allMessages;
            }
            
            await delay(3000);

            // Scroll up multiple times to load history
            console.log('\n   Scrolling to load history...');
            
            for (let scroll = 0; scroll < 5; scroll++) {
                console.log(`   Scroll ${scroll + 1}/5`);
                
                // Scroll the message container up
                const scrollCode = `
                    (function() {
                        // Find scrollable container
                        var containers = document.querySelectorAll('div[style*="overflow"]');
                        var msgArea = null;
                        
                        for (var c of containers) {
                            if (c.scrollHeight > c.clientHeight) {
                                msgArea = c;
                                break;
                            }
                        }
                        
                        if (!msgArea) {
                            // Try finding by class patterns
                            msgArea = document.querySelector('div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6') ||
                                     document.querySelector('div[role="main"]');
                        }
                        
                        if (msgArea) {
                            msgArea.scrollTop = 0;
                            return 'scrolled_to_top';
                        }
                        
                        // Fallback: scroll window
                        window.scrollTo(0, 0);
                        return 'scrolled_window';
                    })()
                `;
                
                await this.controller.executeJS(scrollCode);
                await delay(2000);
            }

            // Take screenshot of loaded history
            const ss = await this.controller.getScreenshotBase64(`history_${username}.png`);
            
            const vision = await analyzeScreenshot(ss, 
                `Describe this conversation. Who is it with? How many messages are visible? What are they discussing?`);
            console.log(`\n   Vision summary: ${vision.description}`);

            // Extract all visible messages
            console.log('\n   Extracting messages...');
            
            const extractCode = `
                (function() {
                    var messages = [];
                    
                    // Get messages by ID
                    var msgElements = document.querySelectorAll('[id^="mid."]');
                    
                    msgElements.forEach(function(el, idx) {
                        try {
                            var id = el.id;
                            var textEl = el.querySelector('div[dir="auto"]') || el.querySelector('span');
                            var content = textEl ? textEl.textContent.trim() : '';
                            
                            // Position-based sender detection
                            var rect = el.getBoundingClientRect();
                            var isFromMe = rect.left > window.innerWidth / 2;
                            
                            // Time
                            var timeEl = el.querySelector('time');
                            var timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent) : '';
                            
                            if (content || el.querySelector('img, video')) {
                                messages.push({
                                    id: id,
                                    content: content.substring(0, 500),
                                    sender: isFromMe ? 'me' : 'them',
                                    timestamp: timestamp,
                                    hasMedia: el.querySelector('img, video') !== null
                                });
                            }
                        } catch (e) {}
                    });
                    
                    return JSON.stringify(messages);
                })()
            `;
            
            const messagesJson = await this.controller.executeJS(extractCode);
            const messages = JSON.parse(messagesJson);
            
            console.log(`   Extracted ${messages.length} messages`);
            
            if (messages.length > 0) {
                console.log('\n   Sample messages:');
                messages.slice(0, 5).forEach((m: any, i: number) => {
                    console.log(`   ${i + 1}. [${m.sender}] ${m.content.substring(0, 50)}...`);
                });
            }

            return messages;

        } catch (error: any) {
            console.error(`\n❌ Error: ${error.message}`);
            return allMessages;
        }
    }

    private extractUsername(url: string): string {
        const match = url.match(/instagram\.com\/([^\/\?]+)/);
        return match ? match[1] : 'unknown';
    }
}

/**
 * Run profile DM test with Sarah Ashley
 */
export async function runProfileDMTest(): Promise<void> {
    const controller = new ProfileDMController();
    
    // Test with Sarah Ashley's profile
    const profileUrl = 'https://www.instagram.com/saraheashley/';
    const message = `Hey! 👋 Testing profile-to-DM at ${new Date().toLocaleTimeString()}`;
    
    // First, extract conversation history
    console.log('\n🔍 Extracting conversation history first...\n');
    const history = await controller.scrollAndExtractHistory('sarah');
    
    console.log(`\nExtracted ${history.length} messages from history.\n`);
    
    // Then send a new message
    const result = await controller.sendMessageFromProfile(profileUrl, message);
    
    // Save results
    const outputPath = './extracted_data/profile_dm_result.json';
    if (!fs.existsSync('./extracted_data')) {
        fs.mkdirSync('./extracted_data', { recursive: true });
    }
    
    fs.writeFileSync(outputPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        history: history,
        dmResult: result
    }, null, 2));
    
    console.log(`\n📁 Results saved to: ${outputPath}`);
}

// Run if executed directly
if (require.main === module) {
    runProfileDMTest().catch(console.error);
}
