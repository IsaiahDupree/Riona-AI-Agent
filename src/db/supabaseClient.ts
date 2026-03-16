/**
 * Shared Supabase Client — Single client instance used by all sync modules.
 * Eliminates duplicate client creation across supabaseDM, supabaseTwitterDM,
 * supabaseNurture, supabaseTwitterContent, and supabaseSync.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger';
import { formatError } from '../utils/errors';

let sharedClient: SupabaseClient | null = null;

/**
 * Returns a shared Supabase client singleton.
 * Returns null if SUPABASE_URL or SUPABASE_KEY are not configured.
 */
export function getSupabaseClient(): SupabaseClient | null {
    if (sharedClient) return sharedClient;

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) return null;

    try {
        sharedClient = createClient(url, key);
        logger.info('[supabase] Shared client initialized');
        return sharedClient;
    } catch (e) {
        logger.warn(`[supabase] Client creation failed: ${formatError(e)}`);
        return null;
    }
}
