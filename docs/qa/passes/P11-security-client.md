# P11 — Client-side security

**Preconditions for every case:** P00 complete.
**Effort:** 45 min. **Fixture:** `hostile-payloads.json`.

The app builds DOM nodes rather than HTML strings. `el()` in `static/app.js`
appends children via `Node.append()`, which turns strings into **text nodes**, so
there is no markup-injection path by construction. Every `innerHTML` in the
codebase is `innerHTML = ""` — a clear, never an assignment.

This pass verifies that invariant still holds and measures the one place
user-controlled data reaches an attribute rather than a text node.

`hostile-payloads.json` carries the probe `"><img src=x onerror=window.__xss=1>`
in every renderable string. Nothing in it is dangerous to your machine — the
payload only sets a variable — but treat it as untrusted and do not publish or
share the fixture.

---

## The no-innerHTML invariant

### P11-001: No innerHTML assignment exists in the client
- **Type:** security
- **Steps:** run this in a shell, not the browser.

      grep -rn "innerHTML" /c/Users/cheep/Claude/sinless-app/static /c/Users/cheep/Claude/sinless-app/sw.js

- **Expected:** every hit is `innerHTML = ""` — a clear with an empty string
  literal. There must be no `innerHTML =` with a variable, template literal or
  concatenation on the right-hand side.
- **Note:** Also confirm there are no hits for `insertAdjacentHTML`, `outerHTML`,
  `document.write`, `createContextualFragment`, `srcdoc`, `eval` or
  `new Function`:

      grep -rnE "insertAdjacentHTML|outerHTML|document\.write|createContextualFragment|srcdoc|\beval\(|new Function" /c/Users/cheep/Claude/sinless-app/static

- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P11-002: The hostile fixture renders on every play tab without executing
- **Type:** security
- **Check:**

      (async () => { window.__xss = undefined; const raw = await (await fetch("docs/qa/fixtures/hostile-payloads.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); const perTab = {}; for (const t of ["overview","skills","kismet","gear","augments","magic","decking","rigging","actions","notes"]) { sheetTab = t; renderSheet(); perTab[t] = window.__xss; } await new Promise(r => setTimeout(r, 300)); return { xssFired: window.__xss, perTab, injectedHandlers: document.querySelectorAll("#sheet [onerror], #sheet [onload], #sheet script").length, payloadVisibleAsText: document.getElementById("sheet").textContent.includes("onerror=window.__xss=1") }; })()

- **Expected:**

      { "xssFired": undefined,
        "perTab": { "overview": undefined, ... all ten undefined },
        "injectedHandlers": 0, "payloadVisibleAsText": true }

- **Note:** `payloadVisibleAsText: true` is the **good** outcome — it proves the
  payload arrived and was rendered inertly as text. A defined `xssFired` or a
  non-zero `injectedHandlers` is a **critical FAIL**: stop the pass and report it
  immediately.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P11-003: The same payload is inert across the chargen tabs
- **Type:** security
- **Check:**

      (async () => { window.__xss = undefined; CHAR.finalized = false; await recalc(); showActiveTab(); for (const t of ["priorities","heritage","stats","knowledge","magic","speaker","augments","weapons","decks","drones","gear"]) { activeTab = t; await recalc(); renderTabs(); renderPanel(); } await new Promise(r => setTimeout(r, 200)); return { xssFired: window.__xss, injectedHandlers: document.querySelectorAll("#app [onerror], #app [onload], #app script").length }; })()

- **Expected:** `{ "xssFired": undefined, "injectedHandlers": 0 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## The residual attribute sink

### P11-004: Character image URLs reach img@src unvalidated
- **Type:** security
- **Steps:**
  1. With `hostile-payloads.json` loaded, enter play mode and click **Notes**.
- **Check:**

      (async () => { CHAR.finalized = true; await recalc(); showActiveTab(); sheetTab = "notes"; renderSheet(); await new Promise(r => setTimeout(r, 200)); return [...document.querySelectorAll("#sheet img")].map(i => ({ src: i.getAttribute("src"), attempted: !!i.currentSrc, loaded: i.naturalWidth > 0 })); })()

- **Expected:**

      [ { "src": "javascript:window.__xss=1", "attempted": true, "loaded": false },
        { "src": "https://example.invalid/beacon.png", "attempted": true, "loaded": false } ]

- **Note:** This is the app's one known residual sink (`sheet.js`, the images
  card). Locally-added images are re-encoded through a canvas and are always
  `data:` URLs, but an **imported or shared** character's
  `play.images[].url` is never re-validated, so an arbitrary string reaches
  `img@src`.

  A `javascript:` URL does **not** execute in `img@src` — that is why `xssFired`
  stays undefined in P11-002. The real exposure is the second entry: an
  off-origin URL the browser will fetch, which discloses the viewer's IP and
  the fact that they opened that character. On the deployed host the CSP
  (`img-src 'self' data:`) blocks it; on a plain static host with no
  `.htaccess`, nothing does.

  Record this as **JUDGEMENT** and file a JC if one does not exist: should
  imported image URLs be restricted to `data:`?
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P11-005: Locally added images are data: URLs
- **Type:** security
- **Steps:**
  1. On the Notes tab of a normal character, add an image from disk.
- **Check:**

      (() => [...document.querySelectorAll("#sheet img")].map(i => (i.getAttribute("src") || "").slice(0, 30)))()

- **Expected:** every entry starts `data:image/`.
- **Note:** If a locally added image keeps a `blob:` or `file:` URL, the canvas
  re-encode has been bypassed. Mark BLOCKED if you have no image to hand.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Storage and transport

### P11-006: No secrets in localStorage
- **Type:** security
- **Check:**

      (() => { const keys = Object.keys(localStorage).filter(k => k.startsWith("sinless:")); const suspicious = keys.filter(k => /token|secret|password|csrf|bearer/i.test(k + String(localStorage.getItem(k)).slice(0, 500))); return { keyCount: keys.length, nonCharKeys: keys.filter(k => !k.includes(":char:")).sort(), suspicious }; })()

- **Expected:** `suspicious` is `[]`.
- **Note:** The CSRF token lives in a module variable only and the session is an
  HttpOnly cookie — neither may appear here. `sinless:session` caching
  `{id,name,email,is_admin}` for offline boot is expected; flag it only if it
  holds anything more.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P11-007: The service worker never caches API responses
- **Type:** security
- **Steps:** read `sw.js`.
- **Check:**

      (async () => { const src = await (await fetch("sw.js", { cache: "reload" })).text(); return { guardsApi: /url\.pathname\.includes\("\/api\/"\)/.test(src), bailsOnNonGet: /method\s*!==\s*"GET"/.test(src), version: (src.match(/CACHE_VERSION\s*=\s*"([^"]+)"/) || [])[1] }; })()

- **Expected:** `{ "guardsApi": true, "bailsOnNonGet": true, "version": "sinless-v143" }`
- **Note:** The version will differ as the app changes; record whatever you see.
  Both booleans must be `true` — a cached `/api` response would serve one user's
  data to the next on a shared machine.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P11-008: Sign-out clears the signed-in user's cache
- **Type:** security
- **Steps:** requires a deployed backend. Mark **BLOCKED** on a local install.
  1. Sign in, confirm characters load.
  2. Sign out.
- **Check:**

      (() => ({ userKeys: Object.keys(localStorage).filter(k => /^sinless:u\d+:/.test(k)), session: localStorage.getItem("sinless:session") }))()

- **Expected:** the signed-out user's `sinless:u<id>:` keys are gone and
  `session` is `null`.
- **Note:** Another account's `sinless:u<other>:` keys are deliberately left
  behind — that is that account's own cache. Only flag it if the *current*
  user's keys survive.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Prototype pollution

### P11-009: A hostile character cannot pollute Object.prototype
- **Type:** security
- **Check:**

      (() => { const before = Object.prototype.polluted; const evil = JSON.parse('{"attributes":{"Strength":3},"__proto__":{"polluted":"yes"},"name":"QA Proto"}'); const m = RULES.mergeDefaults(evil); RULES.calculate(m); return { protoBefore: before, protoAfter: ({}).polluted, ownProp: Object.prototype.hasOwnProperty.call(evil, "__proto__") }; })()

- **Expected:** `{ "protoBefore": undefined, "protoAfter": undefined, "ownProp": true }`
- **Note:** `JSON.parse` creates `__proto__` as an ordinary own property rather
  than walking the prototype chain, and `mergeDefaults` only ever writes into the
  parsed object. `protoAfter` being anything but `undefined` is a **critical
  FAIL**.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Clean up

```js
(async () => { const n = WORKSPACE.tabs.map(t => t.char.name).filter(x => /^QA /.test(x)); for (const x of n) { try { await closeTabByName(x); } catch (e) {} } Object.keys(localStorage).filter(k => k.startsWith("sinless:char:QA-")).forEach(k => localStorage.removeItem(k)); return n; })()
```

## Wrapping up

**P11-002, P11-003 and P11-009 must PASS** — they are the invariants everything
else rests on, and a failure in any of them is a security incident to report
immediately rather than at the end of the session.

**P11-004 is expected JUDGEMENT.** P11-005 and P11-008 will often be BLOCKED
depending on what you have available; say so rather than guessing.
