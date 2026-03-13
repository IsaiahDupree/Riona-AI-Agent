import { Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { ProfileInfo } from '../types/dm';
import * as fs from 'fs';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const PROFILES_DIR = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'profiles');

function ensureDir() {
    if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// ── Scrape a user's Instagram profile ────────────────────────────────

export async function scrapeProfile(page: Page, username: string): Promise<ProfileInfo> {
    logger.info(`[profile] Scraping @${username}...`);

    // Check cache first (profiles don't change often)
    const cached = loadCachedProfile(username);
    if (cached && isRecent(cached._cachedAt, 24)) {
        logger.info(`[profile] Using cached profile for @${username}`);
        return cached;
    }

    await page.goto(`https://www.instagram.com/${username}/`, {
        waitUntil: 'domcontentloaded', timeout: 60000
    });
    await delay(3000);

    const profile = await page.evaluate((user: string) => {
        const result: any = {
            username: user,
            fullName: '',
            bio: '',
            followerCount: 0,
            followingCount: 0,
            postCount: 0,
            isVerified: false,
            niche: '',
            recentCaptions: [] as string[],
            externalUrl: '',
            category: ''
        };

        // Full name — usually in a span or header
        const headerSection = document.querySelector('header');
        if (headerSection) {
            const spans = headerSection.querySelectorAll('span');
            for (const span of spans) {
                const text = span.textContent?.trim() || '';
                // The display name is usually a larger, bold span
                // Skip pure numbers (post/follower counts) and short numeric strings
                if (text.length > 0 && text.length < 60 && text !== user && !/^[\d,.]+[KMB]?$/.test(text)) {
                    const style = window.getComputedStyle(span);
                    const weight = parseInt(style.fontWeight) || 0;
                    if (weight >= 600 || style.fontWeight === 'bold') {
                        result.fullName = text;
                        break;
                    }
                }
            }
        }

        // Stats (posts, followers, following) — in the meta section or header
        const metaEl = document.querySelector('meta[name="description"]');
        if (metaEl) {
            const content = metaEl.getAttribute('content') || '';
            // Format: "123 Followers, 456 Following, 78 Posts - ..."
            const followersMatch = content.match(/([\d,.]+[KMB]?)\s*Followers/i);
            const followingMatch = content.match(/([\d,.]+[KMB]?)\s*Following/i);
            const postsMatch = content.match(/([\d,.]+[KMB]?)\s*Posts/i);

            if (followersMatch) result.followerCount = parseCount(followersMatch[1]);
            if (followingMatch) result.followingCount = parseCount(followingMatch[1]);
            if (postsMatch) result.postCount = parseCount(postsMatch[1]);
        }

        // Fallback: parse from visible text
        if (result.followerCount === 0) {
            const allText = document.body.innerText;
            const statsMatch = allText.match(/([\d,.]+)\s*posts\s*([\d,.]+[KMB]?)\s*followers\s*([\d,.]+[KMB]?)\s*following/i);
            if (statsMatch) {
                result.postCount = parseCount(statsMatch[1]);
                result.followerCount = parseCount(statsMatch[2]);
                result.followingCount = parseCount(statsMatch[3]);
            }
        }

        // Bio
        const bioSection = document.querySelector('div.-vDIg span, section span[dir="auto"]');
        if (!bioSection) {
            // Fallback: look in the header area for bio-like text
            const mainContent = document.querySelector('main')?.innerText || '';
            const lines = mainContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            // Bio is typically after the stats and before posts grid
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line.length > 20 && line.length < 500 &&
                    !line.includes('posts') && !line.includes('followers') &&
                    !line.includes('following') && !line.includes('Follow') &&
                    !line.includes('Message') && !line.includes('Suggested')) {
                    result.bio = line;
                    break;
                }
            }
        } else {
            result.bio = bioSection.textContent?.trim() || '';
        }

        // Verified badge
        result.isVerified = !!document.querySelector('svg[aria-label="Verified"]');

        // Category label (e.g. "Digital Creator", "Entrepreneur")
        const categoryEl = document.querySelector('div[class*="category"]');
        if (categoryEl) {
            result.category = categoryEl.textContent?.trim() || '';
        }

        // External URL
        const linkEl = document.querySelector('a[href*="l.instagram.com"]') ||
            document.querySelector('a[rel="me nofollow noopener noreferrer"]');
        if (linkEl) {
            result.externalUrl = (linkEl as HTMLAnchorElement).href || linkEl.textContent?.trim() || '';
        }

        function parseCount(str: string): number {
            if (!str) return 0;
            str = str.replace(/,/g, '');
            const multiplier = str.match(/[KMB]$/i);
            let num = parseFloat(str);
            if (multiplier) {
                const m = multiplier[0].toUpperCase();
                if (m === 'K') num *= 1000;
                else if (m === 'M') num *= 1000000;
                else if (m === 'B') num *= 1000000000;
            }
            return Math.round(num);
        }

        return result;
    }, username);

    // Cache the profile
    cacheProfile(username, profile);
    logger.info(`[profile] @${username}: ${profile.fullName}, ${profile.followerCount} followers, bio: "${profile.bio?.slice(0, 50)}..."`);
    return profile;
}

// ── Scrape our own profile (for AI context) ──────────────────────────

export async function scrapeOurProfile(page: Page): Promise<ProfileInfo> {
    const username = process.env.INSTAGRAM_BOT_USERNAME || 'the_isaiah_dupree';
    return scrapeProfile(page, username);
}

// ── Profile cache ────────────────────────────────────────────────────

function loadCachedProfile(username: string): (ProfileInfo & { _cachedAt?: string }) | null {
    try {
        ensureDir();
        const filePath = path.join(PROFILES_DIR, `${username.toLowerCase()}.json`);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) { logger.warn('[profile] Failed to load cached profile: ' + formatError(e)); }
    return null;
}

function cacheProfile(username: string, profile: ProfileInfo) {
    try {
        ensureDir();
        const filePath = path.join(PROFILES_DIR, `${username.toLowerCase()}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ ...profile, _cachedAt: new Date().toISOString() }, null, 2));
    } catch (e) { logger.warn('[profile] Failed to cache profile: ' + formatError(e)); }
}

function isRecent(dateStr: string | undefined, hours: number): boolean {
    if (!dateStr) return false;
    const diff = Date.now() - new Date(dateStr).getTime();
    return diff < hours * 60 * 60 * 1000;
}

// ── Load all cached profiles ─────────────────────────────────────────

export function getAllCachedProfiles(): Record<string, ProfileInfo> {
    try {
        ensureDir();
        const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
        const profiles: Record<string, ProfileInfo> = {};
        for (const f of files) {
            const data = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
            profiles[data.username] = data;
        }
        return profiles;
    } catch (e) { logger.warn('[profile] Failed to load all cached profiles: ' + formatError(e)); }
    return {};
}
