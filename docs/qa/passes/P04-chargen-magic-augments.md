# P04 — Chargen UI: magic, speaker, augments

**Preconditions for every case:** P00 complete, chargen mode.
**Effort:** 60 min. **Fixtures:** `maxed-mage.json`, `speaker-spirits.json`,
`synthetic-augmented.json`.

Load a fixture into chargen with this, substituting the filename:

```js
(async () => { const raw = await (await fetch("docs/qa/fixtures/FIXTURE.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); CHAR.finalized = false; await recalc(); showActiveTab(); return CHAR.name; })()
```

---

## Magic — `maxed-mage.json`

### P04-001: The Magic tab reports type and Force budget
- **Type:** correctness
- **Check:**

      (async () => { activeTab = "magic"; await recalc(); renderTabs(); renderPanel(); return { heading: document.querySelector("#panel h2").textContent.trim(), type: CALC.magic.type, force: CALC.magic.start_force, remaining: CALC.magic.force_remaining }; })()

- **Expected:**

      { "heading": "Magic — Archmage 26 / 35 Force left6 / 6 ZP left",
        "type": "Archmage", "force": 35, "remaining": 26 }

- **Note:** The heading string runs two chips together with no separator — that
  is how it renders. Copy it exactly.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-002: A spell above the Force cap is an error
- **Type:** correctness
- **Check:**

      (async () => { CHAR.magic.spells = [{ name: "Create Barrier", force: 9 }]; await recalc(); return CALC.errors; })()

- **Expected:** `["Spell Create Barrier: maximum Force is 6."]`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-003: The school restriction applies to Mage, not Archmage
- **Type:** correctness
- **Check:**

      (async () => { CHAR.magic.spells = [{ name: "Create Barrier", force: 4 }, { name: "Rune of the Unspeakable Alarm", force: 2 }]; CHAR.magic.chosen_type = "Archmage"; await recalc(); const asArch = CALC.errors.slice(); CHAR.magic.chosen_type = "Mage"; await recalc(); return { archmage: asArch, mage: CALC.errors }; })()

- **Expected:** `archmage` is `[]`; `mage` contains an out-of-school error naming
  `Rune of the Unspeakable Alarm` (an Auralurgy spell against an Incantor school).
- **Note:** If `mage` is also empty, the school restriction has stopped working —
  a real FAIL. Restore `chosen_type` to `"Archmage"` afterwards.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-004: A Mage must choose a school
- **Type:** correctness
- **Check:**

      (async () => { CHAR.magic.chosen_type = "Mage"; CHAR.magic.school = ""; CHAR.magic.spells = [{ name: "Create Barrier", force: 4 }]; await recalc(); return { errors: CALC.errors, warnings: CALC.warnings }; })()

- **Expected:** `errors` contains `"Mage: choose one School of magic."`.
- **Note:** JC-020, ruled **A**. This was a warning, which meant a schoolless
  Mage could take spells from every school — with `school` empty the
  out-of-school check is skipped entirely — and still finalize. Now it blocks, so
  the check can no longer be dodged by leaving the field blank.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Speaker — `speaker-spirits.json`

### P04-005: The Speaker tab reports both point pools
- **Type:** correctness
- **Check:**

      (async () => { activeTab = "speaker"; await recalc(); renderTabs(); renderPanel(); return { heading: document.querySelector("#panel h2").textContent.trim(), infusion: CALC.magic.infusion_pts, relationship: CALC.magic.relationship_pts }; })()

- **Expected:**

      { "heading": "Speaker 10 / 10 left 0 / 11 left",
        "infusion": { "budget": 10, "spent": 0, "remaining": 10 },
        "relationship": { "budget": 11, "spent": 11, "remaining": 0 } }

- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-006: Overspending relationship points is an error
- **Type:** correctness
- **Check:**

      (async () => { const spirits = DATA.tables.speaker_spirits.map(s => s.Spirit).slice(0, 6); CHAR.speaker.relationships = spirits; await recalc(); return { count: spirits.length, spent: CALC.magic.relationship_pts.spent, errors: CALC.errors }; })()

- **Expected:** `spent` exceeds 11 and `errors` contains a relationship-points
  overspend message.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-007: Reducing the bond count hides the extra slot, it doesn't destroy it
- **Type:** correctness
- **Steps:**
  1. Reload `speaker-spirits.json`.
  2. Enter play mode (P00 §5) and click the **Magic** tab.
  3. Fill both bond slots with a spirit, a Force and a Favors count.
  4. Return to chargen and reduce **Bonds** from 2 to 1.
  5. Raise it back to 2.
- **Check:**

      (async () => { CHAR.finalized = true; ensurePlay(); CHAR.speaker.bonds = 2; CHAR.play.bond_slots = [{ spirit: "Terra Factorem", force: 5, favors: 3 }, { spirit: "Pacha Mama", force: 4, favors: 2 }]; await recalc(); sheetTab = "magic"; renderSheet(); const before = JSON.parse(JSON.stringify(CHAR.play.bond_slots)); CHAR.speaker.bonds = 1; await recalc(); renderSheet(); const shrunk = JSON.parse(JSON.stringify(CHAR.play.bond_slots)); const tiles = document.querySelectorAll(".sh-bond-tile").length; const held = [...document.querySelectorAll(".hint")].some(n => /Held for 1 bond slot/.test(n.textContent)); CHAR.speaker.bonds = 2; await recalc(); renderSheet(); return { before, shrunk, tiles, held, restored: CHAR.play.bond_slots }; })()

- **Expected:** `before`, `shrunk` and `restored` are all the **same two
  populated slots** — Pacha Mama keeps Force 4 and 2 favors throughout. While
  the count is 1, `tiles` is `1` and `held` is `true`: the dormant slot is
  hidden behind a "Held for 1 bond slot(s) you no longer have" hint, not
  deleted.
- **Note:** The slot array is play state and only ever grows. `speaker.bonds`
  decides how much of it is live; every consumer bounds itself with
  `RULES.speakerBondCount()`. Until 2026-08-05 the Magic render truncated the
  array instead, which destroyed the bond permanently — see P04-011 for the
  rules bug that hid behind that truncation.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-011: Bond Control exploits track the bonds bought, not the array length
- **Type:** correctness
- **Steps:** none — pure engine, no render.
- **Check:**

      (async () => { const ctl = c => (((c.combat || {}).exploit_actions) || []).filter(a => a.kind === "Control").reduce((n, a) => n + a.count, 0); const base = JSON.parse(JSON.stringify(CHAR)); const build = bonds => { const c = JSON.parse(JSON.stringify(base)); c.finalized = true; c.speaker.bonds = bonds; c.play = c.play || {}; c.play.bond_slots = [{ spirit: "Terra Factorem", force: 5, favors: 3 }, { spirit: "Pacha Mama", force: 4, favors: 2 }]; return c; }; return { at0: ctl(RULES.calculate(RULES.mergeDefaults(build(0)))), at1: ctl(RULES.calculate(RULES.mergeDefaults(build(1)))), at2: ctl(RULES.calculate(RULES.mergeDefaults(build(2)))), at9: ctl(RULES.calculate(RULES.mergeDefaults(build(9)))) }; })()

- **Expected:** `{ "at0": 0, "at1": 2, "at2": 4, "at9": 4 }` — two Control
  exploit actions per **live** bond, and a hand-edited count above 4 clamps to
  the four bonds the cost table actually sells.
- **Note:** Load `speaker-spirits.json` in chargen first; the case clones
  whatever `CHAR` holds and only overrides the bond fields. Nothing renders, on
  purpose: before 2026-08-05 `deriveExploitActions` counted `bond_slots`
  entries directly, so a character who dropped 2→1 kept all four exploits until
  some view happened to repaint and trim the array. A derived number that
  depends on which tab you last opened is the bug, not the count itself.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Augments — `synthetic-augmented.json`

### P04-008: The picker hides lower tiers of an owned family
- **Type:** correctness
- **Steps:**
  1. Load `synthetic-augmented.json` in chargen and click the **Augments** tab.
  2. Open the augment browser and look for the Bone Lacing entries.
- **Check:**

      (async () => { activeTab = "augments"; await recalc(); renderTabs(); renderPanel(); const txt = document.getElementById("panel").textContent; return { plastic: txt.includes("Bone Lacing-Plastic"), titanium: txt.includes("Bone Lacing-Titanium"), owned: CHAR.augments.map(a => a.name) }; })()

- **Expected:** both tiers appear in `owned` (they are already installed), and
  the *picker* offers neither for a second purchase.
- **Note:** This is the UI half of JC-008 — unchanged by the ruling, since the
  picker always behaved. What changed is that it and the engine now share
  `RULES.augmentTier` / `RULES.augmentStacks`, so they can't drift. The engine
  half is P02-007, where the
  same character produces zero errors.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-009: Synthetic heritage zeroes augment ZR but not cyber ZR
- **Type:** correctness
- **Check:**

      (async () => { await recalc(); return { heritage: CHAR.heritage.type, augmentZr: CALC.zoetics.augment_zr, cyberZr: CALC.zoetics.cyber_zr, zp: CALC.zoetics.zp }; })()

- **Expected:** `{ "heritage": "Synthetic", "augmentZr": 0, "cyberZr": 5.25, "zp": 1 }`
- **Note:** Two different numbers describing the same augments. That is
  deliberate — Synthetics do not pay ZR for cyberware — but confirm the sheet
  shows the one a player expects. `cyberZr` is the fixture's four augments
  summed with no absorption: Bone Lacing-Plastic 0.5 + Bone Lacing-Titanium 2.25
  + Wired Reflexes 1 2 + Smartlink 0.5. Nothing absorbs, because absorption
  needs Cybertechtronic Eyes/Ears or a cyberlimb and the fixture has none.

  This Expected read `4.75` until 2026-08-05, which was simply wrong — the
  pre-rulings engine returns 5.25 for this fixture too, so it was a
  documentation error rather than a regression.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-010: Synthetics cannot install bioware
- **Type:** correctness
- **Check:**

      (async () => { const bio = DATA.tables.augments.find(a => /bio/i.test(a.Type || "")); CHAR.augments = [...CHAR.augments, { name: bio.Name, count: 1, target: "", slotted: false, alpha: false }]; await recalc(); return { added: bio.Name, type: bio.Type, errors: CALC.errors }; })()

- **Expected:** `errors` contains a message that Synthetics cannot install
  Bioware.
- **Note:** If no error appears, either the ban has broken or the augment you
  picked is not actually bioware — check `type` in the output before recording a
  FAIL.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Amps, rituals and the currency rule

Three subsystems that had no coverage at all until 2026-08-05 — no fixture owns
an Amp power or a ritual skill, and the `woolongs` currency rule was untested
anywhere in the suite.

### P04-012: Amp powers cost half their listed ZP
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (() => { const mk = names => { const c = RULES.defaultCharacter(); c.name = "Amp probe"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.priorities = { magic: 4, attributes: 3, skills: 2, resources: 1, heritage: 0 }; c.heritage.type = "Human"; c.magic = { chosen_type: "Amp", school: "", spells: [], amp_powers: names.map(n => ({ name: n, target: "", times: 1 })), archmage_bind: false }; const k = RULES.calculate(c); return { spent: k.zoetics.amp_zp_spent, remaining: k.zoetics.zp_remaining, offline: k.zoetics.amp_offline, errors: k.errors }; }; return { budget: RULES.calculate(Object.assign(RULES.defaultCharacter(), { priorities: { magic: 4, attributes: 3, skills: 2, resources: 1, heritage: 0 } })).zoetics.zp, none: mk([]), two: mk(["Astral Resistance", "Attribute Boost"]), four: mk(["Adrenaline Boost", "Aspect of the Chelonian", "Astral Resistance", "Attribute Boost"]) }; })()

- **Expected:**

      { "budget": 6,
        "none": { "spent": 0,   "remaining": 6,   "offline": false, "errors": [] },
        "two":  { "spent": 1.5, "remaining": 4.5, "offline": false, "errors": [] },
        "four": { "spent": 5.5, "remaining": 0.5, "offline": false, "errors": [] } }

- **Note:** The halving is the point. Astral Resistance (ZP 2) and Attribute
  Boost (ZP 1) list at 3 between them and cost **1.5**; the four-power set lists
  at 11 and costs **5.5**. If `two` reads `3`, the discount has been lost and
  every Amp in play just got half as powerful.

  `offline` stays false throughout — a magic type only goes offline when ZP
  actually runs out, which 11 listed points does not manage against a budget
  of 6.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-013: Ritual skills are accepted and carry no creation cost
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.name = "Ritual probe"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.priorities = { magic: 4, attributes: 3, skills: 2, resources: 1, heritage: 0 }; c.heritage.type = "Human"; c.ritual_skills = { "Raise Ward": 3, "Break Ward": 1 }; const k = RULES.calculate(c); const known = (DATA.tables.rituals || []).map(r => r.Name); return { stored: k.ritual_skills, errors: k.errors, warnings: k.warnings, bothAreRealRituals: ["Raise Ward", "Break Ward"].every(n => known.includes(n)) }; })()

- **Expected:** `stored` echoes `{ "Raise Ward": 3, "Break Ward": 1 }`,
  `errors` and `warnings` are `[]`, and `bothAreRealRituals` is `true`.
- **Note:** Ritual skills are keyed by name against the `rituals` table and are
  advanced in play through `play.ritual_advances`, which P08 checks is
  persisted. This case is the chargen half — mostly a guard that the map
  survives `calculate` intact, since a rename in the `rituals` table would
  silently orphan every stored ritual. `bothAreRealRituals` is what catches
  that.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-014: The currency house rule renames money everywhere
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (() => { const name = cur => { const c = RULES.defaultCharacter(); c.house_rules = { ...c.house_rules, currency: cur }; RULES.calculate(c); return RULES.currencyName(); }; return { zuzus: name("zuzus"), woolongs: name("woolongs"), backAgain: name("zuzus") }; })()

- **Expected:** `{ "zuzus": "Zuzus", "woolongs": "Woolongs", "backAgain": "Zuzus" }`
- **Note:** The only house rule with no coverage before 2026-08-05. It is
  cosmetic but wide — `currencyName()` feeds every cash label in both UIs, the
  Activity ledger and the markdown export.

  `backAgain` is the real assertion: `activeHouseRules` is module-level state
  set by whichever `calculate` ran last, so this case also proves the rule
  follows the character rather than sticking globally after one is opened.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P04-015: Amp-offline is a Classic-only, ZP≤0 state -- the ZR Casting Penalty house rule never has one
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (() => { const mk = () => { const c = RULES.defaultCharacter(); c.name = "ZR Amp probe"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.priorities = { magic: 4, attributes: 3, skills: 2, resources: 1, heritage: 0 }; c.heritage.type = "Human"; c.house_rules = { ...c.house_rules, zr: "houserule" }; return c; }; const zrRow = DATA.tables.weapons.find(r => (+r.ZR || 0) >= 3); const gearOnly = mk(); gearOnly.magic = { chosen_type: "Amp", school: "", spells: [], amp_powers: [], archmage_bind: false }; gearOnly.weapons = [{ name: zrRow.Weapon, equipped: true }]; gearOnly.skills = { Sorcery: 3 }; const g = RULES.calculate(gearOnly); const allPowers = DATA.tables.amp_powers.map(r => ({ name: r.Name, target: "", times: 1 })); const overspend = mk(); overspend.magic = { chosen_type: "Amp", school: "", spells: [], amp_powers: allPowers, archmage_bind: false }; const o = RULES.calculate(overspend); const classic = mk(); classic.house_rules.zr = "classic"; classic.magic = { chosen_type: "Amp", school: "", spells: [], amp_powers: allPowers, archmage_bind: false }; const cl = RULES.calculate(classic); const zeroOut = mk(); zeroOut.house_rules.zr = "classic"; zeroOut.magic = { chosen_type: "Amp", school: "", spells: [], amp_powers: [{ name: "Astral Resistance", target: "", times: 6 }], archmage_bind: false }; const cz = RULES.calculate(zeroOut); const oneLeft = mk(); oneLeft.house_rules.zr = "classic"; oneLeft.magic = { chosen_type: "Amp", school: "", spells: [], amp_powers: [{ name: "Astral Resistance", target: "", times: 5 }], archmage_bind: false }; const co = RULES.calculate(oneLeft); return { gearOnly: { gearZr: g.zoetics.gear_zr, magicOffline: g.zoetics.magic_offline, ampOffline: g.zoetics.amp_offline, castPenalty: g.skills.Sorcery.notes }, overspend: { magicOffline: o.zoetics.magic_offline, ampOffline: o.zoetics.amp_offline }, classicOverspend: { magicOffline: cl.zoetics.magic_offline, ampOffline: cl.zoetics.amp_offline }, classicExactlyZero: { zpRemaining: cz.zoetics.zp_remaining, ampOffline: cz.zoetics.amp_offline }, classicOneLeft: { zpRemaining: co.zoetics.zp_remaining, ampOffline: co.zoetics.amp_offline } }; })()

- **Expected:**

      { "gearOnly": { "gearZr": 3, "magicOffline": false, "ampOffline": false,
                       "castPenalty": ["−3d on casting rolls (gear/weapon ZR 3)"] },
        "overspend": { "magicOffline": true, "ampOffline": false },
        "classicOverspend": { "magicOffline": false, "ampOffline": true },
        "classicExactlyZero": { "zpRemaining": 0, "ampOffline": true },
        "classicOneLeft": { "zpRemaining": 1, "ampOffline": false } }

- **Note:** Reported bug: "gear ZR shouldn't be able to take Amp powers
  offline under the ZR Casting Penalty house rule — it's only supposed to
  penalise casting." Root cause was in `calculate()` (`static/rules.js`):
  `zpRemaining` under the house rule already excluded gear ZR (gear ZR was
  always a casting-penalty-only effect, per `gearOnly.gearZr: 3` still landing
  a `−3d` Sorcery note with nothing going offline), but `ampOffline` was wired
  to `houseZr ? magicOffline : ...` — a hard alias, not a real removal. So
  whenever cyber ZR or Amp overspend zeroed ZP (`overspend`), the engine
  reported **two** offline flags for the same cause: `magic_offline` (the
  correct "Spells, Amps and Summoning are unavailable" banner) AND
  `amp_offline` (a second, redundant "AMP POWERS OFFLINE" callout on the Amp
  Powers card, `sheet.js` ~8024).

  The fix pins `ampOffline` to `false` outright under the house rule — Amp
  powers have no offline state of their own there; they go dark only through
  the shared `magicOffline` banner (cyber ZR/Amp overspend), never their own
  flag or callout box, and gear ZR only ever shows up as the casting penalty.

  Amp-offline stays a real, distinct mechanic under Classic, though — total
  carried ZR (gear included) reduces ZP there, and `hasAmpPowers && zpRemaining
  <= 0` is what should flip Amp powers dark. A first pass at this fix left
  Classic's comparison at the pre-existing `< 0`, one point too strict:
  `classicExactlyZero` spends exactly the ZP budget (`zpRemaining: 0`) and
  must read `ampOffline: true`; `classicOneLeft` (`zpRemaining: 1`) proves the
  case doesn't just trigger on any spend.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

Expected JUDGEMENT: **P04-008**. P04-004 was ruled on (JC-020) and is now a
correctness case. P04-007 was a genuine data-loss bug and is fixed as of
2026-08-05 — it and its companion P04-011 are both plain correctness cases now,
and either one failing means bond slots have gone back to being trimmed in
place.
