/**
 * Safari Controller
 * 
 * Controls the actual Safari.app browser using AppleScript.
 * This allows using your real Safari profile with existing logins/cookies.
 * 
 * Requires:
 * - macOS
 * - Safari Developer Menu enabled
 * - Automation permissions in System Settings
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export interface PageState {
    url: string;
    title: string;
    loggedIn: boolean;
    hasLoginForm: boolean;
    hasDMInbox: boolean;
    conversationCount: number;
    currentTab: 'primary' | 'general' | 'requests' | 'unknown';
}

export interface ConversationInfo {
    index: number;
    username: string;
    lastMessage: string;
    timestamp: string;
    isUnread: boolean;
    isGroup: boolean;
}

export interface MessageInfo {
    sender: string;
    content: string;
    timestamp: string;
    isFromMe: boolean;
    type: 'text' | 'image' | 'video' | 'link' | 'other';
}

export interface NoteInfo {
    username: string;
    content: string;
    timestamp: string;
    isOwn: boolean;
}

export class SafariController {
    private timeout: number;

    constructor(timeout: number = 30000) {
        this.timeout = timeout;
    }

    /**
     * Execute AppleScript and return result
     */
    private async runAppleScript(script: string): Promise<string> {
        try {
            // Escape the script for shell
            const escapedScript = script.replace(/'/g, "'\"'\"'");
            const { stdout, stderr } = await execAsync(`osascript -e '${escapedScript}'`, {
                timeout: this.timeout
            });
            
            if (stderr && !stderr.includes('missing value')) {
                logger.debug('AppleScript stderr:', { stderr });
            }
            
            return stdout.trim();
        } catch (error: any) {
            logger.error('AppleScript error:', { 
                error: error.message,
                script: script.substring(0, 200)
            });
            throw error;
        }
    }

    /**
     * Execute JavaScript in Safari's current tab
     */
    async executeJS(jsCode: string): Promise<string> {
        // Escape JavaScript for AppleScript
        const escapedJS = jsCode
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');

        const script = `
tell application "Safari"
    tell front window
        tell current tab
            do JavaScript "${escapedJS}"
        end tell
    end tell
end tell`;

        return this.runAppleScript(script);
    }

    /**
     * Launch Safari with a URL
     */
    async launchSafari(url: string): Promise<boolean> {
        try {
            const script = `
tell application "Safari"
    activate
    if (count of windows) = 0 then
        make new document with properties {URL:"${url}"}
    else
        tell front window
            set URL of current tab to "${url}"
        end tell
    end if
end tell`;

            await this.runAppleScript(script);
            logger.info('Safari launched', { url });
            return true;
        } catch (error) {
            logger.error('Failed to launch Safari:', error);
            return false;
        }
    }

    /**
     * Navigate to a URL in current tab
     */
    async navigateTo(url: string): Promise<boolean> {
        try {
            const script = `
tell application "Safari"
    activate
    tell front window
        set URL of current tab to "${url}"
    end tell
end tell`;

            await this.runAppleScript(script);
            await this.delay(2000);
            return true;
        } catch (error) {
            logger.error('Navigation failed:', error);
            return false;
        }
    }

    /**
     * Get current URL
     */
    async getCurrentUrl(): Promise<string> {
        const script = `
tell application "Safari"
    tell front window
        return URL of current tab
    end tell
end tell`;

        return this.runAppleScript(script);
    }

    /**
     * Get page title
     */
    async getPageTitle(): Promise<string> {
        const script = `
tell application "Safari"
    tell front window
        return name of current tab
    end tell
end tell`;

        return this.runAppleScript(script);
    }

    /**
     * Get comprehensive page state
     */
    async getPageState(): Promise<PageState> {
        const jsCode = `
(function() {
    var url = window.location.href;
    var title = document.title;
    var loggedIn = !!document.querySelector('img[alt*="profile picture"]') || 
                   !!document.querySelector('span[aria-label*="Profile"]') ||
                   url.includes('/direct/');
    var hasLoginForm = !!document.querySelector('input[name="username"]');
    var hasDMInbox = url.includes('/direct/inbox') || url.includes('/direct/t/');
    
    // Count conversations
    var convElements = document.querySelectorAll('a[href*="/direct/t/"]');
    var conversationCount = convElements.length;
    
    // Detect current tab (Primary, General, Requests)
    var currentTab = 'unknown';
    var tabLinks = document.querySelectorAll('a[href*="/direct/"]');
    tabLinks.forEach(function(link) {
        if (link.getAttribute('aria-selected') === 'true' || 
            link.classList.contains('active') ||
            link.querySelector('[aria-selected="true"]')) {
            var text = link.textContent.toLowerCase();
            if (text.includes('primary')) currentTab = 'primary';
            else if (text.includes('general')) currentTab = 'general';
            else if (text.includes('request')) currentTab = 'requests';
        }
    });
    
    return JSON.stringify({
        url: url,
        title: title,
        loggedIn: loggedIn,
        hasLoginForm: hasLoginForm,
        hasDMInbox: hasDMInbox,
        conversationCount: conversationCount,
        currentTab: currentTab
    });
})()`;

        try {
            const result = await this.executeJS(jsCode);
            return JSON.parse(result);
        } catch (error) {
            logger.error('Failed to get page state:', error);
            return {
                url: '',
                title: '',
                loggedIn: false,
                hasLoginForm: false,
                hasDMInbox: false,
                conversationCount: 0,
                currentTab: 'unknown'
            };
        }
    }

    /**
     * Navigate to Instagram DMs
     */
    async navigateToDMs(): Promise<boolean> {
        await this.navigateTo('https://www.instagram.com/direct/inbox/');
        await this.delay(3000);
        
        const state = await this.getPageState();
        return state.hasDMInbox;
    }

    /**
     * Click on Primary, General, or Requests tab
     */
    async clickDMTab(tab: 'primary' | 'general' | 'requests'): Promise<boolean> {
        const jsCode = `
(function() {
    var tabText = '${tab}';
    var clicked = false;
    
    // Find tab links in the DM inbox
    var links = document.querySelectorAll('a, div[role="button"], span[role="button"]');
    
    for (var i = 0; i < links.length; i++) {
        var text = (links[i].textContent || '').toLowerCase().trim();
        if (text === tabText || text.includes(tabText)) {
            links[i].click();
            clicked = true;
            break;
        }
    }
    
    // Alternative: look for tab-like elements
    if (!clicked) {
        var tabs = document.querySelectorAll('[role="tab"], [role="tablist"] > *');
        for (var j = 0; j < tabs.length; j++) {
            var tabContent = (tabs[j].textContent || '').toLowerCase();
            if (tabContent.includes(tabText)) {
                tabs[j].click();
                clicked = true;
                break;
            }
        }
    }
    
    return clicked ? 'clicked' : 'not_found';
})()`;

        try {
            const result = await this.executeJS(jsCode);
            await this.delay(2000);
            
            if (result === 'clicked') {
                logger.info(`Clicked ${tab} tab`);
                return true;
            }
            logger.warn(`Could not find ${tab} tab`);
            return false;
        } catch (error) {
            logger.error(`Failed to click ${tab} tab:`, error);
            return false;
        }
    }

    /**
     * Get all visible conversations
     */
    async getConversations(): Promise<ConversationInfo[]> {
        const jsCode = `
(function() {
    var conversations = [];
    
    // Try multiple selector strategies for Instagram's dynamic DOM
    var convElements = [];
    
    // Strategy 1: Direct links to conversations
    var links = document.querySelectorAll('a[href*="/direct/t/"]');
    if (links.length > 0) {
        convElements = Array.from(links);
    }
    
    // Strategy 2: Clickable conversation rows
    if (convElements.length === 0) {
        var rows = document.querySelectorAll('div[role="listbox"] > div, div[role="list"] > div');
        convElements = Array.from(rows).filter(function(el) {
            return el.textContent && el.textContent.length > 0;
        });
    }
    
    // Strategy 3: Look for profile pictures as conversation indicators
    if (convElements.length === 0) {
        var imgs = document.querySelectorAll('img[alt*="profile picture"]');
        imgs.forEach(function(img) {
            var parent = img.closest('div[role="button"]') || img.closest('a') || img.parentElement.parentElement.parentElement;
            if (parent && !convElements.includes(parent)) {
                convElements.push(parent);
            }
        });
    }
    
    // Strategy 4: Use Instagram's specific conversation container classes
    if (convElements.length === 0) {
        // These class patterns are from the actual Instagram DOM
        var convContainers = document.querySelectorAll('div.x9f619.x1ja2u2z.x78zum5.x1n2onr6.x1iyjqo2.xs83m0k.xeuugli.x1qughib.x6s0dn4.x1a02dak.x1q0g3np.xdl72j9');
        convElements = Array.from(convContainers);
    }
    
    // Strategy 5: Find by the message container area
    if (convElements.length === 0) {
        var mainArea = document.querySelector('div.xb57i2i');
        if (mainArea) {
            var rows = mainArea.querySelectorAll('div > div > div > div > div');
            convElements = Array.from(rows).filter(function(el) {
                var hasImg = el.querySelector('img[alt*="profile"]');
                var text = el.textContent || '';
                return hasImg && text.length > 5 && text.length < 500;
            });
        }
    }
    
    // Strategy 6: Generic clickable items in the inbox area
    if (convElements.length === 0) {
        var mainArea = document.querySelector('div[class*="x9f619"]');
        if (mainArea) {
            var clickables = mainArea.querySelectorAll('div[role="button"], div[tabindex="0"]');
            convElements = Array.from(clickables).filter(function(el) {
                var text = el.textContent || '';
                return text.length > 5 && text.length < 500 && !text.includes('New message');
            });
        }
    }
    
    // Debug: log what we found
    console.log('Found ' + convElements.length + ' potential conversations');
    
    convElements.forEach(function(element, index) {
        try {
            var container = element;
            
            // Extract username from various possible locations
            var usernameEl = container.querySelector('span[dir="auto"]') || 
                            container.querySelector('span[class*="x1lliihq"]') ||
                            container.querySelector('img[alt*="profile"]');
            var username = 'Unknown';
            if (usernameEl) {
                if (usernameEl.tagName === 'IMG') {
                    username = (usernameEl.getAttribute('alt') || '').replace("'s profile picture", '').trim();
                } else {
                    username = usernameEl.textContent.trim();
                }
            }
            
            // Extract last message preview - look for secondary text
            var allSpans = container.querySelectorAll('span[dir="auto"], span');
            var lastMessage = '';
            for (var i = allSpans.length - 1; i >= 0; i--) {
                var text = allSpans[i].textContent.trim();
                if (text && text !== username && text.length > 0 && text.length < 200) {
                    lastMessage = text;
                    break;
                }
            }
            
            // Check for unread indicator
            var containerHTML = container.innerHTML || '';
            var isUnread = containerHTML.includes('rgb(0, 149, 246)') || 
                          containerHTML.includes('font-weight: 600') ||
                          containerHTML.includes('font-weight: 700') ||
                          !!container.querySelector('[aria-label*="unread"]');
            
            // Check if group chat
            var isGroup = username.includes(',') || 
                         !!container.querySelector('[aria-label*="group"]') ||
                         (container.querySelectorAll('img[alt*="profile"]').length > 1);
            
            // Extract timestamp
            var timeEl = container.querySelector('time');
            var timestamp = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent.trim()) : '';
            
            if (username !== 'Unknown' || lastMessage) {
                conversations.push({
                    index: index,
                    username: username.substring(0, 50),
                    lastMessage: lastMessage.substring(0, 100),
                    timestamp: timestamp,
                    isUnread: isUnread,
                    isGroup: isGroup
                });
            }
        } catch (e) {
            console.log('Error parsing conversation ' + index + ': ' + e.message);
        }
    });
    
    return JSON.stringify(conversations);
})()`;

        try {
            const result = await this.executeJS(jsCode);
            return JSON.parse(result);
        } catch (error) {
            logger.error('Failed to get conversations:', error);
            return [];
        }
    }

    /**
     * Click on a specific conversation by index
     */
    async clickConversation(index: number): Promise<boolean> {
        const jsCode = `
(function() {
    // Try multiple strategies to find and click conversation
    
    // Strategy 1: Direct conversation links
    var convLinks = document.querySelectorAll('a[href*="/direct/t/"]');
    if (convLinks[${index}]) {
        convLinks[${index}].click();
        return 'clicked_link';
    }
    
    // Strategy 2: Profile pictures in conversation list
    var profileImgs = document.querySelectorAll('img[alt*="profile picture"]');
    var convContainers = [];
    profileImgs.forEach(function(img) {
        var container = img.closest('div[role="button"]') || 
                       img.closest('div[tabindex="0"]') ||
                       img.parentElement.parentElement.parentElement;
        if (container && !convContainers.includes(container)) {
            convContainers.push(container);
        }
    });
    
    if (convContainers[${index}]) {
        convContainers[${index}].click();
        return 'clicked_container';
    }
    
    // Strategy 3: Any clickable row in the inbox
    var rows = document.querySelectorAll('div[role="button"], div[tabindex="0"]');
    var convRows = Array.from(rows).filter(function(el) {
        var text = el.textContent || '';
        return text.length > 5 && text.length < 500 && 
               !text.includes('New message') && 
               !text.includes('Primary') &&
               !text.includes('General') &&
               !text.includes('Requests');
    });
    
    if (convRows[${index}]) {
        convRows[${index}].click();
        return 'clicked_row';
    }
    
    return 'not_found';
})()`;

        try {
            const result = await this.executeJS(jsCode);
            if (result.startsWith('clicked')) {
                logger.info(`Clicked conversation ${index}: ${result}`);
                await this.delay(2000);
                return true;
            }
            logger.warn(`Could not click conversation ${index}: ${result}`);
            return false;
        } catch (error) {
            logger.error('Failed to click conversation:', error);
            return false;
        }
    }

    /**
     * Scroll the conversation list to load more
     */
    async scrollConversationList(direction: 'up' | 'down' = 'down'): Promise<number> {
        const scrollAmount = direction === 'down' ? 500 : -500;
        
        const jsCode = `
(function() {
    // Find the scrollable container for conversations
    var containers = document.querySelectorAll('[role="list"], [role="listbox"], div[style*="overflow"]');
    var scrolled = false;
    var newCount = 0;
    
    for (var i = 0; i < containers.length; i++) {
        var container = containers[i];
        if (container.scrollHeight > container.clientHeight) {
            container.scrollTop += ${scrollAmount};
            scrolled = true;
            break;
        }
    }
    
    // Fallback: scroll the main conversation area
    if (!scrolled) {
        var mainArea = document.querySelector('div[class*="inbox"]') || 
                      document.querySelector('div[role="main"]');
        if (mainArea) {
            mainArea.scrollTop += ${scrollAmount};
        }
    }
    
    // Count conversations after scroll
    newCount = document.querySelectorAll('a[href*="/direct/t/"]').length;
    
    return newCount.toString();
})()`;

        try {
            const result = await this.executeJS(jsCode);
            await this.delay(1000);
            return parseInt(result) || 0;
        } catch (error) {
            logger.error('Failed to scroll:', error);
            return 0;
        }
    }

    /**
     * Get all messages from current conversation
     */
    async getMessagesFromConversation(): Promise<MessageInfo[]> {
        const jsCode = `
(function() {
    var messages = [];
    var seenContent = new Set();
    
    console.log('Looking for messages with Instagram-specific selectors...');
    
    // Strategy 1: Find message elements by their ID pattern (mid.$...)
    var msgElements = document.querySelectorAll('[id^="mid."]');
    console.log('Found ' + msgElements.length + ' message elements by ID');
    
    msgElements.forEach(function(msgEl) {
        try {
            // Find the text content within the message
            var textEl = msgEl.querySelector('span[dir="auto"]') || 
                        msgEl.querySelector('div[dir="auto"]') ||
                        msgEl.querySelector('span');
            
            if (!textEl) return;
            
            var content = textEl.textContent.trim();
            if (!content || content.length < 1) return;
            if (seenContent.has(content)) return;
            seenContent.add(content);
            
            // Check if message is from me by looking at container alignment
            var isFromMe = false;
            var parentRow = msgEl.closest('div.x78zum5');
            if (parentRow) {
                var style = window.getComputedStyle(parentRow);
                isFromMe = style.justifyContent === 'flex-end';
            }
            
            messages.push({
                sender: isFromMe ? 'me' : 'them',
                content: content.substring(0, 500),
                timestamp: '',
                isFromMe: isFromMe,
                type: 'text'
            });
        } catch (e) {
            console.log('Error parsing msg element: ' + e.message);
        }
    });
    
    // Strategy 2: Use the specific class pattern for message containers
    if (messages.length === 0) {
        var containers = document.querySelectorAll('div.x9f619.x1ja2u2z.x78zum5.x1n2onr6.x1iyjqo2.xs83m0k.xeuugli.x1qughib.x6s0dn4.x1a02dak.x1q0g3np.xdl72j9');
        console.log('Found ' + containers.length + ' message containers by class');
        
        containers.forEach(function(container) {
            var textEl = container.querySelector('div > div');
            if (textEl) {
                var content = textEl.textContent.trim();
                if (content && content.length > 0 && !seenContent.has(content)) {
                    seenContent.add(content);
                    
                    var parentRow = container.closest('div[class*="x78zum5"]');
                    var isFromMe = false;
                    if (parentRow) {
                        var style = window.getComputedStyle(parentRow);
                        isFromMe = style.justifyContent === 'flex-end';
                    }
                    
                    messages.push({
                        sender: isFromMe ? 'me' : 'them',
                        content: content.substring(0, 500),
                        timestamp: '',
                        isFromMe: isFromMe,
                        type: 'text'
                    });
                }
            }
        });
    }
    
    // Strategy 3: Look for message rows in the conversation view
    if (messages.length === 0) {
        var allDivs = document.querySelectorAll('div.xb57i2i div > div > div > div > div');
        console.log('Trying deep div search, found ' + allDivs.length);
        
        allDivs.forEach(function(div) {
            var spans = div.querySelectorAll('span[dir="auto"]');
            spans.forEach(function(span) {
                var content = span.textContent.trim();
                if (content && content.length > 1 && content.length < 500 && !seenContent.has(content)) {
                    // Filter out UI text
                    if (content === 'Active now' || content === 'Message' || 
                        content.includes('Seen') || content === 'Send' ||
                        content === 'Primary' || content === 'General' || 
                        content === 'Requests' || content === 'Instagram') return;
                    
                    seenContent.add(content);
                    messages.push({
                        sender: 'them',
                        content: content.substring(0, 500),
                        timestamp: '',
                        isFromMe: false,
                        type: 'text'
                    });
                }
            });
        });
    }
    
    console.log('Total messages found: ' + messages.length);
    return JSON.stringify(messages);
})()`;

        try {
            const result = await this.executeJS(jsCode);
            return JSON.parse(result);
        } catch (error) {
            logger.error('Failed to get messages:', error);
            return [];
        }
    }

    /**
     * Type a message in the current conversation
     */
    async typeMessage(text: string): Promise<boolean> {
        // Escape text for JavaScript
        const escapedText = text
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');

        const jsCode = `
(function() {
    // Find the message input
    var input = document.querySelector('textarea[placeholder*="Message"]') ||
               document.querySelector('div[contenteditable="true"][role="textbox"]') ||
               document.querySelector('[aria-label*="Message"]');
    
    if (!input) return 'input_not_found';
    
    input.focus();
    
    // Clear existing content
    if (input.tagName === 'TEXTAREA') {
        input.value = '';
    } else {
        input.textContent = '';
    }
    
    // Type the message
    var text = "${escapedText}";
    
    if (input.tagName === 'TEXTAREA') {
        input.value = text;
        input.dispatchEvent(new Event('input', {bubbles: true}));
    } else {
        // For contenteditable
        input.textContent = text;
        input.dispatchEvent(new InputEvent('input', {bubbles: true, data: text}));
    }
    
    return 'typed';
})()`;

        try {
            const result = await this.executeJS(jsCode);
            return result === 'typed';
        } catch (error) {
            logger.error('Failed to type message:', error);
            return false;
        }
    }

    /**
     * Send the typed message
     */
    async sendMessage(): Promise<boolean> {
        const jsCode = `
(function() {
    // Try clicking send button
    var sendBtn = document.querySelector('button[type="submit"]') ||
                 document.querySelector('[aria-label*="Send"]') ||
                 document.querySelector('div[role="button"]:has(svg[aria-label*="Send"])');
    
    if (sendBtn) {
        sendBtn.click();
        return 'sent';
    }
    
    // Fallback: press Enter
    var input = document.querySelector('textarea[placeholder*="Message"]') ||
               document.querySelector('div[contenteditable="true"][role="textbox"]');
    
    if (input) {
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, bubbles: true}));
        return 'enter_pressed';
    }
    
    return 'not_sent';
})()`;

        try {
            const result = await this.executeJS(jsCode);
            return result === 'sent' || result === 'enter_pressed';
        } catch (error) {
            logger.error('Failed to send message:', error);
            return false;
        }
    }

    /**
     * Go back to inbox from conversation
     */
    async goBackToInbox(): Promise<boolean> {
        const jsCode = `
(function() {
    // Find back button
    var backBtn = document.querySelector('[aria-label*="Back"]') ||
                 document.querySelector('a[href="/direct/inbox/"]') ||
                 document.querySelector('svg[aria-label*="Back"]')?.closest('button, div[role="button"]');
    
    if (backBtn) {
        backBtn.click();
        return 'clicked';
    }
    
    return 'not_found';
})()`;

        try {
            const result = await this.executeJS(jsCode);
            if (result === 'clicked') {
                await this.delay(2000);
                return true;
            }
            // Fallback: navigate directly
            return this.navigateTo('https://www.instagram.com/direct/inbox/');
        } catch (error) {
            logger.error('Failed to go back:', error);
            return false;
        }
    }

    /**
     * Iterate through all conversations and collect data
     */
    async iterateAllConversations(
        callback?: (conv: ConversationInfo, messages: MessageInfo[]) => Promise<void>,
        maxConversations: number = 50
    ): Promise<{ conversations: ConversationInfo[]; messagesMap: Map<number, MessageInfo[]> }> {
        const allConversations: ConversationInfo[] = [];
        const messagesMap = new Map<number, MessageInfo[]>();

        // Navigate to DMs first
        await this.navigateToDMs();
        await this.delay(2000);

        // Scroll to load all conversations
        let prevCount = 0;
        let currentCount = 0;
        let scrollAttempts = 0;

        do {
            prevCount = currentCount;
            currentCount = await this.scrollConversationList('down');
            scrollAttempts++;
            await this.delay(1000);
        } while (currentCount > prevCount && scrollAttempts < 20 && currentCount < maxConversations);

        logger.info(`Loaded ${currentCount} conversations after ${scrollAttempts} scrolls`);

        // Get all conversations
        const conversations = await this.getConversations();
        logger.info(`Found ${conversations.length} conversations`);

        // Iterate through each
        for (let i = 0; i < Math.min(conversations.length, maxConversations); i++) {
            const conv = conversations[i];
            allConversations.push(conv);

            logger.info(`Processing conversation ${i + 1}/${conversations.length}: ${conv.username}`);

            // Click to open conversation
            const opened = await this.clickConversation(i);
            if (!opened) {
                logger.warn(`Could not open conversation ${i}`);
                continue;
            }

            await this.delay(2000);

            // Get messages
            const messages = await this.getMessagesFromConversation();
            messagesMap.set(i, messages);

            logger.info(`  - Found ${messages.length} messages`);

            // Call callback if provided
            if (callback) {
                await callback(conv, messages);
            }

            // Go back to inbox
            await this.goBackToInbox();
            await this.delay(1500);
        }

        return { conversations: allConversations, messagesMap };
    }

    /**
     * Check all DM tabs (Primary, General, Requests)
     */
    async checkAllDMTabs(): Promise<{
        primary: ConversationInfo[];
        general: ConversationInfo[];
        requests: ConversationInfo[];
    }> {
        const result = {
            primary: [] as ConversationInfo[],
            general: [] as ConversationInfo[],
            requests: [] as ConversationInfo[]
        };

        await this.navigateToDMs();
        await this.delay(2000);

        // Check Primary
        logger.info('Checking Primary tab...');
        await this.clickDMTab('primary');
        await this.delay(2000);
        result.primary = await this.getConversations();
        logger.info(`  Found ${result.primary.length} primary conversations`);

        // Check General
        logger.info('Checking General tab...');
        await this.clickDMTab('general');
        await this.delay(2000);
        result.general = await this.getConversations();
        logger.info(`  Found ${result.general.length} general conversations`);

        // Check Requests
        logger.info('Checking Requests tab...');
        await this.clickDMTab('requests');
        await this.delay(2000);
        result.requests = await this.getConversations();
        logger.info(`  Found ${result.requests.length} message requests`);

        return result;
    }

    /**
     * Helper: delay execution
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==================== SCREENSHOT FUNCTIONALITY ====================

    /**
     * Take a screenshot of the Safari window
     * Returns the path to the screenshot file
     */
    async takeScreenshot(filename?: string): Promise<string> {
        const screenshotDir = path.join(process.cwd(), 'screenshots');
        
        // Ensure screenshots directory exists
        if (!fs.existsSync(screenshotDir)) {
            fs.mkdirSync(screenshotDir, { recursive: true });
        }

        const screenshotName = filename || `safari_${Date.now()}.png`;
        const screenshotPath = path.join(screenshotDir, screenshotName);

        // Use screencapture to capture Safari window
        const script = `
tell application "Safari"
    set winID to id of front window
end tell
do shell script "screencapture -l " & winID & " '${screenshotPath}'"
return "${screenshotPath}"
`;

        try {
            await this.runAppleScript(script);
            
            // Verify file was created
            if (fs.existsSync(screenshotPath)) {
                logger.info(`Screenshot saved: ${screenshotPath}`);
                return screenshotPath;
            }
            
            // Fallback: capture entire screen if window capture fails
            await execAsync(`screencapture -x "${screenshotPath}"`);
            logger.info(`Full screen screenshot saved: ${screenshotPath}`);
            return screenshotPath;
            
        } catch (error) {
            logger.error('Screenshot error, trying fallback:', error);
            
            // Fallback to full screen capture
            try {
                await execAsync(`screencapture -x "${screenshotPath}"`);
                return screenshotPath;
            } catch (fallbackError) {
                logger.error('Fallback screenshot failed:', fallbackError);
                throw fallbackError;
            }
        }
    }

    /**
     * Get screenshot as base64 for API calls
     */
    async getScreenshotBase64(filename?: string): Promise<string> {
        const screenshotPath = await this.takeScreenshot(filename);
        const imageBuffer = fs.readFileSync(screenshotPath);
        return imageBuffer.toString('base64');
    }

    // ==================== NOTES FUNCTIONALITY ====================

    /**
     * Get all visible notes from the DM inbox
     * Notes appear at the top of the inbox as circular profile pictures with text
     */
    async getNotes(): Promise<NoteInfo[]> {
        const jsCode = `
(function() {
    var notes = [];
    
    console.log('Looking for Instagram Notes...');
    
    // Notes are in a horizontal list at the top of DMs
    // Selector pattern from user: ul > li elements containing notes
    var noteItems = document.querySelectorAll('ul > li');
    console.log('Found ' + noteItems.length + ' potential note items');
    
    noteItems.forEach(function(item, index) {
        try {
            // Look for note content within the item
            var noteContainer = item.querySelector('div.x1vjfegm');
            if (!noteContainer) return;
            
            // Get the note text
            var noteText = '';
            var textEl = noteContainer.querySelector('div[dir="auto"], span[dir="auto"]');
            if (textEl) {
                noteText = textEl.textContent.trim();
            }
            
            // Skip if no text (might be "Your note" placeholder)
            if (!noteText || noteText === 'Note...' || noteText === 'Your note') return;
            
            // Get username from profile picture alt or nearby text
            var username = 'Unknown';
            var imgEl = item.querySelector('img[alt*="profile"]');
            if (imgEl) {
                var alt = imgEl.getAttribute('alt') || '';
                username = alt.replace("'s profile picture", '').replace("'s note", '').trim();
            }
            
            // Check if it's own note (usually first item or has specific styling)
            var isOwn = index === 0 || item.querySelector('[aria-label*="Your note"]') !== null;
            
            notes.push({
                username: username,
                content: noteText.substring(0, 60),
                timestamp: '',
                isOwn: isOwn
            });
        } catch (e) {
            console.log('Error parsing note: ' + e.message);
        }
    });
    
    // Alternative: look for note bubbles with specific class pattern
    if (notes.length === 0) {
        var noteDivs = document.querySelectorAll('div.x1vjfegm.x9a3u73');
        console.log('Trying alternative selector, found ' + noteDivs.length);
        
        noteDivs.forEach(function(div) {
            var textEl = div.querySelector('div > div > div > div > div');
            if (textEl) {
                var content = textEl.textContent.trim();
                if (content && content.length > 0 && content !== 'Note...') {
                    notes.push({
                        username: 'Unknown',
                        content: content.substring(0, 60),
                        timestamp: '',
                        isOwn: false
                    });
                }
            }
        });
    }
    
    console.log('Found ' + notes.length + ' notes');
    return JSON.stringify(notes);
})()`;

        try {
            const result = await this.executeJS(jsCode);
            return JSON.parse(result);
        } catch (error) {
            logger.error('Failed to get notes:', error);
            return [];
        }
    }

    /**
     * Click on a specific note to view it
     */
    async clickNote(index: number): Promise<boolean> {
        const jsCode = `
(function() {
    var noteItems = document.querySelectorAll('ul > li');
    
    // Filter to actual notes (those with note content)
    var actualNotes = Array.from(noteItems).filter(function(item) {
        return item.querySelector('div.x1vjfegm') !== null;
    });
    
    if (actualNotes[${index}]) {
        actualNotes[${index}].click();
        return 'clicked';
    }
    
    return 'not_found';
})()`;

        try {
            const result = await this.executeJS(jsCode);
            if (result === 'clicked') {
                logger.info(`Clicked note ${index}`);
                await this.delay(1500);
                return true;
            }
            return false;
        } catch (error) {
            logger.error('Failed to click note:', error);
            return false;
        }
    }

    /**
     * Click on "Your note" to create/edit a note
     */
    async clickOwnNote(): Promise<boolean> {
        const jsCode = `
(function() {
    // Look for "Your note" or the first note item (usually user's own)
    var noteItems = document.querySelectorAll('ul > li');
    
    for (var i = 0; i < noteItems.length; i++) {
        var item = noteItems[i];
        var text = item.textContent || '';
        
        // Check if this is the user's note slot
        if (text.includes('Note...') || text.includes('Your note') || 
            item.querySelector('[aria-label*="Your note"]')) {
            item.click();
            return 'clicked_own';
        }
    }
    
    // Fallback: click first item
    if (noteItems[0]) {
        noteItems[0].click();
        return 'clicked_first';
    }
    
    return 'not_found';
})()`;

        try {
            const result = await this.executeJS(jsCode);
            if (result.startsWith('clicked')) {
                logger.info(`Clicked own note: ${result}`);
                await this.delay(2000);
                return true;
            }
            return false;
        } catch (error) {
            logger.error('Failed to click own note:', error);
            return false;
        }
    }

    /**
     * Type content into the note input field
     */
    async typeNote(text: string): Promise<boolean> {
        const escapedText = text
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');

        const jsCode = `
(function() {
    // Find the note input field using the specific class pattern
    var noteInput = document.querySelector('div.xw2csxc.x1odjw0f.x1n2onr6.x1hnll1o.xpqswwc.notranslate') ||
                   document.querySelector('div[contenteditable="true"].notranslate') ||
                   document.querySelector('div.x1vjfegm div[contenteditable="true"]') ||
                   document.querySelector('[aria-label*="note"] div[contenteditable="true"]');
    
    if (!noteInput) {
        // Try finding any contenteditable in the note area
        var noteArea = document.querySelector('div.x1vjfegm');
        if (noteArea) {
            noteInput = noteArea.querySelector('div[contenteditable="true"]');
        }
    }
    
    if (!noteInput) return 'input_not_found';
    
    noteInput.focus();
    noteInput.textContent = "${escapedText}";
    noteInput.dispatchEvent(new InputEvent('input', {bubbles: true, data: "${escapedText}"}));
    
    return 'typed';
})()`;

        try {
            const result = await this.executeJS(jsCode);
            if (result === 'typed') {
                logger.info('Typed note content');
                return true;
            }
            logger.warn(`Could not type note: ${result}`);
            return false;
        } catch (error) {
            logger.error('Failed to type note:', error);
            return false;
        }
    }

    /**
     * Submit/share the note
     */
    async submitNote(): Promise<boolean> {
        const jsCode = `
(function() {
    // Look for Share button or submit action
    var shareBtn = document.querySelector('button[type="submit"]') ||
                  document.querySelector('div[role="button"]:has-text("Share")') ||
                  document.querySelector('[aria-label*="Share"]');
    
    // Try finding by text content
    if (!shareBtn) {
        var buttons = document.querySelectorAll('div[role="button"], button');
        for (var i = 0; i < buttons.length; i++) {
            var text = buttons[i].textContent.toLowerCase();
            if (text === 'share' || text.includes('share note')) {
                shareBtn = buttons[i];
                break;
            }
        }
    }
    
    if (shareBtn) {
        shareBtn.click();
        return 'shared';
    }
    
    // Try pressing Enter as fallback
    var input = document.querySelector('div[contenteditable="true"].notranslate');
    if (input) {
        input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', keyCode: 13, bubbles: true}));
        return 'enter_pressed';
    }
    
    return 'not_submitted';
})()`;

        try {
            const result = await this.executeJS(jsCode);
            if (result === 'shared' || result === 'enter_pressed') {
                logger.info(`Note submitted: ${result}`);
                await this.delay(2000);
                return true;
            }
            return false;
        } catch (error) {
            logger.error('Failed to submit note:', error);
            return false;
        }
    }

    /**
     * Create a new note (complete flow)
     */
    async createNote(text: string): Promise<boolean> {
        logger.info('Creating new note...');
        
        // Step 1: Navigate to DMs if not already there
        const state = await this.getPageState();
        if (!state.hasDMInbox) {
            await this.navigateToDMs();
            await this.delay(2000);
        }

        // Step 2: Click on own note slot
        const clicked = await this.clickOwnNote();
        if (!clicked) {
            logger.error('Could not click own note');
            return false;
        }

        // Step 3: Type the note
        const typed = await this.typeNote(text);
        if (!typed) {
            logger.error('Could not type note');
            return false;
        }

        // Step 4: Submit
        const submitted = await this.submitNote();
        if (!submitted) {
            logger.warn('Could not auto-submit note - may need manual submission');
            return false;
        }

        logger.info('Note created successfully');
        return true;
    }
}

// Default export
export default SafariController;
