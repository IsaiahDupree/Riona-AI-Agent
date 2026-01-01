/**
 * Safari Message Requests Processor
 * 
 * Processes all message requests including hidden requests.
 * Extracts conversation data and categorizes by status.
 * 
 * Run with: npm run dm:requests
 */

import SafariController from './SafariController';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface RequestConversation {
    name: string;
    username?: string;
    preview: string;
    type: 'visible' | 'hidden';
    index: number;
    hasMedia: boolean;
    timestamp?: string;
}

interface RequestsReport {
    extractedAt: string;
    summary: {
        totalVisible: number;
        totalHidden: number;
        total: number;
    };
    visibleRequests: RequestConversation[];
    hiddenRequests: RequestConversation[];
}

export class RequestsProcessor {
    private controller: SafariController;

    constructor() {
        this.controller = new SafariController(60000);
    }

    /**
     * Get all visible requests from the Requests tab
     */
    async getVisibleRequests(): Promise<RequestConversation[]> {
        const jsCode = `
(function() {
    var requests = [];
    
    // Find request items in the requests section
    // The requests tab has a different structure than primary/general
    var container = document.querySelector('section > main > section');
    if (!container) return JSON.stringify([]);
    
    // Get all clickable items
    var items = container.querySelectorAll('div[role="button"]');
    
    items.forEach(function(item, index) {
        var spans = item.querySelectorAll('span');
        var name = '';
        var preview = '';
        var hasMedia = false;
        
        // Check for media indicators
        hasMedia = item.querySelector('img') !== null || 
                  item.textContent.includes('sent an attachment');
        
        spans.forEach(function(span) {
            var text = span.textContent.trim();
            if (text && text.length > 0 && text.length < 60) {
                // Skip common non-name text
                if (text === 'Hidden Requests' || text.includes('·') || 
                    text === 'Accept' || text === 'Delete' || text === 'Block') {
                    return;
                }
                
                if (!name) {
                    name = text;
                } else if (!preview && text !== name) {
                    preview = text;
                }
            }
        });
        
        if (name && name !== 'Hidden Requests') {
            requests.push({
                name: name,
                preview: preview.substring(0, 100),
                type: 'visible',
                index: index,
                hasMedia: hasMedia
            });
        }
    });
    
    // Remove duplicates
    var unique = [];
    var seen = new Set();
    requests.forEach(function(r) {
        if (!seen.has(r.name)) {
            seen.add(r.name);
            unique.push(r);
        }
    });
    
    return JSON.stringify(unique);
})()`;

        try {
            const result = await this.controller.executeJS(jsCode);
            return JSON.parse(result);
        } catch (e) {
            return [];
        }
    }

    /**
     * Click on "Hidden Requests" to open that section
     */
    async openHiddenRequests(): Promise<boolean> {
        const jsCode = `
(function() {
    // Method 1: Find by text content
    var spans = document.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
        if (spans[i].textContent.includes('Hidden Requests')) {
            var clickable = spans[i].closest('div[role="button"]') ||
                          spans[i].closest('a') ||
                          spans[i].closest('div[tabindex]') ||
                          spans[i].parentElement?.parentElement;
            if (clickable) {
                clickable.click();
                return 'clicked_hidden_requests';
            }
        }
    }
    
    // Method 2: Try the specific class pattern for the link
    var link = document.querySelector('div.x1i10hfl.x1qjc9v5.xjbqb8w');
    if (link && link.textContent.includes('Hidden')) {
        link.click();
        return 'clicked_by_class';
    }
    
    return 'hidden_requests_not_found';
})()`;

        try {
            const result = await this.controller.executeJS(jsCode);
            console.log(`   Open hidden requests: ${result}`);
            return result.includes('clicked');
        } catch (e) {
            return false;
        }
    }

    /**
     * Get all hidden requests
     */
    async getHiddenRequests(): Promise<RequestConversation[]> {
        const jsCode = `
(function() {
    var requests = [];
    
    // In hidden requests view, the structure is similar
    var container = document.querySelector('section > main > section') ||
                   document.querySelector('section > main');
    if (!container) return JSON.stringify([]);
    
    var items = container.querySelectorAll('div[role="button"]');
    
    items.forEach(function(item, index) {
        var spans = item.querySelectorAll('span');
        var name = '';
        var preview = '';
        var hasMedia = false;
        
        hasMedia = item.querySelector('img') !== null ||
                  item.textContent.includes('sent an attachment');
        
        spans.forEach(function(span) {
            var text = span.textContent.trim();
            if (text && text.length > 0 && text.length < 60) {
                if (text === 'Back' || text.includes('·') || 
                    text === 'Accept' || text === 'Delete' || text === 'Block' ||
                    text === 'Hidden Requests') {
                    return;
                }
                
                if (!name) {
                    name = text;
                } else if (!preview && text !== name) {
                    preview = text;
                }
            }
        });
        
        if (name) {
            requests.push({
                name: name,
                preview: preview.substring(0, 100),
                type: 'hidden',
                index: index,
                hasMedia: hasMedia
            });
        }
    });
    
    // Remove duplicates
    var unique = [];
    var seen = new Set();
    requests.forEach(function(r) {
        if (!seen.has(r.name)) {
            seen.add(r.name);
            unique.push(r);
        }
    });
    
    return JSON.stringify(unique);
})()`;

        try {
            const result = await this.controller.executeJS(jsCode);
            return JSON.parse(result);
        } catch (e) {
            return [];
        }
    }

    /**
     * Go back from hidden requests to main requests view
     */
    async goBackFromHidden(): Promise<void> {
        const jsCode = `
(function() {
    // Look for back button
    var backBtn = document.querySelector('svg[aria-label="Back"]')?.closest('div[role="button"]');
    if (backBtn) {
        backBtn.click();
        return 'clicked_back';
    }
    
    // Or just navigate to requests tab
    return 'no_back_button';
})()`;

        await this.controller.executeJS(jsCode);
    }

    /**
     * Process all requests (visible and hidden)
     */
    async processAllRequests(): Promise<RequestsReport> {
        console.log('\n' + '='.repeat(60));
        console.log('📬 MESSAGE REQUESTS PROCESSOR');
        console.log('='.repeat(60));
        console.log('\nProcessing all message requests...\n');

        const report: RequestsReport = {
            extractedAt: new Date().toISOString(),
            summary: { totalVisible: 0, totalHidden: 0, total: 0 },
            visibleRequests: [],
            hiddenRequests: []
        };

        try {
            // Navigate to DM inbox
            await this.controller.launchSafari('https://www.instagram.com/direct/inbox/');
            await delay(5000);

            // Click Requests tab - use direct selector
            console.log('📂 Navigating to Requests tab...');
            
            // First try the controller method
            await this.controller.clickDMTab('requests');
            await delay(2000);
            
            // Verify we're on requests, if not click directly
            const verifyTab = await this.controller.executeJS(`
                (function() {
                    // Check if we're on requests by looking at URL or tab state
                    var tabs = document.querySelectorAll('div[role="tab"], span');
                    for (var t of tabs) {
                        if (t.textContent.includes('Requests')) {
                            // Click it to make sure
                            var clickable = t.closest('div[role="tab"]') || t.closest('div[role="button"]') || t;
                            clickable.click();
                            return 'clicked_requests_tab';
                        }
                    }
                    return 'requests_tab_not_found';
                })()
            `);
            console.log(`   Tab verification: ${verifyTab}`);
            await delay(3000);

            // Take screenshot
            await this.controller.takeScreenshot('requests_01_visible.png');

            // Scroll to load all visible requests
            console.log('   Scrolling to load all requests...');
            for (let i = 0; i < 5; i++) {
                await this.controller.executeJS(`
                    var c = document.querySelector('section > main > section');
                    if (c) c.scrollTop += 500;
                `);
                await delay(1000);
            }

            // Get visible requests
            console.log('\n📋 Extracting VISIBLE requests...');
            report.visibleRequests = await this.getVisibleRequests();
            report.summary.totalVisible = report.visibleRequests.length;
            console.log(`   Found ${report.visibleRequests.length} visible requests`);

            if (report.visibleRequests.length > 0) {
                console.log('\n   Visible Requests:');
                report.visibleRequests.slice(0, 10).forEach((r, i) => {
                    console.log(`   ${i + 1}. ${r.name}${r.hasMedia ? ' 📎' : ''}`);
                    if (r.preview) console.log(`      "${r.preview.substring(0, 40)}..."`);
                });
                if (report.visibleRequests.length > 10) {
                    console.log(`   ... and ${report.visibleRequests.length - 10} more`);
                }
            }

            // Try to open hidden requests
            console.log('\n📋 Looking for HIDDEN requests...');
            const hiddenOpened = await this.openHiddenRequests();
            
            if (hiddenOpened) {
                await delay(3000);
                
                // Take screenshot
                await this.controller.takeScreenshot('requests_02_hidden.png');

                // Scroll in hidden requests
                for (let i = 0; i < 3; i++) {
                    await this.controller.executeJS(`
                        var c = document.querySelector('section > main > section');
                        if (c) c.scrollTop += 500;
                    `);
                    await delay(1000);
                }

                // Get hidden requests
                report.hiddenRequests = await this.getHiddenRequests();
                report.summary.totalHidden = report.hiddenRequests.length;
                console.log(`   Found ${report.hiddenRequests.length} hidden requests`);

                if (report.hiddenRequests.length > 0) {
                    console.log('\n   Hidden Requests:');
                    report.hiddenRequests.slice(0, 10).forEach((r, i) => {
                        console.log(`   ${i + 1}. ${r.name}${r.hasMedia ? ' 📎' : ''}`);
                        if (r.preview) console.log(`      "${r.preview.substring(0, 40)}..."`);
                    });
                    if (report.hiddenRequests.length > 10) {
                        console.log(`   ... and ${report.hiddenRequests.length - 10} more`);
                    }
                }

                // Go back
                await this.goBackFromHidden();
                await delay(1500);
            } else {
                console.log('   No hidden requests section found (or already empty)');
            }

            report.summary.total = report.summary.totalVisible + report.summary.totalHidden;

            // Save report
            const outputPath = './extracted_data/requests_report.json';
            if (!fs.existsSync('./extracted_data')) {
                fs.mkdirSync('./extracted_data', { recursive: true });
            }
            fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

            // Print summary
            console.log('\n' + '='.repeat(60));
            console.log('📊 REQUESTS SUMMARY');
            console.log('='.repeat(60));
            console.log(`\n   Total Requests: ${report.summary.total}`);
            console.log(`   ├── Visible: ${report.summary.totalVisible}`);
            console.log(`   └── Hidden: ${report.summary.totalHidden}`);
            console.log(`\n📁 Report saved to: ${outputPath}`);
            console.log('='.repeat(60) + '\n');

        } catch (error: any) {
            console.error(`\n❌ Error: ${error.message}`);
            logger.error('Requests processor error:', error);
        }

        return report;
    }

    /**
     * Click on a specific request by name to open conversation
     */
    async openRequest(name: string, type: 'visible' | 'hidden' = 'visible'): Promise<boolean> {
        if (type === 'hidden') {
            await this.openHiddenRequests();
            await delay(2000);
        }

        const escapedName = name.replace(/'/g, "\\'");
        const jsCode = `
(function() {
    var spans = document.querySelectorAll('span');
    for (var i = 0; i < spans.length; i++) {
        if (spans[i].textContent.includes('${escapedName}')) {
            var clickable = spans[i].closest('div[role="button"]');
            if (clickable) {
                clickable.click();
                return 'clicked';
            }
        }
    }
    return 'not_found';
})()`;

        try {
            const result = await this.controller.executeJS(jsCode);
            return result === 'clicked';
        } catch (e) {
            return false;
        }
    }

    /**
     * Accept a specific message request by name
     * Opens the request, clicks Accept button, verifies in inbox
     */
    async acceptRequest(name: string, type: 'visible' | 'hidden' = 'visible'): Promise<{success: boolean, message: string}> {
        console.log(`\n📥 Accepting request from: ${name}`);
        
        try {
            // Navigate to requests tab
            await this.controller.navigateTo('https://www.instagram.com/direct/inbox/');
            await delay(4000);
            
            // Go to requests tab
            await this.controller.clickDMTab('requests');
            await delay(2000);
            
            // Click on requests tab again to make sure
            await this.controller.executeJS(`
                var tabs = document.querySelectorAll('span');
                for (var t of tabs) {
                    if (t.textContent.includes('Requests')) {
                        t.closest('div[role="tab"]')?.click() || t.click();
                        break;
                    }
                }
            `);
            await delay(2000);

            // If hidden, open hidden requests first
            if (type === 'hidden') {
                console.log('   Opening hidden requests...');
                await this.openHiddenRequests();
                await delay(2500);
            }

            // Find and click on the request
            console.log('   Finding request...');
            const opened = await this.openRequest(name, type === 'hidden' ? 'visible' : type);
            
            if (!opened) {
                return { success: false, message: `Could not find request from ${name}` };
            }
            
            await delay(2500);
            
            // Take screenshot before accepting
            await this.controller.takeScreenshot(`accept_${name.replace(/[^a-zA-Z0-9]/g, '_')}_before.png`);

            // Click Accept button
            console.log('   Clicking Accept button...');
            const acceptResult = await this.controller.executeJS(`
(function() {
    // Method 1: Use exact user-provided selector for Accept button
    var acceptBtn = document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > div > section > div > div > div > div.x9f619.x2lah0s.x1nhvcw1.x1qjc9v5.xozqiw3.x1q0g3np.x78zum5.x1iyjqo2.x5yr21d.x1t2pt76.x1n2onr6.x1ja2u2z > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x193iq5w.xeuugli.x1r8uery.x1iyjqo2.xs83m0k > div > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1iyjqo2.x2lwn1j.xeuugli.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1.xcrg951.x6prxxf.x6ikm8r.x10wlt62.x1n2onr6.xh8yej3 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x193iq5w.x2lwn1j.x1n2onr6 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.xdt5ytf.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1.x5ur3kl.x13fuv20.x178xt8z > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.xyamay9.xv54qhq.x1l90r2v.xf7dkkf.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x6s0dn4.x1oa3qoh.x1nhvcw1 > div:nth-child(5) > div");
    if (acceptBtn) {
        acceptBtn.click();
        return 'clicked_exact_selector';
    }
    
    // Method 2: Find by text "Accept"
    var buttons = document.querySelectorAll('div[role="button"], button');
    for (var btn of buttons) {
        if (btn.textContent.trim() === 'Accept') {
            btn.click();
            return 'clicked_accept';
        }
    }
    
    // Method 3: Find by aria-label
    acceptBtn = document.querySelector('[aria-label="Accept"]');
    if (acceptBtn) {
        acceptBtn.click();
        return 'clicked_aria';
    }
    
    // Method 4: Look for primary action button in conversation
    var primaryBtn = document.querySelector('div[style*="background-color: rgb(0, 149, 246)"]');
    if (primaryBtn && primaryBtn.textContent.includes('Accept')) {
        primaryBtn.click();
        return 'clicked_primary';
    }
    
    return 'accept_not_found';
})()
            `);
            
            console.log(`   Accept result: ${acceptResult}`);
            
            if (!acceptResult.includes('clicked')) {
                // Maybe already accepted or in different state
                return { success: false, message: `Accept button not found for ${name}` };
            }
            
            await delay(2000);
            
            // After clicking Accept, a modal appears asking "Move messages into: Primary/General"
            // Click "Primary" to complete the accept
            console.log('   Selecting Primary inbox...');
            const primaryResult = await this.controller.executeJS(`
(function() {
    // Look for the modal with Primary/General options
    var buttons = document.querySelectorAll('div[role="button"], button');
    for (var btn of buttons) {
        var text = btn.textContent.trim();
        if (text === 'Primary') {
            btn.click();
            return 'clicked_primary';
        }
    }
    
    // Also try finding by dialog structure
    var dialog = document.querySelector('div[role="dialog"]');
    if (dialog) {
        var options = dialog.querySelectorAll('div[role="button"]');
        for (var opt of options) {
            if (opt.textContent.includes('Primary')) {
                opt.click();
                return 'clicked_dialog_primary';
            }
        }
    }
    
    return 'primary_not_found';
})()
            `);
            console.log(`   Primary selection: ${primaryResult}`);
            
            await delay(3000);
            
            // Take screenshot after accepting
            await this.controller.takeScreenshot(`accept_${name.replace(/[^a-zA-Z0-9]/g, '_')}_after.png`);

            // Verify in primary inbox
            console.log('   Verifying in inbox...');
            await this.controller.navigateTo('https://www.instagram.com/direct/inbox/');
            await delay(3000);
            
            // Check if the person is now in the conversation list
            const escapedName = name.replace(/'/g, "\\'");
            const verified = await this.controller.executeJS(`
                var found = false;
                var spans = document.querySelectorAll('span');
                for (var s of spans) {
                    if (s.textContent.includes('${escapedName}')) {
                        found = true;
                        break;
                    }
                }
                found ? 'verified' : 'not_found';
            `);
            
            if (verified === 'verified') {
                console.log(`   ✅ ${name} added to inbox successfully!`);
                return { success: true, message: `${name} accepted and added to inbox` };
            } else {
                console.log(`   ⚠️ ${name} may have been accepted but not found in inbox`);
                return { success: true, message: `${name} accepted (verify manually)` };
            }
            
        } catch (error: any) {
            console.error(`   ❌ Error: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * Accept multiple requests by name
     */
    async acceptMultipleRequests(names: string[], type: 'visible' | 'hidden' = 'visible'): Promise<{accepted: string[], failed: string[]}> {
        const results = { accepted: [] as string[], failed: [] as string[] };
        
        console.log('\n' + '='.repeat(60));
        console.log('📥 ACCEPTING MULTIPLE REQUESTS');
        console.log('='.repeat(60));
        console.log(`\nRequests to accept: ${names.length}`);
        
        for (const name of names) {
            const result = await this.acceptRequest(name, type);
            if (result.success) {
                results.accepted.push(name);
            } else {
                results.failed.push(name);
            }
            await delay(2000);
        }
        
        console.log('\n' + '='.repeat(60));
        console.log('📊 RESULTS');
        console.log('='.repeat(60));
        console.log(`   ✅ Accepted: ${results.accepted.length}`);
        results.accepted.forEach(n => console.log(`      - ${n}`));
        console.log(`   ❌ Failed: ${results.failed.length}`);
        results.failed.forEach(n => console.log(`      - ${n}`));
        console.log('='.repeat(60) + '\n');
        
        return results;
    }
}

/**
 * Accept a specific request - can be called with name argument
 */
export async function acceptSpecificRequest(name: string, type: 'visible' | 'hidden' = 'visible'): Promise<void> {
    const processor = new RequestsProcessor();
    await processor.acceptRequest(name, type);
}

export async function runRequestsProcessor(): Promise<void> {
    const processor = new RequestsProcessor();
    await processor.processAllRequests();
}

// Run if executed directly
if (require.main === module) {
    runRequestsProcessor().catch(console.error);
}
