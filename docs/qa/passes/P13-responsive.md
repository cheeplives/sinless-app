# P13 — Readability and usability at tablet and desktop sizes

**Preconditions for every case:** P00 complete.
**Effort:** 45–60 min. **Fixture:** `kitchen-sink-final.json` — it is the
densest character in the set, which is what makes layout problems visible.

The app is used on tablets. This pass measures whether it is comfortable there,
at five viewports covering 11-inch and 13-inch devices in both orientations plus
a desktop baseline.

**Measure, do not eyeball.** Screenshots time out intermittently on this app and
"looks fine" is not a finding anyone can act on. Every case below returns numbers.
Where a case genuinely is a matter of taste, it says so and routes to JUDGEMENT.

## The viewports

| Label | Size | Device |
|---|---|---|
| `11-portrait` | 834 × 1194 | 11″ iPad Pro, portrait |
| `11-landscape` | 1194 × 834 | 11″ iPad Pro, landscape |
| `13-portrait` | 1024 × 1366 | 12.9/13″ iPad Pro, portrait |
| `13-landscape` | 1366 × 1024 | 12.9/13″ iPad Pro, landscape |
| `desktop` | 1280 × 800 | baseline for comparison |

Set each with the `resize_window` tool, passing `width` and `height` explicitly.
Re-run the measurement block after every resize.

## Setup

Load the fixture and install the measurement helper once:

```js
(async () => { window.confirm = () => true; window.alert = () => {}; const raw = await (await fetch("docs/qa/fixtures/kitchen-sink-final.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); window.__qaMeasure = async (scope) => { const sel = scope === "chargen" ? "#app" : "#sheet"; const tabs = scope === "chargen" ? ["stats","weapons","gear"] : ["overview","gear","kismet"]; const out = { viewport: window.innerWidth + "x" + window.innerHeight }; for (const t of tabs) { if (scope === "chargen") { activeTab = t; await recalc(); renderTabs(); renderPanel(); } else { sheetTab = t; renderSheet(); } await new Promise(r => setTimeout(r, 80)); const b = [...document.querySelectorAll(sel + " button")].map(x => x.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0); out[t] = { buttons: b.length, minH: b.length ? Math.min(...b.map(r => Math.round(r.height))) : null, under32h: b.filter(r => r.height < 32).length, under44h: b.filter(r => r.height < 44).length, overflow: document.documentElement.scrollWidth > window.innerWidth + 1, scrollW: document.documentElement.scrollWidth }; } return out; }; return "ready"; })()
```

---

## Horizontal overflow

### P13-001: No viewport scrolls the page sideways
- **Type:** usability
- **Steps:** for each of the five viewports, resize and run the Check.
- **Check:**

      window.__qaMeasure("play")

- **Expected:** `overflow` is `false` on every tab at every viewport, and
  `scrollW` never exceeds the viewport width.
- **Note:** Observed at 834 × 1194: `scrollW` 819 against a viewport of 834, no
  overflow on Overview, Gear or Kismet. The page body must never scroll
  sideways; wide tables are expected to scroll **inside their own container**
  instead, which P13-003 checks.
- **Result (record per viewport):**
  - `11-portrait` [ ] PASS [ ] FAIL — `overflow`: ______
  - `11-landscape` [ ] PASS [ ] FAIL — `overflow`: ______
  - `13-portrait` [ ] PASS [ ] FAIL — `overflow`: ______
  - `13-landscape` [ ] PASS [ ] FAIL — `overflow`: ______
  - `desktop` [ ] PASS [ ] FAIL — `overflow`: ______

### P13-002: The chargen side is also clean
- **Type:** usability
- **Check:**

      (async () => { CHAR.finalized = false; await recalc(); showActiveTab(); return await window.__qaMeasure("chargen"); })()

- **Expected:** `overflow` is `false` on Stats, Weapons and Gear at every
  viewport. The Stats tab is the densest screen in the app — if anything
  overflows, it will be that one.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-003: Wide tables scroll inside their own container
- **Type:** usability
- **Check:**

      (() => { const wraps = [...document.querySelectorAll("#sheet .scroll-x, #sheet [style*='overflow']")]; const tables = [...document.querySelectorAll("#sheet table")]; return { wrappedTables: tables.filter(t => t.closest(".scroll-x") || (t.parentElement && /auto|scroll/.test(getComputedStyle(t.parentElement).overflowX))).length, totalTables: tables.length, wrappers: wraps.length }; })()

- **Expected:** every table that is wider than its parent sits inside a
  horizontally scrollable wrapper (`wrapScrollableTables()` in `sheet.js` does
  this). `wrappedTables` should equal the number of wide tables, not necessarily
  `totalTables` — narrow tables need no wrapper.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Touch targets

### P13-004: Controls are large enough to tap
- **Type:** usability
- **Check:**

      window.__qaMeasure("play")

- **Expected (guideline):** interactive controls should be at least **44 px**
  tall for comfortable touch, and no smaller than **32 px**.
- **First check the media query is actually engaged** — this is the whole case:

      matchMedia("(pointer: coarse)").matches

  If that is `false`, you are measuring the desktop layout and the numbers below
  will not reproduce. A tablet-sized *viewport* is not enough; the browser has to
  report a coarse pointer. Resizing alone often doesn't do it — use the device
  emulation, or run it on a real tablet.

- **Observed with a coarse pointer** (375 × 812, the only configuration the
  automation harness can emulate — re-measure at the five tablet viewports and
  record what you get):

  | Tab | Visible buttons | Smallest height | Under 32 px | Under 44 px |
  |---|---|---|---|---|
  | Overview | 65 | 16 px | 4 | 64 |
  | Gear | 61 | 16 px | 6 | 58 |
  | Kismet | 64 | 32 px | **0** | 63 |
  | Stats (chargen) | 119 | 32 px | **0** | 119 |

  Every remaining sub-32 control is a `.sh-reorder-btn` — the ▲/▼ arrows, which
  are 16 px **each** because they are a stacked pair occupying 32 px together.
  Confirm that with:

      [...document.querySelectorAll("#sheet button")].filter(x => { const r = x.getBoundingClientRect(); return r.height > 0 && r.height < 32; }).map(x => x.className || "(none)")

  Anything other than `sh-reorder-btn` in that output is a control the
  coarse-pointer block has missed.

- **Note:** JC-017, ruled **B**. Before the ruling this pass measured 47 of 65
  under 32 px on the Overview and **107 of 108** on chargen Stats, with a
  minimum of 11 px — but those numbers were taken with a tablet viewport and a
  *fine* pointer, so the `@media(pointer:coarse)` block that existed then wasn't
  active either. The block was extended to raise everything clickable to a 32 px
  floor; desktop density is untouched, which is the point of ruling B over C.

  The 44 px column stays high and that is expected: 32 px is the floor the
  ruling bought, not 44.

  Two controls turned out to be sitting below the floor and were added to the
  coarse block on 2026-08-18: `.sh-complex-btn` (the inline **Complex** and
  **Stabilize** buttons on Actions This Round) and `.sh-strip-toggle` (the
  Actions strip's fold control). Both are labelled buttons, so they joined the
  `.btn, .btn-add, …` min-height rule rather than getting sizes of their own.
  Each already sits in a row held open to 32 px by a neighbouring `.mini-btn`,
  so the floor cost no extra height anywhere — measured identical with and
  without it on the strip, the sticky bar and the Actions card. With those in,
  the class list from the check above is **empty** at every tablet viewport,
  not just free of non-`sh-reorder-btn` entries.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-005: Controls do not overlap
- **Type:** usability
- **Check:**

      (() => { const b = [...document.querySelectorAll("#sheet button")].map(x => ({ r: x.getBoundingClientRect(), t: x.textContent.trim().slice(0, 8) })).filter(x => x.r.width > 0); const hits = []; for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) { const a = b[i].r, c = b[j].r; if (a.left < c.right - 1 && c.left < a.right - 1 && a.top < c.bottom - 1 && c.top < a.bottom - 1) hits.push([b[i].t, b[j].t]); } return { overlaps: hits.length, sample: hits.slice(0, 5) }; })()

- **Expected:** `{ "overlaps": 0, "sample": [] }`
- **Note:** Overlapping tap targets mean a mis-tap fires the wrong action —
  that is a real FAIL at any viewport, not a taste question.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Legibility

### P13-006: No text is rendered below a readable size
- **Type:** usability
- **Check:**

      (() => { const nodes = [...document.querySelectorAll("#sheet *, #app *")].filter(e => e.childElementCount === 0 && e.textContent.trim() && e.getBoundingClientRect().width > 0); const sizes = nodes.map(e => parseFloat(getComputedStyle(e).fontSize)); return { min: Math.min(...sizes), max: Math.max(...sizes), under12: sizes.filter(s => s < 12).length, under11: sizes.filter(s => s < 11).length, sampled: sizes.length }; })()

- **Expected:** `under11` is `0`. Anything below 11 px is hard to read on a
  tablet held at arm's length.
- **Note:** Observed on the chargen side: minimum 11.5 px, with 5 elements under
  12 px, out of 65 sampled. That is borderline rather than broken — record the
  numbers and mark **JUDGEMENT** if `under12` is non-zero but `under11` is zero.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-007: Both themes are legible
- **Type:** usability
- **Steps:**
  1. Switch the app between light and dark using its own theme control.
  2. Re-run P13-006 in each.
- **Check:**

      (() => ({ theme: document.documentElement.getAttribute("data-theme"), scheme: document.documentElement.getAttribute("data-scheme"), bodyBg: getComputedStyle(document.body).backgroundColor, bodyFg: getComputedStyle(document.body).color }))()

- **Expected:** the attribute flips, and text remains readable against the
  background in both. This one is a genuine visual judgement — if you cannot
  assess contrast reliably, mark **BLOCKED** rather than guessing.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Navigation reachability

### P13-008: Every tab is reachable at every viewport
- **Type:** usability
- **Check:**

      (() => { const strip = document.querySelector("#sheet .sheet-tabs") || document.querySelector("#sheet nav") || document.querySelector("#workspace-tabs"); if (!strip) return "no tab strip found"; const r = strip.getBoundingClientRect(); const tabs = [...strip.querySelectorAll("button, a")].map(t => t.getBoundingClientRect()); return { stripWidth: Math.round(r.width), viewport: window.innerWidth, tabs: tabs.length, offscreen: tabs.filter(t => t.right > window.innerWidth + 1 || t.left < -1).length, scrollable: /auto|scroll/.test(getComputedStyle(strip).overflowX) }; })()

- **Expected:** `offscreen` is `0`, **or** `scrollable` is `true` so the
  overflowing tabs can be reached by swiping.
- **Note:** A tab that is both offscreen and in a non-scrollable strip is
  unreachable — a hard FAIL. Check this at `11-portrait` especially, the
  narrowest viewport.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-009: The sticky header does not consume the screen in landscape
- **Type:** usability
- **Check:**

      (() => { const h = document.querySelector("#sheet .sheet-head, #sheet header, #sheet .sticky"); if (!h) return "no sticky header found"; const r = h.getBoundingClientRect(); return { headerHeight: Math.round(r.height), viewportHeight: window.innerHeight, percent: Math.round((r.height / window.innerHeight) * 100) }; })()

- **Expected:** `percent` is under 25 at the landscape viewports (834 px tall),
  where vertical space is scarcest.
- **Note:** Run this specifically at `11-landscape` and `13-landscape`. A header
  eating a third of a short viewport is the classic tablet-landscape complaint.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P13-010: The sticky bar (tab strip + actions strip) stays a fraction of a short viewport
- **Type:** usability
- **Check:**

      (() => { const b = document.querySelector("#sheet .sh-stickybar"); if (!b) return "no sticky bar found"; const r = b.getBoundingClientRect(); const strip = document.querySelector(".sh-actions-strip"); return { barHeight: Math.round(r.height), viewportHeight: window.innerHeight, percent: Math.round((r.height / window.innerHeight) * 100), stripPresent: !!strip, stripHeight: strip ? Math.round(strip.getBoundingClientRect().height) : null }; })()

- **Expected:** `percent` is under 15 at the landscape viewports, `stripPresent`
  is `true`, and `stripHeight` is under 60 (one row of pills — it should not
  have wrapped to two at these widths).
- **Note:** `#sheet .sheet-head` — the scroll-away header P13-009 measures — is
  the only element that case's selector can ever resolve to (`.sheet-head`
  precedes `.sh-stickybar` in the DOM, and nothing else in `#sheet` matches
  `header` or `.sticky`), so **the sticky bar's own height sits outside any
  case's budget**. That gap is what this case closes, and it matters more now
  that the bar carries a second row (the actions strip, P06-052) on top of the
  tab strip it always has.

  Measured at `11-landscape` (1194×834) and `13-landscape` (1366×1024) against
  `kitchen-sink-final.json`: `barHeight` 83px both times — `percent` 10 and 8.
  15 leaves real headroom above that without being meaningless; a genuine
  regression (the actions strip wrapping to two rows because a build gained
  enough exploit-action kinds, or a future addition growing the bar further)
  would need to roughly double the current height to trip it.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

Report a table of the five viewports against P13-001, P13-004 and P13-008 — those
three answer "can this be used on a tablet at all". The rest add detail.

**P13-004 should now PASS**, and it is the case most likely to fail for a boring
reason: if `matchMedia("(pointer: coarse)").matches` is `false` you measured the
desktop layout, which is unchanged by design. Check that first and mark
**BLOCKED** rather than FAIL if you can't get a coarse pointer. Everything else
should PASS on a healthy build.
