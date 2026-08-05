# P09 — Homebrew packs and custom content

**Preconditions for every case:** P00 complete.
**Effort:** 45 min. **Fixture:** none.

Homebrew rows are spliced into `DATA_BUNDLE.tables` at boot by
`mergeCustomContent()` and are then indistinguishable from core data to the rest
of the app. They get priced, they drive engine branches, and **nothing validates
their column values**. This pass establishes what a malformed pack can do.

Precedence is core > my packs > subscriptions, first writer of a name wins, and
losers are dropped silently into `HB_COLLISIONS`.

**These cases create homebrew content.** Clean up at the end — the cleanup block
is not optional, and a leftover QA pack will confuse every later pass.

---

### P09-001: Establish the baseline
- **Type:** correctness
- **Check:**

      (() => ({ packs: HB_PACKS.length, subs: HB_SUBS.length, collisions: HB_COLLISIONS.length, customWeapons: DATA.tables.weapons.filter(w => w.Custom === "Y").length, tables: Object.keys(HOMEBREW_CONFIG).length }))()

- **Expected:** on a clean install, `{ "packs": 0, "subs": 0, "collisions": 0, "customWeapons": 0, "tables": 16 }`
- **Note:** If `packs` is non-zero you have real homebrew here. Record the
  starting numbers and compare against them rather than against zero.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-002: A homebrew weapon appears in the game data and gets priced
- **Type:** correctness
- **Check:**

      (async () => { const row = { Weapon: "QA Test Rifle", Type: "Rifle", ZR: "2", Cost: "1000", Accuracy: "2", Reach: "Ranged", Damage: "6", "Firing modes": "SS", Ammo: "10", Pen: "3", Bar: "4", Conceal: "3", Weight: "2", Rarity: "1", Custom: "Y" }; DATA.tables.weapons.push(row); const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:2, attributes:3, skills:4, resources:0 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.weapons = [{ name: "QA Test Rifle", smart: false, mods: [], equipped: true, qty: 1 }]; const k = RULES.calculate(c); const w = k.weapons[0]; return { found: !!w, Pen: w && w.Pen, Bar: w && w.Bar, spent: k.budget.spent, gearZr: k.zoetics.gear_zr }; })()

- **Expected:** `{ "found": true, "Pen": "3", "Bar": "4", "spent": 1000, "gearZr": 2 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-003: Missing numeric columns silently read as zero
- **Type:** leak
- **Check:**

      (async () => { const row = { Weapon: "QA Malformed", Type: "Rifle", Custom: "Y" }; DATA.tables.weapons.push(row); const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:2, attributes:3, skills:4, resources:0 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.weapons = [{ name: "QA Malformed", smart: false, mods: [], equipped: true, qty: 1 }]; const k = RULES.calculate(c); return { spent: k.budget.spent, gearZr: k.zoetics.gear_zr, errors: k.errors, warnings: k.warnings, weapon: k.weapons[0] }; })()

- **Expected:** the weapon is accepted, costs `0`, contributes `0` ZR, and
  produces **no** error or warning.
- **Note:** A row with almost no columns is a perfectly good free weapon. There
  is no schema validation on homebrew at all — file a JC if you think authoring
  mistakes should be caught.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-004: A homebrew Ban column drives a real engine branch
- **Type:** correctness
- **Check:**

      (async () => { const a = { Name: "QA Banning Augment", Type: "Cyberware", ZR: "1", Cost: "100", Ban: "Smartlink", Custom: "Y" }; DATA.tables.augments.push(a); const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:2, attributes:3, skills:4, resources:0 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.augments = [{ name: "QA Banning Augment", count: 1, target: "", slotted: false, alpha: false }, { name: "Smartlink", count: 1, target: "", slotted: false, alpha: false }]; return RULES.calculate(c).errors; })()

- **Expected:** an error naming the conflict between the two augments.
- **Note:** User-authored text in a `Ban` column can make core augments
  uninstallable. That is powerful and intended, but confirm a *typo* in that
  column fails safe (no error) rather than banning something unrelated.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-005: A name colliding with a core row is dropped silently
- **Type:** leak
- **Check:**

      (() => { const before = DATA.tables.weapons.filter(w => /^Katana$/i.test(w.Weapon)).length; const dup = { Weapon: "katana", Type: "Melee", Damage: "99", Cost: "0", Custom: "Y" }; const merged = [...DATA.tables.weapons]; const seen = new Set(merged.map(w => String(w.Weapon).toLowerCase())); const wouldDrop = seen.has(dup.Weapon.toLowerCase()); return { coreCount: before, wouldDrop, collisionsRecorded: HB_COLLISIONS.length }; })()

- **Expected:** `{ "coreCount": 1, "wouldDrop": true, "collisionsRecorded": <n> }`
- **Note:** This mirrors `mergeCustomContent`'s first-writer-wins rule without
  actually re-merging. A homebrew row whose name matches a core row never
  appears and the author is never told — the only record is `HB_COLLISIONS`,
  which has no UI. File a JC if collisions should be surfaced.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-006: Imported packs are field-whitelisted
- **Type:** security
- **Check:**

      (() => { const cfg = HOMEBREW_CONFIG.weapons; const allowed = cfg.fields.map(f => f.key); return { hasBar: allowed.includes("Bar"), hasWeapon: allowed.includes("Weapon"), rejectsProto: !allowed.includes("__proto__"), rejectsReadOnly: !allowed.includes("ReadOnly"), rejectsPackId: !allowed.includes("PackId"), fieldCount: allowed.length }; })()

- **Expected:** `hasBar` and `hasWeapon` are `true`; all three `rejects*` are
  `true`.
- **Note:** `mergePackData` rebuilds each row from this whitelist and coerces
  every value to a trimmed string, so an imported file cannot inject `__proto__`
  or forge the `ReadOnly` / `PackId` / `Custom` markers.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-007: Subscribed pack rows bypass that whitelist
- **Type:** security
- **Check:** read `mergeCustomContent` in `static/homebrew.js` and confirm the
  subscription branch spreads the foreign row (`{...row, ...}`) rather than
  passing it through `mergePackData`.

      (() => { const src = mergeCustomContent.toString(); return { spreadsRawRow: /\.\.\.row/.test(src), callsMergePackData: /mergePackData/.test(src), stampsAfterSpread: /ReadOnly/.test(src) }; })()

- **Expected:** `spreadsRawRow` is `true` and `callsMergePackData` is `false` —
  i.e. subscription rows are **not** whitelisted.
- **Note:** The markers `Custom`, `PackId`, `ReadOnly` and `Source` are assigned
  *after* the spread, so a hostile pack cannot forge those. It can still carry
  arbitrary extra keys. Impact is data shape, not code execution — nothing in
  the render path executes a field value. Mark **JUDGEMENT** and describe what
  you found; do not claim an XSS without demonstrating one (see P11).
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P09-008: Homebrew rows render as text, not markup
- **Type:** security
- **Check:**

      (async () => { window.__xss = undefined; const row = { Weapon: '"><img src=x onerror=window.__xss=1>', Type: "Rifle", Cost: "100", Damage: "1", Pen: "0", Bar: "0", Custom: "Y" }; DATA.tables.weapons.push(row); const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:2, attributes:3, skills:4, resources:0 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.name = "QA HB XSS"; await openCharacter(c); CHAR.finalized = false; activeTab = "weapons"; await recalc(); renderTabs(); renderPanel(); await new Promise(r => setTimeout(r, 200)); return { xssFired: window.__xss, imgCount: document.querySelectorAll("#panel img").length, nameAppearsAsText: document.getElementById("panel").textContent.includes("onerror=window.__xss=1") }; })()

- **Expected:** `{ "xssFired": undefined, "imgCount": 0, "nameAppearsAsText": true }`
- **Note:** The payload must appear as visible text and never as an element. A
  non-zero `imgCount` or a defined `xssFired` is a **critical FAIL** — report it
  immediately, do not finish the pass first.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Clean up — required

Every case above pushed rows onto the live tables. Reload the page to discard
them, then confirm:

```js
(() => ({ leftovers: DATA.tables.weapons.filter(w => /^QA /i.test(w.Weapon) || /onerror/.test(w.Weapon)).map(w => w.Weapon), augments: DATA.tables.augments.filter(a => /^QA /i.test(a.Name)).map(a => a.Name) }))()
```

**Expected after reload:** `{ "leftovers": [], "augments": [] }`

Also remove the test character:

```js
(async () => { try { await closeTabByName("QA HB XSS"); } catch (e) {} localStorage.removeItem("sinless:char:QA-HB-XSS"); return "clean"; })()
```

## Wrapping up

Expected JUDGEMENT: **P09-003, P09-005, P09-007**. P09-008 must PASS — it is the
one case here that would be a security incident rather than a design question.
