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

## The bright line: `play.kit`

At Finalize the character's gear is **copied** into `play.kit`, and from then on
the play sheet edits only that copy. Worn flags, fitted mods, quantities,
α-grades, sales, losses, reordering — all of it lands in the kit, and the
chargen arrays are never written to again.

That one rule replaced four narrower mechanisms (`disposed`, `fitted_mods` /
`disposed_mods`, `unit_overrides`, `armor_worn`), each of which had patched one
path by which play could reach into the creation record.

### P06-018: Ten play actions, and the chargen record does not move
- **Type:** leak
- **Steps:** none — the Check builds and finalizes its own character each time.
- **Check:**

      (async () => { const raw = JSON.parse(JSON.stringify(CHAR)); const KEYS = ["priorities","attributes","skills","knowledge_skills","heritage","magic","augments","weapons","armor","gear","decks","programs","rigs","drones","vehicles","lifestyles","description"]; const fp = () => { const o = {}; for (const k of KEYS) o[k] = CHAR[k]; return JSON.stringify(o); }; const view = () => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; const k = RULES.calculate(c); return [k.budget.remaining, (k.knowledge || {}).remaining]; }; const rows = []; const test = async (label, fn) => { CHAR = RULES.mergeDefaults(JSON.parse(JSON.stringify(raw))); CHAR.armor = [{ name: "Armor Jacket", style: "", material: "", extras: [], active: true }]; CHAR.finalized = true; ensurePlay(); await recalc(); const a = fp(), b = view(); fn(); await recalc(); rows.push({ label, chargen: fp() === a ? "same" : "CHANGED", budget: String(view()) === String(b) ? "same" : "MOVED" }); }; const K = c => CHAR.play.kit[c]; await test("worn", () => { K("armor")[0].active = false; }); await test("equipped", () => { K("weapons")[0].equipped = false; }); await test("carried", () => { K("gear")[0].carried = false; }); await test("qty +5", () => { K("gear")[0].qty = (K("gear")[0].qty || 1) + 5; }); await test("augment count +1", () => { K("augments")[0].count = (K("augments")[0].count || 1) + 1; }); await test("augment alpha", () => { K("augments")[0].alpha = true; }); await test("augment slotted", () => { K("augments")[0].slotted = !K("augments")[0].slotted; }); await test("knowledge added", () => { K("knowledge_skills").push({ name: "Streetwise", points: 3 }); }); await test("description", () => { CHAR.play.description = "changed"; }); await test("reorder", () => { arrayMove(K("weapons"), 0, 1, () => {}); }); return rows; })()

- **Expected:** ten rows, every one `{ chargen: "same", budget: "same" }`.
- **Note:** This is the case the refactor exists for. Before it, **all ten**
  mutated the chargen record and four moved a creation budget — the qty stepper
  by ㄓ5,000, an extra Skillsoft by ㄓ2,500, an α-grade by ㄓ2,500, a knowledge
  skill by 3 points. A single `CHANGED` means something on the sheet is writing
  through to `CHAR.<array>` again instead of `play.kit`; the offender is
  whichever field that row touches.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-019: Sell, lose and cancel through the dialog
- **Type:** correctness
- **Steps:** reload `kitchen-sink-final.json` and enter play mode.
- **Check:**

      (async () => { CHAR.finalized = true; ensurePlay(); CHAR.play.kit = kitFromChargen(); CHAR.play.cash_log = []; await recalc(); const open = async re => { sheetTab = "gear"; renderSheet(); const row = [...document.querySelectorAll("#sheet table tr")].find(r => re.test(r.textContent) && r.querySelector(".row-del")); row.querySelector(".row-del").click(); await new Promise(r => setTimeout(r, 60)); return document.querySelector(".mount-modal"); }; const press = async (m, label) => { [...m.querySelectorAll("button")].find(b => b.textContent.trim() === label).click(); await new Promise(r => setTimeout(r, 120)); }; const cash0 = CHAR.play.cash; let m = await open(/Kalishnikov/); const shown = { heading: m.querySelector("h3").textContent, pct: m.querySelectorAll("input")[0].value, amount: m.querySelectorAll("input")[1].value }; await press(m, "Cancel"); const cancelled = { cash: CHAR.play.cash === cash0, log: CHAR.play.cash_log.length }; m = await open(/Kalishnikov/); m.querySelectorAll("input")[1].value = "500"; await press(m, "Sell"); const sold = { cash: CHAR.play.cash, top: CHAR.play.cash_log[0].label, kit: CHAR.play.kit.weapons.map(w => w.name), chargen: CHAR.weapons.map(w => w.name) }; m = await open(/Katana/); await press(m, "Lost / discarded"); const lost = { cash: CHAR.play.cash, top: CHAR.play.cash_log[0] }; return { cash0, shown, cancelled, sold, lost }; })()

- **Expected:** `shown` is `{ heading: "Part with Kalishnikov A-80?", pct: "50",
  amount: "375" }`. `cancelled` is `{ cash: true, log: 0 }`. `sold.cash` is
  `cash0 + 500`, `sold.top` is `"Sold Kalishnikov A-80"`, `sold.kit` is
  `["Katana"]` and **`sold.chargen` is still `["Kalishnikov A-80", "Katana"]`**.
  `lost.top` has `delta: 0` and label `"Lost Katana"`, with an undo descriptor
  of kind `restore_item`.
- **Note:** `sold.chargen` is the load-bearing assertion. The percentage seeds
  the amount and the amount wins, because what a fence pays is the table's call.
  Escape and clicking the backdrop are Cancel.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-020: The Back-to-Chargen round trip
- **Type:** correctness
- **Steps:** continue from P06-019.
- **Check:**

      (async () => { const out = {}; const sheet = () => (CALC.weapons || []).map(w => w.Weapon); const chargen = () => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; const k = RULES.calculate(c); return { weapons: k.weapons.map(w => w.Weapon), remaining: k.budget.remaining }; }; CHAR.finalized = true; ensurePlay(); CHAR.play.kit = kitFromChargen(); CHAR.play.kit_baseline = kitFromChargen(); CHAR.play.cash_log = []; await recalc(); CHAR.play.kit.weapons.splice(0, 1); await recalc(); out.sold = { sheet: sheet(), chargen: chargen() }; CHAR.finalized = false; await recalc(); out.backToChargen = { listed: sheet(), remaining: CALC.budget.remaining, errors: CALC.errors.length }; CHAR.finalized = true; reconcileKit(); await recalc(); out.refinalized = { sheet: sheet(), logged: CHAR.play.cash_log.length }; CHAR.finalized = false; CHAR.weapons.push({ name: "Katana", mods: [], equipped: true }); CHAR.finalized = true; reconcileKit(); await recalc(); out.afterBuildEdit = { sheet: sheet(), top: CHAR.play.cash_log[0].label }; window.confirm = () => true; window.alert = () => {}; await revertToChargenEnd(); out.reverted = sheet(); return out; })()

- **Expected:**

      { "sold": { "sheet": ["Katana"],
                  "chargen": { "weapons": ["Kalishnikov A-80", "Katana"], "remaining": 33902 } },
        "backToChargen": { "listed": ["Kalishnikov A-80", "Katana"], "remaining": 33902, "errors": 0 },
        "refinalized": { "sheet": ["Katana"], "logged": 0 },
        "afterBuildEdit": { "sheet": ["Katana", "Katana"],
                            "top": "Chargen build edited: +Katana" },
        "reverted": ["Kalishnikov A-80", "Katana", "Katana"] }

- **Note:** Four separate promises in one case. Selling doesn't touch the build.
  Back to Chargen shows the character exactly as made. A re-finalize that
  changed nothing leaves the sale standing and **logs nothing** — `logged: 0` is
  the half people get wrong, since a re-finalize that rebuilt the kit would
  silently undo every sale. A re-finalize that *did* edit the build carries the
  change across and says so. Revert rebuilds the kit from chargen, so everything
  comes back — including the Katana added mid-case.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-021: Fitting and pulling mods leaves the creation record alone
- **Type:** leak
- **Steps:** reload `kitchen-sink-final.json`.
- **Check:**

      (async () => { CHAR = RULES.mergeDefaults(CHAR); CHAR.weapons[0].mods = ["Gyro-mount"]; CHAR.finalized = true; ensurePlay(); CHAR.play.kit = kitFromChargen(); CHAR.play.kit_baseline = kitFromChargen(); CHAR.play.cash_log = []; await recalc(); const creation = () => { const c = JSON.parse(JSON.stringify(CHAR)); c.finalized = false; return RULES.calculate(c).budget.remaining; }; const base = creation(); sheetTab = "gear"; renderSheet(); const chip = [...document.querySelectorAll("#sheet .sh-modslot .chip")].find(c => /Gyro-mount/.test(c.textContent)); chip.click(); await new Promise(r => setTimeout(r, 80)); const m = document.querySelector(".mount-modal"); const dialog = { heading: m.querySelector("h3").textContent, amount: m.querySelectorAll("input")[1].value }; [...m.querySelectorAll("button")].find(b => b.textContent.trim() === "Sell").click(); await new Promise(r => setTimeout(r, 150)); const pulled = { creation: creation(), kit: JSON.parse(JSON.stringify(CHAR.play.kit.weapons[0].mods)), chargen: JSON.parse(JSON.stringify(CHAR.weapons[0].mods)), ledger: CHAR.play.cash_log[0].label }; sheetTab = "gear"; renderSheet(); const sel = [...document.querySelectorAll("#sheet .sh-modslot select")].find(s => [...s.options].some(o => o.value === "Optical Scope")); sel.value = "Optical Scope"; sel.dispatchEvent(new Event("change")); await new Promise(r => setTimeout(r, 150)); const fitted = { creation: creation(), kit: JSON.parse(JSON.stringify(CHAR.play.kit.weapons[0].mods)), chargen: JSON.parse(JSON.stringify(CHAR.weapons[0].mods)) }; return { base, dialog, pulled, fitted }; })()

- **Expected:** `base`, `pulled.creation` and `fitted.creation` are all
  **32402**. `dialog` is `{ heading: "Part with Gyro-mount?", amount: "750" }`.
  `pulled.kit` is `[]` and `fitted.kit` is `["Optical Scope"]`, while
  **`chargen` reads `["Gyro-mount"]` in both** — the build is untouched
  throughout.
- **Note:** Mods leaked both ways before the kit existed: pulling a chargen mod
  refunded ㄓ1,500 to the creation budget, and fitting one in play *charged* it
  ㄓ1,500 for something play cash had already paid for — which could leave a
  character overspent and unable to re-finalize.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-022: A character saved before the kit migrates once
- **Type:** correctness
- **Steps:** none — the Check reloads the fixture itself, so it doesn't inherit
  whatever the previous case left in `CHAR`.
- **Check:**

      (async () => { const raw = await (await fetch("docs/qa/fixtures/kitchen-sink-final.json", { cache: "reload" })).json(); CHAR = RULES.mergeDefaults(raw); CHAR.weapons[0].mods = ["Gyro-mount"]; CHAR.finalized = true; CHAR.play = CHAR.play || {}; Object.assign(CHAR.play, { kit: null, kit_baseline: null, disposed: { weapons: [1] }, disposed_mods: [{ category: "weapons", host: 0, list: "mods", name: "Gyro-mount" }], fitted_mods: [{ category: "weapons", host: 0, list: "mods", name: "Optical Scope" }], unit_overrides: {} }); ensurePlay(); await recalc(); const first = JSON.stringify(CHAR.play.kit); ensurePlay(); ensurePlay(); return { kit: CHAR.play.kit.weapons.map(w => `${w.name}[${(w.mods || []).join("|")}]`), chargen: CHAR.weapons.map(w => `${w.name}[${(w.mods || []).join("|")}]`), legacyCleared: { disposed: CHAR.play.disposed, fitted: CHAR.play.fitted_mods, disposedMods: CHAR.play.disposed_mods }, stable: JSON.stringify(CHAR.play.kit) === first }; })()

- **Expected:**

      { "kit": ["Kalishnikov A-80[Optical Scope]"],
        "chargen": ["Kalishnikov A-80[Gyro-mount]", "Katana[]"],
        "legacyCleared": { "disposed": {}, "fitted": [], "disposedMods": [] },
        "stable": true }

- **Note:** That legacy state means "Katana sold, Gyro-mount pulled, Optical
  Scope fitted", and the migrated kit says exactly that. The old records are
  replayed through the engine once and then cleared — leaving them would apply
  every edit a second time. `stable: true` is the guard: migration must be
  idempotent, since `ensurePlay` runs on every load.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-023: The creation budget freezes at Finalize
- **Type:** correctness
- **Steps:** reload `kitchen-sink-final.json`.
- **Check:**

      (async () => { CHAR.finalized = true; ensurePlay(); CHAR.play.kit = kitFromChargen(); CHAR.play.creation_budget = snapshotCreationBudget(); await recalc(); const b = () => [CALC.budget.spent, CALC.budget.remaining]; const out = { atFinalize: b() }; CHAR.play.kit.weapons.splice(0, 1); await recalc(); out.afterSale = b(); const w = DATA.tables.weapons.find(x => (+x.Cost || 0) > 2000); CHAR.play.purchases.weapons.push({ name: w.Weapon, mods: [], equipped: true }); await recalc(); out.afterPurchase = b(); CHAR.play.kit.weapons[0].mods = ["Gyro-mount"]; await recalc(); out.afterMod = b(); CHAR.finalized = false; CHAR.weapons.push({ name: "Katana", mods: [], equipped: true }); await recalc(); out.chargenIsLive = b(); CHAR.finalized = true; await recalc(); out.stillFrozen = b(); CHAR.play.creation_budget = snapshotCreationBudget(); await recalc(); out.afterRefinalize = b(); return out; })()

- **Expected:**

      { "atFinalize":      [26098, 33902],
        "afterSale":       [26098, 33902],
        "afterPurchase":   [26098, 33902],
        "afterMod":        [26098, 33902],
        "chargenIsLive":   [27598, 32402],
        "stillFrozen":     [26098, 33902],
        "afterRefinalize": [27598, 32402] }

- **Note:** A finalized character's budget line is a record of what the build
  cost, not a running total of what they're carrying — selling a rifle at the
  table shouldn't make creation look cheaper. It used to track the current kit
  in both directions.

  `chargenIsLive` is the half that keeps this honest: back in chargen the
  figures must move again, or the creation budget has stopped working. And the
  freeze is re-taken at every Finalize, not just the first, so a genuine edit to
  the build is picked up (`afterRefinalize`).

  Only the cash figures freeze. `gear_cost_multiplier` and
  `armor_cost_multiplier` stay live — they come from heritage and price what
  play buys today.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-024: No stringified objects reach the DOM
- **Type:** correctness
- **Steps:** any finalized character; a fixture with gear in it is best.
- **Check:**

      (async () => { const hits = []; for (const t of ["overview","skills","kismet","gear","augments","magic","decking","rigging","actions","notes"]) { sheetTab = t; renderSheet(); const txt = document.querySelector("#sheet").textContent; if (/\[object /.test(txt)) hits.push({ tab: t, sample: (txt.match(/.{0,40}\[object [^\]]*\].{0,20}/) || [])[0] }); } return hits; })()

- **Expected:** `[]`
- **Note:** A one-line canary for a whole class of rendering bug. `el()`'s
  children go to `node.append()`, which takes Nodes and strings — hand it
  anything else and it silently stringifies. A Gear-tab cell built as
  `el("td", {}, cond ? [a, b] : [c, d])` shipped for weeks rendering the literal
  text `"[object HTMLSpanElement],[object HTMLInputElement]"` in the **Carried**
  column, because an array child was appended whole instead of flattened.
  `el()` flattens arrays now, so the same call site is correct — but any future
  child that isn't a Node, string or array will land here the same way, and this
  case names the tab and quotes the surrounding text.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-025: The header meters carry play state, not creation budgets
- **Type:** correctness
- **Steps:** any finalized character.
- **Check:**

      (async () => { const read = () => [...document.querySelectorAll(".sheet-head .sh-meter")].map(m => `${m.querySelector(".k").textContent}=${m.querySelector(".v").textContent}`); const strip = () => [...document.querySelectorAll(".sh-compact .sh-cmeter")].map(m => m.textContent.trim()); const p = CHAR.play.physical_damage, s = CHAR.play.stun_damage; CHAR.play.physical_damage = 5; CHAR.play.stun_damage = 4; await recalc(); renderSheet(); const hurt = read(), hurtStrip = strip(); CHAR.play.physical_damage = 0; CHAR.play.stun_damage = 0; await recalc(); renderSheet(); const well = read(); CHAR.play.physical_damage = p; CHAR.play.stun_damage = s; await recalc(); renderSheet(); return { hurt, well, hurtStrip, noBudgets: !read().join(" ").match(/^ZP=|\bZR=/) }; })()

- **Expected:** `hurt` begins `["Wounds=−2d", "Initiative=…"]` and `well` begins
  `["Wounds=0", …]`; `hurtStrip` contains `"Wounds −2d"`; `noBudgets` is `true`.
- **Note:** 5 Physical and 4 Stun is one wound step on each track — `floor(5/3) +
  floor(4/3)` — so **−2d**, not −3d. Getting −1d here means only one track is
  being counted.

  The header is the only chrome visible from every tab, so it carries what
  changes every round rather than what was fixed at creation. ZP and ZR moved
  out: the Kismet tab spends ZP (and now shows the effective value beside the
  base, which is what Force is measured against), the Augments tab shows ZR in
  context, and the MAGIC/AMP OFFLINE notes already fire when ZP goes bad.
  Ghost moved to the attribute line (P06-027) and Armor took its slot, being
  the thing you read on every incoming hit.

  `hurtStrip` matters as much as the header: the compact strip is what's on
  screen while you're actually playing, and the wound penalty sitting beside the
  pool pills is what tells you what those dice are currently worth.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-026: The ZR casting penalty chip appears only when it bites
- **Type:** correctness
- **Check:**

      (async () => { const seen = () => [...document.querySelectorAll(".sheet-head .sh-meter .k")].some(k => /ZR Casting Penalty/.test(k.textContent)); const zr = CHAR.house_rules.zr, mt = CHAR.magic.chosen_type, w = JSON.parse(JSON.stringify(CHAR.weapons)); const set = async (rule, type) => { CHAR.house_rules.zr = rule; RULES.setHouseRule("zr", rule); CHAR.magic.chosen_type = type; CHAR.weapons = [{ name: 'Arasaka "Panther" 20mm cannon', equipped: true, mods: [], qty: 1 }]; await recalc(); renderSheet(); return { shown: seen(), type: CALC.magic.type, gearZr: CALC.zoetics.gear_zr }; }; const caster = await set("houserule", "Mage"); const classic = await set("classic", "Mage"); CHAR.weapons = []; await set("houserule", "Mage"); const noGear = seen(); CHAR.house_rules.zr = zr; RULES.setHouseRule("zr", zr); CHAR.magic.chosen_type = mt; CHAR.weapons = w; await recalc(); renderSheet(); return { caster, classicRule: classic.shown, noGear }; })()

- **Expected:**

      { "caster": { "shown": true, "type": "Mage", "gearZr": 3 },
        "classicRule": false, "noGear": false }

- **Note:** Three conditions, and all three have to hold: the `houserule` ZR
  setting (only there is gear ZR a **casting penalty** rather than a budget), a
  character who can cast, and a penalty that is actually non-zero. It spans both
  grid columns so it reads as a condition currently applying rather than a fourth
  standing stat.

  This is the one piece of ZR worth header space, because unlike ZP it genuinely
  moves in play — pick up or holster a chromed weapon and it changes. A mundane
  never sees it. Note the magic priority has to allow the type: setting
  `chosen_type` to Hedge at magic priority 3 resolves to Amp, so test the
  mundane case with a mundane character.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P06-027: Every attribute shows its cap, and Ghost rides the same line
- **Type:** correctness
- **Steps:** Overview tab on a finalized character.
- **Check:**

      (async () => { sheetTab = "overview"; renderSheet(); const chips = [...document.querySelectorAll(".sh-attrs .sh-attr")].map(c => ({ k: c.querySelector(".k").textContent, v: c.querySelector(".v").firstChild.nodeValue, cap: c.querySelector(".cap") ? c.querySelector(".cap").textContent : null, atMax: c.classList.contains("at-max"), ghost: c.classList.contains("ghost") })); const s = CHAR.play.attribute_advances ? JSON.parse(JSON.stringify(CHAR.play.attribute_advances)) : {}; return { count: chips.length, everyAttrHasCap: chips.filter(c => !c.ghost).every(c => c.cap && +c.cap > 0), capsMatchEngine: chips.filter(c => !c.ghost).every((c, i) => +c.cap === CALC.attributes[RULES.ATTRIBUTES[i]].max), last: chips[chips.length - 1], ghostInHeader: [...document.querySelectorAll(".sheet-head .sh-meter .k")].some(k => /Ghost/.test(k.textContent)) }; })()

- **Expected:**

      { "count": 7, "everyAttrHasCap": true, "capsMatchEngine": true,
        "last": { "k": "GHOST", "v": "2d6", "cap": null, "atMax": false, "ghost": true },
        "ghostInHeader": false }

- **Note:** Seven chips — the six attributes plus Ghost, which is a standing
  figure you read off the character rather than a play meter, so it belongs
  beside them and not in the header. Armor took the header slot it vacated.

  `capsMatchEngine` is the point of the case. The corner number reads
  `CALC.attributes[x].max`, **not** a constant, so an augment that raises a
  maximum moves it: Dermal Plating 2 shows Body at `6` with a cap of `22`, not
  20. A hardcoded 20 would pass a casual glance and be wrong for exactly the
  characters who care.

  `last.cap` is `null` on purpose — Ghost has no maximum, so it carries no
  superscript. `atMax` turns it red once value meets cap, which is why being
  maxed reads without doing the comparison yourself.

  The cap is a **superscript inside `.v`**, so the value has to be read as
  `.v.firstChild.nodeValue` — `.v.textContent` would return `"420"` for a
  Strength 4 against a cap of 20 and quietly pass a sloppier assertion.
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

P06-018 to P06-022 cover the other half of that line, and **P06-018 is the one
to run first if anything here looks wrong.** P06-011 proves a play *purchase*
can't reach the creation budget; P06-018 proves nothing else can either. It is
the case the whole `play.kit` refactor exists to keep passing, and a single
`CHANGED` in its output means the shared-object bug is back.

P06-015 to P06-017 are the lifestyle set, added 2026-08-05 after a real
character (Jimmy Chan) turned up showing 4 prepaid months against a chargen
record of 1. They cover the two independent causes: a sync that never
reconciled a corrected chargen record, and a free `+` on the play counter
sitting next to a button that charges for the same month. P06-016 is the one to
watch — it is the only case that would notice the play sheet handing out paid
goods for nothing.
