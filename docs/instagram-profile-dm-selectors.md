# Instagram Profile-to-DM Selectors

**Date:** January 1, 2026  
**Purpose:** Send DMs directly from a user's profile URL

---

## Workflow

```
Profile URL → Navigate → Click Message Button → Type Message → Send → Verify in DM
```

---

## Profile Page Selectors

### Message Button on Profile
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x17snn68.x6osk4m.x1porb0y.x8vgawa > section > main > div > div > header > section.x14vqqas.x172qv1o > div > div > div > div > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1n2onr6.x6ikm8r.x10wlt62.x1iyjqo2.x2lwn1j.xeuugli.xdt5ytf.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1 > div")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[2]/div[1]/section/main/div/div/header/section[1]/div/div/div/div/div[2]/div
```

**Simplified alternatives:**
```javascript
// By text content
Array.from(document.querySelectorAll('div[role="button"]')).find(b => b.textContent === 'Message')

// By aria-label (if present)
document.querySelector('[aria-label="Message"]')

// By position in header
document.querySelector('header section div[role="button"]')
```

---

## Profile Message Popup Selectors

### Message Input (after clicking Message button)
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x1vjfegm > div > div > div > div.x4k7w5x.x1h91t0o.x1beo9mf.xaigb6o.x12ejxvf.x3igimt.xarpa2k.xedcshv.x1lytzrv.x1t2pt76.x7ja8zs.x1n2onr6.x1qrby5j.x1jfb8zj > div > div > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1iyjqo2.x2lwn1j.xeuugli.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1 > div > div > div:nth-child(2) > div > div > div > div > div > div.html-div.xat24cr.xexx8yu.xyri2b.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1xmf6yo.x13fj5qh.x2fvf9.x1uhb9sk.x1plvlek.xryxfnj.x1iyjqo2.x2lwn1j.xeuugli.xdt5ytf.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1.xc5o50y.xs9asl8 > div > div.xzsf02u.x1a2a7pz.x1n2onr6.x14wi4xw.x1iyjqo2.x1gh3ibb.xisnujt.xeuugli.x1odjw0f.notranslate > p")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[3]/div/div/div/div[3]/div/div/div[2]/div/div/div[2]/div/div/div/div/div/div[2]/div/div[1]/p
```

**Simplified alternatives:**
```javascript
// By notranslate class (consistent)
document.querySelector('div.notranslate[contenteditable="true"]')

// By role
document.querySelector('[role="textbox"]')

// Parent contenteditable
document.querySelector('div[contenteditable="true"]')
```

---

## Conversation Scroll Selectors

### Message Container (for scrolling to load history)
```javascript
// Main message container
document.querySelector('div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6')

// Scroll container (conversations)
document.querySelector('div.xb57i2i.x1q594ok.x5lxg6s')

// Individual messages
document.querySelectorAll('[id^="mid."]')
```

### Scroll Up to Load More
```javascript
// Scroll the message container up
var msgContainer = document.querySelector('div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6');
if (msgContainer) {
    msgContainer.scrollTop = 0; // Scroll to top
}

// Alternative: scroll parent
var parent = document.querySelector('div[role="main"]');
if (parent) parent.scrollTop = 0;
```

---

## Complete Profile-to-DM Flow

### Step 1: Navigate to Profile
```javascript
// URL format: https://www.instagram.com/{username}/
window.location.href = 'https://www.instagram.com/saraheashley/';
```

### Step 2: Click Message Button
```javascript
var msgBtn = Array.from(document.querySelectorAll('div[role="button"]'))
    .find(b => b.textContent === 'Message');
if (msgBtn) msgBtn.click();
```

### Step 3: Wait for Modal/Popup
```javascript
// Wait 2-3 seconds for popup to appear
await delay(2500);
```

### Step 4: Type Message
```javascript
var input = document.querySelector('div.notranslate[contenteditable="true"]') ||
           document.querySelector('[role="textbox"]');
if (input) {
    input.focus();
    input.textContent = 'Your message here';
    input.dispatchEvent(new InputEvent('input', {bubbles: true}));
}
```

### Step 5: Send Message
```javascript
var sendBtn = document.querySelector('svg[aria-label="Send"]')?.closest('div[role="button"]');
if (sendBtn) sendBtn.click();
```

### Step 6: Verify in DM Page
```javascript
// Navigate to DM to verify
window.location.href = 'https://www.instagram.com/direct/inbox/';
// Check conversation list for recent message
```

---

## Key Learnings

1. **Profile vs DM selectors differ** - The popup modal has different DOM structure
2. **notranslate class is universal** - Works for all message inputs
3. **Message button varies** - Look for text "Message" in buttons
4. **Popup takes time** - Always wait 2-3s after clicking Message
5. **Verification recommended** - Check DM inbox after sending
