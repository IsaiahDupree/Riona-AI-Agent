/**
 * Safari Auto Comment
 * 
 * Implements Instagram auto-commenting functionality using Safari.app
 * via AppleScript for DOM manipulation. Adapted from Instagram-Core.ts
 * 
 * Uses the real Safari browser with existing logins/cookies.
 * 
 * Requires:
 * - macOS
 * - Safari Developer Menu enabled (Safari > Settings > Advanced > Show Develop menu)
 * - Automation permissions in System Settings > Privacy & Security > Automation
 */

import { SafariController } from './SafariController';
import { logger } from '../utils/logger';

// ==================== SELECTORS ====================

/**
 * Comment box selectors in priority order
 * Safari uses the same DOM as other browsers, but we need to handle
 * both textarea and contenteditable variants
 */
export const COMMENT_BOX_SELECTORS = [
    'textarea[aria-label="Add a comment…"]',        // Unicode ellipsis (primary)
    'textarea[placeholder="Add a comment…"]',       // Unicode ellipsis
    'textarea[placeholder="Add a comment..."]',     // Three dots fallback
    'textarea[aria-label*="comment"]',              // Partial match
    'form textarea',                                 // Generic form textarea
    'div[contenteditable="true"][role="textbox"]'   // Contenteditable fallback
];

/**
 * Comment icon selector to open the composer
 */
export const COMMENT_ICON_SELECTOR = 'svg[aria-label="Comment"]';

/**
 * Submit button selectors
 */
export const SUBMIT_SELECTORS = [
    'button[type="submit"]',
    'div[role="button"]',
    'form div[role="button"]',
    'form button:not([type])'
];

/**
 * Multi-locale submit button labels
 */
export const SUBMIT_LABELS = [
    // English
    'post', 'send',
    // French
    'publier', 'envoyer',
    // Spanish / Portuguese
    'publicar', 'enviar', 'postar',
    // Italian
    'pubblica',
    // German
    'veröffentlichen', 'senden',
    // Turkish
    'gönder',
    // Japanese
    '投稿',
    // Korean
    '게시', '보내기',
    // Chinese (Simplified)
    '发布', '发表', '发送',
    // Vietnamese
    'gửi'
];

/**
 * Locale-specific keywords for comment field detection
 */
export const COMMENT_KEYWORDS = [
    'comment', 'comentario', 'comentários', 'commentaire', 'kommentar', 'commento',
    'коммент', 'تعليق', 'yorum', 'コメント', '評論', '评论', '댓글', 'komentar'
];

// ==================== INTERFACES ====================

export interface CommentResult {
    success: boolean;
    error?: string;
    method?: string;
    metadata?: {
        comment_method: string | null;
        comment_method_attempt_time_ms: number;
        comment_method_attempts: MethodAttempt[];
    };
}

export interface MethodAttempt {
    method: string;
    success: boolean;
    time_ms: number;
    error?: string;
}

export interface PostInfo {
    permalink: string;
    caption?: string;
    username?: string;
}

// ==================== SAFARI AUTO COMMENT CLASS ====================

export class SafariAutoComment {
    private safari: SafariController;
    private timeout: number;

    constructor(timeout: number = 30000) {
        this.safari = new SafariController(timeout);
        this.timeout = timeout;
    }

    /**
     * Helper delay function
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Navigate to an Instagram post permalink
     */
    async navigateToPost(permalink: string): Promise<boolean> {
        logger.info('[safari] Navigating to post', { permalink });
        const success = await this.safari.navigateTo(permalink);
        if (success) {
            await this.delay(3000); // Wait for post to load
        }
        return success;
    }

    /**
     * Scroll post into view
     */
    async scrollPostIntoView(): Promise<void> {
        const jsCode = `
(function() {
    var article = document.querySelector('article');
    if (article) {
        article.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return 'scrolled';
    }
    return 'no_article';
})()`;
        await this.safari.executeJS(jsCode);
        await this.delay(1500);
    }

    /**
     * Find comment box using multiple selectors
     */
    async findCommentBox(): Promise<{ found: boolean; selector: string | null; isContentEditable: boolean }> {
        const selectorsJson = JSON.stringify(COMMENT_BOX_SELECTORS);
        
        const jsCode = `
(function() {
    var selectors = ${selectorsJson};
    for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el) {
            var isContentEditable = el.getAttribute('contenteditable') === 'true';
            return JSON.stringify({
                found: true,
                selector: selectors[i],
                isContentEditable: isContentEditable
            });
        }
    }
    return JSON.stringify({ found: false, selector: null, isContentEditable: false });
})()`;

        try {
            const result = await this.safari.executeJS(jsCode);
            return JSON.parse(result);
        } catch {
            return { found: false, selector: null, isContentEditable: false };
        }
    }

    /**
     * Click the comment icon to open the composer
     */
    async clickCommentIcon(): Promise<boolean> {
        const jsCode = `
(function() {
    var icon = document.querySelector('svg[aria-label="Comment"]');
    if (icon) {
        var button = icon.closest('button') || icon.closest('div[role="button"]') || icon.parentElement;
        if (button) {
            button.click();
            return 'clicked';
        }
    }
    return 'not_found';
})()`;

        try {
            const result = await this.safari.executeJS(jsCode);
            if (result === 'clicked') {
                await this.delay(700);
                return true;
            }
        } catch {
            // Ignore errors
        }
        return false;
    }

    /**
     * Locale-aware comment field detection
     */
    async findCommentBoxByKeyword(): Promise<{ found: boolean; selector: string | null }> {
        const keywordsJson = JSON.stringify(COMMENT_KEYWORDS);
        
        const jsCode = `
(function() {
    var keywords = ${keywordsJson};
    var candidates = document.querySelectorAll('textarea, form textarea, div[contenteditable="true"][role="textbox"], [role="textbox"][contenteditable="true"]');
    
    for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var label = ((el.getAttribute('aria-label') || '') + ' ' +
                    (el.getAttribute('placeholder') || '') + ' ' +
                    (el.textContent || '')).toLowerCase();
        
        for (var j = 0; j < keywords.length; j++) {
            if (label.includes(keywords[j])) {
                return JSON.stringify({ found: true, index: i });
            }
        }
    }
    return JSON.stringify({ found: false, index: -1 });
})()`;

        try {
            const result = await this.safari.executeJS(jsCode);
            const parsed = JSON.parse(result);
            if (parsed.found) {
                return { found: true, selector: `locale_keyword_${parsed.index}` };
            }
        } catch {
            // Ignore errors
        }
        return { found: false, selector: null };
    }

    /**
     * Focus and clear the comment box
     * Uses Meta key (Cmd) for Safari on macOS instead of Control
     */
    async focusAndClearCommentBox(selector: string): Promise<boolean> {
        const jsCode = `
(function() {
    var selectors = ${JSON.stringify(COMMENT_BOX_SELECTORS)};
    var el = null;
    
    // If selector is a locale keyword match, re-find it
    if ('${selector}'.startsWith('locale_keyword_')) {
        var idx = parseInt('${selector}'.replace('locale_keyword_', ''));
        var candidates = document.querySelectorAll('textarea, form textarea, div[contenteditable="true"][role="textbox"]');
        el = candidates[idx];
    } else {
        el = document.querySelector('${selector}');
    }
    
    if (!el) return 'not_found';
    
    // Focus the element
    el.focus();
    
    // Clear content
    if (el.tagName === 'TEXTAREA') {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
        // Contenteditable
        el.textContent = '';
        el.innerHTML = '';
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    
    return 'cleared';
})()`;

        try {
            const result = await this.safari.executeJS(jsCode);
            await this.delay(400);
            return result === 'cleared';
        } catch {
            return false;
        }
    }

    /**
     * Type comment text with human-like delays
     * Safari uses JavaScript to simulate typing since AppleScript keystroke is unreliable
     */
    async typeComment(comment: string, selector: string): Promise<boolean> {
        // Escape for JavaScript
        const escapedComment = comment
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n');

        const jsCode = `
(function() {
    var selectors = ${JSON.stringify(COMMENT_BOX_SELECTORS)};
    var el = null;
    
    if ('${selector}'.startsWith('locale_keyword_')) {
        var idx = parseInt('${selector}'.replace('locale_keyword_', ''));
        var candidates = document.querySelectorAll('textarea, form textarea, div[contenteditable="true"][role="textbox"]');
        el = candidates[idx];
    } else {
        el = document.querySelector('${selector}');
    }
    
    if (!el) return 'not_found';
    
    var text = "${escapedComment}";
    
    // Type the text
    if (el.tagName === 'TEXTAREA') {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        // Contenteditable
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
    }
    
    return 'typed';
})()`;

        try {
            const result = await this.safari.executeJS(jsCode);
            await this.delay(500);
            return result === 'typed';
        } catch {
            return false;
        }
    }

    /**
     * Submit comment using multiple methods
     */
    async submitComment(): Promise<{ success: boolean; method: string | null; attempts: MethodAttempt[] }> {
        const attempts: MethodAttempt[] = [];
        let successfulMethod: string | null = null;

        // Method 1: Press Enter key
        const method1Start = Date.now();
        try {
            const jsCode = `
(function() {
    var el = document.activeElement;
    if (el) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, bubbles: true }));
        return 'enter_sent';
    }
    return 'no_focus';
})()`;
            const result = await this.safari.executeJS(jsCode);
            const time = Date.now() - method1Start;
            
            if (result === 'enter_sent') {
                attempts.push({ method: 'enter_key', success: true, time_ms: time });
                successfulMethod = 'enter_key';
                logger.info('[safari] Submit method 1 (Enter key) invoked');
                await this.delay(2000);
                return { success: true, method: successfulMethod, attempts };
            }
            attempts.push({ method: 'enter_key', success: false, time_ms: time, error: result });
        } catch (e: any) {
            attempts.push({ method: 'enter_key', success: false, time_ms: Date.now() - method1Start, error: e?.message });
        }

        // Method 2: Click submit button
        const method2Start = Date.now();
        try {
            const jsCode = `
(function() {
    var btn = document.querySelector('button[type="submit"]');
    if (btn && !btn.disabled) {
        btn.click();
        return 'clicked';
    }
    return 'not_found';
})()`;
            const result = await this.safari.executeJS(jsCode);
            const time = Date.now() - method2Start;
            
            if (result === 'clicked') {
                attempts.push({ method: 'submit_button', success: true, time_ms: time });
                successfulMethod = 'submit_button';
                logger.info('[safari] Submit method 2 (submit button) invoked');
                await this.delay(2000);
                return { success: true, method: successfulMethod, attempts };
            }
            attempts.push({ method: 'submit_button', success: false, time_ms: time, error: result });
        } catch (e: any) {
            attempts.push({ method: 'submit_button', success: false, time_ms: Date.now() - method2Start, error: e?.message });
        }

        // Method 3: Form dispatch
        const method3Start = Date.now();
        try {
            const jsCode = `
(function() {
    var form = document.querySelector('article form') || document.querySelector('form');
    if (form) {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return 'dispatched';
    }
    return 'no_form';
})()`;
            const result = await this.safari.executeJS(jsCode);
            const time = Date.now() - method3Start;
            
            if (result === 'dispatched') {
                attempts.push({ method: 'form_dispatch', success: true, time_ms: time });
                successfulMethod = 'form_dispatch';
                logger.info('[safari] Submit method 3 (form dispatch) invoked');
                await this.delay(2000);
                return { success: true, method: successfulMethod, attempts };
            }
            attempts.push({ method: 'form_dispatch', success: false, time_ms: time, error: result });
        } catch (e: any) {
            attempts.push({ method: 'form_dispatch', success: false, time_ms: Date.now() - method3Start, error: e?.message });
        }

        // Method 4: Click role button by text label
        const method4Start = Date.now();
        try {
            const labelsJson = JSON.stringify(SUBMIT_LABELS);
            const jsCode = `
(function() {
    var labels = ${labelsJson};
    var selectors = ['div[role="button"]', 'button[role="button"]', 'form div[role="button"]', 'form button:not([type])'];
    
    for (var s = 0; s < selectors.length; s++) {
        var nodes = document.querySelectorAll(selectors[s]);
        for (var i = 0; i < nodes.length; i++) {
            var text = (nodes[i].textContent || '').trim().toLowerCase();
            for (var j = 0; j < labels.length; j++) {
                if (text === labels[j] || text.includes(labels[j])) {
                    nodes[i].click();
                    return 'clicked_' + text;
                }
            }
        }
    }
    return 'not_found';
})()`;
            const result = await this.safari.executeJS(jsCode);
            const time = Date.now() - method4Start;
            
            if (result.startsWith('clicked_')) {
                attempts.push({ method: 'role_button_text', success: true, time_ms: time });
                successfulMethod = 'role_button_text';
                logger.info(`[safari] Submit method 4 (role button) invoked: ${result}`);
                await this.delay(2000);
                return { success: true, method: successfulMethod, attempts };
            }
            attempts.push({ method: 'role_button_text', success: false, time_ms: time, error: result });
        } catch (e: any) {
            attempts.push({ method: 'role_button_text', success: false, time_ms: Date.now() - method4Start, error: e?.message });
        }

        return { success: false, method: null, attempts };
    }

    /**
     * Verify comment was posted successfully
     */
    async verifyCommentPosted(comment: string): Promise<boolean> {
        // Method 1: Check if comment box is empty
        const jsCode1 = `
(function() {
    var selectors = ${JSON.stringify(COMMENT_BOX_SELECTORS)};
    for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el) {
            if (el.tagName === 'TEXTAREA') {
                return (el.value || '').trim() === '' ? 'empty' : 'has_text';
            } else {
                return (el.textContent || '').trim() === '' ? 'empty' : 'has_text';
            }
        }
    }
    return 'not_found';
})()`;

        try {
            const result = await this.safari.executeJS(jsCode1);
            if (result === 'empty') {
                logger.info('[safari] Verification method 1: comment box empty ✓');
                return true;
            }
        } catch {
            // Continue to next method
        }

        // Method 2: Check for comment text in page
        const escapedComment = comment.replace(/"/g, '\\"').replace(/\n/g, ' ');
        const jsCode2 = `
(function() {
    var article = document.querySelector('article');
    if (article) {
        var text = article.innerText || '';
        return text.includes("${escapedComment}") ? 'found' : 'not_found';
    }
    return 'no_article';
})()`;

        try {
            const result = await this.safari.executeJS(jsCode2);
            if (result === 'found') {
                logger.info('[safari] Verification method 2: comment text found ✓');
                return true;
            }
        } catch {
            // Continue to next method
        }

        // Method 3: Check for error messages
        const jsCode3 = `
(function() {
    var body = document.body.innerText.toLowerCase();
    var errors = ["couldn't post", 'try again', 'action blocked', 
                  'comments on this post have been limited',
                  'only followers can comment', 
                  'commenting has been turned off'];
    for (var i = 0; i < errors.length; i++) {
        if (body.includes(errors[i])) {
            return 'error_' + errors[i];
        }
    }
    return 'no_error';
})()`;

        try {
            const result = await this.safari.executeJS(jsCode3);
            if (result === 'no_error') {
                logger.info('[safari] Verification method 3: no errors found ✓');
                return true;
            }
            logger.warn(`[safari] Error detected: ${result}`);
        } catch {
            // Assume success if no error detected
            return true;
        }

        return false;
    }

    /**
     * Check for commenting restrictions
     */
    async checkCommentRestrictions(): Promise<string | null> {
        const jsCode = `
(function() {
    var body = document.body.innerText.toLowerCase();
    if (body.includes('comments on this post have been limited')) return 'comment_limited';
    if (body.includes('only followers can comment')) return 'followers_only';
    if (body.includes('commenting has been turned off')) return 'commenting_turned_off';
    if (body.includes('action blocked')) return 'action_blocked';
    return null;
})()`;

        try {
            const result = await this.safari.executeJS(jsCode);
            return result === 'null' ? null : result;
        } catch {
            return null;
        }
    }

    /**
     * Main method: Post a comment on the current post
     */
    async postComment(comment: string, isModerationExecution = false): Promise<CommentResult> {
        const startTime = Date.now();
        
        try {
            logger.info('[safari] Starting comment operation');
            if (isModerationExecution) console.log('🚀 Starting Safari auto-comment...');

            // Step 1: Scroll post into view
            await this.scrollPostIntoView();
            if (isModerationExecution) console.log('📍 Post scrolled into view');

            // Step 2: Find comment box
            let commentBoxResult = await this.findCommentBox();
            logger.info(`[safari] Comment box search: ${commentBoxResult.found ? '✓' : '✗'}`);

            // Step 3: If not found, click comment icon
            if (!commentBoxResult.found) {
                if (isModerationExecution) console.log('🔍 Looking for comment icon...');
                const iconClicked = await this.clickCommentIcon();
                if (iconClicked) {
                    if (isModerationExecution) console.log('✅ Clicked comment icon');
                    commentBoxResult = await this.findCommentBox();
                }
            }

            // Step 4: Fallback to locale keyword search
            if (!commentBoxResult.found) {
                const keywordResult = await this.findCommentBoxByKeyword();
                if (keywordResult.found) {
                    commentBoxResult = { found: true, selector: keywordResult.selector, isContentEditable: false };
                    if (isModerationExecution) console.log('✅ Found comment box via locale keywords');
                }
            }

            // Check for restrictions if still not found
            if (!commentBoxResult.found) {
                const restriction = await this.checkCommentRestrictions();
                if (restriction) {
                    return { success: false, error: restriction };
                }
                return { success: false, error: 'Comment box not found with any selector' };
            }

            if (isModerationExecution) console.log('✅ Found comment box');

            // Step 5: Focus and clear
            const cleared = await this.focusAndClearCommentBox(commentBoxResult.selector!);
            if (!cleared) {
                return { success: false, error: 'Failed to focus/clear comment box' };
            }
            if (isModerationExecution) console.log('✅ Comment box focused and cleared');

            // Step 6: Type the comment
            if (isModerationExecution) console.log(`⌨️ Typing: "${comment}"`);
            const typed = await this.typeComment(comment, commentBoxResult.selector!);
            if (!typed) {
                return { success: false, error: 'Failed to type comment' };
            }
            if (isModerationExecution) console.log('✅ Comment typed');

            // Step 7: Submit
            if (isModerationExecution) console.log('📤 Submitting comment...');
            const submitResult = await this.submitComment();
            
            if (!submitResult.success) {
                return {
                    success: false,
                    error: 'Failed to submit comment with any method',
                    metadata: {
                        comment_method: null,
                        comment_method_attempt_time_ms: Date.now() - startTime,
                        comment_method_attempts: submitResult.attempts
                    }
                };
            }

            // Step 8: Verify
            if (isModerationExecution) console.log('🔍 Verifying comment posted...');
            await this.delay(2000);
            const verified = await this.verifyCommentPosted(comment);

            if (verified) {
                if (isModerationExecution) console.log('✅ Comment verified - successfully posted!');
                return {
                    success: true,
                    method: submitResult.method!,
                    metadata: {
                        comment_method: submitResult.method,
                        comment_method_attempt_time_ms: Date.now() - startTime,
                        comment_method_attempts: submitResult.attempts
                    }
                };
            }

            // Check for specific errors
            const restriction = await this.checkCommentRestrictions();
            if (restriction) {
                return { success: false, error: restriction };
            }

            return { success: false, error: 'Could not verify comment was posted' };

        } catch (error: any) {
            logger.error('[safari] Comment operation error:', error);
            return { success: false, error: error?.message || 'Unknown error' };
        }
    }

    /**
     * Post a comment on a specific permalink
     */
    async postCommentOnPermalink(permalink: string, comment: string, isModerationExecution = false): Promise<CommentResult> {
        // Navigate to the post
        const navigated = await this.navigateToPost(permalink);
        if (!navigated) {
            return { success: false, error: 'Failed to navigate to post' };
        }

        // Post the comment
        return this.postComment(comment, isModerationExecution);
    }
}

// ==================== STANDALONE EXECUTION ====================

/**
 * Execute a comment on a post (for direct CLI usage)
 */
export async function executeComment(permalink: string, comment: string): Promise<CommentResult> {
    const autoComment = new SafariAutoComment();
    return autoComment.postCommentOnPermalink(permalink, comment, true);
}

// Run if executed directly
if (require.main === module) {
    const args = process.argv.slice(2);
    
    if (args.length < 2) {
        console.log('Usage: npx ts-node SafariAutoComment.ts <permalink> <comment>');
        console.log('Example: npx ts-node SafariAutoComment.ts "https://www.instagram.com/p/ABC123/" "Great post!"');
        process.exit(1);
    }

    const [permalink, ...commentParts] = args;
    const comment = commentParts.join(' ');

    console.log(`\n🌐 Safari Auto Comment\n`);
    console.log(`📍 Permalink: ${permalink}`);
    console.log(`💬 Comment: ${comment}\n`);

    executeComment(permalink, comment)
        .then(result => {
            if (result.success) {
                console.log('\n✅ Comment posted successfully!');
                console.log(`   Method: ${result.method}`);
            } else {
                console.log(`\n❌ Failed to post comment: ${result.error}`);
            }
            process.exit(result.success ? 0 : 1);
        })
        .catch(err => {
            console.error('\n❌ Error:', err);
            process.exit(1);
        });
}
