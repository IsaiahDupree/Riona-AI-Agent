/**
 * Live Action Test — Notification Replies + DM Responses
 *
 * Tests real browser actions across platforms:
 *   1. Scrape notifications → find unactioned replies → generate + post response
 *   2. Check DM inbox → find unread → generate + send reply
 *
 * Usage:
 *   npx ts-node test-live-actions.ts                                 # Dry-run (default)
 *   npx ts-node test-live-actions.ts --live                          # Actually post replies/DMs
 *   npx ts-node test-live-actions.ts --platform twitter              # Twitter only
 *   npx ts-node test-live-actions.ts --platform instagram            # Instagram only
 *   npx ts-node test-live-actions.ts --action replies                # Reply to comment replies only
 *   npx ts-node test-live-actions.ts --action dms                    # DM replies only
 *   npx ts-node test-live-actions.ts --action all                    # Both (default)
 *   npx ts-node test-live-actions.ts --max-replies 2                 # Max replies to send
 *   npx ts-node test-live-actions.ts --max-dms 2                     # Max DM replies to send
 *   npx ts-node test-live-actions.ts --live --platform twitter --action replies --max-replies 3
 *
 * DRY RUN mode (default):
 *   - Scrapes real notifications and DMs
 *   - Generates AI replies (shows them)
 *   - Does NOT post or send anything
 *
 * LIVE mode (--live):
 *   - Actually posts replies and sends DMs
 *   - Tracks actions in the normal tracking system
 */

import dotenv from 'dotenv';
dotenv.config();

import { Page } from 'puppeteer';
import { logger } from './src/utils/logger';
import { formatError } from './src/utils/errors';
import { delay } from './src/utils/delay';

// ── Arg parsing ─────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isLive = args.includes('--live');
const platformIdx = args.indexOf('--platform');
const platform = platformIdx !== -1 ? args[platformIdx + 1] || 'twitter' : 'twitter';
const actionIdx = args.indexOf('--action');
const actionType = actionIdx !== -1 ? args[actionIdx + 1] || 'all' : 'all';
const maxRepliesIdx = args.indexOf('--max-replies');
const maxReplies = maxRepliesIdx !== -1 ? parseInt(args[maxRepliesIdx + 1], 10) || 3 : 3;
const maxDMsIdx = args.indexOf('--max-dms');
const maxDMs = maxDMsIdx !== -1 ? parseInt(args[maxDMsIdx + 1], 10) || 3 : 3;

const doReplies = actionType === 'all' || actionType === 'replies';
const doDMs = actionType === 'all' || actionType === 'dms';

// ── Twitter Actions ─────────────────────────────────────────────────

async function testTwitterReplies(page: Page) {
    console.log('\n══════════════════════════════════════════════');
    console.log('  TWITTER — Reply to Notification Replies');
    console.log('══════════════════════════════════════════════\n');

    // Step 1: Scrape notifications
    const { checkNotifications, getUnactionedReplies } = await import('./src/client/Twitter-Notifications');
    console.log('Step 1: Scraping notifications (3 scroll passes)...');
    const notifResult = await checkNotifications(page, 50, 3);

    console.log(`  Found ${notifResult.newNotifications.length} new notifications`);
    console.log(`  Replies: ${notifResult.replies} | Mentions: ${notifResult.mentions} | Likes: ${notifResult.likes}`);

    if (notifResult.healthUpdates.length > 0) {
        console.log(`  Health updates:`);
        notifResult.healthUpdates.forEach(h => console.log(`    @${h.username}: ${h.event} → ${h.newHealth.toFixed(2)}`));
    }

    // Step 2: Get all unactioned replies
    const unactioned = getUnactionedReplies();
    console.log(`\nStep 2: ${unactioned.length} unactioned replies to process`);

    if (unactioned.length === 0) {
        console.log('  No unactioned replies — nothing to do.');
        return;
    }

    // Show what we'd reply to
    console.log('\n  Pending replies:');
    unactioned.slice(0, 10).forEach((n, i) => {
        console.log(`    ${i + 1}. @${n.fromUsername} [${n.type}]`);
        console.log(`       Text: "${n.text.slice(0, 120)}"`);
        if (n.theirTweetUrl) console.log(`       URL:  ${n.theirTweetUrl}`);
    });
    if (unactioned.length > 10) console.log(`    ... +${unactioned.length - 10} more`);

    if (isLive) {
        // Step 3: Actually process replies
        console.log(`\nStep 3: LIVE — Processing up to ${maxReplies} replies...`);
        const { processReplyNotifications } = await import('./src/client/Twitter-Reply-Handler');
        const result = await processReplyNotifications(page, maxReplies);

        console.log(`\n  Results:`);
        console.log(`    Processed: ${result.processed}`);
        console.log(`    Replied:   ${result.replied}`);
        console.log(`    Skipped:   ${result.skipped}`);
        console.log(`    Failed:    ${result.failed}`);
        result.details.forEach(d => {
            if (d.action === 'replied') {
                console.log(`    ✓ @${d.username}: "${d.replyText?.slice(0, 80)}"`);
            } else {
                console.log(`    ✗ @${d.username}: ${d.action} (${d.reason || ''})`);
            }
        });
    } else {
        // Dry run — generate replies but don't post
        console.log(`\nStep 3: DRY RUN — Generating replies (not posting)...`);
        const { getBrandPromptContext } = await import('./src/strategy/twitter-brand');
        const brandContext = getBrandPromptContext();
        const OpenAI = (await import('openai')).default;
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
        const { withRetry } = await import('./src/utils/errors');

        for (const notif of unactioned.slice(0, maxReplies)) {
            console.log(`\n    Generating reply to @${notif.fromUsername}...`);
            console.log(`    Their text: "${notif.text.slice(0, 150)}"`);

            try {
                const reply = await withRetry(async () => {
                    const completion = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: [
                            {
                                role: 'system',
                                content: `You are responding to replies on Twitter. ${brandContext} Be genuine, conversational, and brief.`,
                            },
                            {
                                role: 'user',
                                content: `Someone replied to your tweet. Generate a natural, conversational response under 200 chars.\n\nTHEIR REPLY (@${notif.fromUsername}):\n"${notif.text.slice(0, 300)}"\n\nReply only with the response text.`,
                            },
                        ],
                        max_tokens: 80,
                        temperature: 0.85,
                    });
                    return completion.choices[0]?.message?.content?.trim() || '';
                }, { maxRetries: 2, baseDelay: 1000, label: 'dry-run-gen' });

                console.log(`    [DRY] Would reply: "${reply}"`);
            } catch (e) {
                console.log(`    [DRY] Generation failed: ${formatError(e)}`);
            }
        }
    }
}

async function testTwitterDMs(page: Page) {
    console.log('\n══════════════════════════════════════════════');
    console.log('  TWITTER — DM Inbox Check & Reply');
    console.log('══════════════════════════════════════════════\n');

    // Step 1: Read badges
    const { readTwitterBadges } = await import('./src/client/NotificationBadgeReader');
    console.log('Step 1: Reading DM badge...');
    const badges = await readTwitterBadges(page);
    console.log(`  DMs: ${badges.dms} | Notifications: ${badges.notifications}`);

    // Step 2: Scrape inbox
    console.log('\nStep 2: Scraping DM inbox...');
    const { TwitterDM } = await import('./src/client/Twitter-DM');
    const twitterDM = new TwitterDM();
    // Reuse existing page's browser context
    // We need to navigate to inbox on the existing page
    await page.goto('https://x.com/messages', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(3000);

    // Scrape conversation previews
    const conversations = await page.evaluate(() => {
        const items: Array<{ username: string; lastMessage: string; unread: boolean; timestamp: string }> = [];
        const convCells = document.querySelectorAll('[data-testid="conversation"]');

        for (const cell of convCells) {
            const text = (cell.textContent || '').trim();
            const links = cell.querySelectorAll('a[href]');
            let username = '';
            for (const link of links) {
                const href = (link as HTMLAnchorElement).getAttribute('href') || '';
                const match = href.match(/^\/([a-zA-Z0-9_]+)$/);
                if (match && !['home', 'notifications', 'messages', 'explore', 'settings', 'i'].includes(match[1])) {
                    username = match[1];
                    break;
                }
            }

            // Check for unread indicator
            const hasUnread = cell.querySelector('[data-testid="unread"]') !== null
                || cell.querySelector('div[style*="background-color: rgb(29, 155, 240)"]') !== null
                || (cell.getAttribute('aria-label') || '').toLowerCase().includes('unread');

            items.push({
                username: username || 'unknown',
                lastMessage: text.slice(0, 200),
                unread: hasUnread,
                timestamp: new Date().toISOString(),
            });
        }
        return items;
    });

    console.log(`  Found ${conversations.length} conversations`);
    const unread = conversations.filter(c => c.unread);
    console.log(`  Unread: ${unread.length}`);

    if (conversations.length > 0) {
        console.log('\n  Recent conversations:');
        conversations.slice(0, 8).forEach((c, i) => {
            const flag = c.unread ? ' [UNREAD]' : '';
            console.log(`    ${i + 1}. @${c.username}${flag}: "${c.lastMessage.slice(0, 80)}"`);
        });
    }

    if (unread.length > 0 && isLive) {
        console.log(`\nStep 3: LIVE — Would process ${Math.min(unread.length, maxDMs)} DM conversations`);
        console.log('  (DM reply pipeline uses Twitter-DM-AI module — deferring to scheduler)');
    } else if (unread.length > 0) {
        console.log(`\nStep 3: DRY RUN — ${unread.length} unread conversations found`);
        console.log('  Use --live to process them');
    } else {
        console.log('\n  No unread DMs to process.');
    }
}

// ── Instagram Actions ───────────────────────────────────────────────

async function testInstagramReplies(page: Page) {
    console.log('\n══════════════════════════════════════════════');
    console.log('  INSTAGRAM — Reply to Notification Replies');
    console.log('══════════════════════════════════════════════\n');

    const {
        checkIGNotifications,
        getIGUnactionedReplies,
        processIGReplyNotifications,
    } = await import('./src/client/Instagram-Notifications');

    // Step 1: Scrape notifications
    console.log('Step 1: Scraping IG activity page (5 scroll passes)...');
    const notifResult = await checkIGNotifications(page, 50, 5);

    console.log(`  Found ${notifResult.newNotifications.length} new notifications`);
    console.log(`  Replies: ${notifResult.replies} | Mentions: ${notifResult.mentions} | Likes: ${notifResult.likes} | Follows: ${notifResult.follows}`);

    if (notifResult.healthUpdates.length > 0) {
        console.log(`  Health updates:`);
        notifResult.healthUpdates.forEach(h => console.log(`    @${h.username}: ${h.event} → ${h.newHealth.toFixed(2)}`));
    }

    // Step 2: Get unactioned replies
    const unactioned = getIGUnactionedReplies();
    console.log(`\nStep 2: ${unactioned.length} unactioned replies to process`);

    if (unactioned.length === 0) {
        console.log('  No unactioned IG replies — nothing to do.');
        return;
    }

    console.log('\n  Pending replies:');
    unactioned.slice(0, 10).forEach((n, i) => {
        console.log(`    ${i + 1}. @${n.fromUsername} [${n.type}]`);
        console.log(`       Text: "${n.text.slice(0, 120)}"`);
        if (n.postUrl) console.log(`       Post: ${n.postUrl}`);
    });

    if (isLive) {
        console.log(`\nStep 3: LIVE — Processing up to ${maxReplies} IG replies...`);
        const result = await processIGReplyNotifications(page, maxReplies);

        console.log(`\n  Results:`);
        console.log(`    Processed: ${result.processed}`);
        console.log(`    Replied:   ${result.replied}`);
        console.log(`    Skipped:   ${result.skipped}`);
        console.log(`    Failed:    ${result.failed}`);
        result.details.forEach(d => {
            if (d.action === 'replied') {
                console.log(`    + @${d.username}: "${d.replyText?.slice(0, 80)}"`);
            } else {
                console.log(`    - @${d.username}: ${d.action} (${d.reason || ''})`);
            }
        });
    } else {
        console.log(`\nStep 3: DRY RUN — Would generate and post ${Math.min(unactioned.length, maxReplies)} replies`);
        console.log('  Use --live to actually post.');

        // Generate sample replies without posting
        const { getBrandPromptContext } = await import('./src/strategy/twitter-brand');
        const brandContext = getBrandPromptContext();
        const OpenAI = (await import('openai')).default;
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });
        const { withRetry } = await import('./src/utils/errors');

        for (const notif of unactioned.slice(0, maxReplies)) {
            console.log(`\n    Generating IG reply to @${notif.fromUsername}...`);
            try {
                const reply = await withRetry(async () => {
                    const completion = await openai.chat.completions.create({
                        model: 'gpt-4o-mini',
                        messages: [
                            { role: 'system', content: `You are replying to an Instagram comment. ${brandContext} Be genuine and brief.` },
                            { role: 'user', content: `Someone replied to your Instagram comment. Generate a natural response under 150 chars.\n\nTHEIR REPLY (@${notif.fromUsername}):\n"${notif.text.slice(0, 300)}"\n\nReply only with the comment text.` },
                        ],
                        max_tokens: 60,
                        temperature: 0.85,
                    });
                    return completion.choices[0]?.message?.content?.trim() || '';
                }, { maxRetries: 2, baseDelay: 1000, label: 'ig-dry-run' });
                console.log(`    [DRY] Would reply: "${reply}"`);
            } catch (e) {
                console.log(`    [DRY] Generation failed: ${formatError(e)}`);
            }
        }
    }
}

async function testInstagramDMs(page: Page) {
    console.log('\n══════════════════════════════════════════════');
    console.log('  INSTAGRAM — DM Inbox Check');
    console.log('══════════════════════════════════════════════\n');

    const { readInstagramBadges } = await import('./src/client/NotificationBadgeReader');
    console.log('Step 1: Reading IG badges...');
    const badges = await readInstagramBadges(page);
    console.log(`  DMs: ${badges.dms} | Notifications: ${badges.notifications}`);

    // Navigate to DMs
    console.log('\nStep 2: Checking IG DM inbox...');
    await page.goto('https://www.instagram.com/direct/inbox/', {
        waitUntil: 'networkidle2',
        timeout: 20000,
    });
    await delay(3000);

    const conversations = await page.evaluate(() => {
        const items: Array<{ username: string; preview: string; hasUnread: boolean }> = [];

        // IG DM inbox items
        const threads = document.querySelectorAll('a[href*="/direct/t/"], div[role="listitem"], div[class*="thread"]');
        for (const thread of threads) {
            const text = (thread.textContent || '').trim();
            if (!text || text.length < 3) continue;

            const anchors = thread.querySelectorAll('a[href]');
            let username = '';
            for (const a of anchors) {
                const href = (a as HTMLAnchorElement).getAttribute('href') || '';
                const match = href.match(/^\/([a-zA-Z0-9_.]+)\/?$/);
                if (match && !['direct', 'explore', 'accounts', 'p'].includes(match[1])) {
                    username = match[1];
                    break;
                }
            }

            // Unread indicators
            const hasUnread = thread.querySelector('[aria-label*="unread"]') !== null
                || thread.querySelector('div[style*="font-weight: 700"]') !== null;

            items.push({
                username: username || 'unknown',
                preview: text.slice(0, 150),
                hasUnread,
            });
        }
        return items;
    });

    console.log(`  Found ${conversations.length} conversations`);
    const unread = conversations.filter(c => c.hasUnread);
    console.log(`  Unread: ${unread.length}`);

    if (conversations.length > 0) {
        console.log('\n  Recent IG conversations:');
        conversations.slice(0, 8).forEach((c, i) => {
            const flag = c.hasUnread ? ' [UNREAD]' : '';
            console.log(`    ${i + 1}. @${c.username}${flag}: "${c.preview.slice(0, 80)}"`);
        });
    }

    if (unread.length > 0) {
        console.log(`\n  ${isLive ? 'LIVE' : 'DRY RUN'}: ${unread.length} unread DM conversations`);
        if (!isLive) console.log('  Use --live to process them via DM pipeline');
    } else {
        console.log('\n  No unread IG DMs.');
    }
}

// ── Main ────────────────────────────────────────────────────────────

(async () => {
    let closeBrowser: (() => Promise<void>) | null = null;

    try {
        console.log('\n╔═══════════════════════════════════════════════════════════╗');
        console.log(`║   LIVE ACTION TEST — ${platform.toUpperCase().padEnd(10)} ${isLive ? '[LIVE MODE]  ' : '[DRY RUN]    '}            ║`);
        console.log('╚═══════════════════════════════════════════════════════════╝\n');
        console.log(`Mode:         ${isLive ? 'LIVE — will actually post/send' : 'DRY RUN — read-only + AI generation'}`);
        console.log(`Platform:     ${platform}`);
        console.log(`Actions:      ${actionType}`);
        console.log(`Max replies:  ${maxReplies}`);
        console.log(`Max DMs:      ${maxDMs}`);

        // Init browser
        console.log('\nInitializing browser...');
        let page: Page;

        if (platform === 'instagram') {
            const { InstagramAI } = await import('./src/client/Instagram-AI');
            const ig = new InstagramAI();
            await ig.initialize();
            page = ig.getPage()!;
            closeBrowser = () => ig.close();
        } else {
            const { TwitterAI } = await import('./src/client/Twitter-AI');
            const tw = new TwitterAI();
            await tw.initialize();
            page = tw.getPage()!;
            closeBrowser = () => tw.close();
        }

        console.log('Browser ready.\n');

        // Run tests
        if (platform === 'twitter') {
            if (doReplies) await testTwitterReplies(page);
            if (doDMs) await testTwitterDMs(page);
        } else if (platform === 'instagram') {
            if (doReplies) await testInstagramReplies(page);
            if (doDMs) await testInstagramDMs(page);
        }

        // Summary
        console.log('\n══════════════════════════════════════════════');
        console.log('  SUMMARY');
        console.log('══════════════════════════════════════════════');
        if (!isLive) {
            console.log('\n  This was a DRY RUN — nothing was posted or sent.');
            console.log('  To go live, run again with --live flag:');
            console.log(`    npx ts-node test-live-actions.ts --platform ${platform} --live`);
        } else {
            console.log('\n  Live actions completed. Check logs for details.');
        }

    } catch (e) {
        console.error('\nTest failed:', e);
    } finally {
        if (closeBrowser) {
            console.log('\nClosing browser...');
            try { await closeBrowser(); } catch (_) {}
        }
        setTimeout(() => process.exit(0), 2000);
    }
})();
