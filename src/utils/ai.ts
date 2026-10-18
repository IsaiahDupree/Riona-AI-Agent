/**
 * Shared AI client — wraps Anthropic Claude API via OAuth with OpenAI fallback.
 *
 * Auth chain:
 *   1. Claude via OAuth (primary — Claude Code credentials)
 *   2. Claude via ANTHROPIC_AUTH_TOKEN env var
 *   3. OpenAI via OPENAI_API_KEY env var (fallback when Claude fails)
 *
 * OAuth tokens auto-refresh when expiring within 5 minutes.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── OAuth types ──────────────────────────────────────────────────────

interface ClaudeOAuth {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
}

interface CredentialsFile {
    claudeAiOauth?: ClaudeOAuth;
}

// ── Constants ────────────────────────────────────────────────────────

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || '';

// Default models
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_FALLBACK_MODEL = 'gpt-4o-mini';

// ── Client cache ─────────────────────────────────────────────────────

let _client: Anthropic | null = null;
let _cachedToken: string = '';
let _openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI | null {
    if (_openaiClient) return _openaiClient;
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;
    _openaiClient = new OpenAI({ apiKey });
    return _openaiClient;
}

function makeOAuthClient(authToken: string): Anthropic {
    return new Anthropic({
        authToken,
        apiKey: null as any,
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    });
}

// ── Token refresh ────────────────────────────────────────────────────

async function refreshOAuthToken(oauth: ClaudeOAuth): Promise<ClaudeOAuth | null> {
    try {
        const resp = await fetch(REFRESH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: oauth.refreshToken,
            }),
        });

        if (!resp.ok) {
            logger.warn(`[ai] OAuth refresh failed: ${resp.status} ${resp.statusText}`);
            return null;
        }

        const data = await resp.json() as any;
        const refreshed: ClaudeOAuth = {
            accessToken: data.access_token,
            refreshToken: data.refresh_token || oauth.refreshToken,
            expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
            scopes: oauth.scopes,
            subscriptionType: oauth.subscriptionType,
            rateLimitTier: oauth.rateLimitTier,
        };

        // Write back to credentials file
        try {
            const creds: CredentialsFile = { claudeAiOauth: refreshed };
            fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
            logger.info('[ai] OAuth token refreshed and saved');
        } catch (e) {
            logger.warn(`[ai] Could not save refreshed token: ${(e as Error).message}`);
        }

        return refreshed;
    } catch (e) {
        logger.warn(`[ai] OAuth refresh error: ${(e as Error).message}`);
        return null;
    }
}

// ── Get client (async — with refresh) ────────────────────────────────

async function getClientAsync(): Promise<Anthropic> {
    // 1. Try OAuth from credentials file
    try {
        if (fs.existsSync(CREDENTIALS_PATH)) {
            const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
            const creds: CredentialsFile = JSON.parse(raw);
            const oauth = creds.claudeAiOauth;

            if (oauth?.accessToken) {
                // Refresh if expiring soon
                if (oauth.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
                    logger.info('[ai] OAuth token expiring soon, refreshing...');
                    const refreshed = await refreshOAuthToken(oauth);
                    if (refreshed) {
                        _cachedToken = refreshed.accessToken;
                        _client = makeOAuthClient(refreshed.accessToken);
                        return _client;
                    }
                    // Refresh failed but token might still work
                    if (oauth.expiresAt > Date.now()) {
                        _cachedToken = oauth.accessToken;
                        _client = makeOAuthClient(oauth.accessToken);
                        return _client;
                    }
                    logger.error('[ai] OAuth token expired and refresh failed');
                } else {
                    // Token is fresh
                    if (_client && _cachedToken === oauth.accessToken) return _client;
                    _cachedToken = oauth.accessToken;
                    _client = makeOAuthClient(oauth.accessToken);
                    return _client;
                }
            }
        }
    } catch (e) {
        logger.error(`[ai] Failed to read Claude credentials: ${(e as Error).message}`);
    }

    // 2. Try env var auth token
    if (ANTHROPIC_AUTH_TOKEN) {
        _client = makeOAuthClient(ANTHROPIC_AUTH_TOKEN);
        return _client;
    }

    // No API key fallback — OAuth only
    throw new Error('No OAuth credentials available. Run Claude Code to authenticate.');
}

// Synchronous version — uses cached token without refresh
function getClient(): Anthropic {
    if (_client) return _client;

    try {
        if (fs.existsSync(CREDENTIALS_PATH)) {
            const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
            const creds: CredentialsFile = JSON.parse(raw);
            const oauth = creds.claudeAiOauth;
            if (oauth?.accessToken && oauth.expiresAt > Date.now()) {
                _cachedToken = oauth.accessToken;
                _client = makeOAuthClient(oauth.accessToken);
                return _client;
            }
        }
    } catch { /* fall through */ }

    if (ANTHROPIC_AUTH_TOKEN) {
        _client = makeOAuthClient(ANTHROPIC_AUTH_TOKEN);
        return _client;
    }

    throw new Error('No OAuth credentials available. Run Claude Code to authenticate.');
}

// ── Public types ─────────────────────────────────────────────────────

export interface AIChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface AIChatOptions {
    model?: string;
    messages: AIChatMessage[];
    max_tokens?: number;
    temperature?: number;
}

// ── Chat completion ──────────────────────────────────────────────────

// ── OpenAI fallback completion ───────────────────────────────────────

async function openAICompletion(options: AIChatOptions): Promise<string> {
    const client = getOpenAIClient();
    if (!client) throw new Error('No OpenAI API key available for fallback');

    const response = await client.chat.completions.create({
        model: OPENAI_FALLBACK_MODEL,
        messages: options.messages.map(m => ({
            role: m.role,
            content: m.content,
        })),
        max_tokens: options.max_tokens || 150,
        temperature: options.temperature ?? 0.8,
    });

    return response.choices[0]?.message?.content?.trim() || '';
}

// ── Chat completion (Claude primary, OpenAI fallback) ───────────────

/**
 * Generate a chat completion. Tries Claude first, falls back to OpenAI
 * if Claude fails (OAuth expired, rate limit, network error).
 */
export async function chatCompletion(options: AIChatOptions): Promise<string> {
    // ── Try Claude first ────────────────────────────────────────────
    try {
        const client = await getClientAsync();
        const model = options.model || DEFAULT_MODEL;
        const maxTokens = options.max_tokens || 150;
        const temperature = options.temperature ?? 0.8;

        const systemMessages = options.messages.filter(m => m.role === 'system');
        const conversationMessages = options.messages.filter(m => m.role !== 'system');

        const claudeMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        for (const msg of conversationMessages) {
            claudeMessages.push({
                role: msg.role === 'assistant' ? 'assistant' : 'user',
                content: msg.content,
            });
        }

        if (claudeMessages.length === 0 || claudeMessages[0].role !== 'user') {
            claudeMessages.unshift({ role: 'user', content: 'Please respond.' });
        }

        const response = await client.messages.create({
            model,
            max_tokens: maxTokens,
            temperature,
            system: systemMessages.map(m => m.content).join('\n\n') || undefined,
            messages: claudeMessages,
        });

        const textBlock = response.content.find(b => b.type === 'text');
        return textBlock?.text || '';
    } catch (claudeError) {
        // ── Fall back to OpenAI ─────────────────────────────────────
        const errMsg = (claudeError as Error).message || String(claudeError);
        logger.warn(`[ai] Claude failed: ${errMsg} — falling back to OpenAI`);

        try {
            const result = await openAICompletion(options);
            logger.info(`[ai] OpenAI fallback succeeded`);
            return result;
        } catch (openaiError) {
            logger.error(`[ai] OpenAI fallback also failed: ${(openaiError as Error).message}`);
            // Re-throw the original Claude error since both failed
            throw claudeError;
        }
    }
}

export { getClient, getClientAsync, DEFAULT_MODEL, OPENAI_FALLBACK_MODEL };
