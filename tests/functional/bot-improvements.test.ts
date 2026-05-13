/**
 * Tests for bot improvement fixes:
 * 1. Twitter DM protocolTimeout config
 * 2. Threads tech keyword filter coverage
 * 3. Tweet URL capture helper
 */

import { isRelevantTechPost } from '../../src/client/Threads-AI';
import fs from 'fs';
import path from 'path';

// ── Fix #1: protocolTimeout is set in browser launch configs ─────────

describe('Fix #1: Twitter DM protocolTimeout', () => {
    it('should have protocolTimeout in Twitter-DM.ts launch config', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter-DM.ts'),
            'utf-8'
        );
        expect(src).toContain('protocolTimeout');
        // Verify it's a reasonable value (>= 60s)
        const match = src.match(/protocolTimeout:\s*(\d[\d_]*)/);
        expect(match).toBeTruthy();
        const value = parseInt(match![1].replace(/_/g, ''), 10);
        expect(value).toBeGreaterThanOrEqual(60_000);
    });

    it('should have protocolTimeout in BrowserPool.ts launch config', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/browser/BrowserPool.ts'),
            'utf-8'
        );
        expect(src).toContain('protocolTimeout');
        const match = src.match(/protocolTimeout:\s*(\d[\d_]*)/);
        expect(match).toBeTruthy();
        const value = parseInt(match![1].replace(/_/g, ''), 10);
        expect(value).toBeGreaterThanOrEqual(60_000);
    });
});

// ── Fix #2: Threads tech keyword filter ──────────────────────────────

describe('Fix #2: Threads tech keyword filter', () => {
    describe('should accept legitimate tech posts', () => {
        const techPosts = [
            { text: 'SSL/TLS VPN vs IPSec VPN — which is better for remote work?', keyword: 'ssl' },
            { text: "It's been fun launching my first macOS app!", keyword: 'macos' },
            { text: 'Beginners Roadmap to Become a Data Analyst in 2026', keyword: 'data analyst' },
            { text: 'Just deployed my frontend with Vercel and it was seamless', keyword: 'frontend' },
            { text: 'The backend service crashed after the Redis cache expired', keyword: 'backend' },
            { text: 'Learning about VPN tunneling and network security', keyword: 'vpn' },
            { text: 'Set up SSH keys for my new server today', keyword: 'ssh' },
            { text: 'DNS propagation took forever after changing nameservers', keyword: 'dns' },
            { text: 'Building an IoT sensor network with Raspberry Pi', keyword: 'raspberry pi' },
            { text: 'My first Chrome extension just hit 1000 users', keyword: 'chrome extension' },
            { text: 'MongoDB vs PostgreSQL for this new project?', keyword: 'mongodb' },
            { text: 'Just passed my penetration testing certification!', keyword: 'penetration testing' },
            { text: 'Terraform made our infrastructure so much easier to manage', keyword: 'terraform' },
            { text: 'The new Vue 4 composition API is amazing', keyword: 'vue' },
            { text: 'Grinding LeetCode for my upcoming tech interview', keyword: 'leetcode' },
            { text: 'My Arduino project finally works!', keyword: 'arduino' },
            { text: 'Just hit $5k MRR on my bootstrapped SaaS', keyword: 'mrr' },
            { text: 'Switched from Ubuntu to Arch Linux this weekend', keyword: 'ubuntu' },
        ];

        techPosts.forEach(({ text, keyword }) => {
            it(`should match "${keyword}" in: "${text.slice(0, 50)}..."`, () => {
                const result = isRelevantTechPost(text);
                expect(result.relevant).toBe(true);
                expect(result.reason).toContain('tech_keyword');
            });
        });
    });

    describe('should still match original keywords', () => {
        const originalKeywords = [
            'Just built a RAG pipeline with LangChain',
            'OpenAI released a new GPT model today',
            'Learning Python for data science',
            'Docker containers make deployment so much easier',
            'The AI revolution is just getting started',
            'Just launched on Product Hunt!',
            'Y Combinator W26 batch is insane this year',
        ];

        originalKeywords.forEach((text) => {
            it(`should match: "${text.slice(0, 50)}..."`, () => {
                const result = isRelevantTechPost(text);
                expect(result.relevant).toBe(true);
            });
        });
    });

    describe('should reject non-tech posts', () => {
        const nonTechPosts = [
            'Just had the best brunch of my life 🥞',
            'My dog is so cute when he sleeps',
            'Happy birthday to my best friend!',
            'Who else loves watching sunsets?',
            'New workout routine hitting different 💪',
        ];

        nonTechPosts.forEach((text) => {
            it(`should reject: "${text.slice(0, 50)}..."`, () => {
                const result = isRelevantTechPost(text);
                expect(result.relevant).toBe(false);
                expect(result.reason).toBe('no_tech_keywords');
            });
        });
    });

    describe('should reject political posts', () => {
        const politicalPosts = [
            'The Republican party needs to change their stance',
            'Trump just announced a new policy that affects everyone',
            'Liberal vs conservative — the debate continues',
        ];

        politicalPosts.forEach((text) => {
            it(`should reject political: "${text.slice(0, 40)}..."`, () => {
                const result = isRelevantTechPost(text);
                expect(result.relevant).toBe(false);
                expect(result.reason).toContain('political_keyword');
            });
        });
    });
});

// ── Fix #3: Tweet URL capture ────────────────────────────────────────

describe('Fix #3: Tweet URL capture in posting functions', () => {
    it('scrapeLatestTweetUrl should be exported from Twitter-Core', () => {
        // Verify the function exists in the source
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter-Core.ts'),
            'utf-8'
        );
        expect(src).toContain('export async function scrapeLatestTweetUrl');
    });

    it('postThread should return tweetUrl on success', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter-Core.ts'),
            'utf-8'
        );
        // Find the postThread function and check it returns tweetUrl
        const threadSection = src.slice(src.indexOf('export async function postThread'));
        const returnMatch = threadSection.match(/return \{ success: true,\s*tweetUrl/);
        expect(returnMatch).toBeTruthy();
    });

    it('quoteTweet should return tweetUrl on success', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter-Core.ts'),
            'utf-8'
        );
        const quoteSection = src.slice(src.indexOf('export async function quoteTweet'));
        const returnMatch = quoteSection.match(/return \{ success: true,\s*tweetUrl/);
        expect(returnMatch).toBeTruthy();
    });

    it('postTweet should use scrapeLatestTweetUrl as fallback', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter-Core.ts'),
            'utf-8'
        );
        const tweetSection = src.slice(
            src.indexOf('export async function postTweet'),
            src.indexOf('export async function quoteTweet')
        );
        expect(tweetSection).toContain('scrapeLatestTweetUrl');
    });
});

// ── Fix #5: Twitter DM thread message selectors ─────────────────────

describe('Fix #5: Twitter DM thread message selectors', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/client/Twitter-DM.ts'),
        'utf-8'
    );

    it('should use DmScrollerContainer to scope message extraction', () => {
        expect(src).toContain('DmScrollerContainer');
    });

    it('should query tweetText inside scroller (current X UI)', () => {
        expect(src).toContain('[data-testid="tweetText"]');
    });

    it('should check DMSentMessage for isOurs detection', () => {
        expect(src).toContain('DMSentMessage');
    });

    it('should have a fallback div[dir="auto"] scan when selectors match nothing', () => {
        expect(src).toContain('div[dir="auto"]');
    });

    it('should deduplicate messages by text content', () => {
        expect(src).toContain('seen.has(text)');
    });
});

// ── Fix #6: Offer readiness gate skipped for cold outreach ──────────

describe('Fix #6: Offer readiness gate for cold outreach', () => {
    it('should skip readiness check for cold_outreach in Instagram pipeline', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Instagram-DM-Pipeline.ts'),
            'utf-8'
        );
        expect(src).toContain("'cold_outreach'");
        expect(src).toContain("'initial_contact'");
        expect(src).toContain('!coldStages.includes(relationship.stage)');
    });

    it('should skip readiness check for cold_outreach in Twitter pipeline', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter-DM-Pipeline.ts'),
            'utf-8'
        );
        expect(src).toContain("'cold_outreach'");
        expect(src).toContain("'initial_contact'");
        expect(src).toContain('!coldStages.includes(relationship.stage)');
    });

    it('should still check readiness for non-cold stages', () => {
        // The readiness check must still exist (not removed entirely)
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Instagram-DM-Pipeline.ts'),
            'utf-8'
        );
        expect(src).toContain('computeOfferReadiness');
        expect(src).toContain('readiness.score < 0.45');
    });
});

// ── Fix #7: Instagram DM search result selectors ────────────────────

describe('Fix #7: Instagram DM search result selectors', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/client/Instagram-DM.ts'),
        'utf-8'
    );

    it('should include listitem selector for search results', () => {
        expect(src).toContain('div[role="listitem"]');
    });

    it('should include option selector for search results', () => {
        expect(src).toContain('div[role="option"]');
    });

    it('should include tabindex selectors for clickable items', () => {
        expect(src).toContain('div[tabindex="0"]');
    });

    it('should include anchor elements in search selectors', () => {
        expect(src).toContain('a[role="link"]');
    });
});

// ── Fix #8: Twitter DM inbox search bar activation ──────────────────

describe('Fix #8: Twitter DM inbox search bar activation', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/client/Twitter-DM.ts'),
        'utf-8'
    );

    it('should include DmSearchInput selector', () => {
        expect(src).toContain('input[data-testid="DmSearchInput"]');
    });

    it('should include message placeholder variant', () => {
        expect(src).toContain('input[placeholder*="message"]');
    });

    it('should use 2500ms activation delay (not 1500ms)', () => {
        expect(src).toContain('await delay(2500)');
        // The old 1500ms delay should not exist for activation
        expect(src).not.toMatch(/await delay\(1500\);\s*\/\/ (?:Twitter|X) needs time/);
    });

    it('should scope generic fallback inputs to DM panel or aside', () => {
        expect(src).toContain("aside input[type=\"text\"]");
    });
});

// ══════════════════════════════════════════════════════════════════════
// STRATEGIC IMPROVEMENTS
// ══════════════════════════════════════════════════════════════════════

// ── #10: Brand voice injection ──────────────────────────────────────

describe('Strategic #10: Brand voice in all comment generators', () => {
    it('Instagram comments should use getBrandPromptContext()', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Instagram-Core.ts'),
            'utf-8'
        );
        expect(src).toContain("import { getBrandPromptContext } from '../strategy/twitter-brand'");
        expect(src).toContain('getBrandPromptContext()');
        // Should NOT contain the old anonymous persona
        expect(src).not.toContain('casual Instagram user who leaves simple');
    });

    it('Twitter replies should use getBrandPromptContext()', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter-Core.ts'),
            'utf-8'
        );
        expect(src).toContain("import { getBrandPromptContext } from '../strategy/twitter-brand'");
        // The generateReply function should reference brandContext
        const replySection = src.slice(
            src.indexOf('export async function generateReply'),
            src.indexOf('export async function generateReply') + 3000
        );
        expect(replySection).toContain('getBrandPromptContext()');
        // Should NOT contain the old anonymous persona
        expect(replySection).not.toContain('knowledgeable Twitter user');
    });

    it('Threads should still use named Isaiah persona', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Threads-AI.ts'),
            'utf-8'
        );
        expect(src).toContain('You are Isaiah');
    });
});

// ── #11: Token budget increases ─────────────────────────────────────

describe('Strategic #11: Increased token budgets', () => {
    it('Instagram comments should use 150 max_tokens', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Instagram-Core.ts'),
            'utf-8'
        );
        // Find the generateComment function's chatCompletion call
        // Search whole file — function got longer with learning injection
        expect(src).toContain('max_tokens: 150');
    });

    it('Twitter replies should use 150 max_tokens', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter-Core.ts'),
            'utf-8'
        );
        const replySection = src.slice(
            src.indexOf('export async function generateReply'),
            src.indexOf('export async function generateReply') + 3000
        );
        expect(replySection).toContain('max_tokens: 150');
    });

    it('Threads comments should use 120 max_tokens', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Threads-AI.ts'),
            'utf-8'
        );
        // Search the whole file — the function got longer with learning injection
        expect(src).toContain('max_tokens: 120');
    });

    it('Threads should allow up to 280 character comments', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Threads-AI.ts'),
            'utf-8'
        );
        expect(src).toContain('under 280 characters');
        expect(src).toContain('comment.length > 280');
    });
});

// ── #12: IG reply notifications re-enabled ──────────────────────────

describe('Strategic #12: IG reply notifications enabled', () => {
    it('processIGReplyNotifications should be called (not commented out)', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/scheduler.ts'),
            'utf-8'
        );
        // Should have an active (non-commented) call
        const lines = src.split('\n');
        const activeLine = lines.find(l =>
            l.includes('processIGReplyNotifications(page') && !l.trim().startsWith('//')
        );
        expect(activeLine).toBeTruthy();
    });
});

// ── #13: Comment engagement tracking ────────────────────────────────

describe('Strategic #13: Comment engagement check-back tracking', () => {
    it('TrackedComment should have engagement and platform fields', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/tracking/commentTracker.ts'),
            'utf-8'
        );
        expect(src).toContain("platform?: 'instagram' | 'threads'");
        expect(src).toContain('engagement?: CommentEngagement');
    });

    it('should export getCommentsNeedingCheckBack()', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/tracking/commentTracker.ts'),
            'utf-8'
        );
        expect(src).toContain('export function getCommentsNeedingCheckBack');
    });

    it('should export updateCommentEngagement()', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/tracking/commentTracker.ts'),
            'utf-8'
        );
        expect(src).toContain('export function updateCommentEngagement');
    });

    it('should export getEngagementSummary()', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/tracking/commentTracker.ts'),
            'utf-8'
        );
        expect(src).toContain('export function getEngagementSummary');
    });

    it('scheduler should call engagement check-backs', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/scheduler.ts'),
            'utf-8'
        );
        expect(src).toContain('getCommentsNeedingCheckBack');
        expect(src).toContain('updateCommentEngagement');
    });
});

// ══════════════════════════════════════════════════════════════════════
// GRAPH API + BROWSER FALLBACK & VALUE-FOCUSED PROMPTS
// ══════════════════════════════════════════════════════════════════════

// ── IG Graph API with browser fallback ──────────────────────────────

describe('IG DM: Graph API with browser automation fallback', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/client/Instagram-DM.ts'),
        'utf-8'
    );

    it('sendDM should try Graph API first', () => {
        const sendDMSection = src.slice(
            src.indexOf('async sendDM('),
            src.indexOf('async sendDM(') + 500
        );
        expect(sendDMSection).toContain('trySendViaAPI');
    });

    it('should fall back to browser when API returns null', () => {
        const sendDMSection = src.slice(
            src.indexOf('async sendDM('),
            src.indexOf('async sendDM(') + 1000
        );
        // API returns result → use it; null → falls through to browser code
        expect(sendDMSection).toContain('apiResult');
        expect(sendDMSection).toContain('navigateToInbox');
    });

    it('trySendViaAPI should return null on API failure (not throw)', () => {
        const apiStart = src.indexOf('private async trySendViaAPI');
        const apiSection = src.slice(apiStart, apiStart + 2000);
        // On API error, returns null so caller falls through to browser
        expect(apiSection).toContain('return null');
        expect(apiSection).toContain('falling back to browser');
    });

    it('should log Graph API attempt before trying', () => {
        expect(src).toContain('Attempting Graph API send to');
    });

    it('should log when falling back to browser', () => {
        expect(src).toContain('Graph API unavailable');
        expect(src).toContain('falling back to browser');
    });

    it('browser fallback should search and select recipient', () => {
        const sendDMSection = src.slice(
            src.indexOf('async sendDM('),
            src.indexOf('async sendDM(') + 2000
        );
        expect(sendDMSection).toContain('searchAndSelectRecipient');
    });
});

// ── IG Graph API token is valid in .env ─────────────────────────────

describe('IG Graph API token configuration', () => {
    const envSrc = fs.readFileSync(
        path.join(__dirname, '../../.env'),
        'utf-8'
    );

    it('INSTAGRAM_ACCESS_TOKEN should be set and not empty', () => {
        const match = envSrc.match(/INSTAGRAM_ACCESS_TOKEN=(.+)/);
        expect(match).toBeTruthy();
        expect(match![1].length).toBeGreaterThan(20);
    });

    it('META_ACCESS_TOKEN should be set and not empty', () => {
        const match = envSrc.match(/META_ACCESS_TOKEN=(.+)/);
        expect(match).toBeTruthy();
        expect(match![1].length).toBeGreaterThan(20);
    });

    it('FACEBOOK_ACCESS_TOKEN should be set and not empty', () => {
        const match = envSrc.match(/FACEBOOK_ACCESS_TOKEN=(.+)/);
        expect(match).toBeTruthy();
        expect(match![1].length).toBeGreaterThan(20);
    });

    it('all three tokens should match (same long-lived token)', () => {
        const ig = envSrc.match(/INSTAGRAM_ACCESS_TOKEN=(.+)/)?.[1];
        const meta = envSrc.match(/META_ACCESS_TOKEN=(.+)/)?.[1];
        const fb = envSrc.match(/FACEBOOK_ACCESS_TOKEN=(.+)/)?.[1];
        expect(ig).toBe(meta);
        expect(ig).toBe(fb);
    });
});

// ── Value-focused comment/reply prompts ─────────────────────────────

describe('Value-focused prompts across all platforms', () => {
    describe('Instagram comments', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Instagram-Core.ts'),
            'utf-8'
        );

        it('should instruct AI to ADD VALUE', () => {
            expect(src).toContain('ADD VALUE');
        });

        it('should offer specific value-adding approaches', () => {
            expect(src).toContain('specific tool, technique, or resource');
            expect(src).toContain('real-world example or case study');
            expect(src).toContain('contrarian or non-obvious take');
            expect(src).toContain('sharp, specific question');
        });

        it('should require specificity (name names)', () => {
            expect(src).toContain('Be specific');
            expect(src).toContain('name names');
        });

        it('should NOT contain old generic prompt language', () => {
            expect(src).not.toContain('Generate a simple Instagram comment');
            expect(src).not.toContain('Style: Casual and friendly');
        });
    });

    describe('Twitter replies', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter-Core.ts'),
            'utf-8'
        );

        it('should instruct AI to ADD VALUE', () => {
            expect(src).toContain('ADD VALUE');
        });

        it('should offer specific value-adding approaches', () => {
            expect(src).toContain('specific tool, framework, or resource');
            expect(src).toContain('concrete example, stat, or case study');
            expect(src).toContain('non-obvious perspective');
            expect(src).toContain('sharp follow-up question');
        });

        it('should require specificity', () => {
            expect(src).toContain('name tools, techniques, companies, stats');
        });

        it('should NOT contain old generic prompt language', () => {
            expect(src).not.toContain('Sound natural and conversational — write like a real person on Twitter');
            expect(src).not.toContain('agree with substance');
        });
    });

    describe('Threads comments', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Threads-AI.ts'),
            'utf-8'
        );

        it('should instruct AI to ADD VALUE', () => {
            expect(src).toContain('ADD VALUE');
        });

        it('should offer specific value-adding approaches', () => {
            expect(src).toContain('specific tool, library, or technique');
            expect(src).toContain('concrete example, stat, or real experience');
            expect(src).toContain('non-obvious take');
            expect(src).toContain('sharp follow-up question');
        });

        it('should require specificity', () => {
            expect(src).toContain('name tools, frameworks, companies, stats');
        });

        it('should maintain Isaiah persona', () => {
            expect(src).toContain('You are Isaiah');
        });

        it('should describe commenter as knowledgeable contributor', () => {
            expect(src).toContain('knowledgeable person contributing');
        });
    });
});

// ══════════════════════════════════════════════════════════════════════
// ROUND 4: BUGS A-C + STRATEGIC D, F
// ══════════════════════════════════════════════════════════════════════

// ── Fix A: Twitter.ts protocolTimeout ───────────────────────────────

describe('Fix A: Twitter main bot protocolTimeout', () => {
    it('should have protocolTimeout in Twitter.ts launch config', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Twitter.ts'),
            'utf-8'
        );
        expect(src).toContain('protocolTimeout');
        const match = src.match(/protocolTimeout:\s*(\d[\d_]*)/);
        expect(match).toBeTruthy();
        const value = parseInt(match![1].replace(/_/g, ''), 10);
        expect(value).toBeGreaterThanOrEqual(60_000);
    });
});

// ── Fix B: Meta-commentary guard ────────────────────────────────────

describe('Fix B: Guard against meta-commentary AI replies', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/client/Twitter-Reply-Handler.ts'),
        'utf-8'
    );

    it('should skip when ourOriginalText is missing', () => {
        expect(src).toContain('missing_original_context');
        expect(src).toContain('ourOriginalText');
    });

    it('should detect and reject meta-commentary phrases', () => {
        expect(src).toContain('meta_commentary_detected');
        expect(src).toContain("i don't see");
        expect(src).toContain('context provided');
    });

    it('should check multiple meta-commentary patterns', () => {
        const metaSection = src.slice(src.indexOf('metaPhrases'));
        expect(metaSection).toContain("no context");
        expect(metaSection).toContain("not provided");
        expect(metaSection).toContain("not visible");
    });
});

// ── Fix C: New Threads keywords ─────────────────────────────────────

describe('Fix C: Additional Threads keywords', () => {
    const techPosts = [
        { text: 'Started with iPhone 4 and now look where we are', keyword: 'iphone' },
        { text: 'Just launched my app on the App Store!', keyword: 'app store' },
        { text: 'Best remote work tools for distributed teams', keyword: 'remote work' },
        { text: 'We are hiring senior engineers — remote job', keyword: 'remote job' },
        { text: 'The new Samsung Galaxy S26 is insane', keyword: 'samsung' },
        { text: 'If you plant your app in the right ecosystem it grows', keyword: 'my app' },
    ];

    techPosts.forEach(({ text, keyword }) => {
        it(`should match "${keyword}" in: "${text.slice(0, 50)}..."`, () => {
            const { isRelevantTechPost } = require('../../src/client/Threads-AI');
            const result = isRelevantTechPost(text);
            expect(result.relevant).toBe(true);
        });
    });
});

// ── Strategic D: Niche performance weighting ────────────────────────

describe('Strategic D: Niche performance weighting', () => {
    it('nichePerformance module should export key functions', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/tracking/nichePerformance.ts'),
            'utf-8'
        );
        expect(src).toContain('export function recordNicheRun');
        expect(src).toContain('export function selectWeightedNiche');
        expect(src).toContain('export function getTopNiches');
        expect(src).toContain('export function addNicheEngagement');
    });

    it('selectWeightedNiche should give exploration bonus to new niches', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/tracking/nichePerformance.ts'),
            'utf-8'
        );
        // New niches (< 3 runs) should get a high default weight
        expect(src).toContain('entry.runs < 3');
        expect(src).toContain('Exploration bonus');
    });

    it('twitter-scheduler should use selectWeightedNiche instead of round-robin', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/twitter-scheduler.ts'),
            'utf-8'
        );
        expect(src).toContain('selectWeightedNiche');
        expect(src).toContain('recordNicheRun');
    });

    it('twitter-scheduler should record niche run results after completion', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/twitter-scheduler.ts'),
            'utf-8'
        );
        // recordNicheRun should appear after the niche batch runs
        const nicheSection = src.slice(src.indexOf('Running niche batch'));
        expect(nicheSection).toContain('recordNicheRun');
    });
});

// ── Strategic F: Engagement learnings in prompts ────────────────────

describe('Strategic F: Engagement learnings injected into prompts', () => {
    it('Instagram comment generator should import getEngagementSummary', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Instagram-Core.ts'),
            'utf-8'
        );
        expect(src).toContain('getEngagementSummary');
        expect(src).toContain('topPerformers');
        expect(src).toContain('top-performing comments');
    });

    it('Threads comment generator should import getEngagementSummary', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '../../src/client/Threads-AI.ts'),
            'utf-8'
        );
        expect(src).toContain('getEngagementSummary');
        expect(src).toContain('best-performing comments');
    });
});

// ══════════════════════════════════════════════════════════════════════
// OPENAI FALLBACK
// ══════════════════════════════════════════════════════════════════════

describe('OpenAI fallback in AI client', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/utils/ai.ts'),
        'utf-8'
    );

    it('should import OpenAI', () => {
        expect(src).toContain("import OpenAI from 'openai'");
    });

    it('should define OpenAI fallback model', () => {
        expect(src).toContain('OPENAI_FALLBACK_MODEL');
        expect(src).toContain('gpt-4o-mini');
    });

    it('should have getOpenAIClient function', () => {
        expect(src).toContain('function getOpenAIClient');
        expect(src).toContain('OPENAI_API_KEY');
    });

    it('should have openAICompletion fallback function', () => {
        expect(src).toContain('async function openAICompletion');
        expect(src).toContain('client.chat.completions.create');
    });

    it('chatCompletion should try Claude first', () => {
        const chatSection = src.slice(src.indexOf('export async function chatCompletion'));
        expect(chatSection).toContain('Try Claude first');
        expect(chatSection).toContain('client.messages.create');
    });

    it('should fall back to OpenAI when Claude throws', () => {
        const chatSection = src.slice(src.indexOf('export async function chatCompletion'));
        expect(chatSection).toContain('Claude failed');
        expect(chatSection).toContain('falling back to OpenAI');
        expect(chatSection).toContain('openAICompletion');
    });

    it('should log when OpenAI fallback succeeds', () => {
        expect(src).toContain('OpenAI fallback succeeded');
    });

    it('should log when both providers fail', () => {
        expect(src).toContain('OpenAI fallback also failed');
    });

    it('should export OPENAI_FALLBACK_MODEL', () => {
        expect(src).toContain('OPENAI_FALLBACK_MODEL');
    });

    it('OPENAI_API_KEY should be set in .env', () => {
        const envSrc = fs.readFileSync(
            path.join(__dirname, '../../.env'),
            'utf-8'
        );
        const match = envSrc.match(/OPENAI_API_KEY=(.+)/);
        expect(match).toBeTruthy();
        expect(match![1].length).toBeGreaterThan(10);
    });
});

// ══════════════════════════════════════════════════════════════════════
// THREADS META-COMMENTARY GUARD + KEYWORD WORD-BOUNDARY FIX
// ══════════════════════════════════════════════════════════════════════

describe('Threads meta-commentary guard', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '../../src/client/Threads-AI.ts'),
        'utf-8'
    );

    it('should reject "I appreciate the post" style meta-commentary', () => {
        expect(src).toContain('i appreciate the post');
        expect(src).toContain('Rejected meta-commentary');
    });

    it('should reject "as isaiah" self-referencing', () => {
        expect(src).toContain('as isaiah');
    });

    it('should reject "not really a tech" explanations', () => {
        expect(src).toContain('not really a tech');
    });

    it('should return null when meta-commentary detected', () => {
        const guardSection = src.slice(src.indexOf('Reject meta-commentary'));
        expect(guardSection).toContain('return null');
    });
});

describe('Keyword word-boundary matching for short terms', () => {
    const { isRelevantTechPost } = require('../../src/client/Threads-AI');

    it('should match "ai" as standalone word', () => {
        expect(isRelevantTechPost('AI is changing everything').relevant).toBe(true);
        expect(isRelevantTechPost('using ai for automation').relevant).toBe(true);
    });

    it('should NOT match "ai" inside other words', () => {
        expect(isRelevantTechPost('Visible by Verizon is available now').relevant).toBe(false);
        expect(isRelevantTechPost('I maintain my daily routine').relevant).toBe(false);
    });

    it('should match "ml" as standalone but not inside "html"', () => {
        expect(isRelevantTechPost('ML models are getting better').relevant).toBe(true);
        expect(isRelevantTechPost('writing html and css all day').relevant).toBe(false);
    });

    it('should still match longer keywords with includes()', () => {
        expect(isRelevantTechPost('cybersecurity is important').relevant).toBe(true);
        expect(isRelevantTechPost('learning python for data science').relevant).toBe(true);
        expect(isRelevantTechPost('deploying with kubernetes').relevant).toBe(true);
    });

    it('should match "api" as standalone word', () => {
        expect(isRelevantTechPost('Building a REST API today').relevant).toBe(true);
    });

    it('should NOT match "api" inside "capital"', () => {
        // "capital" contains "api" but word-boundary should prevent match
        // Note: "venture" IS a tech keyword, so use a sentence without other keywords
        expect(isRelevantTechPost('The capital of France is beautiful').relevant).toBe(false);
    });
});
