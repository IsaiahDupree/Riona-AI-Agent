/**
 * Twitter Brand Identity & Offers Config
 * Centralized brand voice, niche, and CTA configuration loaded per scheduler run.
 */

import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';
import * as path from 'path';
import * as fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ override: true });

// ── Interfaces ──────────────────────────────────────────────────────

export interface OfferReference {
    id: string;
    name: string;
    description: string;
    link?: string;
    type: 'product' | 'service' | 'lead_magnet' | 'community';
}

export interface BrandIdentity {
    name: string;
    handle: string;
    niche: string;
    subNiches: string[];
    voice: string;
    valueProps: string[];
    targetAudience: string;
    offers: OfferReference[];
    cta: {
        soft: string;
        medium: string;
        hard: string;
    };
}

// ── File path ───────────────────────────────────────────────────────

const BRAND_FILE = path.join(process.cwd(), 'logs', 'config', 'brand-identity.json');

function ensureConfigDir() {
    const dir = path.dirname(BRAND_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Default brand from env vars ─────────────────────────────────────

export function getDefaultBrandIdentity(): BrandIdentity {
    const niches = (process.env.TWITTER_NICHE_HASHTAGS || 'AI,technology').split(',').map(s => s.trim()).filter(Boolean);
    return {
        name: process.env.TWITTER_BRAND_NAME || process.env.TWITTER_BOT_USERNAME || 'Riona',
        handle: `@${process.env.TWITTER_BOT_USERNAME || 'unknown'}`,
        niche: niches[0] || 'AI & tech',
        subNiches: niches.slice(1),
        voice: process.env.TWITTER_BRAND_VOICE || 'Confident, approachable, data-driven',
        valueProps: (process.env.TWITTER_VALUE_PROPS || 'AI-powered growth tools,Social media automation').split(',').map(s => s.trim()),
        targetAudience: process.env.TWITTER_TARGET_AUDIENCE || 'Tech founders, content creators, digital marketers',
        offers: [],
        cta: {
            soft: process.env.TWITTER_CTA_SOFT || 'DM me if you want to chat about this',
            medium: process.env.TWITTER_CTA_MEDIUM || 'I built a tool that does this — link in bio',
            hard: process.env.TWITTER_CTA_HARD || 'Check it out — link in bio',
        }
    };
}

// ── Load / Save ─────────────────────────────────────────────────────

export function loadBrandIdentity(): BrandIdentity {
    ensureConfigDir();
    const saved = safeReadJSON<BrandIdentity | null>(BRAND_FILE, null, 'brand_identity');
    if (saved) return saved;
    const defaults = getDefaultBrandIdentity();
    saveBrandIdentity(defaults);
    return defaults;
}

export function saveBrandIdentity(brand: BrandIdentity): void {
    ensureConfigDir();
    if (!safeWriteJSON(BRAND_FILE, brand, 'brand_identity')) {
        logger.warn('[twitter-brand] Failed to save brand identity');
    }
}

// ── Format for AI system prompts ────────────────────────────────────

export function getBrandPromptContext(brand?: BrandIdentity): string {
    const b = brand || loadBrandIdentity();
    const allNiches = [b.niche, ...b.subNiches].filter(Boolean).join(', ');

    return [
        `You are ${b.name} (${b.handle}), a voice in the ${allNiches} space on Twitter/X.`,
        `Tone: ${b.voice}.`,
        `Value props: ${b.valueProps.join('; ')}.`,
        `Target audience: ${b.targetAudience}.`,
    ].join(' ');
}

export function getOfferContext(brand: BrandIdentity, offerId?: string): string | null {
    if (!offerId || brand.offers.length === 0) return null;
    const offer = brand.offers.find(o => o.id === offerId);
    if (!offer) return null;

    return `Promote "${offer.name}" naturally: ${offer.description}${offer.link ? ` (${offer.link})` : ''}. ` +
        `Weave it into the tweet organically — share a story about building it or a result it achieved. ` +
        `Not a hard sell. Use a soft CTA like: "${brand.cta.soft}" or "${brand.cta.medium}".`;
}
