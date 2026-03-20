/**
 * Instagram DM Handler
 * 
 * This module provides automation functionality for Instagram Direct Messages.
 * It handles navigation to DMs, reading conversations, generating AI responses,
 * and sending messages.
 */

import { Page, ElementHandle } from 'puppeteer';
import { logger } from '../utils/logger';
import { delay } from '../utils/delay';
import dotenv from 'dotenv';
import { chatCompletion } from '../utils/ai';
import { pushStep } from '../trace/runtime';
import { StorageInterface } from '../db/interfaces';
import { SupabaseStorage } from '../db/supabase';

// Load environment variables
dotenv.config();

// OpenAI replaced by shared Anthropic wrapper (chatCompletion)

// DM Processing configuration
const DM_TIMEOUT_MS = parseInt(process.env.DM_TIMEOUT_MS || '30000', 10);
const DM_CHECK_INTERVAL_MS = parseInt(process.env.DM_CHECK_INTERVAL_MS || '60000', 10);
const MAX_DM_RESPONSES_PER_SESSION = parseInt(process.env.MAX_DM_RESPONSES_PER_SESSION || '10', 10);

// Storage instance
let storage: StorageInterface | null = null;

// Interfaces
export interface DMConversation {
    id: string;
    username: string;
    lastMessage: string;
    lastMessageTime: Date;
    isUnread: boolean;
    messageCount?: number;
}

export interface DMMessage {
    id: string;
    sender: string;
    content: string;
    timestamp: Date;
    isFromMe: boolean;
    messageType: 'text' | 'image' | 'video' | 'voice' | 'link' | 'story_reply' | 'other';
}

export interface DMInteraction {
    timestamp: Date;
    type: 'dm_read' | 'dm_sent' | 'dm_error';
    success: boolean;
    conversationId?: string;
    username?: string;
    messageContent?: string;
    error?: string;
    details?: string;
}

export interface DMProcessResult {
    success: boolean;
    conversationsProcessed: number;
    messagesRead: number;
    messagesSent: number;
    errors: string[];
}

// Helper functions
function getRandomDelay(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Initialize storage for DM interactions
 */
async function initDMStorage(): Promise<void> {
    try {
        if (!storage) {
            storage = new SupabaseStorage();
            await storage.connect();
            logger.info('DM Storage initialized successfully', {
                component: 'InstagramDM',
                event: 'storage_init'
            });
        }
    } catch (error) {
        logger.error('Failed to initialize DM storage:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'InstagramDM',
            event: 'storage_init_error'
        });
    }
}

/**
 * Save DM interaction to database
 */
async function saveDMInteraction(interaction: DMInteraction): Promise<void> {
    try {
        if (storage) {
            await storage.saveInteraction({
                timestamp: interaction.timestamp,
                type: 'dm',
                success: interaction.success,
                error: interaction.error,
                details: interaction.details,
                metadata: {
                    type: interaction.type,
                    conversationId: interaction.conversationId,
                    username: interaction.username,
                    messageContent: interaction.messageContent
                }
            });
        }
    } catch (error) {
        logger.error('Failed to save DM interaction:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'InstagramDM',
            event: 'save_interaction_error'
        });
    }
}

/**
 * Navigate to Instagram Direct Messages
 */
async function navigateToDMs(page: Page): Promise<boolean> {
    try {
        logger.info('Navigating to Instagram DMs', {
            component: 'InstagramDM',
            event: 'navigate_dm_start'
        });

        // Navigate to direct messages
        await page.goto('https://www.instagram.com/direct/inbox/', {
            waitUntil: 'networkidle0',
            timeout: DM_TIMEOUT_MS
        });

        // Wait for DM inbox to load
        await delay(2000);

        // Check if we're on the DM page by looking for conversation elements
        const dmIndicators = [
            'div[role="listbox"]',
            'div[aria-label*="Direct"]',
            'div[aria-label*="Message"]',
            'svg[aria-label="Messenger"]',
            'div[class*="inbox"]'
        ];

        for (const selector of dmIndicators) {
            const element = await page.$(selector);
            if (element) {
                logger.info('Successfully navigated to DMs', {
                    component: 'InstagramDM',
                    event: 'navigate_dm_success',
                    indicator: selector
                });
                return true;
            }
        }

        // Handle potential "Turn on Notifications" dialog
        try {
            const notNowButton = await page.$('button:has-text("Not Now")');
            if (notNowButton) {
                await notNowButton.click();
                await delay(1000);
            }
        } catch {
            // Dialog not present, continue
        }

        // Check again after dismissing dialogs
        const inboxLoaded = await page.$('div[role="listbox"]');
        if (inboxLoaded) {
            logger.info('DM inbox loaded after dialog dismissal', {
                component: 'InstagramDM',
                event: 'navigate_dm_success'
            });
            return true;
        }

        logger.warn('Could not verify DM page loaded', {
            component: 'InstagramDM',
            event: 'navigate_dm_uncertain'
        });
        return true; // Proceed anyway as page navigation succeeded

    } catch (error) {
        logger.error('Failed to navigate to DMs:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'InstagramDM',
            event: 'navigate_dm_error'
        });
        return false;
    }
}

/**
 * Get list of conversations from DM inbox
 */
async function getConversations(page: Page, maxConversations: number = 10): Promise<DMConversation[]> {
    const conversations: DMConversation[] = [];

    try {
        logger.info('Fetching DM conversations', {
            component: 'InstagramDM',
            event: 'fetch_conversations_start',
            maxConversations
        });

        // Wait for conversation list to load
        await delay(2000);

        // Try multiple selectors for conversation items
        const conversationSelectors = [
            'div[role="listbox"] > div > div',
            'div[class*="conversation"]',
            'a[href*="/direct/t/"]',
            'div[role="button"][tabindex="0"]'
        ];

        let conversationElements: ElementHandle<Element>[] = [];

        for (const selector of conversationSelectors) {
            const elements = await page.$$(selector);
            if (elements.length > 0) {
                conversationElements = elements.slice(0, maxConversations);
                logger.info(`Found ${elements.length} conversations with selector: ${selector}`, {
                    component: 'InstagramDM',
                    event: 'conversations_found'
                });
                break;
            }
        }

        if (conversationElements.length === 0) {
            logger.warn('No conversations found in DM inbox', {
                component: 'InstagramDM',
                event: 'no_conversations'
            });
            return conversations;
        }

        // Extract conversation data
        for (let i = 0; i < conversationElements.length; i++) {
            try {
                const element = conversationElements[i];

                const conversationData = await element.evaluate((el) => {
                    // Extract username
                    const usernameEl = el.querySelector('span[dir="auto"]') ||
                        el.querySelector('span[class*="username"]') ||
                        el.querySelector('div[class*="username"]');
                    const username = usernameEl?.textContent?.trim() || 'Unknown';

                    // Extract last message preview
                    const messageEls = el.querySelectorAll('span[dir="auto"]');
                    let lastMessage = '';
                    if (messageEls.length > 1) {
                        lastMessage = messageEls[messageEls.length - 1]?.textContent?.trim() || '';
                    }

                    // Check if unread (typically has a blue dot or bold text)
                    const hasUnreadIndicator = el.querySelector('div[class*="unread"]') !== null ||
                        el.querySelector('span[class*="bold"]') !== null ||
                        el.querySelector('div[style*="background-color: rgb(0, 149, 246)"]') !== null;

                    // Get conversation link for ID extraction
                    const link = el.querySelector('a[href*="/direct/t/"]');
                    const href = link?.getAttribute('href') || '';
                    const idMatch = href.match(/\/direct\/t\/(\d+)/);
                    const id = idMatch ? idMatch[1] : `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                    return {
                        id,
                        username,
                        lastMessage,
                        isUnread: hasUnreadIndicator
                    };
                });

                conversations.push({
                    ...conversationData,
                    lastMessageTime: new Date()
                });

            } catch (error) {
                logger.debug(`Failed to extract conversation ${i}:`, {
                    error: error instanceof Error ? error.message : String(error),
                    component: 'InstagramDM'
                });
            }
        }

        logger.info(`Extracted ${conversations.length} conversations`, {
            component: 'InstagramDM',
            event: 'conversations_extracted',
            count: conversations.length
        });

        return conversations;

    } catch (error) {
        logger.error('Error fetching conversations:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'InstagramDM',
            event: 'fetch_conversations_error'
        });
        return conversations;
    }
}

/**
 * Open a specific conversation
 */
async function openConversation(page: Page, conversation: DMConversation): Promise<boolean> {
    try {
        logger.info(`Opening conversation with ${conversation.username}`, {
            component: 'InstagramDM',
            event: 'open_conversation_start',
            conversationId: conversation.id
        });

        // Try to click on the conversation or navigate directly
        const conversationUrl = `https://www.instagram.com/direct/t/${conversation.id}/`;

        await page.goto(conversationUrl, {
            waitUntil: 'networkidle0',
            timeout: DM_TIMEOUT_MS
        });

        await delay(2000);

        // Verify conversation opened by looking for message input
        const messageInputSelectors = [
            'textarea[placeholder*="Message"]',
            'div[contenteditable="true"][role="textbox"]',
            'textarea[aria-label*="Message"]',
            'div[aria-label*="Message"][contenteditable="true"]'
        ];

        for (const selector of messageInputSelectors) {
            const input = await page.$(selector);
            if (input) {
                logger.info('Conversation opened successfully', {
                    component: 'InstagramDM',
                    event: 'open_conversation_success',
                    username: conversation.username
                });
                return true;
            }
        }

        logger.warn('Could not verify conversation opened', {
            component: 'InstagramDM',
            event: 'open_conversation_uncertain',
            username: conversation.username
        });
        return true;

    } catch (error) {
        logger.error('Failed to open conversation:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'InstagramDM',
            event: 'open_conversation_error',
            username: conversation.username
        });
        return false;
    }
}

/**
 * Read messages from the current conversation
 */
async function readMessages(page: Page, maxMessages: number = 20): Promise<DMMessage[]> {
    const messages: DMMessage[] = [];

    try {
        logger.info('Reading messages from conversation', {
            component: 'InstagramDM',
            event: 'read_messages_start',
            maxMessages
        });

        await delay(1500);

        // Get the bot's username for identifying our own messages
        const botUsername = process.env.INSTAGRAM_BOT_USERNAME || '';

        // Try multiple selectors for message elements
        const messageSelectors = [
            'div[role="row"]',
            'div[class*="message"]',
            'div[dir="auto"]',
            'span[dir="auto"]'
        ];

        let messageElements: ElementHandle<Element>[] = [];

        for (const selector of messageSelectors) {
            const elements = await page.$$(selector);
            if (elements.length > 0) {
                messageElements = elements.slice(-maxMessages);
                break;
            }
        }

        // Extract message data
        for (const element of messageElements) {
            try {
                const messageData = await element.evaluate((el, myUsername) => {
                    const text = el.textContent?.trim() || '';
                    if (!text || text.length < 1) return null;

                    // Try to determine if message is from us
                    const parent = el.closest('div[role="row"]');
                    const isFromMe = parent?.querySelector('div[style*="flex-end"]') !== null ||
                        parent?.classList.contains('sent') ||
                        el.closest('div[class*="self"]') !== null;

                    // Determine message type
                    let messageType: 'text' | 'image' | 'video' | 'voice' | 'link' | 'story_reply' | 'other' = 'text';
                    if (el.querySelector('img:not([alt=""])')) messageType = 'image';
                    if (el.querySelector('video')) messageType = 'video';
                    if (text.includes('http://') || text.includes('https://')) messageType = 'link';
                    if (el.querySelector('audio')) messageType = 'voice';

                    return {
                        content: text,
                        isFromMe,
                        messageType
                    };
                }, botUsername);

                if (messageData && messageData.content.length > 0) {
                    messages.push({
                        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        sender: messageData.isFromMe ? botUsername : 'other',
                        content: messageData.content,
                        timestamp: new Date(),
                        isFromMe: messageData.isFromMe,
                        messageType: messageData.messageType as DMMessage['messageType']
                    });
                }
            } catch {
                // Skip individual message extraction errors
            }
        }

        logger.info(`Read ${messages.length} messages`, {
            component: 'InstagramDM',
            event: 'read_messages_success',
            count: messages.length
        });

        return messages;

    } catch (error) {
        logger.error('Error reading messages:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'InstagramDM',
            event: 'read_messages_error'
        });
        return messages;
    }
}

/**
 * Generate an AI response for a DM conversation
 */
async function generateDMResponse(
    messages: DMMessage[],
    username: string,
    context?: string
): Promise<string | null> {
    try {
        logger.info('Generating DM response', {
            component: 'InstagramDM',
            event: 'generate_response_start',
            username,
            messageCount: messages.length
        });

        // Get the last few messages for context
        const recentMessages = messages.slice(-5);
        const lastMessage = recentMessages[recentMessages.length - 1];

        // Don't respond to our own messages
        if (lastMessage?.isFromMe) {
            logger.info('Last message is from us, skipping response', {
                component: 'InstagramDM',
                event: 'skip_own_message'
            });
            return null;
        }

        // Build conversation history for context
        const conversationHistory = recentMessages
            .map(m => `${m.isFromMe ? 'Me' : username}: ${m.content}`)
            .join('\n');

        const systemPrompt = `You are a friendly Instagram user responding to direct messages. 
Your responses should be:
- Natural and conversational
- Friendly but professional
- Concise (1-3 sentences typically)
- Relevant to the conversation
- Not overly promotional or salesy
${context ? `\nAdditional context: ${context}` : ''}

Do NOT:
- Ask for personal information
- Make promises you can't keep
- Be overly formal or robotic
- Use excessive emojis (1-2 max)
- Sound like a bot or automated response`;

        const userPrompt = `Here's the recent conversation with ${username}:

${conversationHistory}

Generate a natural, friendly response to continue this conversation. Just provide the response text, no quotes or prefixes.`;

        const response = await chatCompletion({
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            max_tokens: 150,
            temperature: 0.8
        });

        if (!response) {
            logger.warn('AI did not generate a response', {
                component: 'InstagramDM',
                event: 'no_response_generated'
            });
            return null;
        }

        logger.info('DM response generated', {
            component: 'InstagramDM',
            event: 'generate_response_success',
            responseLength: response.length
        });

        return response;

    } catch (error) {
        logger.error('Error generating DM response:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'InstagramDM',
            event: 'generate_response_error'
        });
        return null;
    }
}

/**
 * Send a message in the current conversation
 */
async function sendMessage(page: Page, message: string): Promise<boolean> {
    try {
        logger.info('Sending DM message', {
            component: 'InstagramDM',
            event: 'send_message_start',
            messageLength: message.length
        });

        // Find the message input
        const inputSelectors = [
            'textarea[placeholder*="Message"]',
            'div[contenteditable="true"][role="textbox"]',
            'textarea[aria-label*="Message"]',
            'div[aria-label*="Message"][contenteditable="true"]',
            'textarea[placeholder*="message"]'
        ];

        let messageInput: ElementHandle<Element> | null = null;

        for (const selector of inputSelectors) {
            const input = await page.$(selector);
            if (input) {
                messageInput = input;
                logger.debug(`Found message input with selector: ${selector}`, {
                    component: 'InstagramDM'
                });
                break;
            }
        }

        if (!messageInput) {
            throw new Error('Message input not found');
        }

        // Focus the input
        await messageInput.focus();
        await delay(300);

        // Clear any existing text
        await page.keyboard.down('Control');
        await page.keyboard.press('A');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
        await delay(200);

        // Type the message with human-like delays
        for (const char of message) {
            await page.keyboard.type(char, { delay: getRandomDelay(30, 80) });
        }
        await delay(500);

        // Find and click the send button, or press Enter
        const sendButtonSelectors = [
            'button[type="submit"]',
            'div[role="button"]:has-text("Send")',
            'svg[aria-label="Send Message"]',
            'button:has(svg[aria-label*="Send"])'
        ];

        let sent = false;

        for (const selector of sendButtonSelectors) {
            try {
                const sendButton = await page.$(selector);
                if (sendButton) {
                    await sendButton.click();
                    sent = true;
                    logger.debug('Clicked send button', { component: 'InstagramDM', selector });
                    break;
                }
            } catch {
                continue;
            }
        }

        // Fallback: press Enter to send
        if (!sent) {
            await page.keyboard.press('Enter');
            sent = true;
            logger.debug('Pressed Enter to send', { component: 'InstagramDM' });
        }

        await delay(1500);

        // Verify message was sent by checking if input is cleared
        const inputCleared = await messageInput.evaluate((el) => {
            const ta = el as HTMLTextAreaElement;
            const ce = el as HTMLElement;
            const isCE = ce.getAttribute('contenteditable') === 'true';
            if (isCE) return (ce.textContent || '').trim() === '';
            return (ta.value || '').trim() === '';
        });

        if (inputCleared) {
            logger.info('DM message sent successfully', {
                component: 'InstagramDM',
                event: 'send_message_success'
            });
            return true;
        }

        logger.warn('Could not verify message was sent', {
            component: 'InstagramDM',
            event: 'send_message_uncertain'
        });
        return true; // Assume success if we got this far

    } catch (error) {
        logger.error('Error sending DM message:', {
            error: error instanceof Error ? error.message : String(error),
            component: 'InstagramDM',
            event: 'send_message_error'
        });
        return false;
    }
}

/**
 * Process a single DM conversation - read messages and optionally respond
 */
async function processConversation(
    page: Page,
    conversation: DMConversation,
    autoRespond: boolean = false,
    trace?: any
): Promise<{ success: boolean; responded: boolean; error?: string }> {
    try {
        logger.info(`Processing conversation with ${conversation.username}`, {
            component: 'InstagramDM',
            event: 'process_conversation_start',
            username: conversation.username,
            autoRespond
        });

        // Open the conversation
        const opened = await openConversation(page, conversation);
        if (!opened) {
            return { success: false, responded: false, error: 'Failed to open conversation' };
        }

        // Read messages
        const messages = await readMessages(page);
        if (messages.length === 0) {
            logger.info('No messages found in conversation', {
                component: 'InstagramDM',
                event: 'no_messages'
            });
            return { success: true, responded: false };
        }

        // Log the interaction
        await saveDMInteraction({
            timestamp: new Date(),
            type: 'dm_read',
            success: true,
            conversationId: conversation.id,
            username: conversation.username,
            details: `Read ${messages.length} messages`
        });

        if (trace) {
            pushStep(trace, {
                name: `dm_read_${conversation.username}`,
                status: 'ok',
                notes: `Read ${messages.length} messages`
            });
        }

        // Check if we should auto-respond
        if (autoRespond) {
            const lastMessage = messages[messages.length - 1];

            // Only respond if the last message is not from us
            if (lastMessage && !lastMessage.isFromMe) {
                // Generate response
                const response = await generateDMResponse(messages, conversation.username);

                if (response) {
                    // Add random delay before responding (more human-like)
                    await delay(getRandomDelay(2000, 5000));

                    // Send the response
                    const sent = await sendMessage(page, response);

                    if (sent) {
                        await saveDMInteraction({
                            timestamp: new Date(),
                            type: 'dm_sent',
                            success: true,
                            conversationId: conversation.id,
                            username: conversation.username,
                            messageContent: response
                        });

                        if (trace) {
                            pushStep(trace, {
                                name: `dm_respond_${conversation.username}`,
                                status: 'ok',
                                notes: `Sent: ${response.substring(0, 50)}...`
                            });
                        }

                        logger.info('Successfully responded to conversation', {
                            component: 'InstagramDM',
                            event: 'auto_respond_success',
                            username: conversation.username
                        });

                        return { success: true, responded: true };
                    }
                }
            }
        }

        return { success: true, responded: false };

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Error processing conversation:', {
            error: errorMessage,
            component: 'InstagramDM',
            event: 'process_conversation_error',
            username: conversation.username
        });

        await saveDMInteraction({
            timestamp: new Date(),
            type: 'dm_error',
            success: false,
            conversationId: conversation.id,
            username: conversation.username,
            error: errorMessage
        });

        return { success: false, responded: false, error: errorMessage };
    }
}

/**
 * Main function to process all DMs
 */
async function processDMs(
    page: Page,
    options: {
        maxConversations?: number;
        autoRespond?: boolean;
        onlyUnread?: boolean;
        trace?: any;
    } = {}
): Promise<DMProcessResult> {
    const {
        maxConversations = 5,
        autoRespond = false,
        onlyUnread = true,
        trace
    } = options;

    const result: DMProcessResult = {
        success: false,
        conversationsProcessed: 0,
        messagesRead: 0,
        messagesSent: 0,
        errors: []
    };

    try {
        logger.info('Starting DM processing', {
            component: 'InstagramDM',
            event: 'process_dms_start',
            maxConversations,
            autoRespond,
            onlyUnread
        });

        // Initialize storage
        await initDMStorage();

        // Navigate to DMs
        const navigated = await navigateToDMs(page);
        if (!navigated) {
            result.errors.push('Failed to navigate to DMs');
            return result;
        }

        if (trace) {
            pushStep(trace, { name: 'navigate_to_dms', status: 'ok' });
        }

        // Get conversations
        const conversations = await getConversations(page, maxConversations);
        if (conversations.length === 0) {
            logger.info('No conversations to process', {
                component: 'InstagramDM',
                event: 'no_conversations'
            });
            result.success = true;
            return result;
        }

        // Filter to only unread if specified
        const toProcess = onlyUnread
            ? conversations.filter(c => c.isUnread)
            : conversations;

        logger.info(`Processing ${toProcess.length} conversations`, {
            component: 'InstagramDM',
            event: 'conversations_to_process',
            total: conversations.length,
            toProcess: toProcess.length
        });

        // Process each conversation
        let responseCount = 0;
        for (const conversation of toProcess) {
            // Respect rate limits
            if (autoRespond && responseCount >= MAX_DM_RESPONSES_PER_SESSION) {
                logger.info('Reached max DM responses for session', {
                    component: 'InstagramDM',
                    event: 'rate_limit_reached',
                    count: responseCount
                });
                break;
            }

            const processResult = await processConversation(
                page,
                conversation,
                autoRespond,
                trace
            );

            result.conversationsProcessed++;

            if (processResult.responded) {
                result.messagesSent++;
                responseCount++;
            }

            if (processResult.error) {
                result.errors.push(`${conversation.username}: ${processResult.error}`);
            }

            // Add delay between conversations
            await delay(getRandomDelay(3000, 7000));
        }

        result.success = true;
        logger.info('DM processing completed', {
            component: 'InstagramDM',
            event: 'process_dms_complete',
            ...result
        });

        return result;

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error('Error in DM processing:', {
            error: errorMessage,
            component: 'InstagramDM',
            event: 'process_dms_error'
        });
        result.errors.push(errorMessage);
        return result;
    }
}

// Export functions
export {
    processDMs,
    navigateToDMs,
    getConversations,
    openConversation,
    readMessages,
    generateDMResponse,
    sendMessage,
    processConversation,
    initDMStorage,
    saveDMInteraction
};
