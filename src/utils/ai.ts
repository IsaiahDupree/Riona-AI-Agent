/**
 * Shared AI client — wraps Anthropic Claude API via OAuth.
 *
 * Auth chain (no API key fallback):
 *   1. OAuth from Claude Code credentials (~/.claude/.credentials.json)
 *   2. ANTHROPIC_AUTH_TOKEN env var (Bearer token)
 *
 * OAuth tokens auto-refresh when expiring within 5 minutes.
 */
import Anthropic from '@anthropic-ai/sdk';
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

// Default model
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

// ── Client cache ─────────────────────────────────────────────────────

let _client: Anthropic | null = null;
let _cachedToken: string = '';

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

/**
 * Generate a chat completion using Claude via OAuth.
 * Accepts the same message format as OpenAI for easy migration.
 */
export async function chatCompletion(options: AIChatOptions): Promise<string> {
    const client = await getClientAsync();
    const model = options.model || DEFAULT_MODEL;
    const maxTokens = options.max_tokens || 150;
    const temperature = options.temperature ?? 0.8;

    // Separate system message from conversation messages
    const systemMessages = options.messages.filter(m => m.role === 'system');
    const conversationMessages = options.messages.filter(m => m.role !== 'system');

    // Claude requires alternating user/assistant messages starting with user
    const claudeMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const msg of conversationMessages) {
        claudeMessages.push({
            role: msg.role === 'assistant' ? 'assistant' : 'user',
            content: msg.content,
        });
    }

    // Ensure we start with a user message
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

    // Extract text from response
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock?.text || '';
}

export { getClient, getClientAsync, DEFAULT_MODEL };
