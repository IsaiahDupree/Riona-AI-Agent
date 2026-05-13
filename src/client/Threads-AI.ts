/**
 * Threads-AI.ts — Threads automation client
 * Mirrors the Instagram-AI.ts architecture for threads.net
 * Runs in a separate Chrome instance with its own profile
 */

import { Page, Browser } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
// AdblockerPlugin removed — was imported but never used
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { chatCompletion } from '../utils/ai';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
    createSession, saveSession, updateDailyStats,
    SessionLog, TrackedComment, hasCommentedOnPost, trackComment
} from '../tracking/threadsTracker';

dotenv.config({ override: true });

// ── Supabase client for saving Threads posts ────────────────────────
let supabase: SupabaseClient | null = null;

function getSupabase(): SupabaseClient | null {
    if (supabase) return supabase;
    const url = process.env.SUPABASE_URL || '';
    const key = process.env.SUPABASE_KEY || '';
    if (!url || !key) return null;
    supabase = createClient(url, key);
    return supabase;
}

interface ThreadsPostRecord {
    post_url: string;
    author_username: string;
    post_text: string | null;
    hashtags: string[];
    our_comment: string | null;
    comment_verified: boolean;
    liked: boolean;
    skipped: boolean;
    skip_reason: string | null;
    session_id: string;
    metadata: Record<string, any>;
}

let supabaseAvailable: boolean | null = null;

async function saveThreadsPost(record: ThreadsPostRecord): Promise<void> {
    const sb = getSupabase();
    if (!sb) return;
    if (supabaseAvailable === false) return; // Skip if previously failed

    try {
        const { error } = await sb
            .from('threads_posts')
            .upsert(record, { onConflict: 'post_url' });
        if (error) {
            if (error.message?.includes('does not exist') || error.code === '42P01') {
                logger.warn('[threads] Supabase threads_posts table not found — run migration 006_threads_posts.sql');
                supabaseAvailable = false;
            } else {
                logger.warn(`[threads] Supabase save failed: ${error.message}`);
            }
        } else {
            if (supabaseAvailable === null) {
                logger.info('[threads] Supabase threads_posts connected');
                supabaseAvailable = true;
            }
        }
    } catch (e) {
        logger.warn(`[threads] Supabase save error: ${e}`);
        supabaseAvailable = false;
    }
}

// Stealth plugins
puppeteer.use(StealthPlugin());

// OpenAI replaced by shared Anthropic wrapper (chatCompletion)

const THREADS_TIMEOUT = parseInt(process.env.THREADS_TIMEOUT_MS || '30000', 10);
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const THREADS_PROFILE = path.join(process.cwd(), 'chrome-profile-threads');
const COOKIES_PATH = path.join(process.cwd(), 'cookies', `threads_${process.env.THREADS_BOT_USERNAME || 'default'}_cookies.json`);

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomDelay = (min: number, max: number) => delay(min + Math.random() * (max - min));

// ── ThreadsAI Class ────────────────────────────────────────────────

export class ThreadsAI {
    private browser: Browser | null = null;
    private page: Page | null = null;
    private username: string;
    private password: string;

    constructor() {
        this.username = process.env.THREADS_BOT_USERNAME || '';
        this.password = process.env.THREADS_BOT_PASSWORD || '';
        if (!this.username || !this.password) {
            throw new Error('Missing THREADS_BOT_USERNAME or THREADS_BOT_PASSWORD in .env');
        }
    }

    getPage(): Page | null { return this.page; }

    async initialize(): Promise<void> {
        try {
            logger.info('[threads] Initializing browser...', {
                component: 'Threads-AI', event: 'init'
            });

            // Ensure profile dir exists
            if (!fs.existsSync(THREADS_PROFILE)) {
                fs.mkdirSync(THREADS_PROFILE, { recursive: true });
            }

            this.browser = await puppeteer.launch({
                headless: false,
                defaultViewport: null,
                executablePath: CHROME_PATH,
                userDataDir: THREADS_PROFILE,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-infobars',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--disable-notifications',
                    '--window-position=960,0',
                    '--window-size=960,1080',
                    '--ignore-certificate-errors',
                    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
                ]
            });

            this.page = await this.browser.newPage();
            this.page.setDefaultNavigationTimeout(THREADS_TIMEOUT);
            this.page.setDefaultTimeout(THREADS_TIMEOUT);

            // Load cookies if available
            await this.loadCookies();

            logger.info('[threads] Browser initialized');
        } catch (error) {
            logger.error('[threads] Init failed:', error);
            throw error;
        }
    }

    private async loadCookies(): Promise<void> {
        if (!this.page) return;
        try {
            if (fs.existsSync(COOKIES_PATH)) {
                const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
                await this.page.setCookie(...cookies);
                logger.info('[threads] Cookies loaded');
            }
        } catch (e) {
            logger.warn('[threads] Failed to load cookies:', e);
        }
    }

    private async saveCookies(): Promise<void> {
        if (!this.page) return;
        try {
            const dir = path.dirname(COOKIES_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const cookies = await this.page.cookies();
            fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
            logger.info('[threads] Cookies saved');
        } catch (e) {
            logger.warn('[threads] Failed to save cookies:', e);
        }
    }

    async ensureLoggedIn(): Promise<boolean> {
        if (!this.page) return false;

        // Threads uses "Continue with Instagram" — so we use Instagram credentials
        const igUsername = process.env.INSTAGRAM_BOT_USERNAME || this.username;
        const igPassword = process.env.INSTAGRAM_BOT_PASSWORD || this.password;

        try {
            // Navigate to Threads login page
            await this.page.goto('https://www.threads.net/login', {
                waitUntil: 'domcontentloaded', timeout: THREADS_TIMEOUT
            });
            await delay(4000);

            // Check if already logged in (redirected to feed)
            const currentUrl = this.page.url();
            const isLoggedIn = await this.page.evaluate(() => {
                const createSvg = document.querySelector('svg[aria-label="Create"]');
                const loginForm = document.querySelector('input[name="username"], input[type="text"]');
                const bodyText = document.body.innerText;
                const hasLoginPrompt = bodyText.includes('Continue with Instagram') || bodyText.includes('Log in');
                return Boolean(createSvg) && !loginForm && !hasLoginPrompt;
            });

            if (isLoggedIn && !currentUrl.includes('/login')) {
                logger.info('[threads] Already logged in via Chrome profile');
                await this.saveCookies();
                return true;
            }

            logger.info('[threads] Not logged in, clicking "Continue with Instagram"...');

            // Step 1: Click "Continue with Instagram" or "Log in" button
            const clickedContinue = await this.page.evaluate(() => {
                const allClickables = document.querySelectorAll('div[role="button"], button, a, span');
                for (const el of allClickables) {
                    const text = (el.textContent || '').trim();
                    if (text === 'Continue with Instagram' || text === 'Log in') {
                        (el as HTMLElement).click();
                        return text;
                    }
                }
                // Also try the Instagram icon button
                const igIcon = document.querySelector('i[aria-label="Instagram"]');
                if (igIcon) {
                    const btn = igIcon.closest('div[role="button"]') || igIcon.closest('button') || igIcon.parentElement;
                    if (btn) { (btn as HTMLElement).click(); return 'instagram-icon'; }
                }
                return null;
            });

            if (clickedContinue) {
                logger.info(`[threads] Clicked: "${clickedContinue}"`);
            } else {
                logger.warn('[threads] Could not find "Continue with Instagram" button');
            }

            // Wait for the Instagram login form to appear (may redirect to instagram.com)
            await delay(5000);

            // Step 2: Check if we landed on Instagram login or if Threads shows its own form
            const pageUrl = this.page.url();
            logger.info(`[threads] Login page URL: ${pageUrl}`);

            // Wait for username input (works for both Threads and Instagram login forms)
            try {
                await this.page.waitForSelector('input[name="username"], input[type="text"], input[aria-label="Username"]', { timeout: 15000 });
            } catch {
                // Maybe already logged into Instagram — check if we got redirected back
                const afterUrl = this.page.url();
                if (!afterUrl.includes('/login') && !afterUrl.includes('/accounts/')) {
                    logger.info('[threads] Appears to be logged in after Instagram SSO redirect');
                    await this.saveCookies();
                    return true;
                }
                logger.error('[threads] Login form not found');
                return false;
            }

            await delay(1500);

            // Step 3: Fill Instagram credentials
            logger.info(`[threads] Filling Instagram credentials for @${igUsername}...`);

            // Clear and type username
            const usernameInput = await this.page.$('input[name="username"], input[type="text"], input[aria-label="Username"]');
            if (usernameInput) {
                await usernameInput.click({ clickCount: 3 });
                await delay(200);
                await usernameInput.type(igUsername, { delay: 80 });
            }
            await delay(500);

            // Clear and type password
            const passwordInput = await this.page.$('input[name="password"], input[type="password"]');
            if (passwordInput) {
                await passwordInput.click();
                await delay(200);
                await passwordInput.type(igPassword, { delay: 80 });
            }
            await delay(1000);

            // Step 4: Submit
            const submitBtn = await this.page.$('button[type="submit"], button._acan');
            if (submitBtn) {
                await submitBtn.click();
                logger.info('[threads] Clicked submit button');
            } else {
                await this.page.keyboard.press('Enter');
                logger.info('[threads] Pressed Enter to submit');
            }

            // Wait for login + redirect back to Threads
            logger.info('[threads] Waiting for Instagram SSO to complete...');
            await delay(15000);

            // Step 5: Dismiss popups (save login info, notifications, etc.)
            for (let attempt = 0; attempt < 3; attempt++) {
                const dismissed = await this.page.evaluate(() => {
                    const buttons = document.querySelectorAll('button, div[role="button"]');
                    for (const btn of buttons) {
                        const text = (btn.textContent || '').trim().toLowerCase();
                        if (text === 'not now' || text === 'skip' || text === 'later' || text === 'not now') {
                            (btn as HTMLElement).click();
                            return text;
                        }
                    }
                    return null;
                });
                if (dismissed) {
                    logger.info(`[threads] Dismissed popup: "${dismissed}"`);
                    await delay(3000);
                } else {
                    break;
                }
            }

            // Save cookies
            await this.saveCookies();

            // Step 6: Verify login
            // Navigate to Threads feed to confirm
            if (!this.page.url().includes('threads.net')) {
                await this.page.goto('https://www.threads.net/', { waitUntil: 'domcontentloaded', timeout: THREADS_TIMEOUT });
                await delay(4000);
            }

            const verified = await this.page.evaluate(() => {
                const createSvg = document.querySelector('svg[aria-label="Create"]');
                const bodyText = document.body.innerText;
                const stillNeedsLogin = bodyText.includes('Continue with Instagram') || bodyText.includes('Sign up');
                return Boolean(createSvg) && !stillNeedsLogin;
            });

            if (verified) {
                logger.info('[threads] Login successful via Instagram SSO');
                await this.saveCookies();
                return true;
            } else {
                logger.error('[threads] Login verification failed — may need manual 2FA');
                logger.info('[threads] Waiting 90s for manual 2FA completion...');
                await delay(90000);
                await this.saveCookies();
                // Check one more time
                const finalCheck = await this.page.evaluate(() => {
                    return Boolean(document.querySelector('svg[aria-label="Create"]'));
                });
                if (finalCheck) {
                    logger.info('[threads] Login confirmed after manual intervention');
                    return true;
                }
                logger.error('[threads] Login still failed after manual wait');
                return false;
            }
        } catch (error) {
            logger.error('[threads] Login error:', error);
            return false;
        }
    }

    async getFreshPage(): Promise<Page | null> {
        try {
            if (this.browser) {
                try {
                    const pages = await this.browser.pages();
                    if (pages.length > 0) {
                        const existing = pages[0] as Page;
                        this.page = existing;
                        await existing.bringToFront();
                        return existing;
                    }
                } catch (e) {
                    logger.debug(`[threads] Existing page reuse failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                try {
                    const newPage = await this.browser.newPage();
                    this.page = newPage;
                    await newPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36');
                    await this.loadCookies();
                    return newPage;
                } catch (e) {
                    logger.debug(`[threads] New page creation failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            // Browser dead — relaunch
            logger.info('[threads] Browser died, relaunching...');
            await this.initialize();
            return this.page;
        } catch (e) {
            logger.error(`[threads] Failed to get fresh page: ${e}`);
            return null;
        }
    }

    async close(): Promise<void> {
        try {
            if (this.browser) {
                await this.browser.close();
                this.browser = null;
                this.page = null;
            }
        } catch (e) {
            logger.error('[threads] Close error:', e);
        }
    }
}

// ── Topic Relevance Filter ─────────────────────────────────────────

const TECH_KEYWORDS = [
    // AI & ML
    'ai', 'artificial intelligence', 'machine learning', 'ml', 'llm', 'gpt',
    'claude', 'openai', 'anthropic', 'gemini', 'deep learning', 'neural',
    'transformer', 'diffusion', 'stable diffusion', 'midjourney',
    'chatbot', 'copilot', 'generative ai', 'computer vision', 'nlp',
    // Programming & Dev
    'coding', 'programming', 'developer', 'software', 'engineering',
    'python', 'javascript', 'typescript', 'rust', 'golang', 'java', 'c++',
    'swift', 'kotlin', 'ruby', 'php', 'scala', 'elixir',
    'frontend', 'backend', 'fullstack', 'full-stack', 'full stack',
    'web dev', 'web development', 'mobile dev', 'mobile app',
    'app developer', 'app development',
    // Frameworks & Tools
    'api', 'saas', 'startup', 'tech', 'automation', 'devops', 'cicd', 'ci/cd',
    'react', 'nextjs', 'next.js', 'vue', 'angular', 'svelte',
    'node', 'django', 'flask', 'spring boot', 'laravel',
    'tailwind', 'webpack', 'vite',
    // Cloud & Infra
    'cloud', 'aws', 'azure', 'gcp', 'docker', 'kubernetes',
    'terraform', 'ansible', 'jenkins', 'gitlab', 'vercel', 'netlify',
    'serverless', 'microservice', 'infrastructure',
    // Data
    'data science', 'data analyst', 'data engineering', 'analytics',
    'algorithm', 'open source', 'dataset', 'big data', 'etl', 'pipeline',
    'database', 'sql', 'nosql', 'mongodb', 'postgresql', 'redis',
    'github', 'vscode', 'linux', 'terminal', 'command line',
    // Crypto & Web3
    'crypto', 'blockchain', 'web3', 'defi', 'smart contract', 'solidity',
    // Security & Networking
    'cybersecurity', 'infosec', 'security', 'encryption', 'firewall',
    'ssl', 'tls', 'vpn', 'ipsec', 'ssh', 'https',
    'penetration testing', 'pentest', 'vulnerability', 'malware',
    'networking', 'dns', 'tcp', 'http', 'protocol',
    // Hardware & Systems
    'robotics', 'quantum', 'iot', 'internet of things', 'embedded',
    'compute', 'gpu', 'nvidia', 'chip', 'semiconductor', 'cpu', 'amd', 'intel',
    'raspberry pi', 'arduino', '3d print',
    // Platforms & OS
    'ios', 'android', 'macos', 'windows', 'ubuntu',
    'iphone', 'ipad', 'apple watch', 'pixel', 'samsung',
    'app store', 'play store', 'my app', 'an app', 'the app', 'your app',
    'built an app', 'launched an app', 'shipping an app', 'native app', 'web app',
    'chrome extension', 'browser extension',
    // Remote / hiring
    'remote work', 'remote job', 'work from home', 'hiring', 'tech hiring',
    // AI tooling
    'rag', 'fine-tuning', 'fine tuning', 'prompt engineering', 'agent', 'agentic',
    'langchain', 'vector database', 'embeddings',
    // Product & Startup
    'no-code', 'low-code', 'indie hacker', 'build in public',
    'product hunt', 'yc', 'y combinator', 'venture', 'funding',
    'saas', 'b2b', 'mrr', 'arr', 'bootstrapped',
    // Career & Industry
    'tech job', 'software engineer', 'dev job', 'tech interview',
    'leetcode', 'system design', 'roadmap',
];

const POLITICAL_KEYWORDS = [
    'democrat', 'republican', 'trump', 'biden', 'harris', 'maga',
    'liberal', 'conservative', 'left-wing', 'right-wing', 'woke',
    'abortion', 'gun control', 'immigration policy', 'border wall',
    'congress', 'senate vote', 'impeach', 'partisan',
    'election fraud', 'stolen election', 'political party',
    'socialism', 'communism', 'fascism', 'marxism',
    'fox news', 'msnbc', 'cnn politics', 'capitol',
    'supreme court ruling', 'roe v wade', 'second amendment',
    'red state', 'blue state', 'swing state', 'ballot',
    'political', 'politician', 'legislation', 'lobby'
];

// Short keywords (<=3 chars) need word-boundary matching to avoid false positives
// e.g. "ai" matching "available", "ml" matching "html"
const SHORT_KW_THRESHOLD = 3;

function matchesKeyword(text: string, keyword: string): boolean {
    if (keyword.length <= SHORT_KW_THRESHOLD) {
        // Use word-boundary regex for short keywords
        const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        return regex.test(text);
    }
    return text.includes(keyword);
}

export function isRelevantTechPost(postText: string): { relevant: boolean; reason: string } {
    const lower = postText.toLowerCase();

    // Check for political content first — reject immediately
    for (const kw of POLITICAL_KEYWORDS) {
        if (matchesKeyword(lower, kw)) {
            return { relevant: false, reason: `political_keyword:${kw}` };
        }
    }

    // Check for tech relevance
    for (const kw of TECH_KEYWORDS) {
        if (matchesKeyword(lower, kw)) {
            return { relevant: true, reason: `tech_keyword:${kw}` };
        }
    }

    return { relevant: false, reason: 'no_tech_keywords' };
}

// ── Comment Generation (Tech-focused, Isaiah's voice) ──────────────

async function generateThreadsComment(postText: string): Promise<string | null> {
    try {
        if (!postText || postText.length < 5) return null;

        let comment = await chatCompletion({
            messages: [
                {
                    role: 'system',
                    content: `You are Isaiah, a developer and tech enthusiast who comments on Threads. You reply as yourself — never explain your reasoning or thought process, never say "I think", "I believe", "in my opinion", "let me explain", "here's why", or anything meta. Just speak directly.

Your comment must ADD VALUE for anyone reading the thread. Pick ONE approach:
- Name a specific tool, library, or technique that's relevant
- Share a concrete example, stat, or real experience that builds on their point
- Offer a non-obvious take or contrarian perspective that makes people think
- Ask a sharp follow-up question that deepens the discussion

Rules:
- ONLY comment on tech, AI, software, startups, and related niche topics
- Be specific — name tools, frameworks, companies, stats, version numbers
- Keep it under 280 characters, natural and conversational
- Use 0-2 emojis max
- No hashtags, no self-promotion, no generic filler like "great post" or "love this"
- Sound like a knowledgeable person contributing, not a fan or a bot
- Match the energy — casual for casual, technical for technical`
                },
                {
                    role: 'user',
                    content: await (async () => {
                        let learning = '';
                        try {
                            const { getEngagementSummary } = await import('../tracking/commentTracker');
                            const summary = getEngagementSummary(7);
                            if (summary.totalChecked >= 5 && summary.topPerformers.length > 0) {
                                const examples = summary.topPerformers.slice(0, 2)
                                    .filter(c => c.platform === 'threads')
                                    .map(c => `"${c.commentText.slice(0, 80)}"`)
                                    .join(', ');
                                if (examples) learning = `\nYour best-performing comments recently: ${examples}. Match that style.\n`;
                            }
                        } catch (_) { /* no learnings */ }
                        return `Reply to this tech post as Isaiah:${learning}\n\n"${postText.slice(0, 500)}"\n\nReply:`;
                    })()
                }
            ],
            max_tokens: 120,
            temperature: 0.8
        });

        if (!comment) return null;

        // Clean up
        comment = comment.replace(/^["']|["']$/g, '').replace(/["*`#]/g, '').trim();
        if (comment.length > 280) comment = comment.slice(0, 277) + '...';
        if (comment.length < 3) return null;

        // Reject meta-commentary (AI explaining itself instead of commenting)
        const metaPhrases = [
            'i appreciate the post', 'i should clarify', 'this isn\'t really',
            'not really a tech', 'not a tech topic', 'i focus on',
            'as isaiah', 'outside my', 'not in my niche', 'i can\'t comment',
            'i don\'t see', 'no context', 'not provided', 'i apologize',
        ];
        const lowerComment = comment.toLowerCase();
        if (metaPhrases.some(p => lowerComment.includes(p))) {
            logger.warn(`[threads] Rejected meta-commentary: "${comment.slice(0, 60)}..."`);
            return null;
        }

        logger.info(`[threads] Generated comment: "${comment}"`);
        return comment;
    } catch (error) {
        logger.error('[threads] Comment generation failed:', error);
        return null;
    }
}

// ── Dismiss Threads popups ─────────────────────────────────────────

async function dismissPopups(page: Page, prefix: string = '[threads]'): Promise<void> {
    try {
        await page.evaluate(() => {
            const buttons = document.querySelectorAll('button, div[role="button"]');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim();
                if (text === 'Not now' || text === 'Not Now' || text === 'Dismiss') {
                    (btn as HTMLElement).click();
                    return;
                }
            }
        });
    } catch (e) {
        logger.debug(`[threads] Popup dismiss failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

// ── Find and interact with feed posts ──────────────────────────────

async function findFeedPosts(page: Page): Promise<string[]> {
    // Threads feed: collect post URLs from the feed
    const postUrls: string[] = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/post/"], a[href*="/@"]');
        const urls: string[] = [];
        const seen = new Set<string>();
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && href.includes('/post/') && !seen.has(href)) {
                // Skip /media, /liked_by, /comments sub-paths — only want the post page itself
                if (/\/post\/[A-Za-z0-9_-]+\/(media|liked_by|comments)/.test(href)) continue;
                seen.add(href);
                const fullUrl = href.startsWith('http') ? href : `https://www.threads.net${href}`;
                urls.push(fullUrl);
            }
        }
        return urls;
    });

    return postUrls;
}

// ── Post a reply on a Threads post page ────────────────────────────

async function postThreadsReply(page: Page, comment: string): Promise<boolean> {
    try {
        // Step 1: Click the Reply icon to open the reply composer
        // On logged-in Threads post pages, the icon is "Reply" (not "Comment")
        // On feed pages it may still be "Comment", so we try both
        const clicked = await page.evaluate(() => {
            const replySvg = document.querySelector('svg[aria-label="Reply"]')
                || document.querySelector('svg[aria-label="Comment"]');
            if (replySvg) {
                // Walk up to find clickable parent — prefer role="button" or <button> over plain DIV
                const clickable = replySvg.closest('div[role="button"], button');
                if (clickable) {
                    (clickable as HTMLElement).click();
                    return 'clicked';
                }
                // Fallback: walk up to first DIV parent
                let el: Element | null = replySvg.parentElement;
                while (el) {
                    if (el.tagName === 'DIV' || el.tagName === 'BUTTON') {
                        (el as HTMLElement).click();
                        return 'clicked';
                    }
                    el = el.parentElement;
                }
            }
            return 'not_found';
        });

        if (clicked === 'not_found') {
            logger.warn('[threads] No Reply/Comment icon found');
            return false;
        }

        // Step 2: Wait for the reply composer to appear (dialog or inline)
        await delay(3000);

        // Check if we got a "Sign up" / "Continue with Instagram" prompt instead of a textbox
        const dialogState = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            if (bodyText.includes('Sign up to chime in') || bodyText.includes('Continue with Instagram')) {
                return 'not_logged_in';
            }
            return 'ok';
        });

        if (dialogState === 'not_logged_in') {
            logger.error('[threads] Not logged in — "Sign up to chime in" prompt appeared');
            // Close the dialog
            await page.keyboard.press('Escape');
            await delay(500);
            return false;
        }

        // Step 3: Find the reply textbox
        const replySelectors = [
            'div[role="textbox"][contenteditable="true"]',
            'div[contenteditable="true"][data-lexical-editor="true"]',
            'div[contenteditable="true"]',
            'p[data-lexical-text="true"]',
        ];

        let replyBox = null;
        for (const sel of replySelectors) {
            const found = await page.$(sel);
            if (found) {
                const isVisible = await found.evaluate((el: Element) => {
                    const rect = el.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                });
                if (isVisible) {
                    replyBox = found;
                    logger.info(`[threads] Found reply box: ${sel}`);
                    break;
                }
            }
        }

        if (!replyBox) {
            // Sometimes the textbox takes a moment to render in the dialog
            await delay(2000);
            for (const sel of replySelectors) {
                const found = await page.$(sel);
                if (found) {
                    const isVisible = await found.evaluate((el: Element) => {
                        const rect = el.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    });
                    if (isVisible) {
                        replyBox = found;
                        logger.info(`[threads] Found reply box (2nd attempt): ${sel}`);
                        break;
                    }
                }
            }
        }

        if (!replyBox) {
            logger.warn('[threads] No reply textbox found after clicking Reply');
            // Close any open dialog
            await page.keyboard.press('Escape');
            await delay(500);
            return false;
        }

        // Step 4: Click the textbox to focus it
        await replyBox.click();
        await delay(500);

        // Step 5: Type the comment character by character
        await page.keyboard.type(comment, { delay: 30 });
        await delay(1000);

        // Step 6: Submit the reply
        // Find the "Post" button using page.$$ and click with Puppeteer (real mouse events)
        // On Threads, the submit button says "Post" — "Reply" is the icon that opens the dialog
        let submitted = false;

        // Debug: log all visible buttons to understand the DOM
        const debugButtons = await page.$$('div[role="button"], button');
        const buttonTexts: string[] = [];
        for (const btn of debugButtons) {
            try {
                const info = await btn.evaluate((el) => {
                    const text = (el.textContent || '').trim();
                    const rect = el.getBoundingClientRect();
                    return { text: text.slice(0, 30), visible: rect.width > 0 && rect.height > 0, w: rect.width, h: rect.height };
                });
                if (info.visible && info.text) buttonTexts.push(info.text);
            } catch (e) {
                logger.debug(`[threads] Button eval failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        logger.info(`[threads] Visible buttons after typing: ${JSON.stringify(buttonTexts)}`);

        // Try "Post" first (the submit button in the composer)
        const allButtons = await page.$$('div[role="button"], button');
        for (const btn of allButtons) {
            try {
                const info = await btn.evaluate((el) => {
                    const text = (el.textContent || '').trim().toLowerCase();
                    const rect = el.getBoundingClientRect();
                    return { text, visible: rect.width > 0 && rect.height > 0 };
                });
                if (info.text === 'post' && info.visible) {
                    logger.info(`[threads] Clicking "Post" button with Puppeteer`);
                    await btn.click();
                    submitted = true;
                    break;
                }
            } catch (e) {
                logger.debug(`[threads] Post button eval failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // If no "Post" button, try "Reply" button that's near the textbox (not the icon)
        if (!submitted) {
            for (const btn of allButtons) {
                try {
                    const info = await btn.evaluate((el) => {
                        const text = (el.textContent || '').trim().toLowerCase();
                        const rect = el.getBoundingClientRect();
                        // Check if this button is near a textbox (inside a dialog/form, not the feed icon)
                        const dialog = el.closest('[role="dialog"]');
                        const form = el.closest('form');
                        return { text, visible: rect.width > 0 && rect.height > 0, inDialog: !!dialog, inForm: !!form };
                    });
                    if (info.text === 'reply' && info.visible && (info.inDialog || info.inForm)) {
                        logger.info(`[threads] Clicking "Reply" button in dialog with Puppeteer`);
                        await btn.click();
                        submitted = true;
                        break;
                    }
                } catch (e) {
                    logger.debug(`[threads] Reply button eval failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }

        if (!submitted) {
            // Fallback: try Ctrl+Enter
            logger.info('[threads] Post/Reply button not found, trying Ctrl+Enter');
            await page.keyboard.down('Control');
            await page.keyboard.press('Enter');
            await page.keyboard.up('Control');
        }

        await delay(3000);
        logger.info('[threads] Reply submitted');
        return true;
    } catch (error) {
        logger.error('[threads] Reply failed:', error);
        return false;
    }
}

// ── Verify a comment was posted ────────────────────────────────────

async function verifyReply(page: Page, comment: string, username: string): Promise<boolean> {
    try {
        // Wait for the dialog to close and any toast/error to appear
        await delay(3000);

        const result = await page.evaluate((commentText: string, botUser: string) => {
            const bodyText = document.body.innerText;
            const bodyLower = bodyText.toLowerCase();

            // Check for error indicators first (strongest negative signal)
            const errorPhrases = [
                "couldn't post", 'try again', 'action blocked',
                'something went wrong', 'this action was blocked',
                'we restrict certain activity', 'temporarily blocked',
                'failed to post', "can't reply"
            ];
            const hasError = errorPhrases.some(t => bodyLower.includes(t));
            if (hasError) return { verified: false, reason: 'error_banner' };

            // Check for toast/snackbar confirmation (Threads shows these briefly)
            // Look for toast elements that might contain confirmation text
            const toasts = document.querySelectorAll('[role="alert"], [role="status"], [data-testid*="toast"], [class*="toast"], [class*="snackbar"], [class*="Toast"], [class*="Snackbar"]');
            for (const toast of toasts) {
                const toastText = (toast.textContent || '').toLowerCase();
                if (toastText.includes('posted') || toastText.includes('replied') || toastText.includes('sent') || toastText.includes('success')) {
                    return { verified: true, reason: 'toast_confirmation' };
                }
            }

            // Check if the reply composer textbox still has our text (not submitted = failed)
            const textboxes = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
            const snippet = commentText.slice(0, 30);
            for (const tb of textboxes) {
                const text = (tb.textContent || '').trim();
                if (text.includes(snippet)) {
                    return { verified: false, reason: 'text_still_in_textbox' };
                }
            }

            // Check if reply dialog is gone (no textboxes at all = dialog closed = submitted)
            if (textboxes.length === 0) {
                return { verified: true, reason: 'dialog_closed' };
            }

            // Check if all textboxes are empty (comment was consumed by submit)
            const allEmpty = Array.from(textboxes).every(tb => (tb.textContent || '').trim() === '');
            if (allEmpty) {
                return { verified: true, reason: 'textbox_cleared' };
            }

            // Check if our comment text appears in the page as a posted comment
            // Look near our bot username to confirm it's OUR posted comment, not just in the prompt
            const commentElements = document.querySelectorAll('[data-testid*="reply"], [class*="reply"], article, [role="article"]');
            for (const el of commentElements) {
                const elText = el.textContent || '';
                if (elText.includes(snippet) && (elText.toLowerCase().includes(botUser.toLowerCase()) || elText.includes(commentText.slice(0, 50)))) {
                    return { verified: true, reason: 'comment_visible_in_dom' };
                }
            }

            // Fallback: check full body for our comment snippet (less reliable but catches edge cases)
            // Only if textboxes don't contain it (already checked above)
            if (bodyText.includes(snippet)) {
                return { verified: true, reason: 'comment_in_body' };
            }

            return { verified: false, reason: 'unknown' };
        }, comment, username);

        logger.info(`[threads] verify reply: ${result.verified ? '✅' : '❌'} (${result.reason})`);
        return result.verified;
    } catch (e) {
        logger.warn('[threads] verify reply error:', e);
        return false;
    }
}

// ── Main batch function: run a feed commenting session ─────────────

export async function runThreadsBatch(
    username: string,
    targetPosts: number = 10
): Promise<{ commentsPosted: number; session: SessionLog }> {
    const threadsAI = new ThreadsAI();
    const session = createSession();
    let commentsPosted = 0;

    try {
        await threadsAI.initialize();
        const loggedIn = await threadsAI.ensureLoggedIn();
        if (!loggedIn) throw new Error('Failed to log in to Threads');

        let page = threadsAI.getPage()!;

        // Custom feed URL (e.g. a tech-focused Threads group) or fallback to search
        const CUSTOM_FEED_URL = process.env.THREADS_CUSTOM_FEED_URL || 'https://www.threads.com/custom_feed/18115229170663013';

        // Fallback search topics if custom feed fails
        const TECH_SEARCH_TOPICS = [
            'artificial intelligence', 'machine learning', 'software engineering',
            'AI agents', 'startup tech', 'web development', 'LLM',
            'developer tools', 'open source', 'coding', 'python programming',
            'cloud computing', 'cybersecurity', 'data science', 'devops',
            'react nextjs', 'automation', 'GPT Claude', 'indie hacker',
            'build in public', 'saas', 'tech startup'
        ];

        // Try custom feed first, fall back to search
        let feedSource = 'custom_feed';
        logger.info(`[threads] Starting tech-focused batch, target: ${targetPosts} posts`);
        logger.info(`[threads] Navigating to custom feed: ${CUSTOM_FEED_URL}`);

        await page.goto(CUSTOM_FEED_URL, {
            waitUntil: 'domcontentloaded', timeout: THREADS_TIMEOUT
        });
        await delay(4000);
        await dismissPopups(page);

        // Check if the custom feed loaded posts — if not, fall back to search
        const initialPosts = await findFeedPosts(page);
        if (initialPosts.length === 0) {
            const searchTopic = TECH_SEARCH_TOPICS[Math.floor(Math.random() * TECH_SEARCH_TOPICS.length)];
            const searchUrl = `https://www.threads.net/search?q=${encodeURIComponent(searchTopic)}&serp_type=default`;
            feedSource = `search:${searchTopic}`;
            logger.info(`[threads] Custom feed empty, falling back to search: "${searchTopic}"`);
            await page.goto(searchUrl, {
                waitUntil: 'domcontentloaded', timeout: THREADS_TIMEOUT
            });
            await delay(4000);
            await dismissPopups(page);
        }
        logger.info(`[threads] Feed source: ${feedSource}`);

        // Collect post URLs by scrolling the feed
        let postUrls: string[] = [];
        let scrollAttempts = 0;
        const maxScrolls = 20;

        while (postUrls.length < targetPosts && scrollAttempts < maxScrolls) {
            const urls = await findFeedPosts(page);
            const prevCount = postUrls.length;
            const urlSet = new Set(postUrls);
            for (const url of urls) urlSet.add(url);
            postUrls = [...urlSet];

            if (postUrls.length === prevCount) {
                scrollAttempts++;
                if (scrollAttempts >= 5) break;
            } else {
                scrollAttempts = 0;
            }

            logger.info(`[threads] Scroll: ${postUrls.length}/${targetPosts} posts collected`);
            await page.evaluate(() => window.scrollBy(0, 1200));
            await randomDelay(2000, 3500);
            await dismissPopups(page);
        }

        logger.info(`[threads] Collected ${postUrls.length} post URLs`);

        if (postUrls.length === 0) {
            logger.warn('[threads] No posts found in feed');
            return { commentsPosted: 0, session };
        }

        // Process each post
        const processedUrls = new Set<string>();

        for (let i = 0; i < Math.min(postUrls.length, targetPosts); i++) {
            const postUrl = postUrls[i];

            try {
                if (processedUrls.has(postUrl)) {
                    session.postsSkippedDuplicate++;
                    continue;
                }
                processedUrls.add(postUrl);

                // Check if we already commented on this post in a previous session
                const previousComment = hasCommentedOnPost(postUrl);
                if (previousComment) {
                    logger.info(`[threads] SKIP (already commented) ${postUrl}`);
                    session.postsSkippedDuplicate++;
                    continue;
                }

                logger.info(`[threads] Processing ${i + 1}/${Math.min(postUrls.length, targetPosts)}: ${postUrl}`);

                // Open a fresh tab for each post to avoid stale page state after commenting
                // The previous tab's SPA state can block navigations
                try {
                    const browser = (threadsAI as any).browser;
                    if (browser) {
                        // Close old page (ignore errors if already closed)
                        try { await page.close(); } catch (e) { logger.debug(`[threads] Page close failed: ${e instanceof Error ? e.message : String(e)}`); }
                        const newPage = await browser.newPage();
                        newPage.setDefaultNavigationTimeout(THREADS_TIMEOUT);
                        newPage.setDefaultTimeout(THREADS_TIMEOUT);
                        page = newPage;
                        (threadsAI as any).page = newPage;
                    }
                } catch (e) {
                    logger.warn(`[threads] Failed to create fresh tab: ${e}`);
                    // Fall back to recovery
                    const freshPage = await threadsAI.getFreshPage();
                    if (freshPage) {
                        page = freshPage;
                    } else {
                        logger.error('[threads] Cannot recover page, stopping batch');
                        break;
                    }
                }

                // Navigate to post — use domcontentloaded instead of networkidle2
                // because Threads keeps long-running network requests that cause timeouts
                await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: THREADS_TIMEOUT });
                await delay(3000 + Math.random() * 2000);

                // Dismiss browser notification prompt and any Threads popups
                try {
                    // Handle Chrome's "Enable notifications" permission dialog
                    const client = await page.createCDPSession();
                    await client.send('Browser.grantPermissions', {
                        permissions: ['notifications'],
                        origin: 'https://www.threads.net'
                    });
                    await client.detach();
                } catch (e) {
                    logger.debug(`[threads] CDP notification grant failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                await dismissPopups(page);

                session.postsProcessed++;

                // Extract username from the URL (reliable — DOM selectors pick up nav bar)
                const urlMatch = postUrl.match(/@([^/]+)/);
                const postAuthor = urlMatch ? urlMatch[1] : 'unknown';

                // Extract post text
                const meta = await page.evaluate((authorUsername: string) => {
                    const username = ''; // extracted from URL above instead

                    // Post text: look for text content in the post
                    let postText = '';
                    const textElements = document.querySelectorAll(
                        'span[dir="auto"], div[dir="auto"], div[data-pressable-container="true"] span'
                    );
                    for (const el of textElements) {
                        const text = (el.textContent || '').trim();
                        if (text.length > 10 && text.length < 3000) {
                            const lower = text.toLowerCase();
                            // Skip UI elements
                            const isUI = ['log in', 'sign up', 'suggested', 'follow', 'likes', 'replies'].some(
                                s => lower === s || (lower.length < 20 && lower.startsWith(s))
                            );
                            if (isUI) continue;
                            // Skip text that is just the author's username (with optional "Verified" suffix)
                            const cleaned = text.replace(/Verified\s*$/, '').replace(/\s*\d+[wdhms]\s*$/, '').trim();
                            if (cleaned.toLowerCase() === authorUsername.toLowerCase()) continue;
                            // Skip if text starts with username followed by time indicator (e.g. "username 2w")
                            if (lower.startsWith(authorUsername.toLowerCase())) continue;
                            postText = text;
                            break;
                        }
                    }

                    // Like status
                    const hasLikeBtn = Boolean(document.querySelector('svg[aria-label="Like"]'));
                    const alreadyLiked = Boolean(document.querySelector('svg[aria-label="Unlike"]'));

                    return { username, postText, hasLikeBtn, alreadyLiked };
                }, postAuthor);

                // Extract hashtags from post text
                const hashtags = (meta.postText || '').match(/#\w+/g)?.map((h: string) => h.slice(1).toLowerCase()) || [];

                if (!meta.postText) {
                    logger.warn(`[threads] No post text found, skipping`);
                    session.postsSkippedOther++;
                    await saveThreadsPost({
                        post_url: postUrl, author_username: postAuthor,
                        post_text: null, hashtags, our_comment: null,
                        comment_verified: false, liked: false,
                        skipped: true, skip_reason: 'no_text',
                        session_id: session.sessionId, metadata: {}
                    });
                    continue;
                }

                // Topic filter: only engage with tech/AI posts, skip political content
                const relevance = isRelevantTechPost(meta.postText);
                if (!relevance.relevant) {
                    logger.info(`[threads] SKIP (not tech) @${postAuthor} — ${relevance.reason}: "${meta.postText.slice(0, 60)}..."`);
                    session.postsSkippedOther++;
                    await saveThreadsPost({
                        post_url: postUrl, author_username: postAuthor,
                        post_text: meta.postText, hashtags, our_comment: null,
                        comment_verified: false, liked: false,
                        skipped: true, skip_reason: `topic_filter:${relevance.reason}`,
                        session_id: session.sessionId, metadata: {}
                    });
                    continue;
                }
                logger.info(`[threads] Topic match: ${relevance.reason}`);

                // Skip own posts
                const botUser = (process.env.INSTAGRAM_BOT_USERNAME || process.env.THREADS_BOT_USERNAME || '').toLowerCase().replace(/[@/]/g, '');
                if (botUser && postAuthor.toLowerCase().replace(/[@/]/g, '') === botUser) {
                    logger.info(`[threads] SKIP (own post) @${postAuthor}`);
                    session.postsSkippedOther++;
                    await saveThreadsPost({
                        post_url: postUrl, author_username: postAuthor,
                        post_text: meta.postText, hashtags, our_comment: null,
                        comment_verified: false, liked: false,
                        skipped: true, skip_reason: 'own_post',
                        session_id: session.sessionId, metadata: {}
                    });
                    continue;
                }

                logger.info(`[threads] @${postAuthor}: "${meta.postText.slice(0, 80)}..."`);

                // Like the post
                let didLike = false;
                if (meta.hasLikeBtn && !meta.alreadyLiked) {
                    didLike = await page.evaluate(() => {
                        const svg = document.querySelector('svg[aria-label="Like"]');
                        if (svg) {
                            const btn = svg.closest('button') || svg.closest('div[role="button"]') || svg.parentElement;
                            if (btn) { (btn as HTMLElement).click(); return true; }
                        }
                        return false;
                    });
                    if (didLike) {
                        await delay(1500);
                        logger.info('[threads] Liked post');
                    }
                }

                // Generate AI comment
                const comment = await generateThreadsComment(meta.postText);
                if (!comment) {
                    logger.warn('[threads] Failed to generate comment');
                    session.commentsFailed++;
                    await saveThreadsPost({
                        post_url: postUrl, author_username: postAuthor,
                        post_text: meta.postText, hashtags, our_comment: null,
                        comment_verified: false, liked: !meta.alreadyLiked && meta.hasLikeBtn,
                        skipped: true, skip_reason: 'comment_gen_failed',
                        session_id: session.sessionId, metadata: {}
                    });
                    continue;
                }

                // Post the reply
                const posted = await postThreadsReply(page, comment);
                if (!posted) {
                    logger.warn('[threads] Failed to post reply');
                    session.commentsFailed++;
                    await saveThreadsPost({
                        post_url: postUrl, author_username: postAuthor,
                        post_text: meta.postText, hashtags, our_comment: comment,
                        comment_verified: false, liked: !meta.alreadyLiked && meta.hasLikeBtn,
                        skipped: false, skip_reason: 'reply_failed',
                        session_id: session.sessionId, metadata: {}
                    });
                    continue;
                }

                // Verify
                await delay(2000);
                const verified = await verifyReply(page, comment, username);

                const tracked: TrackedComment = {
                    postUrl,
                    postUsername: postAuthor,
                    commentText: comment,
                    timestamp: new Date().toISOString(),
                    verified,
                    sessionId: session.sessionId,
                    captionSnippet: meta.postText.slice(0, 100),
                    liked: didLike || meta.alreadyLiked
                };

                // Persist to local tracker (enables duplicate prevention + daily counts)
                trackComment(tracked);

                session.commentsPosted++;
                if (verified) session.commentsVerified++;
                if (didLike) session.likesPosted++;
                session.comments.push(tracked);
                commentsPosted++;

                logger.info(`[threads] Comment ${commentsPosted} on @${postAuthor} verified=${verified}`);

                // Save to Supabase for market research
                await saveThreadsPost({
                    post_url: postUrl, author_username: postAuthor,
                    post_text: meta.postText, hashtags,
                    our_comment: comment, comment_verified: verified,
                    liked: true, skipped: false, skip_reason: null,
                    session_id: session.sessionId,
                    metadata: { alreadyLiked: meta.alreadyLiked }
                });

                // Human-like delay
                await randomDelay(4000, 8000);

            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                logger.error(`[threads] Error on ${postUrl}: ${errMsg}`);
                session.errors.push(errMsg);
                session.commentsFailed++;

                if (errMsg.includes('detached Frame') || errMsg.includes('Session closed') || errMsg.includes('Target closed')) {
                    logger.info('[threads] Frame detached — recovering...');
                    const freshPage = await threadsAI.getFreshPage();
                    if (freshPage) {
                        page = freshPage;
                    } else {
                        break;
                    }
                }
            }
        }

        logger.info(`[threads] Batch complete: ${commentsPosted} comments`);

    } catch (error: any) {
        session.errors.push(error?.message || 'Unknown error');
        logger.error('[threads] Fatal error in batch:', error);
    } finally {
        await threadsAI.close();
        saveSession(session);
        updateDailyStats(session);
    }

    return { commentsPosted, session };
}
