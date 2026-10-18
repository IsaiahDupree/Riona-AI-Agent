/**
 * Quick diagnostic: show recent posts, comments, DMs and check for issues
 * Run: node scripts/check-recent-activity.js
 */
const fs = require('fs');
const path = require('path');

function safeLoad(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return []; }
}

const replies = safeLoad('logs/tracking/twitter/replies.json');
const twitterDMs = safeLoad('logs/tracking/twitter-dm/messages.json');
const igDMs = safeLoad('logs/tracking/dm/messages.json');

// Sort all by timestamp desc
replies.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
twitterDMs.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
igDMs.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║           Riona System Activity Report                  ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

// ── Twitter Replies (Comments) ──
console.log('── RECENT TWITTER REPLIES (last 5) ──\n');
for (const r of replies.slice(0, 5)) {
    console.log(`  ${r.timestamp}`);
    console.log(`    To: @${r.tweetAuthor}`);
    console.log(`    Reply: ${(r.replyText || '').slice(0, 100)}`);
    console.log(`    Verified: ${r.verified}  URL: ${(r.tweetUrl || '').slice(0, 60)}`);
    console.log();
}
const todayReplies = replies.filter(r => r.timestamp && r.timestamp.startsWith(new Date().toISOString().slice(0, 10)));
console.log(`  Today total: ${todayReplies.length} replies, ${todayReplies.filter(r => r.verified).length} verified\n`);

// ── Twitter DMs ──
console.log('── RECENT TWITTER DMS (last 5) ──\n');
for (const d of twitterDMs.slice(0, 5)) {
    console.log(`  ${d.timestamp}`);
    console.log(`    ${d.direction === 'outbound' ? 'To' : 'From'}: @${d.recipientUsername}`);
    console.log(`    Msg: ${(d.messageText || '').slice(0, 100)}`);
    console.log(`    Verified: ${d.verified}`);
    console.log();
}
console.log(`  Total Twitter DMs: ${twitterDMs.length}\n`);

// ── Instagram DMs ──
console.log('── RECENT INSTAGRAM DMS (last 5) ──\n');
const realIgDMs = igDMs.filter(d => d.recipientUsername !== '__test_tracker_user__');
for (const d of realIgDMs.slice(0, 5)) {
    console.log(`  ${d.timestamp}`);
    console.log(`    ${d.direction === 'outbound' ? 'To' : 'From'}: @${d.recipientUsername}`);
    console.log(`    Msg: ${(d.messageText || '').slice(0, 100)}`);
    console.log(`    Verified: ${d.verified}`);
    console.log();
}
console.log(`  Total IG DMs: ${realIgDMs.length}\n`);

// ── Issue Detection ──
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║           Issue Detection                               ║');
console.log('╚══════════════════════════════════════════════════════════╝\n');

let issues = 0;

// 1. Front truncation check
console.log('── FRONT TRUNCATION CHECK (last 30 replies) ──');
let truncCount = 0;
for (const r of replies.slice(0, 30)) {
    const text = r.replyText || '';
    // Starts with lowercase letter (missing capitalized first word)
    if (text.length > 0 && /^[a-z]/.test(text)) {
        console.log(`  POSSIBLY TRUNCATED: "${text.slice(0, 80)}..."`);
        truncCount++;
    }
    // Starts with punctuation
    if (/^[,;:\-]/.test(text)) {
        console.log(`  TRUNCATED (starts with punct): "${text.slice(0, 80)}..."`);
        truncCount++;
    }
}
if (truncCount === 0) {
    console.log('  ✓ No front truncation detected');
} else {
    console.log(`  ✗ ${truncCount} possibly truncated reply(ies)`);
    issues += truncCount;
}
console.log();

// 2. DM duplicate check
console.log('── DM DUPLICATE CHECK (today) ──');
const todayStr = new Date().toISOString().slice(0, 10);
function checkDupes(dms, platform) {
    const todayDMs = dms.filter(d => d.timestamp && d.timestamp.startsWith(todayStr) && d.recipientUsername !== '__test_tracker_user__');
    const map = {};
    for (const d of todayDMs) {
        const key = d.recipientUsername;
        if (!map[key]) map[key] = [];
        map[key].push(d);
    }
    let dupes = 0;
    for (const [user, msgs] of Object.entries(map)) {
        if (msgs.length > 1) {
            console.log(`  ✗ ${platform} DUPLICATE: @${user} has ${msgs.length} DMs today`);
            dupes++;
        }
    }
    if (dupes === 0) console.log(`  ✓ No ${platform} duplicates today`);
    return dupes;
}
issues += checkDupes(igDMs, 'Instagram');
issues += checkDupes(twitterDMs, 'Twitter');
console.log();

// 3. Bad targets
console.log('── BAD DM TARGETS ──');
const badTargets = ['chat', 'messages', 'home', 'explore', 'notifications', 'settings'];
let badCount = 0;
for (const d of twitterDMs) {
    if (badTargets.includes(d.recipientUsername)) {
        console.log(`  ✗ Twitter DM sent to @${d.recipientUsername} (not a real user) at ${d.timestamp}`);
        badCount++;
    }
}
for (const d of igDMs) {
    if (badTargets.includes(d.recipientUsername)) {
        console.log(`  ✗ IG DM sent to @${d.recipientUsername} (not a real user) at ${d.timestamp}`);
        badCount++;
    }
}
if (badCount === 0) {
    console.log('  ✓ No bad targets detected');
} else {
    issues += badCount;
}
console.log();

// 4. Message content checks
console.log('── MESSAGE QUALITY CHECK (last 10 DMs) ──');
let qualityIssues = 0;
for (const d of [...twitterDMs.slice(0, 10), ...realIgDMs.slice(0, 10)]) {
    const msg = d.messageText || '';
    if (msg.length < 20) {
        // Skip test messages
        if (msg.includes('test')) continue;
        console.log(`  ✗ Very short DM to @${d.recipientUsername}: "${msg}"`);
        qualityIssues++;
    }
    // Check if message looks like it was truncated (starts mid-sentence)
    if (msg.length > 0 && /^[a-z]/.test(msg) && !msg.startsWith('hey') && !msg.startsWith('haha') && !msg.startsWith('lol')) {
        console.log(`  ✗ DM may be front-truncated: @${d.recipientUsername}: "${msg.slice(0, 60)}..."`);
        qualityIssues++;
    }
}
if (qualityIssues === 0) {
    console.log('  ✓ No quality issues detected');
} else {
    issues += qualityIssues;
}
console.log();

// Summary
console.log('═══════════════════════════════════════════════════════════');
if (issues === 0) {
    console.log('  RESULT: All checks passed - system looks healthy');
} else {
    console.log(`  RESULT: ${issues} issue(s) detected - review above`);
}
console.log('═══════════════════════════════════════════════════════════');
