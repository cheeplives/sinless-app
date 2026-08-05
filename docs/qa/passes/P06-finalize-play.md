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

      { "errors": ["Firearms: a specialization needs at least 1 rank in the skill.",
                   "Skill points overspent by 69.",
                   "Choose a lifestyle with at least 1 prepaid month."],
        "warnings": ["Athletics: maximum 6 skill points at creation."] }

- **Note:** The control for P06-001. If this one is also empty, blanking has
  leaked into chargen and that is a genuine FAIL.

  All three errors come from the Check's own setup, which is blunter than it
  looks: `c.skills = { Athletics: 99 }` **replaces** the whole skills map, so
  every other skill drops to 0 ranks. That overspends the budget by 69, and it
  strips the ranks out from under the fixture's Firearms specialization, which
  JC-001 now errors on. The Expected listed only the lifestyle error until
  2026-08-05 — the overspend was missing even before JC-001 existed.
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

### P06-011b: The line holds for every purchasable category
- **Type:** correctness
- **Steps:** reload the fixture first — this buys one of everything.
- **Check:**

      (async () => { window.confirm = () => true; CHAR.play.cash = 5000000; const p = CHAR.play.purchases; p.decks.push({ name: "MasterDeck", mods: [] }); logCash("Bought MasterDeck", -1000, { kind: "deck", name: "MasterDeck" }); p.programs.push("Acid Burn 1"); logCash("Bought program Acid Burn 1", -500, { kind: "program", name: "Acid Burn 1" }); p.rigs.push({ name: "Basic VCR", mods: [] }); logCash("Bought Basic VCR", -2000, { kind: "rig", name: "Basic VCR" }); p.drones.push({ name: "Bug-Spy", weapons: [], mods: [] }); logCash("Bought Bug-Spy", -300, { kind: "drone", name: "Bug-Spy" }); await playChangedRecalc(); const chargen = { decks: CHAR.decks.length, programs: CHAR.programs.length, rigs: CHAR.rigs.length, drones: CHAR.drones.length }; const joined = { decks: allDecks().length, programs: allPrograms().length, rigs: allRigs().length, drones: allDrones().length }; const probe = JSON.parse(JSON.stringify(CHAR)); probe.finalized = false; const remaining = RULES.calculate(probe).budget.remaining; const before = CHAR.play.cash; for (let n = 0; n < 4; n++) await undoCashSpend(CHAR.play.cash_log[0]); return { chargen, joined, remaining, refunded: CHAR.play.cash - before, leftOver: p.decks.length + p.programs.length + p.rigs.length + p.drones.length }; })()

- **Expected:**

      { "chargen": { "decks": 0, "programs": 0, "rigs": 0, "drones": 0 },
        "joined":  { "decks": 1, "programs": 1, "rigs": 1, "drones": 1 },
        "remaining": 33902, "refunded": 3800, "leftOver": 0 }

- **Note:** JC-024, ruled **A**: there is a hard and fast line between the
  chargen record and anything after Finalize, and `play.purchases` now holds
  every purchasable category. `chargen` all-zero with `joined` all-one is the
  line; `remaining` unmoved is what it buys; `leftOver` zero is Undo reaching all
  four. Vehicles behave identically and are left out only to keep the expression
  readable.

  The subtle one underneath this is `unitStateKey`, which keys a drone's damage
  tracks by position in the **joined** list. Buy a drone in play, damage it, then
  buy another and check the damage stayed on the first — if it jumps, the keying
  has broken.
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

## Lifestyle months: chargen record vs play balance

Chargen months are **bought** with creation cash (`priceMiscGearAndLifestyle`
charges `MonthlyCost × months`, and at least one month is a hard chargen error).
`play.lifestyles[].months` is months *remaining*, and drifts as they are burned
or prepaid. `play.lifestyles_baseline` records what chargen said at the last
sync, which is what lets the two be told apart.

### P06-015: Correcting chargen months carries across; an unrelated re-finalize doesn't
- **Type:** correctness
- **Steps:** load any finalized fixture, or run straight from a fresh sheet.
- **Check:**

      (async () => { CHAR = RULES.defaultCharacter(); CHAR.name = "LS Case"; CHAR.lifestyles = [{ name: "Squatter", months: 6 }]; CHAR.finalized = true; ensurePlay(); seedLifestyles(); const m = () => CHAR.play.lifestyles[0].months; const seeded = m(); CHAR.play.lifestyles[0].months = 2; syncChargenLifestyles(); const burnKept = m(); CHAR.lifestyles[0].months = 3; syncChargenLifestyles(); const corrected = m(); return { seeded, burnKept, corrected, baseline: CHAR.play.lifestyles_baseline, log: CHAR.play.cash_log.map(e => e.label) }; })()

- **Expected:**

      { "seeded": 6, "burnKept": 2, "corrected": 3,
        "baseline": { "Squatter": 3 },
        "log": ["Squatter lifestyle corrected in chargen: 2 → 3 mo"] }

- **Note:** `burnKept` is the important one. Re-finalizing after an edit that
  didn't touch lifestyles must leave the play balance alone — otherwise fixing a
  typo in the character's name hands back every month they had burned. If
  `corrected` comes back `2`, the sync has gone back to being insert-only and
  the mismatch this whole section exists for is live again.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-016: The Months counter is free but never silent
- **Type:** leak
- **Steps:** continue from P06-015 (or any finalized character with a lifestyle).
- **Check:**

      (async () => { await recalc(); sheetTab = "gear"; renderSheet(); const card = [...document.querySelectorAll(".sh-card")].find(c => /^Lifestyle$/.test(((c.querySelector("h3") || {}).textContent || "").trim())); const plus = [...card.querySelectorAll("button")].find(b => b.textContent.trim() === "+"); const cash = CHAR.play.cash, months = CHAR.play.lifestyles[0].months; plus.click(); const after = { months: CHAR.play.lifestyles[0].months, cash: CHAR.play.cash, top: CHAR.play.cash_log[0] }; const realConfirm = window.confirm; window.confirm = () => true; await undoCashSpend(CHAR.play.cash_log[0]); window.confirm = realConfirm; return { cash, months, after, undone: CHAR.play.lifestyles[0].months }; })()

- **Expected:** `after.months` is one higher, `after.cash` is **unchanged**, and
  `after.top` is `{ delta: 0, label: "Adjusted … lifestyle to N mo (unpaid)",
  undo: { kind: "lifestyle_adjust", … } }`. `undone` returns to `months`.
- **Note:** The counter sits beside a **+1 mo (cost)** button that charges for
  the same thing, so a free up-tick has to be visible or the two are impossible
  to tell apart after the fact. A zero-delta ledger row renders as an em dash,
  not `+ㄓ0`. If `after.cash` dropped, the counter has started charging and the
  paid button is now double-billing.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-017: A character saved before the fix is repaired once, on load
- **Type:** correctness
- **Steps:** none — builds the pre-fix shape directly.
- **Check:**

      (async () => { CHAR = RULES.defaultCharacter(); CHAR.name = "LS Legacy"; CHAR.lifestyles = [{ name: "Wealthy", months: 1 }]; CHAR.finalized = true; CHAR.play.cash_log = []; CHAR.play.lifestyles = [{ name: "Wealthy", months: 4, active: true }]; CHAR.play.lifestyles_seeded = true; delete CHAR.play.lifestyles_baseline; delete CHAR.play.lifestyles_reconciled; ensurePlay(); const first = { months: CHAR.play.lifestyles[0].months, log: CHAR.play.cash_log.length, baseline: CHAR.play.lifestyles_baseline }; ensurePlay(); ensurePlay(); return { first, afterRepeats: { months: CHAR.play.lifestyles[0].months, log: CHAR.play.cash_log.length } }; })()

- **Expected:**

      { "first": { "months": 1, "log": 1, "baseline": { "Wealthy": 1 } },
        "afterRepeats": { "months": 1, "log": 1 } }

- **Note:** The absence of `lifestyles_baseline` is what marks a character
  finalized before 2026-08-05. The repair sets the play balance to the chargen
  purchase, logs it undoably, and stamps the baseline so it can never run twice
  — `afterRepeats.log` staying at 1 is the half that matters, since a repair
  that re-fires on every `ensurePlay` would overwrite live play state forever.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Parting with kit in play

The other half of the JC-024 line. A play purchase is never written into a
chargen array; a chargen item sold or lost in play is never spliced *out* of
one. The index goes into `play.disposed`, `applyPlayAdvances` filters it from
the finalized sheet, and the creation record is left exactly as built.

### P06-018: Selling chargen kit leaves the creation budget alone
- **Type:** leak
- **Steps:** load `kitchen-sink-final.json` (already finalized).
- **Check:**

      (async () => { CHAR.finalized = true; ensurePlay(); CHAR.play.disposed = {}; await recalc(); const before = (() => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; return RULES.calculate(c).budget.remaining; })(); disposedList("weapons").push(0); logCash("Sold " + CHAR.weapons[0].name + " (chargen kit)", 1000, { kind: "dispose_chargen", category: "weapons", at: 0 }); await recalc(); const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; const k = RULES.calculate(c); return { before, remaining: k.budget.remaining, chargenWeapons: k.weapons.map(w => w.Weapon), playWeapons: (CALC.weapons || []).map(w => w.Weapon), chargenArray: CHAR.weapons.map(w => w.name), errors: k.errors }; })()

- **Expected:**

      { "before": 33902, "remaining": 33902,
        "chargenWeapons": ["Kalishnikov A-80", "Katana"],
        "playWeapons": ["Katana"],
        "chargenArray": ["Kalishnikov A-80", "Katana"],
        "errors": [] }

- **Note:** This is P06-011 pointed the other way, and the bug it was written
  for. Until 2026-08-05 every ✕ on the play sheet spliced the owning array, so
  selling chargen kit handed its cost back to the creation budget — sell a
  weapon in play, go Back to Chargen, spend the money again. `remaining` moving
  at all means that is live once more. `chargenArray` is the tell: the chargen
  record must be untouched even though the sheet no longer lists the weapon.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-019: Sell, lose and cancel through the dialog
- **Type:** correctness
- **Steps:** continue from P06-018 (do not reload), then reset with
  `CHAR.play.disposed = {}; CHAR.play.cash_log = []; await recalc();`.
- **Check:**

      (async () => { const open = async re => { sheetTab = "gear"; renderSheet(); const row = [...document.querySelectorAll("#sheet table tr")].find(r => re.test(r.textContent) && r.querySelector(".row-del")); row.querySelector(".row-del").click(); await new Promise(r => setTimeout(r, 60)); return document.querySelector(".mount-modal"); }; const press = async (m, label) => { [...m.querySelectorAll("button")].find(b => b.textContent.trim() === label).click(); await new Promise(r => setTimeout(r, 120)); }; const cash0 = CHAR.play.cash; let m = await open(/Kalishnikov/); const shown = { heading: m.querySelector("h3").textContent, pct: m.querySelectorAll("input")[0].value, amount: m.querySelectorAll("input")[1].value }; await press(m, "Cancel"); const afterCancel = { cash: CHAR.play.cash, log: CHAR.play.cash_log.length }; m = await open(/Kalishnikov/); m.querySelectorAll("input")[1].value = "500"; await press(m, "Sell"); const afterSell = { cash: CHAR.play.cash, top: CHAR.play.cash_log[0] }; m = await open(/Katana/); await press(m, "Lost / discarded"); const afterLost = { cash: CHAR.play.cash, top: CHAR.play.cash_log[0] }; return { cash0, shown, afterCancel, afterSell, afterLost, disposed: CHAR.play.disposed }; })()

- **Expected:** `shown` is `{ heading: "Part with Kalishnikov A-80?", pct: "50",
  amount: "375" }` — half of the ㄓ749 it cost. Cancel changes nothing. The sale
  adds the hand-typed **500** and logs
  `{ delta: 500, label: "Sold Kalishnikov A-80 (chargen kit)", undo: { kind:
  "dispose_chargen", category: "weapons", at: 0 } }`. The loss logs the same
  shape with `delta: 0` and label `"Lost Katana (chargen kit)"`. `disposed`
  ends `{ weapons: [0, 1] }`.
- **Note:** The percentage is a starting point, not a rule — the amount field
  wins, because what a fence pays is the table's call. Every disposal is logged
  whether or not money moved, which is the whole point: a zero-delta row is how
  "it burned in the car" stays visible. Escape and clicking the backdrop are
  Cancel.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-020: Undo and Revert both hand the kit back
- **Type:** correctness
- **Steps:** continue from P06-019.
- **Check:**

      (async () => { const realConfirm = window.confirm, realAlert = window.alert; window.confirm = () => true; window.alert = () => {}; await undoCashSpend(CHAR.play.cash_log[0]); const afterUndo = { disposed: JSON.parse(JSON.stringify(CHAR.play.disposed)), onSheet: (CALC.weapons || []).map(w => w.Weapon) }; await revertToChargenEnd(); window.confirm = realConfirm; window.alert = realAlert; return { afterUndo, afterRevert: { disposed: CHAR.play.disposed, onSheet: (CALC.weapons || []).map(w => w.Weapon), log: CHAR.play.cash_log.length } }; })()

- **Expected:**

      { "afterUndo":   { "disposed": { "weapons": [0] }, "onSheet": ["Katana"] },
        "afterRevert": { "disposed": {}, "log": 0,
                         "onSheet": ["Kalishnikov A-80", "Katana"] } }

  The undo takes back the most recent entry — the lost Katana — leaving the
  sold Kalishnikov disposed. Revert then clears the play layer entirely and
  both weapons come back.
- **Note:** Undoing a *sale* also takes the money back out — `undoCashSpend`
  does the cash half, and a loss logged `delta: 0` so undoing one only returns
  the item. Revert is the bigger hammer: it is the only thing that makes a
  disposal permanent-in-reverse.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-021: Fitting and pulling mods leaves the creation budget alone
- **Type:** leak
- **Steps:** load `kitchen-sink-final.json`.
- **Check:**

      (async () => { CHAR = RULES.mergeDefaults(CHAR); CHAR.weapons[0].mods = ["Gyro-mount"]; CHAR.finalized = true; ensurePlay(); CHAR.play.fitted_mods = []; CHAR.play.disposed_mods = []; await recalc(); const creation = () => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; return RULES.calculate(c).budget.remaining; }; const base = creation(); sheetTab = "gear"; renderSheet(); const chip = [...document.querySelectorAll("#sheet .sh-modslot .chip")].find(c => /Gyro-mount/.test(c.textContent)); chip.click(); await new Promise(r => setTimeout(r, 80)); const m = document.querySelector(".mount-modal"); const dialog = { heading: m.querySelector("h3").textContent, amount: m.querySelectorAll("input")[1].value }; [...m.querySelectorAll("button")].find(b => b.textContent.trim() === "Sell").click(); await new Promise(r => setTimeout(r, 150)); const pulled = { creation: creation(), chargenRecord: JSON.parse(JSON.stringify(CHAR.weapons[0].mods)), disposed: JSON.parse(JSON.stringify(CHAR.play.disposed_mods)), onSheet: (CALC.weapons || [])[0].mods.map(x => x.name), ledger: CHAR.play.cash_log[0].label }; sheetTab = "gear"; renderSheet(); const sel = [...document.querySelectorAll("#sheet .sh-modslot select")].find(s => [...s.options].some(o => o.value === "Optical Scope")); sel.value = "Optical Scope"; sel.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 150)); const fitted = { creation: creation(), chargenRecord: JSON.parse(JSON.stringify(CHAR.weapons[0].mods)), fitted: JSON.parse(JSON.stringify(CHAR.play.fitted_mods)), onSheet: (CALC.weapons || [])[0].mods.map(x => x.name) }; return { base, dialog, pulled, fitted }; })()

- **Expected:** `base`, `pulled.creation` and `fitted.creation` are all
  **32402**. `dialog` is
  `{ heading: "Part with Gyro-mount?", amount: "750" }` — half of ㄓ1,500.
  After the pull, `chargenRecord` is still `["Gyro-mount"]`, `disposed` holds
  `{ category: "weapons", host: 0, list: "mods", name: "Gyro-mount" }`,
  `onSheet` is `[]`, and the ledger reads
  `"Sold Gyro-mount (off Kalishnikov A-80)"`. After the fit, `chargenRecord` is
  *still* `["Gyro-mount"]`, `fitted` holds the Optical Scope record, and
  `onSheet` is `["Optical Scope"]` — the Gyro-mount stays sold, so the sheet
  shows only what the character actually has.
- **Note:** Both directions leaked until 2026-08-05. Pulling a chargen mod
  handed its ㄓ1,500 back to the creation budget; fitting one in play billed the
  creation budget for something play cash had just paid for, which could leave a
  character overspent and unable to re-finalize. `chargenRecord` is the tell in
  both halves — it must never change. If `creation` moves, the mod editors are
  writing into the chargen host again.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-022: Drones and vehicles copy-on-write instead
- **Type:** correctness
- **Steps:** none — builds a unit with a mod and a mounted weapon.
- **Check:**

      (async () => { CHAR = RULES.defaultCharacter(); CHAR.name = "Unit mods"; CHAR.lifestyles = [{ name: "Squatter", months: 1 }]; const wpn = DATA.tables.weapons.find(x => (+x.Cost || 0) > 0); const dm = DATA.tables.drone_mods[0]; CHAR.drones = [{ name: DATA.tables.drones[0].Drone, label: "", weapons: [wpn.Weapon], mods: [{ name: dm["Drone Mod"] }] }]; CHAR.finalized = true; ensurePlay(); await recalc(); const creation = () => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; return RULES.calculate(c).budget.remaining; }; const base = creation(); const pull = async re => { sheetTab = "rigging"; renderSheet(); const chip = [...document.querySelectorAll("#sheet .chip")].find(c => re.test(c.textContent) && /✕/.test(c.textContent)); chip.click(); await new Promise(r => setTimeout(r, 80)); const m = document.querySelector(".mount-modal"); const h = m.querySelector("h3").textContent; [...m.querySelectorAll("button")].find(b => b.textContent.trim() === "Lost / discarded").click(); await new Promise(r => setTimeout(r, 140)); return h; }; const modHead = await pull(new RegExp(dm["Drone Mod"])); const wpnHead = await pull(new RegExp(wpn.Weapon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); return { base, after: creation(), modHead, wpnHead, overrides: JSON.parse(JSON.stringify(CHAR.play.unit_overrides)), chargenDrone: JSON.parse(JSON.stringify(CHAR.drones[0])) }; })()

- **Expected:** `base` and `after` are equal. Both dialogs open (`modHead` and
  `wpnHead` are `"Part with …?"`). `overrides` is
  `{ "drones:0": { "mods": [], "weapons": [] } }` and `chargenDrone` still
  carries both its mod and its weapon.
- **Note:** Units are the one category that does NOT use per-mod records. A
  unit's mods point at its weapons by index, so pulling a weapon renumbers the
  mods on the others — replaying that as individual add/remove entries on every
  recalc would be a reindexing minefield. The first play edit snapshots that
  unit's `weapons` and `mods` into `play.unit_overrides` and everything after
  works on the copy. Same guarantee, different mechanism: `chargenDrone`
  unchanged is what both are for. Unit mods get no Undo button — restoring one
  out of a renumbered set isn't a safe single step.
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

P06-018 to P06-020 are its mirror image, added the same day. P06-011 proves a
play *purchase* can't reach the creation budget; P06-018 proves a play
*disposal* can't either. Before that, every ✕ on the play sheet spliced the
chargen array and refunded the item's cost to the creation budget — verified at
ㄓ1,498 for a weapon, ㄓ20,000 for gear, ㄓ2,500 for an augment whose own button
promised no refund.

P06-015 to P06-017 are the lifestyle set, added 2026-08-05 after a real
character (Jimmy Chan) turned up showing 4 prepaid months against a chargen
record of 1. They cover the two independent causes: a sync that never
reconciled a corrected chargen record, and a free `+` on the play counter
sitting next to a button that charges for the same month. P06-016 is the one to
watch — it is the only case that would notice the play sheet handing out paid
goods for nothing.
