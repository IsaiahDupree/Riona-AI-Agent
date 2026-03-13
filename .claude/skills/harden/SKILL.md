---
name: harden
description: Audit and fix error handling, failure modes, and resilience across the codebase. Use when improving reliability, strengthening error boundaries, or preparing for production.
argument-hint: "[file-pattern] or [directory] — defaults to full codebase"
---

# Error Handling Hardening

Target: $ARGUMENTS (or entire `src/` if not specified)

Perform a comprehensive error handling audit and fix pass. Use the established patterns from `src/utils/errors.ts`.

## Step 1: Find Issues

Search the target for these failure patterns:

1. **Empty catch blocks** — `catch {}` or `catch { }` that silently swallow errors
2. **Missing error logging** — catches that don't log what went wrong
3. **No retry on transient failures** — network/API calls without retry logic
4. **Unsafe file I/O** — `fs.writeFileSync` without atomic write protection, `JSON.parse` without try/catch
5. **Hardcoded paths** — `/tmp/` or other OS-specific paths
6. **Missing return after response** — Express routes that send a response but don't `return`
7. **Promise.all without error isolation** — concurrent promises where one failure kills all
8. **Dummy/sentinel values** — fake IDs or placeholder values used on error instead of null
9. **Silent degradation** — functions that return `[]` or `null` on error without logging (caller can't distinguish "empty" from "broken")
10. **No timeout** — API calls or browser operations that can hang indefinitely

## Step 2: Apply Fixes Using Established Patterns

### Error Classification & Retry
```typescript
import { withRetry, classifyError, isRetryable, formatError } from '../utils/errors';

// Retry transient failures with exponential backoff
const result = await withRetry(() => apiCall(), {
    maxRetries: 3,
    baseDelay: 1000,
    label: 'api_call_name'
});

// Classify errors to choose handling strategy
const category = classifyError(error); // 'transient' | 'rate_limit' | 'blocked' | 'auth' | 'not_found' | 'fatal' | 'unknown'
```

### Safe File I/O (Atomic Writes)
```typescript
import { safeReadJSON, safeWriteJSON, safeWriteFileSync } from '../utils/errors';

// Read JSON with fallback (logs warning on failure)
const data = safeReadJSON<MyType[]>(filePath, [], 'label');

// Atomic write (temp file + rename, prevents corruption)
safeWriteJSON(filePath, data, 'label');
```

### Cross-Platform Paths
```typescript
import { screenshotPath } from '../utils/errors';

// Instead of: '/tmp/screenshot.png'
await page.screenshot({ path: screenshotPath('screenshot.png') });
```

### Logging Severity Guide
| Context | Level | When |
|---------|-------|------|
| DOM element eval, trace steps | `logger.debug` | Non-critical, expected to sometimes fail |
| File I/O, API calls, data sync | `logger.warn` | Needs visibility, may indicate degraded service |
| Data loss, crashes, auth failures | `logger.error` | Requires attention |

### Empty Catch Fix Pattern
```typescript
// BAD
try { await operation(); } catch {}

// GOOD (non-critical DOM op)
try { await operation(); } catch (e) {
    logger.debug(`[module] operation failed: ${formatError(e)}`);
}

// GOOD (file I/O)
try { await operation(); } catch (e) {
    logger.warn(`[module] operation failed: ${formatError(e)}`);
}
```

### Express Route Pattern
```typescript
// Always return after sending a response
if (!valid) {
    res.status(400).json({ error: 'Invalid input' });
    return;  // <-- REQUIRED
}
```

### Promise.all Error Isolation
```typescript
// BAD — one failure kills everything
await Promise.all([loopA(), loopB()]);

// GOOD — each loop handles its own errors
const promiseA = loopA().catch(e => logger.error(`Loop A crashed: ${formatError(e)}`));
const promiseB = loopB().catch(e => logger.error(`Loop B crashed: ${formatError(e)}`));
await Promise.all([promiseA, promiseB]);
```

## Step 3: Verify

1. Run `npx tsc --noEmit` to verify clean compilation
2. Run `npx jest --passWithNoTests` to verify tests still pass
3. Count remaining empty catches: `grep -r "catch\s*{}" src/` should return 0
4. Summarize what was fixed with a severity-grouped table

## Step 4: Report

Output a summary table:

| Severity | File | Fix |
|----------|------|-----|
| CRITICAL | ... | ... |
| HIGH | ... | ... |
| MEDIUM | ... | ... |
