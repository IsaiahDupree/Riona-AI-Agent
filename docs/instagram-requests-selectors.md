# Instagram Message Requests Selectors

**Date:** January 1, 2026  
**Purpose:** Process message requests (visible and hidden)

---

## Request Tabs Structure

```
Requests Tab
├── Visible Requests (main list)
│   ├── Request 1 (nth-child 1)
│   ├── Request 2 (nth-child 2)
│   └── ... up to nth-child(N)
└── Hidden Requests (separate section)
    ├── "Hidden Requests" button/link
    └── Hidden Request List
        ├── Hidden Request 1
        └── Hidden Request N
```

---

## Visible Requests Selectors

### Request Item (1st in list)
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > section > div > div > div > div.xjp7ctv > div > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x2lah0s.x193iq5w.xeuugli.xvbhtw8 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.xdt5ytf.xqjyukv.x1qjc9v5.x1oa3qoh.x1nhvcw1 > div:nth-child(1) > div > div > div > div > div > div.x9f619.x1ja2u2z.x78zum5.x1n2onr6.x1iyjqo2.xs83m0k.xeuugli.x1qughib.x6s0dn4.x1a02dak.x1q0g3np.xdl72j9 > div > div > div.html-div.xdj266r.x14z9mp.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.xkj4a21.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1e56ztr.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.xs83m0k.x1q0g3np.xqjyukv.x6s0dn4.x1oa3qoh.x1nhvcw1")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/section/div/div/div/div[2]/div/div[1]/div/div[3]/div/div[1]/div[2]/div[1]/div/div/div/div/div/div[2]/div/div/div[1]
```

### Request Item (14th in list)
**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/section/div/div/div/div[2]/div/div[1]/div/div[3]/div/div[1]/div[2]/div[14]/div/div/div/div/div/div[2]/div/div/div[1]
```

---

## Hidden Requests Selectors

### "Hidden Requests" Button/Link
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > section > div > div > div > div.xjp7ctv > div > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x2lah0s.x193iq5w.xeuugli.xvbhtw8 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6 > div.x1i10hfl.x1qjc9v5.xjbqb8w.xjqpnuy.xc5r6h4.xqeqjp1.x1phubyo.x13fuv20.x18b5jzi.x1q0q8m5.x1t7ytsu.x972fbf.x10w94by.x1qhh985.x14e42zd.x9f619.x1ypdohk.xdl72j9.x2lah0s.x3ct3a4.x2lwn1j.xeuugli.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x1n2onr6.x16tdsg8.x1hl2dhg.xggy1nq.x1ja2u2z.x1t137rt.x1q0g3np.x87ps6o.x1lku1pv.x1a2a7pz.x4gyw5p.xd3so5o.x1l895ks.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1lliihq.xdj266r.x14z9mp.xat24cr.x1lziwak.xg6hnt2.x18wri0h > div > div > div.x9f619.x1ja2u2z.x78zum5.x1n2onr6.x1iyjqo2.xs83m0k.xeuugli.x1qughib.x6s0dn4.x1a02dak.x1q0g3np.xdl72j9 > div > span > span")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/section/div/div/div/div[2]/div/div[1]/div/div[3]/div/div[1]/div[1]/div/div/div[2]/div/span/span
```

### Hidden Request Item (1st)
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > section > div > div > div > div.xjp7ctv > div > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x2lah0s.x193iq5w.xeuugli.xvbhtw8 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6 > div > div:nth-child(1) > div > div > div > div > div > div.x9f619.x1ja2u2z.x78zum5.x1n2onr6.x1iyjqo2.xs83m0k.xeuugli.x1qughib.x6s0dn4.x1a02dak.x1q0g3np.xdl72j9 > div > div")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/section/div/div/div/div[2]/div/div[1]/div/div[3]/div/div[1]/div/div[1]/div/div/div/div/div/div[2]/div/div
```

### Hidden Request Item (10th)
**CSS Selector:**
```javascript
document.querySelector("#mount_0_0_Gi > div > div > div.x9f619.x1n2onr6.x1ja2u2z > div > div > div.x78zum5.xdt5ytf.x1t2pt76.x1n2onr6.x1ja2u2z.x10cihs4 > div.html-div.xdj266r.x14z9mp.xat24cr.x1lziwak.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.x16ye13r.xvbhtw8.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.x1q0g3np.xqjyukv.x1qjc9v5.x1oa3qoh.x1qughib > div.xvc5jky.xh8yej3.x10o80wk.x14k21rp.x1v4esvl.x8vgawa > section > main > section > div > div > div > div.xjp7ctv > div > div.x9f619.x1n2onr6.x1ja2u2z.x78zum5.xdt5ytf.x2lah0s.x193iq5w.xeuugli.xvbhtw8 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x6ikm8r.x10wlt62.x1n2onr6 > div > div.x78zum5.xdt5ytf.x1iyjqo2.x1n2onr6 > div > div:nth-child(10) > div > div > div > div")
```

**XPath:**
```xpath
//*[@id="mount_0_0_Gi"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/section/main/section/div/div/div/div[2]/div/div[1]/div/div[3]/div/div[1]/div/div[10]/div/div/div/div
```

---

## Simplified Selectors

### Find "Hidden Requests" link by text
```javascript
Array.from(document.querySelectorAll('span'))
    .find(s => s.textContent.includes('Hidden Requests'))?.click()
```

### Get all request items
```javascript
document.querySelectorAll('section[role="main"] div[role="button"]')
```

### Click request by index
```javascript
document.querySelectorAll('section > main > section div[role="button"]')[index]?.click()
```
