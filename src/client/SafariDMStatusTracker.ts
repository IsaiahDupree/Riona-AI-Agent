/**
 * Safari DM Status Tracker
 * 
 * Analyzes conversations to determine reply status:
 * - REPLIED: Last message was from me
 * - TO_REPLY: Last message was from them (awaiting response)
 * 
 * Run with: npm run dm:status
 */

import SafariController from './SafariController';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface ConversationStatus {
    name: string;
    username?: string;
    lastMessage: string;
    lastMessageFrom: 'me' | 'them' | 'unknown';
    status: 'replied' | 'to_reply' | 'unknown';
    timestamp?: string;
    unread?: boolean;
    tab: 'primary' | 'general' | 'requests';
}

interface StatusReport {
    generatedAt: string;
    summary: {
        total: number;
        replied: number;
        toReply: number;
        unknown: number;
    };
    toReply: ConversationStatus[];
    replied: ConversationStatus[];
    unknown: ConversationStatus[];
}

export class DMStatusTracker {
    private controller: SafariController;

    constructor() {
        this.controller = new SafariController(60000);
    }

    /**
     * Get conversation list with last message info
     */
    async getConversationsWithStatus(tab: 'primary' | 'general' | 'requests'): Promise<ConversationStatus[]> {
        const jsCode = `
(function() {
    var conversations = [];
    
    // Find conversation container
    var container = document.querySelector('div.xb57i2i') || 
                   document.querySelector('div[role="list"]') ||
                   document.querySelector('section > main');
    
    if (!container) return JSON.stringify([]);
    
    // Get all conversation items
    var items = container.querySelectorAll('div[role="button"]');
    
    items.forEach(function(item, index) {
        var spans = item.querySelectorAll('span');
        var name = '';
        var lastMessage = '';
        var isFromMe = false;
        var hasUnread = false;
        
        // Check for unread indicator (blue dot)
        hasUnread = item.querySelector('div[style*="background-color: rgb(0, 149, 246)"]') !== null ||
                   item.querySelector('svg[aria-label*="unread"]') !== null;
        
        spans.forEach(function(span, spanIdx) {
            var text = span.textContent.trim();
            
            if (text && text.length > 0) {
                // First meaningful span is usually the name
                if (!name && text.length < 50 && !text.includes('·') && 
                    !text.includes('Active') && text !== 'Verified') {
                    name = text;
                }
                // Look for "You:" prefix indicating our message
                else if (text.startsWith('You:')) {
                    lastMessage = text.substring(4).trim();
                    isFromMe = true;
                }
                // Other text is likely their message
                else if (name && !lastMessage && text !== name && 
                        text.length > 1 && !text.includes('·')) {
                    lastMessage = text;
                    isFromMe = false;
                }
            }
        });
        
        // Also check for "You:" in the full text content
        var fullText = item.textContent;
        if (fullText.includes('You:') && !isFromMe) {
            isFromMe = true;
        }
        
        if (name && name !== 'Note...' && name !== 'Your note' && name !== 'Search') {
            conversations.push({
                name: name,
                lastMessage: lastMessage.substring(0, 100),
                lastMessageFrom: isFromMe ? 'me' : (lastMessage ? 'them' : 'unknown'),
                status: isFromMe ? 'replied' : (lastMessage ? 'to_reply' : 'unknown'),
                unread: hasUnread,
                index: index
            });
        }
    });
    
    // Remove duplicates by name
    var unique = [];
    var seen = new Set();
    conversations.forEach(function(c) {
        if (!seen.has(c.name)) {
            seen.add(c.name);
            unique.push(c);
        }
    });
    
    return JSON.stringify(unique);
})()`;

        try {
            const result = await this.controller.executeJS(jsCode);
            const convs = JSON.parse(result);
            return convs.map((c: any) => ({ ...c, tab }));
        } catch (e) {
            return [];
        }
    }

    /**
     * Scan all tabs and generate status report
     */
    async generateStatusReport(): Promise<StatusReport> {
        console.log('\n' + '='.repeat(60));
        console.log('📊 DM STATUS TRACKER');
        console.log('='.repeat(60));
        console.log('\nAnalyzing conversations to find reply status...\n');

        const report: StatusReport = {
            generatedAt: new Date().toISOString(),
            summary: { total: 0, replied: 0, toReply: 0, unknown: 0 },
            toReply: [],
            replied: [],
            unknown: []
        };

        try {
            // Navigate to DM inbox
            await this.controller.launchSafari('https://www.instagram.com/direct/inbox/');
            await delay(5000);

            const tabs: Array<'primary' | 'general' | 'requests'> = ['primary', 'general', 'requests'];
            
            for (const tab of tabs) {
                console.log(`📂 Scanning ${tab.toUpperCase()} tab...`);
                
                await this.controller.clickDMTab(tab);
                await delay(2500);
                
                // Scroll to load more
                for (let i = 0; i < 3; i++) {
                    await this.controller.executeJS(`
                        var c = document.querySelector('div.xb57i2i');
                        if (c) c.scrollTop += 500;
                    `);
                    await delay(1000);
                }
                
                const conversations = await this.getConversationsWithStatus(tab);
                console.log(`   Found ${conversations.length} conversations`);
                
                for (const conv of conversations) {
                    if (conv.status === 'replied') {
                        report.replied.push(conv);
                        report.summary.replied++;
                    } else if (conv.status === 'to_reply') {
                        report.toReply.push(conv);
                        report.summary.toReply++;
                    } else {
                        report.unknown.push(conv);
                        report.summary.unknown++;
                    }
                    report.summary.total++;
                }
            }

            // Print report
            console.log('\n' + '='.repeat(60));
            console.log('📋 STATUS REPORT');
            console.log('='.repeat(60));
            
            console.log(`\n📊 Summary:`);
            console.log(`   Total conversations: ${report.summary.total}`);
            console.log(`   ✅ Replied: ${report.summary.replied}`);
            console.log(`   ⏳ To Reply: ${report.summary.toReply}`);
            console.log(`   ❓ Unknown: ${report.summary.unknown}`);
            
            if (report.toReply.length > 0) {
                console.log(`\n⏳ NEED TO REPLY (${report.toReply.length}):`);
                console.log('─'.repeat(50));
                report.toReply.forEach((c, i) => {
                    console.log(`   ${i + 1}. ${c.name} [${c.tab}]`);
                    console.log(`      Last: "${c.lastMessage.substring(0, 40)}..."`);
                    if (c.unread) console.log(`      🔵 UNREAD`);
                });
            }
            
            if (report.replied.length > 0) {
                console.log(`\n✅ ALREADY REPLIED (${report.replied.length}):`);
                console.log('─'.repeat(50));
                report.replied.slice(0, 10).forEach((c, i) => {
                    console.log(`   ${i + 1}. ${c.name} [${c.tab}]`);
                    console.log(`      You: "${c.lastMessage.substring(0, 40)}..."`);
                });
                if (report.replied.length > 10) {
                    console.log(`   ... and ${report.replied.length - 10} more`);
                }
            }

            // Save report
            const outputPath = './extracted_data/dm_status_report.json';
            if (!fs.existsSync('./extracted_data')) {
                fs.mkdirSync('./extracted_data', { recursive: true });
            }
            fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
            
            console.log(`\n📁 Report saved to: ${outputPath}`);
            console.log('='.repeat(60) + '\n');

        } catch (error: any) {
            console.error(`\n❌ Error: ${error.message}`);
            logger.error('Status tracker error:', error);
        }

        return report;
    }

    /**
     * Get only conversations that need a reply
     */
    async getToReplyList(): Promise<ConversationStatus[]> {
        const report = await this.generateStatusReport();
        return report.toReply;
    }
}

export async function runStatusTracker(): Promise<void> {
    const tracker = new DMStatusTracker();
    await tracker.generateStatusReport();
}

// Run if executed directly
if (require.main === module) {
    runStatusTracker().catch(console.error);
}
