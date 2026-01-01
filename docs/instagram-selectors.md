# Instagram DM Selectors Reference

This document contains tested CSS selectors and XPath expressions for Instagram DM automation.
Last updated: January 1, 2026

## Conversation List Selectors

### First Conversation Item (Index 0)
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > div > section > div > div > div > div.x9f619.x2lah0s.x1nhvcw1.x1qjc9v5.xozqiw3.x1q0g3np.x78zum5.x1iyjqo2.x5yr21d.x1t2pt76.x1n2onr6.x1ja2u2z > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x2lah0s.x193iq5w.xeuugli.xvbhtw8 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6 > div.xb57i2i.x1q594ok.x5lxg6s.x78zum5.xdt5ytf.x6ikm8r.x1ja2u2z.x1pq812k.x1rohswg.xfk6m8.x1yqm8si.xjx87ck.xx8ngbg.xwo3gff.x1n2onr6.x1oyok0e.x1odjw0f.x1e4zzel.x1xzczws > div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6 > div > div > div:nth-child(1) > div > div > div > div > div > div.x9f619.x1ja2u2z.x78zum5.x1n2onr6.x1iyjqo2.xs83m0k.xeuugli.x1qughib.x6s0dn4.x1a02dak.x1q0g3np.xdl72j9 > div > div")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/div/section/div/div/div/div[1]/div[1]/div/div[4]/div[2]/div[1]/div/div/div[1]/div/div/div/div/div/div[2]/div/div
```

### Conversation Container (Clickable)
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > div > section > div > div > div > div.x9f619.x2lah0s.x1nhvcw1.x1qjc9v5.xozqiw3.x1q0g3np.x78zum5.x1iyjqo2.x5yr21d.x1t2pt76.x1n2onr6.x1ja2u2z > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x2lah0s.x193iq5w.xeuugli.xvbhtw8 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6 > div.xb57i2i.x1q594ok.x5lxg6s.x78zum5.xdt5ytf.x6ikm8r.x1ja2u2z.x1pq812k.x1rohswg.xfk6m8.x1yqm8si.xjx87ck.xx8ngbg.xwo3gff.x1n2onr6.x1oyok0e.x1odjw0f.x1e4zzel.x1xzczws > div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6 > div > div > div:nth-child(1) > div > div > div > div > div")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/div/section/div/div/div/div[1]/div[1]/div/div[4]/div[2]/div[1]/div/div/div[1]/div/div/div/div/div
```

## Message Selectors

### Specific Message by ID
**CSS Selector (escaped):**
```javascript
document.querySelector("#mid\\.\\$cAD8OhExR8jihj6LJbWbXl2AMkAS2 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x78zum5.xh8yej3 > div.x1cy8zhl.x78zum5.xdt5ytf.x193iq5w.x1n2onr6.x1kxipp6 > div > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x6ikm8r.x10wlt62 > div > span > div")
```

**XPath:**
```xpath
//*[@id="mid.$cAD8OhExR8jihj6LJbWbXl2AMkAS2"]/div[1]/div[1]/div/div[1]/div/span/div
```

### Message at Index 31
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > div > section > div > div > div > div.x9f619.x2lah0s.x1nhvcw1.x1qjc9v5.xozqiw3.x1q0g3np.x78zum5.x1iyjqo2.x5yr21d.x1t2pt76.x1n2onr6.x1ja2u2z > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x2lah0s.x193iq5w.xeuugli.xvbhtw8 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6 > div.xb57i2i.x1q594ok.x5lxg6s.x78zum5.xdt5ytf.x6ikm8r.x1ja2u2z.x1pq812k.x1rohswg.xfk6m8.x1yqm8si.xjx87ck.xx8ngbg.xwo3gff.x1n2onr6.x1oyok0e.x1odjw0f.x1e4zzel.x1xzczws > div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6 > div > div > div:nth-child(31) > div > div > div > div > div")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/div/section/div/div/div/div[1]/div[1]/div/div[4]/div[2]/div[1]/div/div/div[31]/div/div/div/div/div
```

## Message Input Field Selectors

### Message Input (p element inside contenteditable)
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > div > section > div > div > div > div.x9f619.x2lah0s.x1nhvcw1.x1qjc9v5.xozqiw3.x1q0g3np.x78zum5.x1iyjqo2.x5yr21d.x1t2pt76.x1n2onr6.x1ja2u2z > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x193iq5w.xeuugli.x1r8uery.x1iyjqo2.xs83m0k > div > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1iyjqo2.x2lwn1j.xeuugli.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1.xcrg951.x6prxxf.x6ikm8r.x10wlt62.x1n2onr6.xh8yej3 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x193iq5w.x2lwn1j.x1n2onr6 > div:nth-child(2) > div > div > div > div > div > div.html-div.xat24cr.xexx8yu.xyri2b.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1xmf6yo.x13fj5qh.x2fvf9.x1uhb9sk.x1plvlek.xryxfnj.x1iyjqo2.x2lwn1j.xeuugli.xdt5ytf.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1.xs9asl8 > div > div.xzsf02u.x1a2a7pz.x1n2onr6.x14wi4xw.x1iyjqo2.x1gh3ibb.xisnujt.xeuugli.x1odjw0f.notranslate > p")
```

**XPath:**
```xpath
/html/body/div[1]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/div/section/div/div/div/div[1]/div[2]/div/div[1]/div/div[2]/div[2]/div/div/div/div/div/div[2]/div/div[1]/p
```

### Contenteditable Container (notranslate class)
**CSS Selector:**
```javascript
document.querySelector("div.xzsf02u.x1a2a7pz.x1n2onr6.x14wi4xw.x1iyjqo2.x1gh3ibb.xisnujt.xeuugli.x1odjw0f.notranslate")
```

## Conversation in Requests Tab

### Requests Conversation Item
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > section > div > div > div > div.xjp7ctv > div > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x2lah0s.x193iq5w.xeuugli.xvbhtw8 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.xdt5ytf.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1 > div:nth-child(1) > div > div > div > div > div > div.x9f619.x1ja2u2z.x78zum5.x1n2onr6.x1iyjqo2.xs83m0k.xeuugli.x1qughib.x6s0dn4.x1a02dak.x1q0g3np.xdl72j9 > div > div > div.html-div.xdj266r.x14z9mp.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.xkj4a21.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1e56ztr.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.xs83m0k.x1q0g3np.xqjyukv.x6s0dn4.x1oa3qoh.x1nhvcw1")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/section/div/div/div/div[2]/div/div[1]/div/div[3]/div/div[1]/div[2]/div[1]/div/div/div/div/div/div[2]/div/div/div[1]
```

## Key Class Patterns

### Important Instagram Classes
- `xzsf02u` - Message input container
- `notranslate` - Contenteditable input
- `x1ja2u2z` - Common layout class
- `x78zum5` - Flex container
- `xdt5ytf` - Flex direction
- `x1n2onr6` - Layout positioning
- `xb57i2i` - Conversation list container
- `x1qughib` - Interactive elements

### Message ID Pattern
Messages have IDs like: `mid.$cAD8OhExR8jihj6LJbWbXl2AMkAS2`
- Prefix: `mid.`
- Random string following

## Usage Notes

1. The `#mount_0_0_Gi` ID may change between sessions
2. Use `nth-child(N)` to select specific conversation by index
3. Message input requires focus before typing
4. Use `notranslate` class to find contenteditable input
5. XPath is more reliable for dynamic content
