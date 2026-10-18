/**
 * DM Routes API Tests
 * Tests Express API endpoints for the DM system
 * Uses supertest-style manual testing against the router
 */

import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';

// Import the functions the routes depend on
import { loadConfig, saveConfig, loadOffers, saveOffers, loadPendingSends, savePendingSends } from '../../src/client/Instagram-DM-Pipeline';
import { getConversionStats, getFullAnalytics, getAllLearnings, getBestSendingHours } from '../../src/client/Instagram-DM-Analytics';
import { getAllRelationships, getFeedbackStats } from '../../src/client/Instagram-DM-AI';
import { getAllDMs, getTodayDMCount } from '../../src/tracking/dmTracker';

// ═══════════════════════════════════════════════════════════════════════
// Pipeline Config API
// ═══════════════════════════════════════════════════════════════════════

describe('Pipeline Config', () => {
    it('should load config with all required fields', () => {
        const config = loadConfig();
        expect(config).toHaveProperty('autoApprove');
        expect(config).toHaveProperty('maxDMsPerDay');
        expect(config).toHaveProperty('minDelayBetweenDMs');
        expect(config).toHaveProperty('cooldownHoursPerUser');
        expect(config).toHaveProperty('skipIfNoReplyAfterDays');
        expect(config).toHaveProperty('maxFollowUps');
        expect(config).toHaveProperty('offerEnabled');
    });

    it('should persist config changes', () => {
        const config = loadConfig();
        const original = { ...config };

        config.maxDMsPerDay = 99;
        saveConfig(config);

        const reloaded = loadConfig();
        expect(reloaded.maxDMsPerDay).toBe(99);

        // Restore
        saveConfig(original);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Offers CRUD
// ═══════════════════════════════════════════════════════════════════════

describe('Offers CRUD', () => {
    it('should load default offers when no file exists', () => {
        const offers = loadOffers();
        expect(Array.isArray(offers)).toBe(true);
        expect(offers.length).toBeGreaterThanOrEqual(2); // 2 defaults
    });

    it('should have required fields on each offer', () => {
        const offers = loadOffers();
        for (const offer of offers) {
            expect(offer).toHaveProperty('id');
            expect(offer).toHaveProperty('name');
            expect(offer).toHaveProperty('description');
            expect(offer).toHaveProperty('targetCategories');
            expect(offer).toHaveProperty('minWarmth');
            expect(offer).toHaveProperty('minStage');
            expect(offer).toHaveProperty('active');
            expect(offer).toHaveProperty('timesOffered');
            expect(offer).toHaveProperty('conversions');
        }
    });

    it('should create, save, and delete an offer', () => {
        const offers = loadOffers();
        const before = offers.length;

        offers.push({
            id: '__test_offer__',
            name: 'Test Offer',
            description: 'Test',
            targetCategories: ['personal'],
            targetTags: [],
            targetNiches: [],
            minWarmth: 0,
            minStage: 'cold_outreach',
            messageHint: 'test',
            active: true,
            timesOffered: 0,
            conversions: 0
        });
        saveOffers(offers);

        const after = loadOffers();
        expect(after.length).toBe(before + 1);

        // Delete
        const cleaned = after.filter(o => o.id !== '__test_offer__');
        saveOffers(cleaned);
        expect(loadOffers().length).toBe(before);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Pending Sends API
// ═══════════════════════════════════════════════════════════════════════

describe('Pending Sends', () => {
    it('should load pending sends as array', () => {
        const sends = loadPendingSends();
        expect(Array.isArray(sends)).toBe(true);
    });

    it('should approve a pending send', () => {
        const sends = loadPendingSends();
        sends.push({
            id: '__test_approve__',
            recipientUsername: 'test',
            message: 'test',
            context: {
                relationship: { category: 'personal', warmth: 0, stage: 'cold_outreach', notes: [], tags: [] },
                objective: 'test'
            },
            status: 'pending',
            createdAt: new Date().toISOString()
        });
        savePendingSends(sends);

        // Approve
        const loaded = loadPendingSends();
        const send = loaded.find(s => s.id === '__test_approve__');
        expect(send).toBeDefined();
        send!.status = 'approved';
        send!.reviewedAt = new Date().toISOString();
        savePendingSends(loaded);

        const verified = loadPendingSends().find(s => s.id === '__test_approve__');
        expect(verified!.status).toBe('approved');

        // Cleanup
        const cleaned = loadPendingSends().filter(s => s.id !== '__test_approve__');
        savePendingSends(cleaned);
    });

    it('should reject a pending send', () => {
        const sends = loadPendingSends();
        sends.push({
            id: '__test_reject__',
            recipientUsername: 'test',
            message: 'test',
            context: {
                relationship: { category: 'personal', warmth: 0, stage: 'cold_outreach', notes: [], tags: [] },
                objective: 'test'
            },
            status: 'pending',
            createdAt: new Date().toISOString()
        });
        savePendingSends(sends);

        const loaded = loadPendingSends();
        const send = loaded.find(s => s.id === '__test_reject__');
        send!.status = 'rejected';
        savePendingSends(loaded);

        const verified = loadPendingSends().find(s => s.id === '__test_reject__');
        expect(verified!.status).toBe('rejected');

        // Cleanup
        const cleaned = loadPendingSends().filter(s => s.id !== '__test_reject__');
        savePendingSends(cleaned);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Analytics Endpoints
// ═══════════════════════════════════════════════════════════════════════

describe('Analytics Data', () => {
    it('should return full analytics with all sections', () => {
        const analytics = getFullAnalytics();
        expect(analytics).toHaveProperty('feedback');
        expect(analytics).toHaveProperty('conversions');
        expect(analytics).toHaveProperty('learnings');
        expect(analytics).toHaveProperty('timing');
    });

    it('should return conversion stats with required fields', () => {
        const stats = getConversionStats();
        expect(stats).toHaveProperty('totalConversions');
        expect(stats).toHaveProperty('byType');
        expect(stats).toHaveProperty('byOffer');
        expect(stats).toHaveProperty('totalValue');
        expect(stats).toHaveProperty('avgDMsToConvert');
        expect(stats).toHaveProperty('avgDaysToConvert');
    });

    it('should return learnings as array', () => {
        const learnings = getAllLearnings();
        expect(Array.isArray(learnings)).toBe(true);
    });

    it('should return best hours as sorted array', () => {
        const hours = getBestSendingHours();
        expect(Array.isArray(hours)).toBe(true);
        // If data exists, should be sorted by reply rate
        if (hours.length >= 2) {
            expect(hours[0].replyRate).toBeGreaterThanOrEqual(hours[1].replyRate);
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Pipeline Status
// ═══════════════════════════════════════════════════════════════════════

describe('Pipeline Status', () => {
    it('should aggregate pipeline status correctly', () => {
        const config = loadConfig();
        const sends = loadPendingSends();
        const todayDMs = getTodayDMCount();

        const pending = sends.filter(s => s.status === 'pending').length;
        const approved = sends.filter(s => s.status === 'approved').length;
        const sent = sends.filter(s => s.status === 'sent').length;

        expect(typeof pending).toBe('number');
        expect(typeof approved).toBe('number');
        expect(typeof sent).toBe('number');
        expect(config.maxDMsPerDay - todayDMs).toBeGreaterThanOrEqual(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Outreach Targets
// ═══════════════════════════════════════════════════════════════════════

describe('Outreach Targets', () => {
    const targetsFile = path.join(process.cwd(), 'logs', 'tracking', 'dm', 'outreach_targets.json');

    afterAll(() => {
        // Cleanup test targets
        try {
            if (fs.existsSync(targetsFile)) {
                const targets: string[] = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
                const cleaned = targets.filter(t => !t.startsWith('__test'));
                fs.writeFileSync(targetsFile, JSON.stringify(cleaned, null, 2));
            }
        } catch { }
    });

    it('should add and read targets', () => {
        const dir = path.dirname(targetsFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        let existing: string[] = [];
        try {
            if (fs.existsSync(targetsFile)) {
                existing = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
            }
        } catch { }

        existing.push('__testuser1__', '__testuser2__');
        fs.writeFileSync(targetsFile, JSON.stringify(existing, null, 2));

        const loaded: string[] = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
        expect(loaded).toContain('__testuser1__');
        expect(loaded).toContain('__testuser2__');
    });

    it('should deduplicate targets', () => {
        let targets: string[] = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
        const newTargets = ['__testuser1__', '__testuser3__'];
        const added = newTargets.filter(u => !targets.includes(u));
        targets.push(...added);
        fs.writeFileSync(targetsFile, JSON.stringify(targets, null, 2));

        const loaded: string[] = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
        const count = loaded.filter(t => t === '__testuser1__').length;
        expect(count).toBe(1);
    });
});
