/**
 * Safari DM Extractor - Comprehensive Conversation Data Extraction
 * 
 * Cycles through all conversations, extracts messages and metadata,
 * saves to structured JSON with optional Vision verification.
 * 
 * Run with: npm run extract:dms
 */

import SafariController from './SafariController';
import { logger } from '../utils/logger';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Configuration
const CONFIG = {
    useVisionVerification: true,
    maxConversations: 50,
    delayBetweenConversations: 3000,
    delayAfterClick: 2500,
    scrollAttempts: 3,
    outputDir: './extracted_data',
    screenshotsEnabled: true
};

interface ExtractedMessage {
    id: string;
    sender: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
    type: 'text' | 'image' | 'video' | 'link' | 'attachment' | 'reel';
    rawHtml?: string;
}

interface ExtractedConversation {
    id: string;
    participantName: string;
    participantUsername: string;
    isVerified: boolean;
    isGroup: boolean;
    messageCount: number;
    messages: ExtractedMessage[];
    lastActivity: string;
    extractedAt: string;
    tab: 'primary' | 'general' | 'requests';
    screenshotPath?: string;
    visionSummary?: string;
}

interface ExtractionResult {
    extractedAt: string;
    totalConversations: number;
    totalMessages: number;
    conversations: ExtractedConversation[];
    errors: string[];
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function analyzeWithVision(base64: string, prompt: string): Promise<string> {
    if (!CONFIG.useVisionVerification || !process.env.OPENAI_API_KEY) {
        return 'Vision disabled';
    }
    
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: `data:image/png;base64,${base64}`, detail: "low" } }
                ]
            }],
            max_tokens: 300
        });
        return response.choices[0]?.message?.content || 'No response';
    } catch (e: any) {
        return `Vision error: ${e.message}`;
    }
}

async function getConversationList(controller: SafariController): Promise<Array<{name: string, preview: string, index: number}>> {
    const jsCode = `
(function() {
    var conversations = [];
    
    // Find conversation container
    var container = document.querySelector('div.xb57i2i') || 
                   document.querySelector('div[role="list"]') ||
                   document.querySelector('section > main > div > section');
    
    if (!container) return JSON.stringify([]);
    
    // Get all clickable conversation items
    var items = container.querySelectorAll('div[role="button"], div.x1n2onr6');
    
    items.forEach(function(item, index) {
        var spans = item.querySelectorAll('span');
        var name = '';
        var preview = '';
        
        spans.forEach(function(span) {
            var text = span.textContent.trim();
            if (text && text.length > 0 && text.length < 50) {
                if (!name && !text.includes('·') && !text.includes('Verified')) {
                    name = text;
                } else if (name && !preview && text !== name) {
                    preview = text;
                }
            }
        });
        
        if (name && name !== 'Note...' && name !== 'Your note') {
            conversations.push({
                name: name,
                preview: preview.substring(0, 100),
                index: index
            });
        }
    });
    
    return JSON.stringify(conversations);
})()`;

    try {
        const result = await controller.executeJS(jsCode);
        return JSON.parse(result);
    } catch (e) {
        return [];
    }
}

async function extractMessagesFromConversation(controller: SafariController): Promise<ExtractedMessage[]> {
    const jsCode = `
(function() {
    var messages = [];
    
    // Find message containers - look for elements with message IDs
    var msgElements = document.querySelectorAll('[id^="mid."]');
    
    if (msgElements.length === 0) {
        // Fallback: look for message-like divs
        msgElements = document.querySelectorAll('div.x78zum5.xdt5ytf div[dir="auto"]');
    }
    
    msgElements.forEach(function(el, idx) {
        try {
            var id = el.id || 'msg_' + idx;
            var content = '';
            
            // Get text content
            var textEl = el.querySelector('div[dir="auto"]') || el.querySelector('span') || el;
            content = textEl.textContent.trim();
            
            // Check for media
            var hasImage = el.querySelector('img[src*="instagram"]') !== null;
            var hasVideo = el.querySelector('video') !== null;
            var hasLink = el.querySelector('a[href]') !== null;
            
            var type = 'text';
            if (hasVideo) type = 'video';
            else if (hasImage) type = 'image';
            else if (hasLink) type = 'link';
            
            // Determine sender (rough heuristic based on position)
            var rect = el.getBoundingClientRect();
            var isFromMe = rect.left > window.innerWidth / 2;
            
            // Look for timestamp
            var timeEl = el.querySelector('time') || el.closest('div')?.querySelector('time');
            var timestamp = timeEl ? timeEl.getAttribute('datetime') || timeEl.textContent : '';
            
            if (content || type !== 'text') {
                messages.push({
                    id: id,
                    sender: isFromMe ? 'me' : 'them',
                    content: content.substring(0, 500),
                    timestamp: timestamp,
                    isFromMe: isFromMe,
                    type: type
                });
            }
        } catch (e) {
            // Skip problematic elements
        }
    });
    
    return JSON.stringify(messages);
})()`;

    try {
        const result = await controller.executeJS(jsCode);
        return JSON.parse(result);
    } catch (e) {
        return [];
    }
}

async function getParticipantInfo(controller: SafariController): Promise<{name: string, username: string, isVerified: boolean}> {
    const jsCode = `
(function() {
    var info = {name: '', username: '', isVerified: false};
    
    // Look for header with participant name
    var header = document.querySelector('header') || document.querySelector('div.x1iyjqo2 > div:first-child');
    
    if (header) {
        var nameSpan = header.querySelector('span');
        if (nameSpan) info.name = nameSpan.textContent.trim();
        
        // Check for verified badge
        info.isVerified = header.querySelector('svg[aria-label*="Verified"]') !== null ||
                         header.textContent.includes('Verified');
        
        // Look for username link
        var link = header.querySelector('a[href*="/"]');
        if (link) {
            var href = link.getAttribute('href') || '';
            info.username = href.replace(/\\//g, '');
        }
    }
    
    return JSON.stringify(info);
})()`;

    try {
        const result = await controller.executeJS(jsCode);
        return JSON.parse(result);
    } catch (e) {
        return { name: '', username: '', isVerified: false };
    }
}

async function clickConversationByName(controller: SafariController, name: string): Promise<boolean> {
    const escapedName = name.replace(/'/g, "\\'").replace(/"/g, '\\"');
    
    const jsCode = `
(function() {
    var spans = document.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
        if (spans[i].textContent.includes("${escapedName}")) {
            var parent = spans[i].closest('div[role="button"]') || 
                        spans[i].closest('div').parentElement?.parentElement?.parentElement;
            if (parent) {
                parent.click();
                return 'clicked';
            }
        }
    }
    return 'not_found';
})()`;

    try {
        const result = await controller.executeJS(jsCode);
        return result === 'clicked';
    } catch (e) {
        return false;
    }
}

async function scrollConversationList(controller: SafariController): Promise<void> {
    const jsCode = `
(function() {
    var container = document.querySelector('div.xb57i2i') || 
                   document.querySelector('div[role="list"]');
    if (container) {
        container.scrollTop += 500;
        return 'scrolled';
    }
    return 'no_container';
})()`;

    await controller.executeJS(jsCode);
    await delay(1500);
}

export async function extractAllDMs(): Promise<ExtractionResult> {
    const controller = new SafariController(60000);
    const result: ExtractionResult = {
        extractedAt: new Date().toISOString(),
        totalConversations: 0,
        totalMessages: 0,
        conversations: [],
        errors: []
    };

    // Ensure output directory exists
    if (!fs.existsSync(CONFIG.outputDir)) {
        fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }

    console.log('\n' + '='.repeat(60));
    console.log('📥 INSTAGRAM DM DATA EXTRACTION');
    console.log('='.repeat(60));
    console.log(`\nConfig:`);
    console.log(`   Max conversations: ${CONFIG.maxConversations}`);
    console.log(`   Vision verification: ${CONFIG.useVisionVerification}`);
    console.log(`   Output directory: ${CONFIG.outputDir}\n`);

    try {
        // Navigate to DMs
        console.log('📱 Navigating to Instagram DMs...');
        await controller.launchSafari('https://www.instagram.com/direct/inbox/');
        await delay(5000);

        const tabs: Array<'primary' | 'general' | 'requests'> = ['primary', 'general', 'requests'];
        
        for (const tab of tabs) {
            console.log(`\n${'─'.repeat(50)}`);
            console.log(`📂 Processing ${tab.toUpperCase()} tab`);
            console.log('─'.repeat(50));

            // Click tab
            await controller.clickDMTab(tab);
            await delay(CONFIG.delayAfterClick);

            // Scroll to load more conversations
            console.log('   Scrolling to load conversations...');
            for (let i = 0; i < CONFIG.scrollAttempts; i++) {
                await scrollConversationList(controller);
            }

            // Get conversation list
            const conversations = await getConversationList(controller);
            console.log(`   Found ${conversations.length} conversations in ${tab}`);

            // Process each conversation
            for (let i = 0; i < Math.min(conversations.length, CONFIG.maxConversations); i++) {
                const conv = conversations[i];
                
                if (!conv.name || conv.name.length < 2) continue;
                
                console.log(`\n   [${i + 1}/${conversations.length}] ${conv.name}`);
                
                try {
                    // Return to tab
                    await controller.clickDMTab(tab);
                    await delay(1500);
                    
                    // Click on conversation
                    const clicked = await clickConversationByName(controller, conv.name);
                    
                    if (!clicked) {
                        console.log(`      ⚠️ Could not open conversation`);
                        result.errors.push(`Failed to open: ${conv.name}`);
                        continue;
                    }
                    
                    await delay(CONFIG.delayAfterClick);
                    
                    // Get participant info
                    const participant = await getParticipantInfo(controller);
                    
                    // Extract messages
                    const messages = await extractMessagesFromConversation(controller);
                    console.log(`      📝 Extracted ${messages.length} messages`);
                    
                    // Take screenshot if enabled
                    let screenshotPath = '';
                    let visionSummary = '';
                    
                    if (CONFIG.screenshotsEnabled) {
                        const ssName = `${tab}_${i}_${conv.name.replace(/[^a-zA-Z0-9]/g, '_')}.png`;
                        screenshotPath = path.join(CONFIG.outputDir, 'screenshots', ssName);
                        
                        if (!fs.existsSync(path.join(CONFIG.outputDir, 'screenshots'))) {
                            fs.mkdirSync(path.join(CONFIG.outputDir, 'screenshots'), { recursive: true });
                        }
                        
                        try {
                            const ss = await controller.getScreenshotBase64(ssName);
                            
                            if (CONFIG.useVisionVerification && i < 5) { // Vision on first 5 per tab
                                visionSummary = await analyzeWithVision(ss, 
                                    `Summarize this Instagram conversation. Who is it with? What are they discussing? Any notable content?`);
                                console.log(`      🤖 Vision: ${visionSummary.substring(0, 80)}...`);
                            }
                        } catch (e) {
                            // Screenshot failed, continue
                        }
                    }
                    
                    // Build conversation record
                    const extractedConv: ExtractedConversation = {
                        id: `${tab}_${i}_${Date.now()}`,
                        participantName: participant.name || conv.name,
                        participantUsername: participant.username,
                        isVerified: participant.isVerified,
                        isGroup: false,
                        messageCount: messages.length,
                        messages: messages,
                        lastActivity: conv.preview,
                        extractedAt: new Date().toISOString(),
                        tab: tab,
                        screenshotPath: screenshotPath,
                        visionSummary: visionSummary
                    };
                    
                    result.conversations.push(extractedConv);
                    result.totalMessages += messages.length;
                    
                } catch (error: any) {
                    console.log(`      ❌ Error: ${error.message}`);
                    result.errors.push(`${conv.name}: ${error.message}`);
                }
                
                await delay(CONFIG.delayBetweenConversations);
            }
        }

        result.totalConversations = result.conversations.length;

        // Save results
        const outputPath = path.join(CONFIG.outputDir, `dm_extraction_${Date.now()}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
        
        // Also save a summary
        const summaryPath = path.join(CONFIG.outputDir, 'latest_extraction.json');
        fs.writeFileSync(summaryPath, JSON.stringify(result, null, 2));

        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 EXTRACTION COMPLETE');
        console.log('='.repeat(60));
        console.log(`\n   Total conversations: ${result.totalConversations}`);
        console.log(`   Total messages: ${result.totalMessages}`);
        console.log(`   Errors: ${result.errors.length}`);
        console.log(`\n   Data saved to: ${outputPath}`);
        console.log(`   Latest link: ${summaryPath}`);
        
        if (result.errors.length > 0) {
            console.log(`\n   ⚠️ Errors encountered:`);
            result.errors.slice(0, 5).forEach(e => console.log(`      - ${e}`));
        }
        
        console.log('\n' + '='.repeat(60) + '\n');

    } catch (error: any) {
        console.error('\n❌ Fatal error:', error.message);
        result.errors.push(`Fatal: ${error.message}`);
        logger.error('Extraction error:', error);
    }

    return result;
}

// Run if executed directly
if (require.main === module) {
    extractAllDMs().catch(console.error);
}
