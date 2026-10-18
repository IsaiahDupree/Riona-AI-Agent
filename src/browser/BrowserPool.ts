/**
 * BrowserPool — singleton browser manager per Chrome profile
 *
 * Manages one Puppeteer browser per profile key. Operations that need a browser
 * acquire a lease, use it, and release it. Operations for the same profile queue
 * up automatically (mutex per profile). Different profiles run in parallel.
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';
import { logger } from '../utils/logger';
import { eventBus, EVENTS } from '../services/EventBus';
import type { ServiceId } from '../services/ServiceState';
import { SERVICE_PROFILES } from '../services/ServiceState';
import * as path from 'path';
import * as fs from 'fs';

puppeteer.use(StealthPlugin());

export type ProfileKey = ServiceId;

export interface BrowserInstance {
    browser: Browser;
    page: Page;
    status: 'idle' | 'busy' | 'launching' | 'closing';
    owner: string | null;        // who currently holds the lease
    lastUsed: number;
    launchedAt: number;
    profileDir: string;
    pageRecoveries: number;
}

export interface BrowserLease {
    page: Page;
    profileKey: ProfileKey;
    release: () => void;
}

interface QueuedOperation {
    resolve: (lease: BrowserLease) => void;
    reject: (error: Error) => void;
    owner: string;
    queuedAt: number;
}

const CHROME_PATH = process.env.CHROME_PATH ||
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

class BrowserPoolImpl {
    private instances = new Map<ProfileKey, BrowserInstance>();
    private queues = new Map<ProfileKey, QueuedOperation[]>();
    private shutdownRequested = false;

    /**
     * Acquire a browser lease for a profile. If the browser isn't running,
     * it will be launched. If another operation holds the lease, this call
     * queues and waits.
     */
    async acquire(profileKey: ProfileKey, owner: string = 'unknown'): Promise<BrowserLease> {
        if (this.shutdownRequested) {
            throw new Error('BrowserPool is shutting down');
        }

        const instance = this.instances.get(profileKey);

        // Browser exists and is idle — grant lease immediately
        if (instance && instance.status === 'idle') {
            return this.grantLease(profileKey, instance, owner);
        }

        // Browser exists but busy — queue
        if (instance && (instance.status === 'busy' || instance.status === 'launching')) {
            return this.enqueue(profileKey, owner);
        }

        // No browser — launch one
        return this.launchAndGrant(profileKey, owner);
    }

    /**
     * Get current status of all browser instances
     */
    getStatus(): Record<ProfileKey, { status: string; owner: string | null; queueLength: number; uptime: number; pageRecoveries: number } | null> {
        const result: any = {};
        const allKeys: ProfileKey[] = ['instagram-feed', 'instagram-dm', 'threads', 'twitter-feed', 'twitter-dm'];

        for (const key of allKeys) {
            const instance = this.instances.get(key);
            const queue = this.queues.get(key) || [];
            if (instance) {
                result[key] = {
                    status: instance.status,
                    owner: instance.owner,
                    queueLength: queue.length,
                    uptime: Date.now() - instance.launchedAt,
                    pageRecoveries: instance.pageRecoveries,
                };
            } else {
                result[key] = null;
            }
        }
        return result;
    }

    /**
     * Check if a browser is alive and responsive
     */
    async healthCheck(profileKey: ProfileKey): Promise<{ alive: boolean; url?: string; responsive?: boolean }> {
        const instance = this.instances.get(profileKey);
        if (!instance) return { alive: false };

        try {
            const url = instance.page.url();
            // Quick responsiveness check
            await instance.page.evaluate(() => document.readyState);
            return { alive: true, url, responsive: true };
        } catch {
            return { alive: true, responsive: false };
        }
    }

    /**
     * Take a screenshot of the current page
     */
    async screenshot(profileKey: ProfileKey): Promise<Buffer | null> {
        const instance = this.instances.get(profileKey);
        if (!instance || instance.status === 'closing') return null;

        try {
            return await instance.page.screenshot({ fullPage: false }) as Buffer;
        } catch {
            return null;
        }
    }

    /**
     * Navigate a browser to a URL (must not be currently leased)
     */
    async navigate(profileKey: ProfileKey, url: string): Promise<boolean> {
        const instance = this.instances.get(profileKey);
        if (!instance || instance.status !== 'idle') return false;

        try {
            instance.status = 'busy';
            instance.owner = 'navigate';
            await instance.page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
            return true;
        } catch {
            return false;
        } finally {
            instance.status = 'idle';
            instance.owner = null;
        }
    }

    /**
     * Close a specific browser instance
     */
    async close(profileKey: ProfileKey): Promise<void> {
        const instance = this.instances.get(profileKey);
        if (!instance) return;

        instance.status = 'closing';
        eventBus.emit(EVENTS.BROWSER_STATUS_CHANGE, { profileKey, status: 'closing' });

        // Reject all queued operations
        const queue = this.queues.get(profileKey) || [];
        for (const op of queue) {
            op.reject(new Error(`Browser ${profileKey} is closing`));
        }
        this.queues.set(profileKey, []);

        try {
            await instance.browser.close();
        } catch (e) {
            logger.warn(`[browser-pool] Error closing ${profileKey}: ${e instanceof Error ? e.message : String(e)}`);
        }

        this.instances.delete(profileKey);
        eventBus.emit(EVENTS.BROWSER_STATUS_CHANGE, { profileKey, status: 'closed' });
        logger.info(`[browser-pool] Closed ${profileKey}`);
    }

    /**
     * Shut down all browsers
     */
    async shutdownAll(): Promise<void> {
        this.shutdownRequested = true;
        const keys = Array.from(this.instances.keys());
        await Promise.all(keys.map(k => this.close(k)));
        logger.info('[browser-pool] All browsers shut down');
    }

    /**
     * Get the raw page for a profile (for passing to existing client classes)
     * Only use when you know the lease is held.
     */
    getPage(profileKey: ProfileKey): Page | null {
        return this.instances.get(profileKey)?.page || null;
    }

    // ── Internal ──────────────────────────────────────────────────────

    private async launchAndGrant(profileKey: ProfileKey, owner: string): Promise<BrowserLease> {
        const profileDir = this.resolveProfileDir(profileKey);

        // Mark as launching so subsequent acquire() calls queue
        const placeholder: BrowserInstance = {
            browser: null as any,
            page: null as any,
            status: 'launching',
            owner: null,
            lastUsed: Date.now(),
            launchedAt: Date.now(),
            profileDir,
            pageRecoveries: 0,
        };
        this.instances.set(profileKey, placeholder);
        eventBus.emit(EVENTS.BROWSER_STATUS_CHANGE, { profileKey, status: 'launching' });

        try {
            // Ensure profile dir exists
            if (!fs.existsSync(profileDir)) {
                fs.mkdirSync(profileDir, { recursive: true });
            }

            const browser = await puppeteer.launch({
                headless: false,
                executablePath: CHROME_PATH,
                userDataDir: profileDir,
                protocolTimeout: 180_000,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-infobars',
                    '--window-position=0,0',
                    '--ignore-certifcate-errors',
                    '--ignore-certifcate-errors-spki-list',
                    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    '--start-maximized',
                ],
            }) as Browser;

            const pages = await browser.pages();
            const page = pages.length > 0 ? pages[0] : await browser.newPage();

            const instance: BrowserInstance = {
                browser,
                page,
                status: 'idle',
                owner: null,
                lastUsed: Date.now(),
                launchedAt: Date.now(),
                profileDir,
                pageRecoveries: 0,
            };

            this.instances.set(profileKey, instance);
            eventBus.emit(EVENTS.BROWSER_STATUS_CHANGE, { profileKey, status: 'ready' });
            logger.info(`[browser-pool] Launched ${profileKey} (profile: ${path.basename(profileDir)})`);

            return this.grantLease(profileKey, instance, owner);
        } catch (error) {
            this.instances.delete(profileKey);
            eventBus.emit(EVENTS.BROWSER_STATUS_CHANGE, { profileKey, status: 'launch_failed' });

            // Reject queued operations
            const queue = this.queues.get(profileKey) || [];
            for (const op of queue) {
                op.reject(error instanceof Error ? error : new Error(String(error)));
            }
            this.queues.set(profileKey, []);

            throw error;
        }
    }

    private grantLease(profileKey: ProfileKey, instance: BrowserInstance, owner: string): BrowserLease {
        instance.status = 'busy';
        instance.owner = owner;
        instance.lastUsed = Date.now();

        const release = () => {
            instance.status = 'idle';
            instance.owner = null;
            instance.lastUsed = Date.now();

            // Process next queued operation
            const queue = this.queues.get(profileKey) || [];
            if (queue.length > 0) {
                const next = queue.shift()!;
                this.queues.set(profileKey, queue);
                try {
                    const lease = this.grantLease(profileKey, instance, next.owner);
                    next.resolve(lease);
                } catch (err) {
                    next.reject(err instanceof Error ? err : new Error(String(err)));
                }
            }
        };

        return { page: instance.page, profileKey, release };
    }

    private enqueue(profileKey: ProfileKey, owner: string): Promise<BrowserLease> {
        return new Promise((resolve, reject) => {
            const queue = this.queues.get(profileKey) || [];
            queue.push({ resolve, reject, owner, queuedAt: Date.now() });
            this.queues.set(profileKey, queue);
            logger.debug(`[browser-pool] Queued ${owner} for ${profileKey} (position: ${queue.length})`);
        });
    }

    private resolveProfileDir(profileKey: ProfileKey): string {
        const profileName = SERVICE_PROFILES[profileKey];
        return path.join(process.cwd(), profileName);
    }
}

// Singleton
export const browserPool = new BrowserPoolImpl();
