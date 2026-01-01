/**
 * Safari Selector Test with Vision Verification
 * 
 * Tests different CSS selectors and XPath expressions to find
 * which ones work for Instagram DM interactions.
 * 
 * Run with: npm run test:selectors
 */

import SafariController from './SafariController';
import { logger } from '../utils/logger';
import OpenAI from 'openai';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface SelectorResult {
    selector: string;
    type: 'css' | 'xpath' | 'js';
    success: boolean;
    result: string;
    elementFound: boolean;
}

interface VisionVerification {
    description: string;
    conversationOpen: boolean;
    personName: string;
    messageInputVisible: boolean;
    messages: string[];
    lastMessage: string;
}

async function analyzeWithVision(base64Image: string, prompt: string): Promise<VisionVerification> {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: `${prompt}\n\nRespond in JSON:\n{"description":"","conversationOpen":true/false,"personName":"","messageInputVisible":true/false,"messages":[],"lastMessage":""}` },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}`, detail: "high" } }
                ]
            }],
            max_tokens: 800
        });

        const content = response.choices[0]?.message?.content || '{}';
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        return jsonMatch ? JSON.parse(jsonMatch[0]) : { description: content, conversationOpen: false, personName: '', messageInputVisible: false, messages: [], lastMessage: '' };
    } catch (error: any) {
        return { description: `Error: ${error.message}`, conversationOpen: false, personName: '', messageInputVisible: false, messages: [], lastMessage: '' };
    }
}

export async function runSelectorTest(): Promise<void> {
    const controller = new SafariController(60000);
    const results: SelectorResult[] = [];
    
    console.log('\n🔬 Safari Selector Test with Vision Verification\n');
    console.log('Testing different selectors to find Sarah Ashley and send a message.\n');
    console.log('='.repeat(60) + '\n');

    try {
        // Step 1: Navigate to DMs
        console.log('📱 STEP 1: Navigate to Instagram DMs\n');
        await controller.launchSafari('https://www.instagram.com/direct/inbox/');
        await delay(5000);

        const ss1 = await controller.getScreenshotBase64('selector_01_inbox.png');
        const v1 = await analyzeWithVision(ss1, 'Describe this Instagram DM inbox. List conversation names visible.');
        console.log(`   Vision: ${v1.description}`);
        console.log(`   Conversations detected: ${v1.messages.join(', ') || 'check screenshot'}\n`);

        // Step 2: Test CONVERSATION CLICK selectors
        console.log('='.repeat(60));
        console.log('📂 STEP 2: Testing CONVERSATION CLICK Selectors');
        console.log('   Target: Sarah Ashley (index 1)\n');

        const conversationSelectors = [
            // CSS Selectors
            { type: 'css', name: 'Role=button divs', selector: `document.querySelectorAll('div[role="button"]')[1]?.click()` },
            { type: 'css', name: 'Listitem role', selector: `document.querySelectorAll('[role="listitem"]')[1]?.click()` },
            { type: 'css', name: 'Link with href /direct/t/', selector: `document.querySelectorAll('a[href*="/direct/t/"]')[1]?.click()` },
            { type: 'css', name: 'Span with username', selector: `Array.from(document.querySelectorAll('span')).find(s => s.textContent.includes('Sarah'))?.closest('div[role="button"]')?.click()` },
            { type: 'css', name: 'IMG profile picture', selector: `document.querySelectorAll('div.x9f619 img[alt*="profile"]')[1]?.closest('div[role="button"]')?.click()` },
            
            // XPath via evaluate
            { type: 'xpath', name: 'XPath listitem[2]', selector: `document.evaluate("//div[@role='listitem'][2]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue?.click()` },
            { type: 'xpath', name: 'XPath contains Sarah', selector: `document.evaluate("//*[contains(text(),'Sarah')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue?.closest('div')?.click()` },
            
            // Direct class selectors from Instagram DOM
            { type: 'js', name: 'Instagram container class', selector: `document.querySelectorAll('div.x1n2onr6.x1ja2u2z')[1]?.click()` },
            { type: 'js', name: 'Conversation row click', selector: `
                var convs = document.querySelectorAll('div[role="listitem"], div.x1n2onr6');
                var sarah = Array.from(convs).find(c => c.textContent.includes('Sarah'));
                if(sarah) { sarah.click(); 'clicked_sarah'; } else { 'not_found'; }
            `},
        ];

        // Test each conversation selector
        for (const sel of conversationSelectors) {
            console.log(`   Testing: ${sel.name}`);
            console.log(`   Selector: ${sel.selector.substring(0, 60)}...`);
            
            // First go back to inbox
            await controller.navigateTo('https://www.instagram.com/direct/inbox/');
            await delay(3000);
            
            try {
                const jsResult = await controller.executeJS(sel.selector);
                const success = jsResult && jsResult !== 'null' && jsResult !== 'undefined';
                
                results.push({
                    selector: sel.name,
                    type: sel.type as 'css' | 'xpath' | 'js',
                    success: !!success,
                    result: jsResult || 'no result',
                    elementFound: !!success
                });
                
                console.log(`   Result: ${success ? '✅' : '❌'} ${jsResult || 'no result'}`);
                
                if (success) {
                    await delay(2000);
                    const ssConv = await controller.getScreenshotBase64(`selector_conv_${sel.name.replace(/\s/g, '_')}.png`);
                    const vConv = await analyzeWithVision(ssConv, 'Is a conversation open? Who is it with? Is Sarah Ashley visible?');
                    console.log(`   Vision: ${vConv.conversationOpen ? '✅ Conversation OPEN' : '❌ Not open'} - ${vConv.personName || vConv.description}`);
                    
                    if (vConv.conversationOpen && vConv.personName.toLowerCase().includes('sarah')) {
                        console.log(`   🎯 SUCCESS: Found working selector for Sarah!\n`);
                        break;
                    }
                }
            } catch (e: any) {
                console.log(`   Result: ❌ Error: ${e.message}`);
                results.push({ selector: sel.name, type: sel.type as 'css' | 'xpath' | 'js', success: false, result: e.message, elementFound: false });
            }
            console.log('');
        }

        // Step 3: Open Sarah's conversation using working method
        console.log('='.repeat(60));
        console.log('📖 STEP 3: Opening Sarah Ashley conversation (index 1)\n');
        
        await controller.navigateTo('https://www.instagram.com/direct/inbox/');
        await delay(4000);
        
        // Use the controller's built-in method which has multiple fallbacks
        const opened = await controller.clickConversation(1); // Sarah is at index 1
        await delay(3000);
        
        const ss3 = await controller.getScreenshotBase64('selector_03_sarah_open.png');
        const v3 = await analyzeWithVision(ss3, 'Is this a conversation with Sarah Ashley? Describe what messages are visible. Is there a message input field?');
        
        console.log(`   Conversation opened: ${opened ? '✅' : '❌'}`);
        console.log(`   Vision confirms: ${v3.conversationOpen ? '✅' : '❌'}`);
        console.log(`   Person: ${v3.personName}`);
        console.log(`   Message input visible: ${v3.messageInputVisible ? '✅' : '❌'}`);
        console.log(`   Last message: "${v3.lastMessage}"`);

        // Step 4: Test MESSAGE INPUT selectors
        console.log('\n' + '='.repeat(60));
        console.log('✏️ STEP 4: Testing MESSAGE INPUT Selectors\n');

        const inputSelectors = [
            { type: 'css', name: 'Contenteditable div', selector: `document.querySelector('div[contenteditable="true"]')?.outerHTML?.substring(0,100)` },
            { type: 'css', name: 'Textarea', selector: `document.querySelector('textarea')?.outerHTML?.substring(0,100)` },
            { type: 'css', name: 'Aria-label message', selector: `document.querySelector('[aria-label*="essage"]')?.outerHTML?.substring(0,100)` },
            { type: 'css', name: 'Placeholder Message', selector: `document.querySelector('[placeholder*="essage"]')?.outerHTML?.substring(0,100)` },
            { type: 'css', name: 'Role textbox', selector: `document.querySelector('[role="textbox"]')?.outerHTML?.substring(0,100)` },
            { type: 'js', name: 'Instagram input class', selector: `document.querySelector('div.xzsf02u')?.outerHTML?.substring(0,100)` },
            { type: 'js', name: 'Notranslate class', selector: `document.querySelector('div.notranslate[contenteditable="true"]')?.outerHTML?.substring(0,100)` },
        ];

        let workingInputSelector = '';
        
        for (const sel of inputSelectors) {
            console.log(`   Testing: ${sel.name}`);
            
            try {
                const jsResult = await controller.executeJS(sel.selector);
                const found = !!(jsResult && jsResult !== 'null' && jsResult !== 'undefined' && jsResult.length > 10);
                
                results.push({
                    selector: sel.name,
                    type: sel.type as 'css' | 'xpath' | 'js',
                    success: found,
                    result: jsResult || 'not found',
                    elementFound: found
                });
                
                console.log(`   Result: ${found ? '✅ FOUND' : '❌'}`);
                if (found) {
                    console.log(`   Element: ${jsResult.substring(0, 80)}...`);
                    workingInputSelector = sel.name;
                }
            } catch (e: any) {
                console.log(`   Result: ❌ Error`);
            }
        }

        // Step 5: Type test message
        console.log('\n' + '='.repeat(60));
        console.log('⌨️ STEP 5: Typing Test Message\n');
        
        const testMessage = `Hey Sarah! 👋 Selector test at ${new Date().toLocaleTimeString()}`;
        console.log(`   Message: "${testMessage}"\n`);

        // Try multiple typing methods
        const typingMethods = [
            {
                name: 'Method 1: Focus + textContent + Input event',
                code: `
                    var input = document.querySelector('div[contenteditable="true"]') || document.querySelector('[role="textbox"]');
                    if (input) {
                        input.focus();
                        input.textContent = "${testMessage}";
                        input.dispatchEvent(new InputEvent('input', {bubbles: true, data: "${testMessage}"}));
                        'typed_method1';
                    } else { 'no_input'; }
                `
            },
            {
                name: 'Method 2: innerHTML + multiple events',
                code: `
                    var input = document.querySelector('div[contenteditable="true"]');
                    if (input) {
                        input.focus();
                        input.innerHTML = "${testMessage}";
                        input.dispatchEvent(new Event('input', {bubbles: true}));
                        input.dispatchEvent(new Event('change', {bubbles: true}));
                        'typed_method2';
                    } else { 'no_input'; }
                `
            },
            {
                name: 'Method 3: execCommand insertText',
                code: `
                    var input = document.querySelector('div[contenteditable="true"]');
                    if (input) {
                        input.focus();
                        document.execCommand('insertText', false, "${testMessage}");
                        'typed_method3';
                    } else { 'no_input'; }
                `
            }
        ];

        let messageTyped = false;
        
        for (const method of typingMethods) {
            console.log(`   ${method.name}`);
            
            try {
                // Clear input first
                await controller.executeJS(`
                    var input = document.querySelector('div[contenteditable="true"]');
                    if (input) { input.textContent = ''; input.innerHTML = ''; }
                `);
                await delay(500);
                
                const result = await controller.executeJS(method.code);
                console.log(`   Result: ${result}`);
                
                await delay(1500);
                
                // Take screenshot and verify with vision
                const ssType = await controller.getScreenshotBase64(`selector_05_type_${method.name.substring(0,10)}.png`);
                const vType = await analyzeWithVision(ssType, `Is there text "${testMessage.substring(0,20)}" visible in the message input field? Describe what you see in the input area.`);
                
                console.log(`   Vision: ${vType.description}`);
                
                if (vType.messageInputVisible || vType.description.toLowerCase().includes('test') || vType.description.toLowerCase().includes('typed')) {
                    console.log(`   ✅ Message appears to be typed!\n`);
                    messageTyped = true;
                    break;
                }
            } catch (e: any) {
                console.log(`   Error: ${e.message}`);
            }
            console.log('');
        }

        // Step 6: Test SEND BUTTON selectors
        console.log('='.repeat(60));
        console.log('🚀 STEP 6: Testing SEND BUTTON Selectors\n');

        const sendSelectors = [
            { name: 'SVG send icon click', code: `document.querySelector('svg[aria-label="Send"]')?.closest('div[role="button"]')?.click(); 'clicked_svg'` },
            { name: 'Button type submit', code: `document.querySelector('button[type="submit"]')?.click(); 'clicked_submit'` },
            { name: 'Div role=button Send', code: `Array.from(document.querySelectorAll('div[role="button"]')).find(b => b.textContent === 'Send')?.click(); 'clicked_send_text'` },
            { name: 'Enter keypress', code: `
                var input = document.querySelector('div[contenteditable="true"]');
                if (input) {
                    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, bubbles: true}));
                    input.dispatchEvent(new KeyboardEvent('keypress', {key: 'Enter', keyCode: 13, bubbles: true}));
                    input.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', keyCode: 13, bubbles: true}));
                    'enter_pressed';
                }
            `},
            { name: 'Form submit', code: `document.querySelector('form')?.submit(); 'form_submitted'` },
        ];

        console.log('   Testing send methods...\n');
        
        for (const sel of sendSelectors) {
            console.log(`   ${sel.name}`);
            
            try {
                const result = await controller.executeJS(sel.code);
                console.log(`   Result: ${result || 'no result'}`);
                
                results.push({
                    selector: sel.name,
                    type: 'js',
                    success: !!(result && !result.includes('undefined')),
                    result: result || 'no result',
                    elementFound: true
                });
            } catch (e: any) {
                console.log(`   Error: ${e.message}`);
            }
        }

        // Final screenshot and verification
        console.log('\n' + '='.repeat(60));
        console.log('📊 STEP 7: Final Verification\n');
        
        await delay(3000);
        const ssFinal = await controller.getScreenshotBase64('selector_07_final.png');
        const vFinal = await analyzeWithVision(ssFinal, 
            `Check if a test message was sent. Look for any message containing "Selector test" or "Hey Sarah". Was the message delivered? What is the last message in the conversation?`);
        
        console.log(`   Vision Analysis:`);
        console.log(`   ${vFinal.description}`);
        console.log(`   Last message: "${vFinal.lastMessage}"`);
        
        const messageSent = vFinal.lastMessage.toLowerCase().includes('test') || 
                           vFinal.lastMessage.toLowerCase().includes('selector') ||
                           vFinal.description.toLowerCase().includes('sent') ||
                           vFinal.description.toLowerCase().includes('delivered');

        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('📋 SELECTOR TEST SUMMARY');
        console.log('='.repeat(60) + '\n');

        console.log('✅ Working Selectors:');
        results.filter(r => r.success).forEach(r => {
            console.log(`   [${r.type.toUpperCase()}] ${r.selector}`);
        });

        console.log('\n❌ Failed Selectors:');
        results.filter(r => !r.success).forEach(r => {
            console.log(`   [${r.type.toUpperCase()}] ${r.selector}`);
        });

        console.log('\n📊 Test Results:');
        console.log(`   Conversation opened: ${opened ? '✅' : '❌'}`);
        console.log(`   Message typed: ${messageTyped ? '✅' : '❌'}`);
        console.log(`   Message sent: ${messageSent ? '✅' : '⚠️ Check manually'}`);
        console.log(`   Working input selector: ${workingInputSelector || 'none confirmed'}`);
        
        console.log('\n📁 Screenshots saved to: ./screenshots/');
        console.log('   - selector_01_inbox.png');
        console.log('   - selector_03_sarah_open.png');
        console.log('   - selector_05_type_*.png');
        console.log('   - selector_07_final.png\n');

    } catch (error: any) {
        console.error('\n❌ Error:', error.message);
        logger.error('Selector test error:', error);
    }
}

// Run if executed directly
if (require.main === module) {
    runSelectorTest().catch(console.error);
}
