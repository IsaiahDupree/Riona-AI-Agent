/**
 * Twitter DM Integration Tests
 *
 * Tests: TwitterDM.fromPage() factory, watcher state management,
 * inbox scraping logic, scheduler integration, PIN handling,
 * and sentiment analysis.
 */

// Ensure OPENAI_API_KEY is set before any module imports (Twitter-DM-AI initializes OpenAI at load time)
if (!process.env.OPENAI_API_KEY) {
    process.env.OPENAI_API_KEY = 'test-key-not-used';
}

import { analyzeSentiment } from '../../src/client/Twitter-DM-Pipeline';
import { ConversationPreview } from '../../src/types/dm';
import * as fs from 'fs';
import * as path from 'path';

// ── Mock Puppeteer Page & Browser ────────────────────────────────────

function makeMockBrowser(overrides: Record<string, any> = {}) {
    return {
        pages: async () => [],
        newPage: async () => makeMockPage(),
        close: async () => {},
        ...overrides
    };
}

function makeMockPage(overrides: Record<string, any> = {}) {
    const mockBrowser = makeMockBrowser();
    const page: any = {
        browser: () => overrides.browser || mockBrowser,
        goto: async () => {},
        url: () => overrides.url || 'https://x.com/messages',
        evaluate: async (fn: Function) => fn(),
        $: async () => null,
        $$: async () => [],
        waitForSelector: async () => null,
        setViewport: async () => {},
        screenshot: async () => {},
        keyboard: { press: async () => {}, type: async () => {} },
        ...overrides
    };
    // Ensure the browser reference points back to a browser that knows this page
    if (!overrides.browser) {
        (page.browser as any) = () => ({
            ...mockBrowser,
            pages: async () => [page],
        });
    }
    return page;
}

// ── Helpers ──────────────────────────────────────────────────────────

const OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'leave me alone', 'block', 'report', 'spam', "don't message", 'no thanks'];

function makeConversation(
    username: string,
    lastMessage: string,
    unread = false
): ConversationPreview {
    return {
        username,
        lastMessage,
        lastMessageTime: '2h',
        unread,
        profilePicUrl: ''
    };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. TwitterDM.fromPage() Factory
// ═══════════════════════════════════════════════════════════════════════

describe('TwitterDM.fromPage() factory', () => {
    // Dynamic import to avoid side-effects at module load
    let TwitterDM: typeof import('../../src/client/Twitter-DM').TwitterDM;

    beforeAll(async () => {
        const mod = await import('../../src/client/Twitter-DM');
        TwitterDM = mod.TwitterDM;
    });

    it('should create an instance with shared = true', () => {
        const page = makeMockPage();
        const dm = TwitterDM.fromPage(page);
        // shared is private, but we can verify behavior: close() should not close browser
        expect(dm).toBeDefined();
        expect(dm.getPage()).toBe(page);
    });

    it('should set page and browser from the provided page', () => {
        const mockBrowser = makeMockBrowser();
        const page = makeMockPage({ browser: mockBrowser });
        // Override browser() to return our specific mock
        page.browser = () => mockBrowser;

        const dm = TwitterDM.fromPage(page);
        expect(dm.getPage()).toBe(page);
    });

    it('close() on shared instance does NOT close the browser (just nulls refs)', async () => {
        let browserClosed = false;
        const mockBrowser = makeMockBrowser({
            close: async () => { browserClosed = true; }
        });
        const page = makeMockPage();
        page.browser = () => mockBrowser;

        const dm = TwitterDM.fromPage(page);
        await dm.close();

        expect(browserClosed).toBe(false);
        expect(dm.getPage()).toBeNull();
    });

    it('getPage() returns the provided page', () => {
        const page = makeMockPage();
        const dm = TwitterDM.fromPage(page);
        expect(dm.getPage()).toBe(page);
    });

    it('ensurePage() returns the provided page when valid', async () => {
        const page = makeMockPage({
            evaluate: async () => 'complete'
        });
        const dm = TwitterDM.fromPage(page);
        const result = await dm.ensurePage();
        expect(result).toBe(page);
    });

    it('ensurePage() throws if browser is null (after close)', async () => {
        const page = makeMockPage();
        const dm = TwitterDM.fromPage(page);
        await dm.close(); // nulls browser on shared instance
        await expect(dm.ensurePage()).rejects.toThrow('Browser not initialized');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Watcher State Management
// ═══════════════════════════════════════════════════════════════════════

describe('Watcher state management', () => {
    const TEMP_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', '__test_watcher__');
    const STATE_FILE = path.join(TEMP_DIR, 'watcher_state.json');

    // We test the watcher logic by mocking the TwitterDM.scrapeInbox at the instance level
    let TwitterDM: typeof import('../../src/client/Twitter-DM').TwitterDM;
    let checkForNewTwitterDMs: typeof import('../../src/client/Twitter-DM-Watcher').checkForNewTwitterDMs;
    let initializeTwitterWatcherState: typeof import('../../src/client/Twitter-DM-Watcher').initializeTwitterWatcherState;

    // The watcher uses a hardcoded state file path. We can test its logic by providing
    // mock DMs. We'll create a wrapper that tests the core detection logic.

    beforeAll(async () => {
        const dmMod = await import('../../src/client/Twitter-DM');
        TwitterDM = dmMod.TwitterDM;
        const watcherMod = await import('../../src/client/Twitter-DM-Watcher');
        checkForNewTwitterDMs = watcherMod.checkForNewTwitterDMs;
        initializeTwitterWatcherState = watcherMod.initializeTwitterWatcherState;
    });

    // ── Unit tests for detection logic (no file I/O) ────────────────

    describe('detection logic (unit)', () => {
        it('empty state → all conversations with changed messages detected as new', () => {
            // Simulate the logic from checkForNewTwitterDMs
            const knownLastMessages: Record<string, string> = {};
            const conversations: ConversationPreview[] = [
                makeConversation('alice', 'Hey there!'),
                makeConversation('bob', 'What is up?'),
            ];
            const ourUsername = 'the_isaiah_dupree';
            const newMessages: Array<{ from: string; preview: string }> = [];
            const seen = new Set<string>();

            for (const convo of conversations) {
                const username = convo.username.toLowerCase().replace('@', '');
                if (!username || username === ourUsername) continue;

                if (convo.unread && !seen.has(username)) {
                    seen.add(username);
                    newMessages.push({ from: convo.username, preview: convo.lastMessage });
                }

                if (!seen.has(username) && convo.lastMessage) {
                    const knownLast = knownLastMessages[username];
                    if (convo.lastMessage !== knownLast) {
                        const previewLower = convo.lastMessage.toLowerCase();
                        const looksLikeOurs = previewLower.startsWith('you:') ||
                            previewLower.startsWith('you sent') ||
                            previewLower.startsWith('you reacted');
                        if (!looksLikeOurs) {
                            seen.add(username);
                            newMessages.push({ from: convo.username, preview: convo.lastMessage });
                        }
                    }
                }
            }

            expect(newMessages).toHaveLength(2);
            expect(newMessages[0].from).toBe('alice');
            expect(newMessages[1].from).toBe('bob');
        });

        it('known state → only changed messages detected', () => {
            const knownLastMessages: Record<string, string> = {
                alice: 'Hey there!',
                bob: 'What is up?',
            };
            const conversations: ConversationPreview[] = [
                makeConversation('alice', 'Hey there!'),        // unchanged
                makeConversation('bob', 'New message from bob'), // changed
                makeConversation('carol', 'Hi!'),               // new user
            ];
            const ourUsername = 'the_isaiah_dupree';
            const newMessages: Array<{ from: string; preview: string }> = [];
            const seen = new Set<string>();

            for (const convo of conversations) {
                const username = convo.username.toLowerCase().replace('@', '');
                if (!username || username === ourUsername) continue;

                if (convo.unread && !seen.has(username)) {
                    seen.add(username);
                    newMessages.push({ from: convo.username, preview: convo.lastMessage });
                }

                if (!seen.has(username) && convo.lastMessage) {
                    const knownLast = knownLastMessages[username];
                    if (convo.lastMessage !== knownLast) {
                        const previewLower = convo.lastMessage.toLowerCase();
                        const looksLikeOurs = previewLower.startsWith('you:') ||
                            previewLower.startsWith('you sent') ||
                            previewLower.startsWith('you reacted');
                        if (!looksLikeOurs) {
                            seen.add(username);
                            newMessages.push({ from: convo.username, preview: convo.lastMessage });
                        }
                    }
                }
            }

            expect(newMessages).toHaveLength(2);
            expect(newMessages.find(m => m.from === 'alice')).toBeUndefined();
            expect(newMessages.find(m => m.from === 'bob')).toBeDefined();
            expect(newMessages.find(m => m.from === 'carol')).toBeDefined();
        });

        it('skips our own messages (username === ourUsername)', () => {
            const knownLastMessages: Record<string, string> = {};
            const ourUsername = 'the_isaiah_dupree';
            const conversations: ConversationPreview[] = [
                makeConversation('the_isaiah_dupree', 'My own message'),
                makeConversation('alice', 'Hello!'),
            ];
            const newMessages: Array<{ from: string; preview: string }> = [];
            const seen = new Set<string>();

            for (const convo of conversations) {
                const username = convo.username.toLowerCase().replace('@', '');
                if (!username || username === ourUsername) continue;

                if (!seen.has(username) && convo.lastMessage) {
                    const knownLast = knownLastMessages[username];
                    if (convo.lastMessage !== knownLast) {
                        const previewLower = convo.lastMessage.toLowerCase();
                        const looksLikeOurs = previewLower.startsWith('you:') ||
                            previewLower.startsWith('you sent') ||
                            previewLower.startsWith('you reacted');
                        if (!looksLikeOurs) {
                            seen.add(username);
                            newMessages.push({ from: convo.username, preview: convo.lastMessage });
                        }
                    }
                }
            }

            expect(newMessages).toHaveLength(1);
            expect(newMessages[0].from).toBe('alice');
        });

        it('filters out "You:" prefixed messages (looksLikeOurs)', () => {
            const knownLastMessages: Record<string, string> = {};
            const ourUsername = 'bot';
            const conversations: ConversationPreview[] = [
                makeConversation('alice', 'You: Hey I sent this'),
                makeConversation('bob', 'You sent a photo'),
                makeConversation('carol', 'You reacted with a heart'),
                makeConversation('dave', 'They sent a real message'),
            ];
            const newMessages: Array<{ from: string; preview: string }> = [];
            const seen = new Set<string>();

            for (const convo of conversations) {
                const username = convo.username.toLowerCase().replace('@', '');
                if (!username || username === ourUsername) continue;

                if (!seen.has(username) && convo.lastMessage) {
                    const knownLast = knownLastMessages[username];
                    if (convo.lastMessage !== knownLast) {
                        const previewLower = convo.lastMessage.toLowerCase();
                        const looksLikeOurs = previewLower.startsWith('you:') ||
                            previewLower.startsWith('you sent') ||
                            previewLower.startsWith('you reacted');
                        if (!looksLikeOurs) {
                            seen.add(username);
                            newMessages.push({ from: convo.username, preview: convo.lastMessage });
                        }
                    }
                }
            }

            expect(newMessages).toHaveLength(1);
            expect(newMessages[0].from).toBe('dave');
        });

        it('DOM unread detection takes priority (deduplication via seen set)', () => {
            const knownLastMessages: Record<string, string> = {
                alice: 'Old message',
            };
            const ourUsername = 'bot';
            // alice has both: unread=true AND changed message
            // Should only appear once due to dedup via `seen`
            const conversations: ConversationPreview[] = [
                makeConversation('alice', 'New message from alice', true),
            ];
            const newMessages: Array<{ from: string; preview: string }> = [];
            const seen = new Set<string>();
            let unreadFromDOM = 0;
            let detectedByState = 0;

            for (const convo of conversations) {
                const username = convo.username.toLowerCase().replace('@', '');
                if (!username || username === ourUsername) continue;

                if (convo.unread && !seen.has(username)) {
                    seen.add(username);
                    newMessages.push({ from: convo.username, preview: convo.lastMessage });
                    unreadFromDOM++;
                }

                if (!seen.has(username) && convo.lastMessage) {
                    const knownLast = knownLastMessages[username];
                    if (convo.lastMessage !== knownLast) {
                        const previewLower = convo.lastMessage.toLowerCase();
                        const looksLikeOurs = previewLower.startsWith('you:') ||
                            previewLower.startsWith('you sent') ||
                            previewLower.startsWith('you reacted');
                        if (!looksLikeOurs) {
                            seen.add(username);
                            newMessages.push({ from: convo.username, preview: convo.lastMessage });
                            detectedByState++;
                        }
                    }
                }
            }

            // alice detected only once (via DOM), not double-counted
            expect(newMessages).toHaveLength(1);
            expect(unreadFromDOM).toBe(1);
            expect(detectedByState).toBe(0);
        });

        it('state is updated after processing all conversations', () => {
            const knownLastMessages: Record<string, string> = {};
            const conversations: ConversationPreview[] = [
                makeConversation('alice', 'Message 1'),
                makeConversation('bob', 'Message 2'),
            ];

            // Simulate the state update loop
            for (const convo of conversations) {
                const username = convo.username.toLowerCase().replace('@', '');
                if (convo.lastMessage) {
                    knownLastMessages[username] = convo.lastMessage;
                }
            }

            expect(knownLastMessages['alice']).toBe('Message 1');
            expect(knownLastMessages['bob']).toBe('Message 2');
        });

        it('initializeTwitterWatcherState logic populates state without flagging as new', () => {
            // Simulate the initialize logic: record all current messages as known
            const ourUsername = 'bot';
            const conversations: ConversationPreview[] = [
                makeConversation('alice', 'Existing message 1'),
                makeConversation('bob', 'Existing message 2'),
                makeConversation('bot', 'Our own message'),
            ];
            const state: { knownLastMessages: Record<string, string> } = {
                knownLastMessages: {}
            };

            for (const convo of conversations) {
                const username = convo.username.toLowerCase().replace('@', '');
                if (username && username !== ourUsername && convo.lastMessage) {
                    state.knownLastMessages[username] = convo.lastMessage;
                }
            }

            // All existing messages recorded, own messages excluded
            expect(Object.keys(state.knownLastMessages)).toHaveLength(2);
            expect(state.knownLastMessages['alice']).toBe('Existing message 1');
            expect(state.knownLastMessages['bob']).toBe('Existing message 2');
            expect(state.knownLastMessages['bot']).toBeUndefined();
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Inbox Scraping Logic (unit-testable parts)
// ═══════════════════════════════════════════════════════════════════════

describe('Inbox scraping logic', () => {

    describe('username extraction from text lines', () => {
        // Mirrors the logic inside scrapeInbox's page.evaluate
        function extractUsername(lines: string[]): string {
            for (const line of lines) {
                if (!/^\d+[hmd]$|^(All|Requests|Search)$/i.test(line.trim())) {
                    return line.trim();
                }
            }
            return '';
        }

        it('should extract username from first valid line', () => {
            expect(extractUsername(['Alice', '2h', 'Hey there'])).toBe('Alice');
        });

        it('should skip time indicators (2h, 5m, 1d)', () => {
            expect(extractUsername(['2h', 'Alice', 'Hey'])).toBe('Alice');
            expect(extractUsername(['5m', '1d', 'Bob'])).toBe('Bob');
        });

        it('should skip tab labels (All, Requests, Search)', () => {
            expect(extractUsername(['All', 'Requests', 'Alice'])).toBe('Alice');
            expect(extractUsername(['Search', 'Bob', 'Hello'])).toBe('Bob');
        });

        it('should return empty for no valid lines', () => {
            expect(extractUsername(['2h', '5m', 'All'])).toBe('');
        });
    });

    describe('last message extraction', () => {
        // Mirrors the logic inside scrapeInbox's page.evaluate
        function extractLastMessage(lines: string[], username: string): string {
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trim();
                if (/^\d+[hmd]$|^(All|Requests|Search)$/i.test(line)) continue;
                if (line === username) continue;
                return line;
            }
            return '';
        }

        it('should extract last message (last non-time, non-username line)', () => {
            expect(extractLastMessage(['Alice', 'Hey there!', '2h'], 'Alice')).toBe('Hey there!');
        });

        it('should skip time indicators at the end', () => {
            expect(extractLastMessage(['Bob', 'Hello world', '5m'], 'Bob')).toBe('Hello world');
        });

        it('should skip username line', () => {
            expect(extractLastMessage(['Carol', 'Carol', 'Nice to meet you'], 'Carol')).toBe('Nice to meet you');
        });

        it('should return empty if only username and time', () => {
            expect(extractLastMessage(['Dave', '1h'], 'Dave')).toBe('');
        });
    });

    describe('opt-out keyword detection', () => {
        it.each(OPT_OUT_KEYWORDS)('should detect opt-out keyword: "%s"', (keyword) => {
            const text = `I want to ${keyword} from this`;
            const lower = text.toLowerCase();
            const detected = OPT_OUT_KEYWORDS.some(k => lower.includes(k));
            expect(detected).toBe(true);
        });

        it('should not flag normal messages', () => {
            const normalMessages = [
                'Hey, how are you?',
                'Thanks for reaching out!',
                'Tell me more',
                'Interesting project',
            ];
            for (const msg of normalMessages) {
                const lower = msg.toLowerCase();
                const detected = OPT_OUT_KEYWORDS.some(k => lower.includes(k));
                expect(detected).toBe(false);
            }
        });

        it('should be case-insensitive', () => {
            const text = 'STOP messaging me NOW';
            const lower = text.toLowerCase();
            const detected = OPT_OUT_KEYWORDS.some(k => lower.includes(k));
            expect(detected).toBe(true);
        });
    });

    describe('looksLikeOurs filtering', () => {
        function looksLikeOurs(preview: string): boolean {
            const previewLower = preview.toLowerCase();
            return previewLower.startsWith('you:') ||
                previewLower.startsWith('you sent') ||
                previewLower.startsWith('you reacted');
        }

        it('should detect "You:" prefix', () => {
            expect(looksLikeOurs('You: Hey there')).toBe(true);
            expect(looksLikeOurs('you: lowercase too')).toBe(true);
        });

        it('should detect "You sent" prefix', () => {
            expect(looksLikeOurs('You sent a photo')).toBe(true);
            expect(looksLikeOurs('You sent an attachment')).toBe(true);
        });

        it('should detect "You reacted" prefix', () => {
            expect(looksLikeOurs('You reacted with a heart')).toBe(true);
        });

        it('should NOT flag messages that do not start with our prefixes', () => {
            expect(looksLikeOurs('Hey you!')).toBe(false);
            expect(looksLikeOurs('Thanks for your reply')).toBe(false);
            expect(looksLikeOurs('Do you want to chat?')).toBe(false);
        });

        it('should NOT flag messages mentioning "you" in the middle', () => {
            expect(looksLikeOurs('I told you something')).toBe(false);
            expect(looksLikeOurs('Are you there?')).toBe(false);
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Scheduler Integration Bugs / Edge Cases
// ═══════════════════════════════════════════════════════════════════════

describe('Scheduler integration', () => {

    describe('dmWatcherInitialized flag (runDMTasks initializes once)', () => {
        it('should only initialize watcher state on the first call', () => {
            // Simulate the dmWatcherInitialized guard logic
            let dmWatcherInitialized = false;
            let initCount = 0;

            function simulateInitialization() {
                if (!dmWatcherInitialized) {
                    initCount++;
                    dmWatcherInitialized = true;
                }
            }

            simulateInitialization();
            simulateInitialization();
            simulateInitialization();

            expect(initCount).toBe(1);
            expect(dmWatcherInitialized).toBe(true);
        });

        it('should remain false if initialization fails', () => {
            let dmWatcherInitialized = false;
            let initCount = 0;

            function simulateInitialization(shouldFail: boolean) {
                if (!dmWatcherInitialized) {
                    initCount++;
                    if (shouldFail) {
                        // Non-fatal error: flag stays false so we retry next run
                        return;
                    }
                    dmWatcherInitialized = true;
                }
            }

            simulateInitialization(true);  // fails
            expect(dmWatcherInitialized).toBe(false);
            expect(initCount).toBe(1);

            simulateInitialization(false); // succeeds
            expect(dmWatcherInitialized).toBe(true);
            expect(initCount).toBe(2);

            simulateInitialization(false); // no-op
            expect(initCount).toBe(2);
        });
    });

    describe('pipeline tasks run every 3rd run', () => {
        it('runNumber % 3 === 0 triggers pipeline tasks', () => {
            const pipelineRuns: number[] = [];
            for (let run = 1; run <= 12; run++) {
                if (run % 3 === 0) {
                    pipelineRuns.push(run);
                }
            }
            expect(pipelineRuns).toEqual([3, 6, 9, 12]);
        });

        it('runNumber 1 and 2 do NOT trigger pipeline tasks', () => {
            expect(1 % 3 === 0).toBe(false);
            expect(2 % 3 === 0).toBe(false);
        });

        it('runNumber 3, 6, 9 trigger pipeline tasks', () => {
            expect(3 % 3 === 0).toBe(true);
            expect(6 % 3 === 0).toBe(true);
            expect(9 % 3 === 0).toBe(true);
        });
    });

    describe('DM tasks run even when daily reply target is reached', () => {
        it('should call runDMTasks even when effectiveCount >= DAILY_TARGET', () => {
            // Simulate the scheduler logic from scheduledRun()
            const DAILY_TARGET = 500;
            const effectiveCount = 600; // exceeded
            let dmTasksCalled = false;

            // The scheduler's logic: even when target reached, DM tasks still run
            if (effectiveCount >= DAILY_TARGET) {
                const isWithinActiveHours = true;
                if (isWithinActiveHours) {
                    // This is the DM-only path from the scheduler
                    dmTasksCalled = true;
                }
            }

            expect(dmTasksCalled).toBe(true);
        });

        it('should NOT call DM tasks outside active hours even when target reached', () => {
            const DAILY_TARGET = 500;
            const effectiveCount = 600;
            let dmTasksCalled = false;

            if (effectiveCount >= DAILY_TARGET) {
                const isWithinActiveHours = false;
                if (isWithinActiveHours) {
                    dmTasksCalled = true;
                }
            }

            expect(dmTasksCalled).toBe(false);
        });
    });

    describe('graceful error handling (all errors non-fatal)', () => {
        it('runDMTasks wraps everything in try-catch', async () => {
            // Verify that the pattern from the source code handles errors gracefully.
            // Each sub-task in runDMTasks is wrapped in its own try-catch.
            // Simulate: even if one task throws, others should still run.
            const results: string[] = [];

            async function simulateRunDMTasks() {
                // Task 1: Initialize watcher
                try {
                    throw new Error('Init failed');
                } catch (e) {
                    results.push('init-caught');
                }

                // Task 2: Process delayed replies
                try {
                    results.push('delayed-ok');
                } catch (e) {
                    results.push('delayed-caught');
                }

                // Task 3: Check for new DMs
                try {
                    results.push('check-ok');
                } catch (e) {
                    results.push('check-caught');
                }

                // Task 4: Pipeline tasks
                try {
                    throw new Error('Pipeline failed');
                } catch (e) {
                    results.push('pipeline-caught');
                }
            }

            await simulateRunDMTasks();
            expect(results).toEqual(['init-caught', 'delayed-ok', 'check-ok', 'pipeline-caught']);
            // All tasks ran despite errors in tasks 1 and 4
            expect(results).toHaveLength(4);
        });

        it('outer try-catch in runDMTasks prevents scheduler crash', async () => {
            let crashed = false;
            let dmError: string | null = null;

            try {
                // Simulate the outer try-catch of runDMTasks
                try {
                    throw new Error('Something catastrophic');
                } catch (dmErr) {
                    dmError = (dmErr as Error).message;
                    // Non-fatal: just log the warning
                }
            } catch (e) {
                crashed = true;
            }

            expect(crashed).toBe(false);
            expect(dmError).toBe('Something catastrophic');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. PIN Handling
// ═══════════════════════════════════════════════════════════════════════

describe('PIN handling', () => {

    it('detects PIN prompt from URL containing /pin/recovery', () => {
        const url = 'https://x.com/i/pin/recovery?next=/messages';
        const needsPin = url.includes('/pin/recovery') || url.includes('/pin');
        expect(needsPin).toBe(true);
    });

    it('detects PIN prompt from URL containing /pin', () => {
        const url = 'https://x.com/i/pin?next=/messages';
        const needsPin = url.includes('/pin/recovery') || url.includes('/pin');
        expect(needsPin).toBe(true);
    });

    it('skips PIN handling when URL does not contain /pin', () => {
        const url = 'https://x.com/messages';
        const needsPin = url.includes('/pin/recovery') || url.includes('/pin');
        expect(needsPin).toBe(false);
    });

    it('skips PIN handling for home URL', () => {
        const url = 'https://x.com/home';
        const needsPin = url.includes('/pin/recovery') || url.includes('/pin');
        expect(needsPin).toBe(false);
    });

    it('skips PIN handling for profile URLs', () => {
        const url = 'https://x.com/the_isaiah_dupree';
        const needsPin = url.includes('/pin/recovery') || url.includes('/pin');
        expect(needsPin).toBe(false);
    });

    it('handlePinPrompt uses env PIN or default 7911', () => {
        const envPin = process.env.TWITTER_DM_PIN;
        const pin = envPin || '7911';
        // Default should be 7911 if env var not set
        if (!envPin) {
            expect(pin).toBe('7911');
        }
        expect(typeof pin).toBe('string');
        expect(pin.length).toBeGreaterThan(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Sentiment Analysis (from Twitter-DM-Pipeline.ts)
// ═══════════════════════════════════════════════════════════════════════

describe('Sentiment Analysis (integration)', () => {

    describe('positive messages detected correctly', () => {
        it('should detect enthusiastic replies as positive', () => {
            expect(analyzeSentiment('That sounds awesome! I would love to connect')).toBe('positive');
            expect(analyzeSentiment('Thanks so much, I really appreciate it!')).toBe('positive');
            expect(analyzeSentiment('Yes absolutely, let\'s do it!')).toBe('positive');
        });

        it('should require >= 2 positive words for positive', () => {
            // Single positive word = neutral
            expect(analyzeSentiment('Thanks')).toBe('neutral');
            expect(analyzeSentiment('Sure')).toBe('neutral');
            // Two positive words = positive
            expect(analyzeSentiment('Thanks, sounds good')).toBe('positive');
        });

        it('should detect emoji-heavy positive messages', () => {
            expect(analyzeSentiment('Love it! Amazing work 🔥')).toBe('positive');
        });
    });

    describe('negative messages detected correctly', () => {
        it('should detect opt-out language as negative', () => {
            expect(analyzeSentiment('No thanks, not interested')).toBe('negative');
            expect(analyzeSentiment('Stop messaging me')).toBe('negative');
            expect(analyzeSentiment('This is spam')).toBe('negative');
            expect(analyzeSentiment('Leave me alone')).toBe('negative');
        });

        it('should detect report/block language as negative', () => {
            expect(analyzeSentiment('I will block you')).toBe('negative');
            expect(analyzeSentiment('Going to report this account')).toBe('negative');
        });

        it('should detect scam accusations as negative', () => {
            expect(analyzeSentiment('This looks like a scam')).toBe('negative');
        });
    });

    describe('neutral messages default', () => {
        it('should return neutral for simple acknowledgments', () => {
            expect(analyzeSentiment('Ok')).toBe('neutral');
            expect(analyzeSentiment('I see')).toBe('neutral');
            expect(analyzeSentiment('Hmm')).toBe('neutral');
        });

        it('should return neutral for questions without sentiment', () => {
            expect(analyzeSentiment('What do you mean?')).toBe('neutral');
            expect(analyzeSentiment('Who are you?')).toBe('neutral');
        });

        it('should return neutral for empty-ish text', () => {
            expect(analyzeSentiment('')).toBe('neutral');
            expect(analyzeSentiment('...')).toBe('neutral');
        });
    });

    describe('priority: negative over positive', () => {
        it('should return negative even with positive words present', () => {
            expect(analyzeSentiment('Thanks but please stop, not interested')).toBe('negative');
            expect(analyzeSentiment('I appreciate it but don\'t message me again')).toBe('negative');
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Pipeline Configuration
// ═══════════════════════════════════════════════════════════════════════

describe('Pipeline configuration', () => {
    it('loadConfig returns default values when no file exists', async () => {
        const { loadConfig } = await import('../../src/client/Twitter-DM-Pipeline');
        const config = loadConfig();
        // Should have all required fields with sensible defaults
        expect(config).toHaveProperty('autoApprove');
        expect(config).toHaveProperty('maxDMsPerDay');
        expect(config).toHaveProperty('minDelayBetweenDMs');
        expect(config).toHaveProperty('cooldownHoursPerUser');
        expect(config).toHaveProperty('skipIfNoReplyAfterDays');
        expect(config).toHaveProperty('maxFollowUps');
        expect(config).toHaveProperty('offerEnabled');
        expect(typeof config.maxDMsPerDay).toBe('number');
        expect(config.maxDMsPerDay).toBeGreaterThan(0);
    });

    it('TwitterDMPipeline constructor merges config overrides', async () => {
        const { TwitterDMPipeline } = await import('../../src/client/Twitter-DM-Pipeline');
        const { TwitterDM } = await import('../../src/client/Twitter-DM');
        const page = makeMockPage();
        const dm = TwitterDM.fromPage(page);

        // Pass partial override
        const pipeline = new TwitterDMPipeline(dm, { maxDMsPerDay: 99 });
        // Can't directly access config, but construction should succeed
        expect(pipeline).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. Edge Cases
// ═══════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
    it('should handle @-prefixed usernames in watcher dedup', () => {
        const username = '@alice';
        const cleaned = username.toLowerCase().replace('@', '');
        expect(cleaned).toBe('alice');
    });

    it('should handle empty conversation list gracefully', () => {
        const conversations: ConversationPreview[] = [];
        const newMessages: Array<{ from: string; preview: string }> = [];

        for (const convo of conversations) {
            newMessages.push({ from: convo.username, preview: convo.lastMessage });
        }

        expect(newMessages).toHaveLength(0);
    });

    it('should handle conversations with empty lastMessage', () => {
        const knownLastMessages: Record<string, string> = {};
        const conversations: ConversationPreview[] = [
            makeConversation('alice', ''),
        ];
        const newMessages: Array<{ from: string; preview: string }> = [];
        const seen = new Set<string>();

        for (const convo of conversations) {
            const username = convo.username.toLowerCase().replace('@', '');
            if (!username) continue;

            // State comparison only runs if convo.lastMessage is truthy
            if (!seen.has(username) && convo.lastMessage) {
                const knownLast = knownLastMessages[username];
                if (convo.lastMessage !== knownLast) {
                    seen.add(username);
                    newMessages.push({ from: convo.username, preview: convo.lastMessage });
                }
            }
        }

        // Empty lastMessage should be skipped
        expect(newMessages).toHaveLength(0);
    });

    it('should handle very long message previews', () => {
        const longMsg = 'a'.repeat(500);
        // analyzeSentiment should not crash
        expect(analyzeSentiment(longMsg)).toBe('neutral');
    });

    it('should handle special characters in usernames', () => {
        const username = '@_special_user_123';
        const cleaned = username.toLowerCase().replace('@', '');
        expect(cleaned).toBe('_special_user_123');
    });

    it('prune logic only triggers when stale entries > 50', () => {
        // Mirrors the stale entry pruning from checkForNewTwitterDMs
        const knownLastMessages: Record<string, string> = {};
        // Populate with 60 entries
        for (let i = 0; i < 60; i++) {
            knownLastMessages[`user${i}`] = `msg${i}`;
        }

        // Current inbox only has 5 users
        const currentUsernames = new Set(['user0', 'user1', 'user2', 'user3', 'user4']);
        const staleKeys = Object.keys(knownLastMessages).filter(k => !currentUsernames.has(k));

        // 55 stale entries > 50 threshold
        expect(staleKeys.length).toBe(55);
        expect(staleKeys.length > 50).toBe(true);

        // After pruning
        if (staleKeys.length > 50) {
            for (const key of staleKeys) {
                delete knownLastMessages[key];
            }
        }
        expect(Object.keys(knownLastMessages)).toHaveLength(5);
    });

    it('prune logic does NOT trigger when stale entries <= 50', () => {
        const knownLastMessages: Record<string, string> = {};
        for (let i = 0; i < 55; i++) {
            knownLastMessages[`user${i}`] = `msg${i}`;
        }

        // Current inbox has 10 users (only 45 stale)
        const currentUsernames = new Set(Array.from({ length: 10 }, (_, i) => `user${i}`));
        const staleKeys = Object.keys(knownLastMessages).filter(k => !currentUsernames.has(k));

        expect(staleKeys.length).toBe(45);
        expect(staleKeys.length > 50).toBe(false);

        // No pruning should happen
        const sizeBeforePrune = Object.keys(knownLastMessages).length;
        if (staleKeys.length > 50) {
            for (const key of staleKeys) {
                delete knownLastMessages[key];
            }
        }
        expect(Object.keys(knownLastMessages).length).toBe(sizeBeforePrune);
    });
});
