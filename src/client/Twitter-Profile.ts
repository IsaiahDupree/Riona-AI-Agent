import { Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';
import { syncTwitterProfileToSupabase } from '../db/supabaseTwitterDM';
import { ProfileInfo } from '../types/dm';
import * as fs from 'fs';
import * as path from 'path';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
const PROFILES_DIR = path.join(process.cwd(), 'logs', 'tracking', 'twitter-dm', 'profiles');

function ensureDir() {
    if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// ── Scrape a user's Twitter/X profile ────────────────────────────────

export async function scrapeTwitterProfile(page: Page, username: string): Promise<ProfileInfo> {
    logger.info(`[twitter-profile] Scraping @${username}...`);

    // Check cache first (profiles don't change often)
    const cached = loadCachedProfile(username);
    if (cached && isRecent(cached._cachedAt, 24)) {
        logger.info(`[twitter-profile] Using cached profile for @${username}`);
        return cached;
    }

    await page.goto(`https://x.com/${username}`, {
        waitUntil: 'domcontentloaded', timeout: 60000
    });
    await delay(3000);

    const profile = await page.evaluate((user: string) => {
        const parseCount = (s: string): number => {
            if (!s) return 0;
            s = s.replace(/,/g, '');
            const multiplier = s.match(/[KMB]$/i);
            let num = parseFloat(s);
            if (multiplier) {
                const m = multiplier[0].toUpperCase();
                if (m === 'K') num *= 1000;
                else if (m === 'M') num *= 1000000;
                else if (m === 'B') num *= 1000000000;
            }
            return Math.round(num);
        };

        const result: any = {
            username: user,
            fullName: '',
            bio: '',
            followerCount: 0,
            followingCount: 0,
            postCount: 0,
            isVerified: false,
            niche: '',
            externalUrl: '',
            category: ''
        };

        // Display name from UserName testid
        const userNameEl = document.querySelector('div[data-testid="UserName"]');
        if (userNameEl) {
            const spans = userNameEl.querySelectorAll('span');
            for (const span of spans) {
                const text = span.textContent?.trim() || '';
                if (text.length > 0 && !text.startsWith('@') && text !== user &&
                    !/^[\d,.]+[KMB]?$/.test(text) && text.length < 60) {
                    const style = window.getComputedStyle(span);
                    const weight = parseInt(style.fontWeight) || 0;
                    if (weight >= 600 || style.fontWeight === 'bold') {
                        result.fullName = text;
                        break;
                    }
                }
            }
            // Fallback: first non-@ span
            if (!result.fullName) {
                for (const span of spans) {
                    const text = span.textContent?.trim() || '';
                    if (text.length > 0 && !text.startsWith('@') && text.length < 60) {
                        result.fullName = text;
                        break;
                    }
                }
            }
        }

        // Bio from UserDescription
        const bioEl = document.querySelector('div[data-testid="UserDescription"]');
        if (bioEl) {
            result.bio = bioEl.textContent?.trim() || '';
        }

        // Follower/following counts from profile links
        const followerLinks = [
            document.querySelector('a[href$="/verified_followers"]'),
            document.querySelector('a[href$="/followers"]')
        ];
        for (const link of followerLinks) {
            if (link) {
                const text = link.textContent?.trim() || '';
                const match = text.match(/([\d,.]+[KMB]?)/i);
                if (match) {
                    result.followerCount = parseCount(match[1]);
                    break;
                }
            }
        }

        const followingLink = document.querySelector('a[href$="/following"]');
        if (followingLink) {
            const text = followingLink.textContent?.trim() || '';
            const match = text.match(/([\d,.]+[KMB]?)/i);
            if (match) {
                result.followingCount = parseCount(match[1]);
            }
        }

        // Verified badge
        result.isVerified = !!(
            document.querySelector('svg[aria-label="Verified account"]') ||
            document.querySelector('svg[data-testid="icon-verified"]') ||
            document.querySelector('[data-testid="UserName"] svg[aria-label*="erified"]')
        );

        // External URL
        const urlEl = document.querySelector('a[data-testid="UserUrl"]');
        if (urlEl) {
            result.externalUrl = (urlEl as HTMLAnchorElement).href || urlEl.textContent?.trim() || '';
        }

        // Post count — try to find in the nav or header stats
        // Twitter shows "X posts" in the header area
        const headerEl = document.querySelector('div[data-testid="UserName"]')?.closest('div[data-testid="primaryColumn"]');
        if (headerEl) {
            const headerText = (headerEl as HTMLElement).innerText || '';
            const postsMatch = headerText.match(/([\d,.]+[KMB]?)\s*posts?/i);
            if (postsMatch) {
                result.postCount = parseCount(postsMatch[1]);
            }
        }

        // Category — sometimes shown under the name
        const categoryEl = document.querySelector('div[data-testid="UserProfileHeader_Items"] span');
        if (categoryEl) {
            const text = categoryEl.textContent?.trim() || '';
            if (text && !text.startsWith('http') && !text.includes('Joined')) {
                result.category = text;
            }
        }

        return result;
    }, username);

    // Cache the profile
    cacheProfile(username, profile);

    // Sync to Supabase (fire-and-forget)
    syncTwitterProfileToSupabase(username, profile).catch(() => {});

    logger.info(`[twitter-profile] @${username}: ${profile.fullName}, ${profile.followerCount} followers, bio: "${profile.bio?.slice(0, 50)}..."`);
    return profile;
}

// ── Scrape our own profile (for AI context) ──────────────────────────

export async function scrapeOurTwitterProfile(page: Page): Promise<ProfileInfo> {
    const username = process.env.TWITTER_BOT_USERNAME || '';
    if (!username) {
        logger.warn('[twitter-profile] TWITTER_BOT_USERNAME not set');
        return {
            username: 'unknown',
            fullName: '',
            bio: '',
            followerCount: 0,
            followingCount: 0,
            postCount: 0,
            isVerified: false
        };
    }
    return scrapeTwitterProfile(page, username);
}

// ── Profile cache ────────────────────────────────────────────────────

function loadCachedProfile(username: string): (ProfileInfo & { _cachedAt?: string }) | null {
    try {
        ensureDir();
        const filePath = path.join(PROFILES_DIR, `${username.toLowerCase()}.json`);
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) { logger.warn('[twitter-profile] Failed to load cached profile: ' + formatError(e)); }
    return null;
}

function cacheProfile(username: string, profile: ProfileInfo) {
    try {
        ensureDir();
        const filePath = path.join(PROFILES_DIR, `${username.toLowerCase()}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ ...profile, _cachedAt: new Date().toISOString() }, null, 2));
    } catch (e) { logger.warn('[twitter-profile] Failed to cache profile: ' + formatError(e)); }
}

function isRecent(dateStr: string | undefined, hours: number): boolean {
    if (!dateStr) return false;
    const diff = Date.now() - new Date(dateStr).getTime();
    return diff < hours * 60 * 60 * 1000;
}

// ── Load all cached profiles ─────────────────────────────────────────

export function getAllCachedTwitterProfiles(): Record<string, ProfileInfo> {
    try {
        ensureDir();
        const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.json'));
        const profiles: Record<string, ProfileInfo> = {};
        for (const f of files) {
            const data = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
            profiles[data.username] = data;
        }
        return profiles;
    } catch (e) { logger.warn('[twitter-profile] Failed to load all cached profiles: ' + formatError(e)); }
    return {};
}
