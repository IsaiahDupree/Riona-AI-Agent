/**
 * Safari Direct Test - Sarah Ashley with User-Provided Selectors
 * 
 * Uses exact CSS selectors and XPath from Instagram DOM inspection
 * Tests each selector and verifies with Vision AI
 * 
 * Run with: npm run test:sarah:direct
 */

import SafariController from './SafariController';
import { logger } from '../utils/logger';
import OpenAI from 'openai';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ override: true });

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
                    { type: "text", text: `${prompt}\n\nRespond in JSON: {"success":true/false,"description":"","personVisible":"","inputVisible":true/false,"lastMessage":""}` },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${base64}`, detail: "high" } }
                ]
            }],
            max_tokens: 500
        });
        const content = response.choices[0]?.message?.content || '{}';
        const match = content.match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : { description: content };
    } catch (e: any) {
        return { success: false, description: e.message };
    }
}

// User-provided selectors from Instagram DOM inspection
const SELECTORS = {
    // Conversation list - nth-child(2) for Sarah (index 1, 0-based becomes 2 in nth-child)
    conversationItem: (n: number) => `#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > div > section > div > div > div > div.x9f619.x2lah0s.x1nhvcw1.x1qjc9v5.xozqiw3.x1q0g3np.x78zum5.x1iyjqo2.x5yr21d.x1t2pt76.x1n2onr6.x1ja2u2z > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x2lah0s.x193iq5w.xeuugli.xvbhtw8 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6 > div.xb57i2i.x1q594ok.x5lxg6s.x78zum5.xdt5ytf.x6ikm8r.x1ja2u2z.x1pq812k.x1rohswg.xfk6m8.x1yqm8si.xjx87ck.xx8ngbg.xwo3gff.x1n2onr6.x1oyok0e.x1odjw0f.x1e4zzel.x1xzczws > div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6 > div > div > div:nth-child(${n}) > div > div > div > div > div`,
    
    // Message input with notranslate class
    messageInput: `div.xzsf02u.x1a2a7pz.x1n2onr6.x14wi4xw.x1iyjqo2.x1gh3ibb.xisnujt.xeuugli.x1odjw0f.notranslate`,
    
    // Alternative input selector
    messageInputAlt: `#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > div > section > div > div > div > div.x9f619.x2lah0s.x1nhvcw1.x1qjc9v5.xozqiw3.x1q0g3np.x78zum5.x1iyjqo2.x5yr21d.x1t2pt76.x1n2onr6.x1ja2u2z > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x193iq5w.xeuugli.x1r8uery.x1iyjqo2.xs83m0k > div > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1iyjqo2.x2lwn1j.xeuugli.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1.xcrg951.x6prxxf.x6ikm8r.x10wlt62.x1n2onr6.xh8yej3 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x193iq5w.x2lwn1j.x1n2onr6 > div:nth-child(2) > div > div > div > div > div > div.html-div.xat24cr.xexx8yu.xyri2b.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1xmf6yo.x13fj5qh.x2fvf9.x1uhb9sk.x1plvlek.xryxfnj.x1iyjqo2.x2lwn1j.xeuugli.xdt5ytf.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1.xs9asl8 > div > div.xzsf02u.x1a2a7pz.x1n2onr6.x14wi4xw.x1iyjqo2.x1gh3ibb.xisnujt.xeuugli.x1odjw0f.notranslate > p`,
    
    // XPath for conversation
    conversationXPath: (n: number) => `//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/div/section/div/div/div/div[1]/div[1]/div/div[4]/div[2]/div[1]/div/div/div[${n}]/div/div/div/div/div`,
    
    // XPath for message input
    inputXPath: `/html/body/div[1]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/div/section/div/div/div/div[1]/div[2]/div/div[1]/div/div[2]/div[2]/div/div/div/div/div/div[2]/div/div[1]/p`
};

export async function runSarahDirectTest(): Promise<void> {
    const controller = new SafariController(60000);
    
    console.log('\n' + '='.repeat(60));
    console.log('🎯 SARAH ASHLEY DIRECT TEST');
    console.log('Using user-provided Instagram selectors');
    console.log('='.repeat(60) + '\n');

    try {
        // STEP 1: Navigate to DMs
        console.log('📱 STEP 1: Navigate to Instagram DMs');
        await controller.launchSafari('https://www.instagram.com/direct/inbox/');
        await delay(5000);
        
        let ss = await controller.getScreenshotBase64('sarah_01_inbox.png');
        let vision = await analyzeScreenshot(ss, 'Is this Instagram DM inbox? Is Sarah Ashley visible in the conversation list?');
        console.log(`   Vision: ${vision.description}`);
        console.log(`   Sarah visible: ${vision.personVisible?.toLowerCase().includes('sarah') ? '✅' : '❌'}\n`);

        // STEP 2: Test conversation selectors
        console.log('🔬 STEP 2: Testing conversation click selectors');
        console.log('   Sarah is at index 2 (second conversation)\n');
        
        const clickMethods = [
            {
                name: 'User CSS Selector (nth-child 2)',
                code: `
                    var el = document.querySelector("${SELECTORS.conversationItem(2).replace(/"/g, '\\"')}");
                    if (el) { el.click(); 'clicked_css'; } else { 'not_found'; }
                `
            },
            {
                name: 'XPath method',
                code: `
                    var result = document.evaluate("${SELECTORS.conversationXPath(2)}", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    if (result.singleNodeValue) { result.singleNodeValue.click(); 'clicked_xpath'; } else { 'xpath_not_found'; }
                `
            },
            {
                name: 'Find by text "Sarah"',
                code: `
                    var spans = document.querySelectorAll('span');
                    var found = false;
                    for (var i = 0; i < spans.length; i++) {
                        if (spans[i].textContent.includes('Sarah Ashley')) {
                            var parent = spans[i].closest('div[role="button"]') || spans[i].closest('div').parentElement.parentElement.parentElement;
                            if (parent) { parent.click(); found = true; break; }
                        }
                    }
                    found ? 'clicked_sarah_text' : 'sarah_not_found';
                `
            },
            {
                name: 'Conversation list div click',
                code: `
                    var container = document.querySelector('div.xb57i2i.x1q594ok.x5lxg6s');
                    if (container) {
                        var items = container.querySelectorAll('div > div > div');
                        // Find the one with Sarah
                        for (var item of items) {
                            if (item.textContent && item.textContent.includes('Sarah')) {
                                item.click();
                                return 'clicked_container_sarah';
                            }
                        }
                    }
                    'container_not_found';
                `
            }
        ];

        let conversationOpened = false;
        
        for (const method of clickMethods) {
            console.log(`   Testing: ${method.name}`);
            
            // Reset to inbox first
            await controller.navigateTo('https://www.instagram.com/direct/inbox/');
            await delay(3000);
            
            try {
                const result = await controller.executeJS(method.code);
                console.log(`   Result: ${result}`);
                
                if (result && result.includes('clicked')) {
                    await delay(3000);
                    
                    ss = await controller.getScreenshotBase64(`sarah_02_${method.name.substring(0,10).replace(/\s/g,'_')}.png`);
                    vision = await analyzeScreenshot(ss, 
                        'Is a conversation open with Sarah Ashley? Or any individual chat? Is there a message input field visible at the bottom?');
                    
                    console.log(`   Vision: ${vision.description}`);
                    console.log(`   Conversation open: ${vision.inputVisible ? '✅' : '❌'}`);
                    
                    if (vision.inputVisible || vision.description.toLowerCase().includes('conversation') || 
                        vision.description.toLowerCase().includes('chat') || vision.description.toLowerCase().includes('message')) {
                        conversationOpened = true;
                        console.log(`   ✅ SUCCESS with: ${method.name}\n`);
                        break;
                    }
                }
            } catch (e: any) {
                console.log(`   Error: ${e.message}`);
            }
            console.log('');
        }

        if (!conversationOpened) {
            console.log('⚠️ Could not open conversation with selectors. Trying controller method...');
            await controller.navigateTo('https://www.instagram.com/direct/inbox/');
            await delay(3000);
            await controller.clickConversation(1); // Sarah at index 1
            await delay(3000);
            
            ss = await controller.getScreenshotBase64('sarah_02_fallback.png');
            vision = await analyzeScreenshot(ss, 'Is there a conversation open? Is message input visible?');
            conversationOpened = vision.inputVisible || false;
        }

        // STEP 3: Test message input selectors
        console.log('✏️ STEP 3: Testing message input selectors\n');
        
        const inputMethods = [
            {
                name: 'notranslate class selector',
                code: `document.querySelector("${SELECTORS.messageInput}")?.outerHTML?.substring(0,100) || 'not_found'`
            },
            {
                name: 'Full path p element',
                code: `document.querySelector("${SELECTORS.messageInputAlt.replace(/"/g, '\\"')}")?.outerHTML?.substring(0,100) || 'not_found'`
            },
            {
                name: 'XPath input',
                code: `
                    var result = document.evaluate("${SELECTORS.inputXPath}", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                    result.singleNodeValue ? result.singleNodeValue.outerHTML.substring(0,100) : 'xpath_not_found';
                `
            },
            {
                name: 'contenteditable search',
                code: `document.querySelector('div[contenteditable="true"]')?.outerHTML?.substring(0,100) || 'not_found'`
            },
            {
                name: 'Role textbox',
                code: `document.querySelector('[role="textbox"]')?.outerHTML?.substring(0,100) || 'not_found'`
            }
        ];

        let workingInputSelector = '';
        
        for (const method of inputMethods) {
            console.log(`   Testing: ${method.name}`);
            try {
                const result = await controller.executeJS(method.code);
                const found = result && result.length > 20 && !result.includes('not_found');
                console.log(`   Found: ${found ? '✅' : '❌'} ${found ? result.substring(0,60) + '...' : result}`);
                if (found && !workingInputSelector) {
                    workingInputSelector = method.name;
                }
            } catch (e: any) {
                console.log(`   Error: ${e.message}`);
            }
        }
        
        console.log(`\n   Working input: ${workingInputSelector || 'none'}\n`);

        // STEP 4: Type message
        console.log('⌨️ STEP 4: Typing test message\n');
        
        const testMsg = `Hi Sarah! 👋 Test at ${new Date().toLocaleTimeString()}`;
        console.log(`   Message: "${testMsg}"\n`);
        
        const typeCode = `
            var input = document.querySelector('div[contenteditable="true"]') || 
                       document.querySelector('div.notranslate[contenteditable="true"]') ||
                       document.querySelector('[role="textbox"]');
            if (input) {
                input.focus();
                input.textContent = '';
                
                // Method 1: Direct set
                input.textContent = "${testMsg}";
                
                // Method 2: Input event
                input.dispatchEvent(new InputEvent('input', {bubbles: true, data: "${testMsg}"}));
                
                // Method 3: Also try innerHTML for p element
                var p = input.querySelector('p') || input;
                if (p.tagName === 'P') {
                    p.textContent = "${testMsg}";
                }
                
                'typed';
            } else { 'no_input'; }
        `;
        
        const typeResult = await controller.executeJS(typeCode);
        console.log(`   Type result: ${typeResult}`);
        
        await delay(2000);
        ss = await controller.getScreenshotBase64('sarah_04_typed.png');
        vision = await analyzeScreenshot(ss, `Is there text in the message input? Does it say "${testMsg.substring(0,15)}"? What text is visible in the input field?`);
        console.log(`   Vision: ${vision.description}\n`);

        // STEP 5: Send message
        console.log('🚀 STEP 5: Sending message\n');
        
        const sendCode = `
            // Try multiple send methods
            var sent = false;
            
            // Method 1: SVG send button
            var svg = document.querySelector('svg[aria-label="Send"]');
            if (svg) {
                var btn = svg.closest('div[role="button"]') || svg.parentElement;
                if (btn) { btn.click(); sent = true; }
            }
            
            // Method 2: Submit button
            if (!sent) {
                var submit = document.querySelector('button[type="submit"]');
                if (submit) { submit.click(); sent = true; }
            }
            
            // Method 3: Enter key
            if (!sent) {
                var input = document.querySelector('div[contenteditable="true"]');
                if (input) {
                    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, bubbles: true}));
                    sent = true;
                }
            }
            
            sent ? 'sent' : 'not_sent';
        `;
        
        const sendResult = await controller.executeJS(sendCode);
        console.log(`   Send result: ${sendResult}`);
        
        await delay(3000);
        ss = await controller.getScreenshotBase64('sarah_05_sent.png');
        vision = await analyzeScreenshot(ss, 
            `Was a message sent? Look for our test message "${testMsg.substring(0,15)}" in the conversation. What is the last message visible?`);
        
        console.log(`   Vision: ${vision.description}`);
        console.log(`   Last message: ${vision.lastMessage || 'unknown'}\n`);

        // Summary
        console.log('='.repeat(60));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(60));
        console.log(`   Conversation opened: ${conversationOpened ? '✅' : '❌'}`);
        console.log(`   Working input selector: ${workingInputSelector || 'none found'}`);
        console.log(`   Message typed: ${typeResult === 'typed' ? '✅' : '❌'}`);
        console.log(`   Message sent: ${sendResult === 'sent' ? '✅ (check Safari)' : '❌'}`);
        console.log(`   Screenshots: ./screenshots/sarah_*.png`);
        console.log('='.repeat(60) + '\n');

    } catch (error: any) {
        console.error('\n❌ Error:', error.message);
        logger.error('Sarah direct test error:', error);
    }
}

if (require.main === module) {
    runSarahDirectTest().catch(console.error);
}
