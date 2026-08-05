# P06 — The finalize boundary and play mode

**Preconditions for every case:** P00 complete, including the `confirm`/`alert`
stubs (§3) — several cases here trigger dialogs.
**Effort:** 60–75 min. **Fixture:** `kitchen-sink-final.json` unless stated.

This is the highest-yield pass in the suite. The chargen↔play boundary is where
state written by one mode is read by the other, and it is where the app is least
defended: once `finalized` is true, `rules.js` returns empty `errors` and
`warnings`, so an illegal state produces no visible complaint at all.

Load the fixture once at the start:

```js
(async () => { const raw = await (await fetch("docs/qa/fixtures/kitchen-sink-final.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); return { name: CHAR.name, finalized: CHAR.finalized }; })()
```

**Expected:** `{ "name": "QA Kitchen Sink", "finalized": true }`

Several cases mutate `CHAR`. Reload the fixture between sections rather than
assuming a clean slate.

---

## The blanking behaviour

### P06-001: A finalized character drops its creation-only problems
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = true; c.lifestyles = []; c.skills = { Athletics: 99 }; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:** `{ "errors": [], "warnings": [] }`
- **Note:** JC-012, ruled **B**. That character has no lifestyle and a skill at
  99, and both stay silent — they are creation rules and creation is over. The
  lists are no longer blanked *unconditionally* though; P06-001b is the half that
  now speaks.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-001b: …but still reports what stays illegal at the table
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = true; c.play.cash = -2500; c.augments = [...c.augments, { name: "Bone Lacing-Plastic", count: 1 }, { name: "Bone Lacing-Titanium", count: 1 }]; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:** `errors` contains both

      "Bone Lacing: only one tier may be installed — remove all but one of Bone Lacing-Plastic, Bone Lacing-Titanium."
      "Overdrawn by ㄓ2,500."

- **Note:** The reduced set is *what is installed in your body, and what is in
  your wallet*: augment conflicts and tiers, the Synthetic Bioware ban, augment
  requirements, Body Index over Body, a martial art above Unarmed Combat, an
  overdrawn `play.cash`, and the three worn-armor warnings. The overdraw is
  measured against `play.cash`, **not** the creation budget. Overloaded mounts
  and the magic/Amp OFFLINE state are deliberately excluded — the sheet has
  dedicated read-outs for both. The play Overview renders whatever survives in a
  **Needs attention** card, which is absent entirely for a clean character.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-002: The same character un-finalized reports both problems
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; c.lifestyles = []; c.skills = { Athletics: 99 }; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:**

      { "errors": ["Choose a lifestyle with at least 1 prepaid month."],
        "warnings": ["Athletics: maximum 6 skill points at creation."] }

- **Note:** The control for P06-001. If this one is also empty, blanking has
  leaked into chargen and that is a genuine FAIL.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-003: The loaded fixture is genuinely valid, not merely silent
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:** `{ "errors": [], "warnings": [] }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Advances

### P06-004: Play advances apply only while finalized
- **Type:** correctness
- **Check:**

      (() => { const on = JSON.parse(JSON.stringify(CHAR)); on.finalized = true; const off = JSON.parse(JSON.stringify(CHAR)); off.finalized = false; return { advance: CHAR.play.attribute_advances.Strength, finalizedStrength: RULES.calculate(on).attributes.Strength.final, chargenStrength: RULES.calculate(off).attributes.Strength.final }; })()

- **Expected:** `{ "advance": 1, "finalizedStrength": 6, "chargenStrength": 5 }`
- **Note:** This is the gate working correctly — a play advance must not inflate
  a character that has gone back to chargen.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-005: Advances are clamped to the caps the Kismet buttons enforce
- **Type:** correctness
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = true; c.play.skill_advances = { Athletics: 40 }; c.play.attribute_advances = { Strength: 40 }; const k = RULES.calculate(c); return { athletics: k.skills.Athletics.final, strength: k.attributes.Strength.final, strengthMax: k.attributes.Strength.max, errors: k.errors }; })()

- **Expected:** `{ "athletics": 8, "strength": 29, "strengthMax": 20, "errors": [] }`
- **Note:** JC-013, ruled **A**. Both used to sail through — Athletics reached 43
  and Strength 44 — because the caps lived only in the Kismet tab's button
  `disabled` attributes, which an imported or hand-edited ledger never touches.
  `applyPlayAdvances` clamps now: skills to 8 (rank 6 by Kismet, 7 on a mastery
  boon, 8 on a major one) and attributes to the engine's level range of 29.
  Strength 29 is still over its per-heritage `strengthMax` of 20 — that stays a
  **warning**, per JC-002, and warnings about creation caps aren't play-relevant,
  so `errors` is empty.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Condition tracks

### P06-006: Stored damage is not re-clamped when the track shrinks
- **Type:** leak
- **Steps:**
  1. Run the Check below. It writes a damage value far above the track maximum.
- **Check:**

      (() => { CHAR.play.physical_damage = 99; return { trackMax: CALC.condition.physical, stored: CHAR.play.physical_damage }; })()

- **Expected:** `{ "trackMax": 8, "stored": 99 }`
- **Note:** The renderer clamps what it *draws* (`min(stored, max)`), but the
  stored value is untouched. Losing a Body-boosting infusion or augment shrinks
  the track without correcting existing damage. Reload the fixture afterwards.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## The Kismet ledger

### P06-007: Ledger entries carry a serializable undo descriptor
- **Type:** correctness
- **Check:**

      (() => ({ entries: CHAR.play.kismet_log.map(e => ({ label: e.label, delta: e.delta, undoKind: e.undo ? e.undo.kind : null })), kismet: CHAR.play.kismet }))()

- **Expected:** `{ "entries": [{ "label": "Strength 5 -> 6", "delta": -6, "undoKind": "attribute" }], "kismet": 12 }`
- **Note:** `undo` must be a plain `{kind, name}` object, never a function — the
  ledger is JSON-persisted and a closure would not survive a save.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-008: Undo refunds the kismet and decrements the advance
- **Type:** correctness
- **Steps:**
  1. Click the **Kismet** tab.
  2. Find the ledger row `Strength 5 -> 6` and click its **Undo** button.
- **Check:**

      (() => ({ kismet: CHAR.play.kismet, advance: CHAR.play.attribute_advances.Strength || 0, logLength: CHAR.play.kismet_log.length }))()

- **Expected:** `{ "kismet": 18, "advance": 0, "logLength": 0 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-009: The Activity ledger undoes a purchase and refunds it in full
- **Type:** correctness
- **Steps:**
  1. Reload the fixture. The fixture starts with `play.cash` at **1500**.
  2. Click the **Gear** tab and buy any item.
  3. Scroll to **Activity** at the bottom. The purchase row has an **Undo**
     button; the starting-cash roll does not.
  4. Press Undo and confirm.
- **Check:**

      (async () => { window.confirm = () => true; const before = CHAR.play.cash; const w = DATA.tables.weapons.find(x => +x.Cost > 0 && x.Type === "Melee"); CHAR.play.purchases.weapons.push({ name: w.Weapon, smart: false, mods: [], equipped: true, qty: 1 }); logCash(`Bought ${w.Weapon}`, -Math.round(+w.Cost), { kind: "weapon", name: w.Weapon }); await playChangedRecalc(); const spent = CHAR.play.cash; await undoCashSpend(CHAR.play.cash_log[0]); return { before, spent, after: CHAR.play.cash, weapons: CHAR.play.purchases.weapons.length, top: CHAR.play.cash_log[0].label }; })()

- **Expected:** `spent` is `before` minus the weapon's cost, `after` is back to
  `before` exactly, `weapons` is `0`, and `top` is the starting-cash roll — the
  purchase row is gone from the ledger.
- **Note:** JC-011, ruled **A but scoped**. Undo lives **only** in the Activity
  ledger; the per-row ✕ on the tabs above still just removes the item and keeps
  the money, and the card says so. Covered kinds: weapon, armor, gear, augment,
  spell, hacking level, weapon mod, armor extra, gear mount, prepaid lifestyle
  month. Rows with nothing to reverse — manual adjustments, α-grade upgrades,
  quality changes, the cash roll — get no button. Undoing a purchase whose item
  was already removed reports that and pays nothing.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Purchases crossing back into chargen

### P06-010: A weapon bought in play lands in `play.purchases`
- **Type:** correctness
- **Steps:**
  1. Reload the fixture.
  2. Click the **Gear** tab.
  3. Expand a weapon category and click **Buy** on any weapon.
- **Check:**

      (() => ({ chargenWeapons: CHAR.weapons.map(w => w.name), playWeapons: CHAR.play.purchases.weapons.map(w => w.name), allWeapons: allWeapons().map(w => w.name), calcWeapons: (CALC.weapons || []).map(w => w.Weapon) }))()

- **Expected:** `chargenWeapons` is unchanged (`["Kalishnikov A-80", "Katana"]`
  for this fixture); the new weapon is in `playWeapons`; `allWeapons` is the two
  chargen ones **followed by** the new one; `calcWeapons` matches `allWeapons`
  element for element.
- **Note:** JC-010, ruled **A**. Weapons and armor joined gear, augments, spells,
  amp powers and hacking levels in `play.purchases`. The ordering matters as much
  as the split: `applyPlayAdvances` appends purchases **after** the chargen
  entries, so index N of the character's array is still index N of the matching
  CALC array — which is what lets the Gear tab keep indexing straight across. The
  Gear tab reads the union through `allWeapons()` / `allArmor()`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-011: That weapon is **not** charged against the creation budget
- **Type:** correctness
- **Steps:** (continues from P06-010 — do not reload)
- **Check:**

      (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; const k = RULES.calculate(c); return { remaining: k.budget.remaining, weapons: k.weapons.map(w => w.Weapon), errors: k.errors }; })()

- **Expected:** `remaining` is still **33902** — the number the fixture starts
  with, whatever you bought — `weapons` lists only the two chargen weapons, and
  `errors` is `[]`.
- **Note:** This is the harm JC-010 was ruled on: money earned and spent in play
  used to be retroactively deducted from the creation budget the moment you went
  Back to Chargen, and `revertToChargenEnd()` couldn't remove the item either.
  Both follow from the split. If `remaining` moves at all, the purchase has
  leaked back into the chargen arrays — re-check P06-010 first, since this case
  can only be right if that one is.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Grenade launchers in play

### P06-012: A launcher takes Damage, Pen and Barrier from the chambered grenade
- **Type:** correctness
- **Steps:**
  1. Reload the fixture.
  2. Run the setup below, then read the Overview weapon line.
- **Setup:**

      (async () => { CHAR.weapons = [{ name: "Ares Grenade Launcher", smart: false, mods: [], equipped: true, qty: 1, ammo: "Incendiary Grenade" }, { name: "Incendiary Grenade", smart: false, mods: [], equipped: true, qty: 3 }]; await recalc(); sheetTab = "overview"; renderSheet(); return "ready"; })()

- **Check:**

      (() => [...document.querySelectorAll("#sheet td.sub")].map(n => n.textContent.trim()).find(t => /^GrenadeLauncher/.test(t)))()

- **Expected:** a line containing `DMG 10+fire`, `Pen 0` and `Barrier 3`.
- **Note:** If it reads `DMG By Grenade` with no Barrier, the launcher's `Type`
  has reverted to `Heavy` and it can no longer chamber anything — see P02-012.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-013: An empty launcher shows an em dash, not a zero
- **Type:** correctness
- **Steps:** (continues from P06-012)
- **Check:**

      (async () => { delete CHAR.weapons[0].ammo; await recalc(); renderSheet(); return [...document.querySelectorAll("#sheet td.sub")].map(n => n.textContent.trim()).find(t => /^GrenadeLauncher/.test(t)); })()

- **Expected:** a line containing `DMG By Grenade` and `Barrier —`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Every play tab renders

### P06-014: All ten play tabs render without throwing
- **Type:** correctness
- **Steps:**
  1. Reload the fixture.
- **Check:**

      (async () => { const tabs = ["overview","skills","kismet","gear","augments","magic","decking","rigging","actions","notes"]; const bad = []; for (const t of tabs) { try { sheetTab = t; renderSheet(); if (!document.getElementById("sheet").textContent.trim()) bad.push(t + ":empty"); } catch (e) { bad.push(t + ":" + e.message); } } return bad; })()

- **Expected:** `[]`
- **Note:** A tab name in the output is a hard failure — record the message
  verbatim, it names the throwing function.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

Every case should PASS. P06-001, P06-005, P06-009, P06-010 and P06-011 were all
JUDGEMENT before the first round of rulings (JC-012, JC-013, JC-011, JC-010);
each is now a correctness case for the ruled behaviour, joined by the new
P06-001b.

P06-011 is the load-bearing one. If `budget.remaining` moves when you buy
something in play, the chargen/play split has broken and every "my cash is wrong
after going back to chargen" report is live again.
