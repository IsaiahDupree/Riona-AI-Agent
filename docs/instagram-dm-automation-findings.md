# Instagram DM Automation - Findings & Learnings

**Date:** January 1, 2026  
**Status:** ✅ Successfully Implemented  
**Platform:** Safari on macOS via AppleScript

---

## Executive Summary

Successfully automated Instagram DM interactions using Safari browser automation via AppleScript with OpenAI Vision verification. The system can navigate conversations, read messages, type and send messages to specific users.

---

## Working Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Node.js/TS    │────▶│   AppleScript    │────▶│   Safari.app    │
│  SafariController│     │  osascript       │     │  Real Browser   │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                                                │
         │              ┌──────────────────┐              │
         └─────────────▶│  OpenAI Vision   │◀─────────────┘
                        │  GPT-4o          │   Screenshots
                        └──────────────────┘
```

---

## Key Findings

### 1. Successful Selectors

| Purpose | Selector | Type | Reliability |
|---------|----------|------|-------------|
| **Message Input** | `div.notranslate[contenteditable="true"]` | CSS | ⭐⭐⭐⭐⭐ |
| **Message Input Alt** | `div.xzsf02u.x1a2a7pz...notranslate` | CSS | ⭐⭐⭐⭐ |
| **Find by Name** | `spans.find(s => s.textContent.includes('Name'))` | JS | ⭐⭐⭐⭐⭐ |
| **Send Button** | `svg[aria-label="Send"]` → closest button | CSS+JS | ⭐⭐⭐⭐⭐ |
| **Contenteditable** | `div[contenteditable="true"]` | CSS | ⭐⭐⭐⭐ |

### 2. Failed/Unreliable Selectors

| Selector | Issue |
|----------|-------|
| `#mount_0_0_Gi` based paths | Mount ID changes between sessions |
| `nth-child(N)` for conversations | Index shifts with new messages |
| `role="listitem"` | Matches too many elements |
| XPath with dynamic IDs | IDs regenerate on page load |

### 3. Best Practices Discovered

1. **Use text content matching** - Finding elements by their visible text is most reliable
2. **notranslate class** - Instagram's message input always has this class
3. **Multiple fallbacks** - Always have 2-3 selector strategies
4. **Vision verification** - GPT-4o accurately verifies UI state
5. **Delays are critical** - 2-3 second delays after navigation/clicks

---

## Working Code Patterns

### Opening a Conversation by Name
```javascript
var spans = document.querySelectorAll('span');
for (var i = 0; i < spans.length; i++) {
    if (spans[i].textContent.includes('Sarah Ashley')) {
        var parent = spans[i].closest('div[role="button"]') || 
                    spans[i].closest('div').parentElement.parentElement;
        if (parent) { parent.click(); break; }
    }
}
```

### Typing a Message
```javascript
var input = document.querySelector('div[contenteditable="true"]') || 
           document.querySelector('div.notranslate[contenteditable="true"]');
if (input) {
    input.focus();
    input.textContent = "Your message here";
    input.dispatchEvent(new InputEvent('input', {bubbles: true}));
}
```

### Sending a Message
```javascript
var svg = document.querySelector('svg[aria-label="Send"]');
if (svg) {
    var btn = svg.closest('div[role="button"]') || svg.parentElement;
    if (btn) btn.click();
}
```

### Getting Conversations List
```javascript
var conversations = [];
var container = document.querySelector('div.xb57i2i');
if (container) {
    var items = container.querySelectorAll('div[role="button"]');
    items.forEach(item => {
        var name = item.querySelector('span')?.textContent || '';
        var preview = item.querySelector('span:nth-child(2)')?.textContent || '';
        if (name) conversations.push({name, preview});
    });
}
```

---

## Instagram DOM Patterns

### Key Classes
- `xzsf02u` - Message input container
- `notranslate` - Contenteditable text input
- `x1ja2u2z` - Common layout class
- `x78zum5` - Flex container
- `xb57i2i` - Conversation list container
- `x1qughib` - Interactive/clickable elements

### Message ID Format
```
mid.$cAD8OhExR8jihj6LJbWbXl2AMkAS2
     └─── Random unique identifier
```

### DOM Structure
```
section > main > div > section > div > div > div
    └── Conversation list (div.xb57i2i)
        └── Individual conversations (div with role="button")
            └── Profile image, name span, preview span
    └── Message area (div.x1iyjqo2)
        └── Messages container
            └── Individual messages (div with id="mid.$...")
        └── Input area (div.notranslate[contenteditable])
```

---

## Vision AI Integration

### Effective Prompts

**For conversation detection:**
```
Is a conversation open? Who is it with? Is there a message input field visible?
```

**For message verification:**
```
Was a message sent? Look for "test message" in the conversation. What is the last message?
```

**For inbox analysis:**
```
Is this Instagram DM inbox? List all visible conversation names.
```

### Response Format
```json
{
    "success": true,
    "description": "Conversation open with Sarah Ashley",
    "personVisible": "Sarah Ashley",
    "inputVisible": true,
    "lastMessage": "Hi Sarah! Test at 5:32 PM"
}
```

---

## Test Results

### Sarah Ashley Test (Jan 1, 2026)
| Step | Status | Method Used |
|------|--------|-------------|
| Navigate to DMs | ✅ | Direct URL |
| Find Sarah | ✅ | Text content search |
| Open conversation | ✅ | Parent element click |
| Find input | ✅ | notranslate class |
| Type message | ✅ | textContent + InputEvent |
| Send message | ✅ | SVG aria-label + click |
| Vision verify | ✅ | GPT-4o confirmed delivery |

---

## Files Reference

| File | Purpose |
|------|---------|
| `src/client/SafariController.ts` | Core Safari automation via AppleScript |
| `src/client/SafariSarahDirectTest.ts` | Direct test with user selectors |
| `src/client/SafariVisionTest.ts` | Vision-verified testing |
| `src/client/SafariSelectorTest.ts` | Selector comparison testing |
| `docs/instagram-selectors.md` | Raw selector reference |

---

## Commands

```bash
# Quick tests
npm run test:safari:dm        # Basic DM test
npm run test:sarah:direct     # Sarah Ashley with Vision

# Full extraction
npm run test:safari:dm:full   # Extract all conversations

# Selector testing
npm run test:selectors        # Compare selector methods
npm run test:vision           # Vision-only verification
```

---

## Limitations & Notes

1. **Session dependent** - Requires logged-in Safari session
2. **Rate limiting** - Add delays to avoid Instagram blocks
3. **Dynamic IDs** - Mount IDs change, avoid hardcoding
4. **Vision API costs** - Each screenshot analysis uses GPT-4o tokens
5. **macOS only** - AppleScript is macOS specific

---

## Profile-to-DM Workflow (NEW)

Successfully implemented sending DMs directly from a profile URL.

### Workflow
```
Profile URL → Navigate → Click "Message" Button → Type in Popup → Send → Verify in DM
```

### Key Selectors

**Message Button on Profile:**
```javascript
// Best approach - find by text
Array.from(document.querySelectorAll('div[role="button"]'))
    .find(b => b.textContent === 'Message')?.click()
```

**Message Input in Popup:**
```javascript
document.querySelector('div.notranslate[contenteditable="true"]')
```

### Test Results (Jan 1, 2026)
| Step | Status |
|------|--------|
| Navigate to profile | ✅ |
| Click Message button | ✅ |
| Type in popup | ✅ |
| Send message | ✅ |
| Verify in DM inbox | ✅ |

### Usage
```bash
npm run dm:profile  # Test with saraheashley
```

---

## Conversation History Scrolling

### Scroll to Load More Messages
```javascript
var container = document.querySelector('div[style*="overflow"]');
if (container) container.scrollTop = 0; // Scroll to top
```

### Extract All Messages
```javascript
document.querySelectorAll('[id^="mid."]').forEach(el => {
    var content = el.querySelector('div[dir="auto"]')?.textContent;
    var isFromMe = el.getBoundingClientRect().left > window.innerWidth / 2;
});
```

---

## Next Steps

- [x] Implement conversation cycling for bulk extraction
- [x] Profile-to-DM messaging system
- [ ] Add auto-response capability
- [ ] Create conversation filtering (by name, date, unread)
- [ ] Add message history persistence to database
- [ ] Implement typing indicators and read receipts detection
- [ ] Batch messaging to multiple profiles

---

## Message Requests Processing (NEW)

### Request Types
- **Visible Requests**: Normal message requests in the Requests tab
- **Hidden Requests**: Spam/offensive messages filtered by Instagram

### Selectors for Requests

**Accept Button (exact selector):**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > ... > div:nth-child(5) > div")
```

**Hidden Requests Link:**
```javascript
Array.from(document.querySelectorAll('span'))
    .find(s => s.textContent.includes('Hidden Requests'))?.click()
```

### Accept Request Workflow
1. Navigate to Requests tab
2. Find request by name
3. Click to open conversation
4. Click "Accept" button
5. Select "Primary" or "General" from modal
6. Verify in main inbox

### Test Results (Jan 1, 2026)
| Person | Type | Status |
|--------|------|--------|
| Andrew Sandler | Visible | ✅ Accepted |

### Usage
```bash
npm run dm:requests  # List all requests (visible + hidden)
npm run dm:accept    # Accept specific request
```

---

## Status Tracking

### Reply Status Detection
- **Replied**: Last message preview starts with "You:"
- **To Reply**: Last message from them (no "You:" prefix)

### Test Results
- Total conversations: 30
- Replied: 4
- To Reply: 26

### Usage
```bash
npm run dm:status  # Generate reply status report
```

---

## All Available Commands

```bash
# DM Operations
npm run dm:status      # Check replied vs to-reply status
npm run dm:requests    # List all message requests
npm run dm:accept      # Accept a specific request
npm run dm:profile     # Send DM from profile URL
npm run extract:dms    # Extract all DM conversations

# Testing
npm run test:sarah:direct  # Test with Sarah Ashley
npm run test:vision        # Vision-verified testing
npm run test:selectors     # Selector testing
```

---

## Session Summary (January 1, 2026)

### Accomplished
1. ✅ Created Safari AppleScript-based automation for Instagram DMs
2. ✅ Implemented OpenAI Vision API verification
3. ✅ Built comprehensive DM extraction (49+ conversations)
4. ✅ Created profile-to-DM messaging system
5. ✅ Implemented reply status tracking (replied vs to-reply)
6. ✅ Built message requests processor (visible + hidden)
7. ✅ Added accept request functionality with Primary/General selection
8. ✅ Documented all selectors and patterns

### Key Files Created
- `src/client/SafariController.ts` - Core Safari automation
- `src/client/SafariDMExtractor.ts` - DM extraction
- `src/client/SafariProfileDM.ts` - Profile-to-DM messaging
- `src/client/SafariDMStatusTracker.ts` - Reply status tracking
- `src/client/SafariRequestsProcessor.ts` - Requests handling
- `docs/instagram-dm-automation-findings.md` - This document
- `docs/instagram-selectors.md` - Selector reference
- `docs/instagram-profile-dm-selectors.md` - Profile DM selectors
- `docs/instagram-requests-selectors.md` - Requests selectors
