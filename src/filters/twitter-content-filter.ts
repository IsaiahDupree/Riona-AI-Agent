/**
 * Twitter Content Filter — Hard gates that run BEFORE any engagement.
 *
 * Flow:  post → language gate → geo gate → topic gate → risk gate → engage or skip
 *
 * Default action: SKIP.  Everything is deny-by-default.
 */

import { logger } from '../utils/logger';
import { safeReadJSON, safeWriteJSON } from '../utils/errors';
import * as path from 'path';
import * as fs from 'fs';

// ── Policy types ─────────────────────────────────────────────────────

export interface ContentFilterPolicy {
    geo_policy: {
        mode: 'allowlist_only';
        allowed_countries: string[];
        skip_if_unknown_country: boolean;
    };
    language_policy: {
        allowed_languages: string[];
        min_confidence: number;
        skip_if_mixed_language: boolean;
    };
    topic_policy: {
        blocked_topics: string[];
        skip_if_uncertain: boolean;
    };
    risk_policy: {
        skip_if_toxic: boolean;
        skip_if_controversial: boolean;
        skip_if_identity_sensitive: boolean;
    };
    blocked_accounts: string[];
    keyword_denylist: string[];
    default_action: 'skip' | 'allow';
}

export interface FilterResult {
    allowed: boolean;
    reason: string;
    gate: 'language' | 'geo' | 'topic' | 'risk' | 'account' | 'keyword' | 'passed';
    confidence: number;
}

// ── Default policy ───────────────────────────────────────────────────

const DEFAULT_POLICY: ContentFilterPolicy = {
    geo_policy: {
        mode: 'allowlist_only',
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'NZ'],
        skip_if_unknown_country: true,
    },
    language_policy: {
        allowed_languages: ['en'],
        min_confidence: 0.85,
        skip_if_mixed_language: true,
    },
    topic_policy: {
        blocked_topics: [
            'politics', 'elections', 'government_policy', 'geopolitics',
            'war', 'activism', 'religion_conflict', 'culture_war',
            'public_controversy',
        ],
        skip_if_uncertain: true,
    },
    risk_policy: {
        skip_if_toxic: true,
        skip_if_controversial: true,
        skip_if_identity_sensitive: true,
    },
    blocked_accounts: [
        // ── Politicians & Government ──
        'potus', 'vp', 'whitehouse', 'senatemajldr', 'speakerjohnson',
        'joebiden', 'kamalaharris', 'realdonaldtrump', 'barackobama',
        'hillaryclinton', 'berniesanders', 'aoc', 'tedcruz', 'marcorubio',
        'rondesantis', 'gavinnewsom', 'elonmusk',
        // ── News Outlets ──
        'caborrero', 'caborrerohd',
        'cnn', 'foxnews', 'msnbc', 'nytimes', 'washingtonpost',
        'baborrero', 'abc', 'nbcnews', 'cbsnews', 'reuters', 'ap',
        'bbcworld', 'bbcnews', 'nytpolitics', 'politico', 'thehill',
        'huffpost', 'braborrero', 'newsweek', 'usatoday', 'latimes',
        'nypost', 'dailymail', 'guardian', 'independent', 'axios',
        // ── Political Commentators ──
        'baborrero', 'taborrero',
        'benshapiro', 'charliekirk11', 'tomilahren', 'laurenboebert',
        'mtgreenee', 'ilhanmn', 'rashidatlaib', 'repjayapal',
        'seaborrero', 'tuckercarlson', 'hannity', 'inaborrero',
        'reaborrero', 'maborrero', 'jaborrero',
    ],
    keyword_denylist: [
        // ── Politics ──
        'president', 'senate', 'congress', 'republican', 'democrat',
        'gop', 'dnc', 'rnc', 'liberal', 'conservative', 'left wing',
        'right wing', 'maga', 'woke', 'antifa',
        // ── Elections ──
        'election', 'vote', 'ballot', 'campaign', 'primary',
        'electoral', 'caucus', 'swing state', 'poll numbers',
        // ── Geopolitics & War ──
        'gaza', 'ukraine', 'russia', 'putin', 'zelensky', 'hamas',
        'israel', 'palestine', 'nato', 'china threat', 'taiwan invasion',
        'north korea', 'iran nuclear', 'sanctions',
        // ── Immigration & Border ──
        'border wall', 'deportation', 'illegal immigrant', 'migrant caravan',
        'asylum seeker', 'immigration policy', 'daca', 'ice raids',
        // ── Social Issues ──
        'abortion', 'pro-life', 'pro-choice', 'roe v wade',
        'gun control', 'second amendment', '2nd amendment', 'mass shooting',
        'police brutality', 'defund the police', 'blm',
        'critical race theory', 'crt', 'dei', 'affirmative action',
        'white supremac', 'systemic racism',
        // ── Culture War ──
        'trans rights', 'gender ideology', 'drag queen', 'groomer',
        'woke agenda', 'cancel culture', 'book ban',
        // ── Government Policy ──
        'tariff', 'trade war', 'stimulus check', 'student loan forgiveness',
        'medicare for all', 'universal healthcare', 'green new deal',
        'supreme court', 'scotus', 'executive order', 'impeach',
        // ── Religion Conflict ──
        'islamophob', 'antisemit', 'christian nationalist', 'sharia',
        // ── Protest / Activism ──
        'protest', 'riot', 'insurrection', 'january 6', 'jan 6',
        'coup', 'martial law',
    ],
    default_action: 'skip',
};

// ── Policy loading ───────────────────────────────────────────────────

const POLICY_FILE = path.join(process.cwd(), 'logs', 'config', 'content-filter-policy.json');

let cachedPolicy: ContentFilterPolicy | null = null;

export function loadFilterPolicy(): ContentFilterPolicy {
    if (cachedPolicy) return cachedPolicy;
    const dir = path.dirname(POLICY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const loaded = safeReadJSON<ContentFilterPolicy | null>(POLICY_FILE, null, 'content_filter_policy');
    if (loaded) {
        cachedPolicy = loaded;
        return loaded;
    }
    // First run — save default policy
    safeWriteJSON(POLICY_FILE, DEFAULT_POLICY, 'content_filter_policy');
    cachedPolicy = DEFAULT_POLICY;
    return DEFAULT_POLICY;
}

export function reloadFilterPolicy(): ContentFilterPolicy {
    cachedPolicy = null;
    return loadFilterPolicy();
}

// ── Skip logging ─────────────────────────────────────────────────────

const SKIP_LOG_FILE = path.join(process.cwd(), 'logs', 'tracking', 'twitter', 'filter_skips.json');

interface SkipEntry {
    timestamp: string;
    gate: string;
    reason: string;
    author: string;
    textPreview: string;
}

let skipBuffer: SkipEntry[] = [];

function logSkip(gate: string, reason: string, author: string, text: string) {
    const entry: SkipEntry = {
        timestamp: new Date().toISOString(),
        gate,
        reason,
        author: author || 'unknown',
        textPreview: (text || '').slice(0, 120),
    };
    skipBuffer.push(entry);
    // Flush every 20 entries
    if (skipBuffer.length >= 20) flushSkipLog();
}

export function flushSkipLog() {
    if (skipBuffer.length === 0) return;
    try {
        const dir = path.dirname(SKIP_LOG_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const existing = safeReadJSON<SkipEntry[]>(SKIP_LOG_FILE, [], 'filter_skip_log');
        // Keep last 500 entries
        const combined = [...existing, ...skipBuffer].slice(-500);
        safeWriteJSON(SKIP_LOG_FILE, combined, 'filter_skip_log');
    } catch (e) {
        logger.debug(`[content-filter] Failed to flush skip log: ${e}`);
    }
    skipBuffer = [];
}

// ── Language detection (lightweight, no external deps) ────────────────

// Common English words for fast detection
const ENGLISH_MARKERS = new Set([
    'the', 'is', 'are', 'was', 'were', 'have', 'has', 'had', 'been',
    'will', 'would', 'could', 'should', 'can', 'may', 'might',
    'this', 'that', 'these', 'those', 'with', 'from', 'about',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'under', 'again', 'further', 'then', 'once', 'here',
    'there', 'when', 'where', 'why', 'how', 'all', 'each', 'every',
    'both', 'few', 'more', 'most', 'other', 'some', 'such', 'only',
    'same', 'than', 'very', 'just', 'because', 'but', 'and', 'not',
    'you', 'your', 'they', 'their', 'what', 'which', 'who', 'whom',
    'people', 'know', 'think', 'want', 'need', 'make', 'like',
    'time', 'year', 'also', 'back', 'work', 'first', 'even', 'new',
    'way', 'use', 'her', 'him', 'two', 'long', 'come', 'get', 'made',
]);

// Non-Latin scripts that clearly indicate non-English
const NON_LATIN_REGEX = /[\u0600-\u06FF\u0750-\u077F]|[\u4E00-\u9FFF\u3400-\u4DBF]|[\u3040-\u309F\u30A0-\u30FF]|[\uAC00-\uD7AF]|[\u0400-\u04FF]|[\u0E00-\u0E7F]|[\u0900-\u097F]|[\u0980-\u09FF]|[\u0A80-\u0AFF]|[\u0B00-\u0B7F]|[\u0C00-\u0C7F]|[\u0D00-\u0D7F]/g;

interface LanguageResult {
    isEnglish: boolean;
    confidence: number;
    isMixed: boolean;
}

function detectLanguage(text: string): LanguageResult {
    if (!text || text.trim().length === 0) {
        return { isEnglish: false, confidence: 0, isMixed: false };
    }

    // Strip URLs, mentions, hashtags for cleaner analysis
    const cleaned = text
        .replace(/https?:\/\/\S+/g, '')
        .replace(/@\w+/g, '')
        .replace(/#\w+/g, '')
        .trim();

    if (cleaned.length < 5) {
        // Too short to analyze meaningfully — treat as English if original had content
        return { isEnglish: text.length > 5, confidence: 0.5, isMixed: false };
    }

    // Check for non-Latin scripts
    const nonLatinMatches = cleaned.match(NON_LATIN_REGEX) || [];
    const nonLatinRatio = nonLatinMatches.length / cleaned.length;

    if (nonLatinRatio > 0.3) {
        const isMixed = nonLatinRatio < 0.7;
        return { isEnglish: false, confidence: 0.95, isMixed };
    }

    // Word-level English detection
    const words = cleaned.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    if (words.length === 0) return { isEnglish: false, confidence: 0, isMixed: false };

    let englishWords = 0;
    for (const word of words) {
        // Strip punctuation for matching
        const clean = word.replace(/[^a-z']/g, '');
        if (ENGLISH_MARKERS.has(clean)) englishWords++;
    }

    const englishRatio = englishWords / words.length;

    // High confidence English
    if (englishRatio >= 0.25 && nonLatinRatio < 0.05) {
        return { isEnglish: true, confidence: Math.min(0.95, 0.7 + englishRatio), isMixed: false };
    }

    // Mixed language
    if (englishRatio >= 0.15 && nonLatinRatio >= 0.05) {
        return { isEnglish: false, confidence: 0.7, isMixed: true };
    }

    // Check if text is mostly Latin characters (could be Spanish, French, etc.)
    const latinChars = cleaned.replace(/[^a-zA-ZÀ-ÿ]/g, '').length;
    const latinRatio = latinChars / cleaned.length;

    if (latinRatio > 0.7 && englishRatio < 0.15) {
        // Latin script but low English word match — likely another Latin-script language
        return { isEnglish: false, confidence: 0.8, isMixed: false };
    }

    // Default: allow if mostly Latin with some English markers
    if (englishRatio >= 0.1 && latinRatio > 0.8) {
        return { isEnglish: true, confidence: 0.6, isMixed: false };
    }

    return { isEnglish: false, confidence: 0.6, isMixed: false };
}

// ── Geo inference from tweet metadata ────────────────────────────────

// US timezone / locale signals from display name and tweet text
const US_LOCALE_SIGNALS = [
    /\b(EST|CST|MST|PST|EDT|CDT|MDT|PDT)\b/,
    /\b(eastern|central|mountain|pacific)\s+time\b/i,
    /\b(new york|los angeles|chicago|houston|phoenix|philadelphia|san antonio|san diego|dallas|san jose|austin|jacksonville|fort worth|columbus|charlotte|indianapolis|san francisco|seattle|denver|nashville|portland|las vegas|memphis|louisville|baltimore|milwaukee|albuquerque|tucson|fresno|sacramento|mesa|kansas city|atlanta|omaha|miami|tulsa|tampa|aurora|minneapolis|pittsburgh|detroit|boston|raleigh)\b/i,
    /\b(california|texas|florida|new york|illinois|pennsylvania|ohio|georgia|north carolina|michigan|new jersey|virginia|washington|arizona|tennessee|massachusetts|indiana|missouri|maryland|wisconsin|colorado|minnesota|south carolina|alabama|louisiana|kentucky|oregon|oklahoma|connecticut|utah|iowa|mississippi|arkansas|nevada|nebraska|idaho|hawaii)\b/i,
];

const FIVE_EYES_SIGNALS: Record<string, RegExp[]> = {
    CA: [/\b(toronto|vancouver|montreal|ottawa|calgary|edmonton|winnipeg|alberta|ontario|quebec|british columbia)\b/i],
    GB: [/\b(london|manchester|birmingham|leeds|liverpool|bristol|glasgow|edinburgh|cardiff|uk|britain|england|scotland|wales)\b/i],
    AU: [/\b(sydney|melbourne|brisbane|perth|adelaide|canberra|hobart|darwin|australia|aussie)\b/i],
    NZ: [/\b(auckland|wellington|christchurch|new zealand|kiwi)\b/i],
};

interface GeoResult {
    inferredCountry: string | null;
    confidence: number;
    signals: string[];
}

function inferGeo(text: string, displayName: string, username: string): GeoResult {
    const combined = `${text} ${displayName}`.toLowerCase();
    const signals: string[] = [];

    // Check US signals first
    for (const pattern of US_LOCALE_SIGNALS) {
        const match = combined.match(pattern);
        if (match) {
            signals.push(`US:${match[0]}`);
        }
    }
    if (signals.length > 0) {
        return { inferredCountry: 'US', confidence: 0.7 + Math.min(0.25, signals.length * 0.1), signals };
    }

    // Check Five Eyes allies
    for (const [country, patterns] of Object.entries(FIVE_EYES_SIGNALS)) {
        for (const pattern of patterns) {
            const match = combined.match(pattern);
            if (match) {
                signals.push(`${country}:${match[0]}`);
                return { inferredCountry: country, confidence: 0.7, signals };
            }
        }
    }

    // No geo signals — unknown
    return { inferredCountry: null, confidence: 0, signals: [] };
}

// ── Topic classification ─────────────────────────────────────────────

interface TopicResult {
    isBlocked: boolean;
    matchedTopic: string | null;
    matchedKeywords: string[];
    confidence: number;
}

function classifyTopic(text: string, policy: ContentFilterPolicy): TopicResult {
    const lower = text.toLowerCase();
    const matchedKeywords: string[] = [];

    // Keyword denylist — exact substring match
    for (const keyword of policy.keyword_denylist) {
        if (lower.includes(keyword.toLowerCase())) {
            matchedKeywords.push(keyword);
        }
    }

    if (matchedKeywords.length >= 2) {
        return {
            isBlocked: true,
            matchedTopic: 'multiple_keyword_matches',
            matchedKeywords,
            confidence: 0.95,
        };
    }

    if (matchedKeywords.length === 1) {
        // Single keyword match — could be false positive, but still block with moderate confidence
        return {
            isBlocked: true,
            matchedTopic: 'keyword_match',
            matchedKeywords,
            confidence: 0.8,
        };
    }

    return { isBlocked: false, matchedTopic: null, matchedKeywords: [], confidence: 0.9 };
}

// ── Risk scoring ─────────────────────────────────────────────────────

const TOXIC_PATTERNS = [
    /\b(stfu|gtfo|kys|kill\s+yourself|die\s+in)\b/i,
    /\b(idiot|moron|stupid|dumb\s*ass|retard)/i,
    /\bf+[u*]+c*k/i,
    /\bn+[i1]+g+[e3]*r/i,
];

const CONTROVERSIAL_PATTERNS = [
    /\bwake\s+up\s+sheeple\b/i,
    /\bconspiracy\b/i,
    /\bplandemic\b/i,
    /\bgreat\s+reset\b/i,
    /\bdeep\s+state\b/i,
    /\bnew\s+world\s+order\b/i,
    /\bfalse\s+flag\b/i,
    /\bcontrolled\s+opposition\b/i,
];

interface RiskResult {
    isToxic: boolean;
    isControversial: boolean;
    isIdentitySensitive: boolean;
}

function scoreRisk(text: string): RiskResult {
    const isToxic = TOXIC_PATTERNS.some(p => p.test(text));
    const isControversial = CONTROVERSIAL_PATTERNS.some(p => p.test(text));

    // Identity-sensitive: mentions specific racial/ethnic/gender groups in charged context
    const identityTerms = /\b(white people|black people|all men|all women|immigrants are|muslims are|jews are|christians are)\b/i;
    const isIdentitySensitive = identityTerms.test(text);

    return { isToxic, isControversial, isIdentitySensitive };
}

// ── Main filter function ─────────────────────────────────────────────

/**
 * Run the full content filter pipeline on a tweet.
 * Returns whether to engage or skip, with reason logging.
 *
 * Call this BEFORE generateReply / postReply / likeTweet.
 */
export function filterTweet(
    text: string,
    username: string,
    displayName: string = '',
): FilterResult {
    const policy = loadFilterPolicy();

    // ── Gate 1: Blocked accounts ──
    const lowerUser = (username || '').toLowerCase().replace(/^@/, '');
    if (policy.blocked_accounts.includes(lowerUser)) {
        const result: FilterResult = {
            allowed: false,
            reason: `Blocked account: @${lowerUser}`,
            gate: 'account',
            confidence: 1.0,
        };
        logSkip('account', result.reason, lowerUser, text);
        return result;
    }

    // ── Gate 2: Language ──
    const lang = detectLanguage(text);

    if (!lang.isEnglish && lang.confidence >= policy.language_policy.min_confidence) {
        const result: FilterResult = {
            allowed: false,
            reason: `Non-English content (confidence: ${(lang.confidence * 100).toFixed(0)}%)`,
            gate: 'language',
            confidence: lang.confidence,
        };
        logSkip('language', result.reason, lowerUser, text);
        return result;
    }

    if (lang.isMixed && policy.language_policy.skip_if_mixed_language) {
        const result: FilterResult = {
            allowed: false,
            reason: 'Mixed language content',
            gate: 'language',
            confidence: lang.confidence,
        };
        logSkip('language', result.reason, lowerUser, text);
        return result;
    }

    if (!lang.isEnglish && lang.confidence < policy.language_policy.min_confidence) {
        // Low confidence — fail closed
        const result: FilterResult = {
            allowed: false,
            reason: `Language uncertain (confidence: ${(lang.confidence * 100).toFixed(0)}%, threshold: ${(policy.language_policy.min_confidence * 100).toFixed(0)}%)`,
            gate: 'language',
            confidence: lang.confidence,
        };
        logSkip('language', result.reason, lowerUser, text);
        return result;
    }

    // ── Gate 3: Keyword denylist & topic ──
    const topic = classifyTopic(text, policy);

    if (topic.isBlocked) {
        const result: FilterResult = {
            allowed: false,
            reason: `Blocked topic: ${topic.matchedTopic} [${topic.matchedKeywords.join(', ')}]`,
            gate: 'topic',
            confidence: topic.confidence,
        };
        logSkip('topic', result.reason, lowerUser, text);
        return result;
    }

    // ── Gate 4: Risk scoring ──
    const risk = scoreRisk(text);

    if (risk.isToxic && policy.risk_policy.skip_if_toxic) {
        const result: FilterResult = {
            allowed: false,
            reason: 'Toxic content detected',
            gate: 'risk',
            confidence: 0.9,
        };
        logSkip('risk', result.reason, lowerUser, text);
        return result;
    }

    if (risk.isControversial && policy.risk_policy.skip_if_controversial) {
        const result: FilterResult = {
            allowed: false,
            reason: 'Controversial content detected',
            gate: 'risk',
            confidence: 0.85,
        };
        logSkip('risk', result.reason, lowerUser, text);
        return result;
    }

    if (risk.isIdentitySensitive && policy.risk_policy.skip_if_identity_sensitive) {
        const result: FilterResult = {
            allowed: false,
            reason: 'Identity-sensitive content detected',
            gate: 'risk',
            confidence: 0.8,
        };
        logSkip('risk', result.reason, lowerUser, text);
        return result;
    }

    // ── Gate 5: Geo inference (soft gate — skip only if non-allowed country detected) ──
    const geo = inferGeo(text, displayName, username);

    // Only apply geo gate if we have a clear non-allowed country signal
    // Most tweets won't have geo signals — we allow those through (English already verified)
    if (geo.inferredCountry && !policy.geo_policy.allowed_countries.includes(geo.inferredCountry)) {
        const result: FilterResult = {
            allowed: false,
            reason: `Non-allowed country: ${geo.inferredCountry} (signals: ${geo.signals.join(', ')})`,
            gate: 'geo',
            confidence: geo.confidence,
        };
        logSkip('geo', result.reason, lowerUser, text);
        return result;
    }

    // ── All gates passed ──
    return {
        allowed: true,
        reason: 'All filters passed',
        gate: 'passed',
        confidence: 1.0,
    };
}

// ── Stats helper ─────────────────────────────────────────────────────

export function getFilterStats(): { total: number; byGate: Record<string, number> } {
    const entries = safeReadJSON<SkipEntry[]>(SKIP_LOG_FILE, [], 'filter_skip_log');
    const today = new Date().toISOString().slice(0, 10);
    const todayEntries = entries.filter(e => e.timestamp.startsWith(today));

    const byGate: Record<string, number> = {};
    for (const entry of todayEntries) {
        byGate[entry.gate] = (byGate[entry.gate] || 0) + 1;
    }

    return { total: todayEntries.length, byGate };
}
