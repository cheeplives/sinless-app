# P05 — Chargen UI: weapons, decks, drones, gear, and the finalize gate

**Preconditions for every case:** P00 complete, chargen mode, dialog stubs
installed (§3) — the finalize cases raise a confirm.
**Effort:** 60 min. **Fixture:** `min-mundane.json`.

Load and set a classic priority spread with a modest budget:

```js
(async () => { const raw = await (await fetch("docs/qa/fixtures/min-mundane.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); CHAR.finalized = false; CHAR.house_rules.priorities = "classic"; CHAR.priorities = { heritage: 1, magic: 2, attributes: 3, skills: 4, resources: 0 }; await recalc(); showActiveTab(); return { cash: CALC.budget.starting_cash, errors: CALC.errors.length }; })()
```

**Expected:** `{ "cash": 25000, "errors": 1 }` — the one error is the missing
lifestyle, which P05-008 fixes.

---

## Equipment tabs

### P05-001: Every equipment tab shows the cash chip
- **Type:** correctness
- **Check:**

      (async () => { const out = {}; for (const t of ["weapons","decks","drones","gear"]) { activeTab = t; await recalc(); renderTabs(); renderPanel(); out[t] = document.querySelector("#panel h2").textContent.trim(); } return out; })()

- **Expected:**

      { "weapons": "Weapons ㄓ25,000 left", "decks": "Decks ㄓ25,000 left",
        "drones": "Rigs ㄓ25,000 left", "gear": "Gear ㄓ25,000 left" }

- **Note:** The Drones tab's heading reads "Rigs". That is the existing wording,
  not a bug.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-002: Buying reduces the remaining cash on every tab
- **Type:** correctness
- **Steps:**
  1. Click the **Weapons** tab.
  2. Expand a category and click a weapon to add it.
- **Check:**

      (async () => { CHAR.weapons = [{ name: "Kalishnikov A-80", smart: false, mods: [], equipped: true, qty: 1 }]; activeTab = "weapons"; await recalc(); renderPanel(); return { spent: CALC.budget.spent, remaining: CALC.budget.remaining, heading: document.querySelector("#panel h2").textContent.trim() }; })()

- **Expected:** `spent` is the weapon's price, `remaining` is `25000 - spent`,
  and the heading shows the same remaining figure.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-003: The same mod fitted twice warns but is allowed
- **Type:** correctness
- **Check:**

      (async () => { CHAR.weapons = [{ name: "Kalishnikov A-80", smart: false, mods: ["Laser Sight", "Laser Sight"], equipped: true, qty: 1 }]; await recalc(); return { errors: CALC.errors, warnings: CALC.warnings }; })()

- **Expected:** `errors` is `[]`; `warnings` contains
  `"Kalishnikov A-80: Laser Sight fitted more than once."`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-004: Barrier appears on the weapon stat lines
- **Type:** correctness
- **Check:**

      (async () => { CHAR.weapons = [{ name: "Kalishnikov A-80", smart: false, mods: [], equipped: true, qty: 1 }, { name: "Katana", smart: false, mods: [], equipped: true, qty: 1 }]; activeTab = "weapons"; await recalc(); renderPanel(); return [...document.querySelectorAll("#panel tr .sub")].map(n => n.textContent.trim()).filter(t => /Acc |melee/.test(t)); })()

- **Expected:** the rifle's line contains `Pen 5 · Barrier 4`; the Katana's line
  contains `Pen 1 AP` with **no** Barrier segment at all.
- **Note:** A blank Barrier must print nothing rather than `Barrier 0` — melee
  weapons have no rating, which is different from a rating of zero.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-005: Slot breaches block; capacity breaches only warn
- **Type:** correctness
- **Check:**

      (async () => { CHAR.priorities = { heritage: 1, magic: 2, attributes: 3, skills: 0, resources: 4 }; CHAR.skill_specializations = {}; const rig = DATA.tables.rigs[0]; CHAR.rigs = [{ name: rig["Rig Type"], mods: DATA.tables.rig_mods.map(m => m["Rig Mod"]) }]; const drone = DATA.tables.drones[0]; CHAR.drones = [{ name: drone.Drone, weapons: DATA.tables.drone_ballistic_weapons.slice(0, 3).map(w => w["Drone Ballistic Weapon"]), mods: [] }]; await recalc(); return { errors: CALC.errors.filter(e => /slot|hard point/i.test(e)), warnings: CALC.warnings.filter(w => /weight|WW/i.test(w)) }; })()

- **Expected:**

      { "errors": ["Basic VCR: 5 mod slot(s) used but only 1 available.",
                   "Bug-Spy: 3 weapons mounted — only 0 hard point(s)."],
        "warnings": ["Bug-Spy: fitted weight 3 exceeds WW 0."] }

- **Note:** JC-003, ruled **C**, and this case is the whole ruling in one output.
  Mod slots and hard points are physical mounting points — there is nowhere to
  put the thing — so they block. Loaded weight against WW is a capacity, so it
  advises. The same drone raises one of each. Also still warnings: a deck's
  required Hacking rating, a vehicle's leftover Cargo, and the Body ÷ 3 vehicle
  weapon cap (a formula, unlike the drone's countable hard points).
  `skill_specializations` is cleared first because an earlier case may have left
  one behind, and its error would drown the filter.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-006: Overspending cash is an error and the chip goes negative
- **Type:** correctness
- **Check:**

      (async () => { CHAR.priorities = { heritage: 1, magic: 2, attributes: 3, skills: 4, resources: 0 }; CHAR.drones = []; CHAR.rigs = []; CHAR.weapons = [{ name: 'Militech AM-3 "Anti-Matter Rifle"', smart: false, mods: [], equipped: true, qty: 1 }]; activeTab = "gear"; await recalc(); renderPanel(); return { remaining: CALC.budget.remaining, errors: CALC.errors.filter(e => /Cash/.test(e)) }; })()

- **Expected:** `remaining` is `-10000` and `errors` contains
  `"Cash overspent by ㄓ10,000."`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## The finalize gate

### P05-007: An error disables Finalize
- **Type:** correctness
- **Steps:**
  1. Click the **Gear** tab — Finalize only appears on the last tab.
  2. Observe the Finalize button while the cash error from P05-006 stands.
- **Check:**

      (() => { const b = [...document.querySelectorAll("#app button")].find(x => /finali/i.test(x.textContent)); return { found: !!b, disabled: b ? b.disabled : null, errors: CALC.errors.length }; })()

- **Expected:** `found` is `true`, `disabled` is `true`, `errors` is non-zero.
- **Note:** If `found` is `false` you are not on the Gear tab. The button exists
  only there.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-008: A warning alone does not disable Finalize
- **Type:** correctness
- **Check:**

      (async () => { CHAR.weapons = []; CHAR.lifestyles = [{ name: "Squatter", months: 1 }]; CHAR.skills = { Athletics: 7 }; activeTab = "gear"; await recalc(); renderPanel(); const b = [...document.querySelectorAll("#app button")].find(x => /finali/i.test(x.textContent)); return { errors: CALC.errors, warnings: CALC.warnings, disabled: b ? b.disabled : null }; })()

- **Expected:** `errors` is `[]`, `warnings` contains the Athletics cap message,
  `disabled` is `false`.
- **Note:** JC-002, ruled **C**: cap breaches stay warnings, so this character
  still finalizes. What changed is reachability — the Stats tab's skill stepper
  now stops at `RULES.SKILL_RANK_CAP` and each attribute stepper at the largest
  base that keeps Final inside its maximum, so 7 is only reachable the way this
  case does it: by writing the value directly.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-009: Finalize requires a name
- **Type:** correctness
- **Check:**

      (async () => { window.__alerts = []; const saved = CHAR.name; CHAR.name = ""; await recalc(); renderPanel(); await finalizeCharacter(); const r = { alerts: window.__alerts.slice(), finalized: CHAR.finalized }; CHAR.name = saved; return r; })()

- **Expected:** `finalized` is `false` and `alerts` contains a message about the
  name.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-010: A name collision is detected before it overwrites anything
- **Type:** correctness
- **Steps:**
  1. Run the Check. It saves a decoy character, then asks whether a **different**
     character would land in the decoy's slot.
  2. Then, by hand: name the open character `QA Collision`, save the decoy again,
     and press **Finalize**. Confirm the prompt names the decoy and that
     cancelling leaves it intact.
- **Check:**

      (async () => { const decoy = RULES.mergeDefaults({ attributes: { Strength: 9 }, name: "QA Collision" }); STORAGE.cacheCharacter(decoy); window.CHAR = RULES.defaultCharacter(); CHAR.name = "QA  Collision"; CHAR.attributes.Strength = 2; const clash = STORAGE.collidingCharacter(CHAR); const self = STORAGE.collidingCharacter(STORAGE.loadCharacter("QA Collision")); const free = STORAGE.collidingCharacter({ name: "QA Definitely Unused" }); return { clash, self, free, sanitisesSame: STORAGE.sanitizeName("QA  Collision") === STORAGE.sanitizeName("QA Collision") }; })()

- **Expected:**

      { "clash": "QA Collision", "self": null, "free": null, "sanitisesSame": true }

- **Note:** JC-014, ruled **A**. `clash` returns the **stored** character's own
  name, which is what the prompt shows — note the two-space spelling collides
  with the one-space one, since both sanitise to `QA-Collision`. `self` is null
  because a character loaded from a slot carries `saved_as`, so re-saving itself
  isn't a collision. Finalize and the sheet's Save both check this; nothing else
  does, so `STORAGE.cacheCharacter` called directly still overwrites — that is
  the low-level write, not the user action.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-011: A successful finalize enters play mode
- **Type:** correctness
- **Check:**

      (async () => { CHAR.name = "QA Finalize Test"; CHAR.skills = {}; CHAR.lifestyles = [{ name: "Squatter", months: 1 }]; activeTab = "gear"; await recalc(); renderPanel(); await finalizeCharacter(); return { finalized: CHAR.finalized, cashRolled: CHAR.play.cash_rolled, ghost: CHAR.play.ghost_rating, sheetVisible: !document.getElementById("sheet").hidden }; })()

- **Expected:** `finalized` is `true`, `cashRolled` is `true`, `ghost` is a
  number between 2 and 12, and the sheet is visible.
- **Note:** Starting cash and ghost rating are rolled **once** and guarded — run
  finalize twice and they must not change. Verify with P05-012.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-012: Re-finalizing does not re-roll starting cash
- **Type:** correctness
- **Check:**

      (async () => { const before = { cash: CHAR.play.starting_cash, ghost: CHAR.play.ghost_rating }; CHAR.finalized = false; await recalc(); await finalizeCharacter(); return { before, after: { cash: CHAR.play.starting_cash, ghost: CHAR.play.ghost_rating }, stable: before.cash === CHAR.play.starting_cash && before.ghost === CHAR.play.ghost_rating }; })()

- **Expected:** `stable` is `true`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

### P05-013: Removing the last deck refunds the Hacking program rating
- **Type:** leak
- **Steps:** none — the Check builds its own character and clicks the real ✕.
- **Check:**

      (async () => { const setup = rating => { CHAR = RULES.defaultCharacter(); CHAR.name = "Hack refund"; CHAR.priorities = { heritage: 4, magic: 5, attributes: 2, skills: 3, resources: 1 }; CHAR.heritage.type = "Human"; CHAR.lifestyles = [{ name: "Squatter", months: 1 }]; CHAR.hacking_rating = rating; }; const cat = () => CALC.budget.categories["Decks and Programs"]; const kill = async re => { const row = [...document.querySelectorAll("#panel table tr")].find(r => re.test(r.textContent) && r.querySelector(".row-del")); if (!row) return "no row"; row.querySelector(".row-del").click(); await new Promise(r => setTimeout(r, 220)); await recalc(); return "ok"; }; const out = {}; setup(6); CHAR.decks = [{ name: "MasterDeck", mods: [] }]; activeTab = "decks"; await recalc(); renderTabs(); renderPanel(); out.before = { cat: cat(), rating: CHAR.hacking_rating }; await kill(/MasterDeck/); out.afterLastDeck = { cat: cat(), rating: CHAR.hacking_rating, cashLeft: CALC.budget.remaining }; setup(6); CHAR.decks = [{ name: "MasterDeck", mods: [] }, { name: "Shingo Activa", mods: [] }]; activeTab = "decks"; await recalc(); renderTabs(); renderPanel(); await kill(/MasterDeck/); out.stillOneDeck = { rating: CHAR.hacking_rating, decks: CHAR.decks.length }; return out; })()

- **Expected:**

      { "before":         { "cat": 44000, "rating": 6 },
        "afterLastDeck":  { "cat": 0, "rating": 0, "cashLeft": 60000 },
        "stillOneDeck":   { "rating": 6, "decks": 1 } }

- **Note:** The rating is a separate ㄓ5,000/level line from the deck itself, so
  losing the last deck used to leave it standing and still billed — a reported
  ㄓ30,000 (6 levels) sitting in the Cost Breakdown under a hint that read "No
  decks owned — no rating required".

  `stillOneDeck` is the guard on the other side: removing one deck of two must
  **not** touch the rating, because the remaining deck still needs it. Fitted
  mods were never part of this — they live on the deck object and have always
  gone with it, which is worth knowing when a report blames them.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-014: The buying list shows what the item has, and Polymer Oneshot pistols say so in their name
- **Type:** correctness
- **Steps:** none.
- **Check:**

      (async () => { CHAR = RULES.defaultCharacter(); CHAR.name = "QA Buying List"; CHAR.priorities = { heritage: 2, magic: 0, attributes: 3, skills: 2, resources: 3 }; CHAR.heritage.type = "Human"; activeTab = "weapons"; await recalc(); renderTabs(); renderPanel(); document.querySelectorAll(".cat-head").forEach(h => h.click()); const items = [...document.querySelectorAll(".cat-item")]; const findItem = name => { const it = items.find(x => x.querySelector("b").textContent === name); return it ? it.querySelector(".sub").textContent : null; }; const posSub = findItem("Teen Dreem (POS)"); const armorSub = findItem("Battle Armor"); const oldNamed = RULES.mergeDefaults({ name: "x", weapons: [{ name: "Teen Dreem", equipped: true }] }); return { posSub, armorHasZR: /ZR 2/.test(armorSub || ""), armorHasRarity: /Rarity 4/.test(armorSub || ""), migratedName: oldNamed.weapons[0].name }; })()

- **Expected:**

      { "posSub": "Rarity 2 · ZR 1 · Acc 0 · SS, BF · Weight 1 · Pen 2 · Barrier 0 · Conceal 1 · Damage 2 · Polymer Oneshot, cannot be reloaded",
        "armorHasZR": true, "armorHasRarity": true, "migratedName": "Teen Dreem (POS)" }

- **Note:** Reported bug (issue #63), two parts. Part 1: the buying list
  didn't say what an item actually had — a weapon's Oneshot flag ("Polymer
  Oneshot, cannot be reloaded") and integrated mods were only shown on the
  OWNED row (`weaponTraitBits` was already wired into `tabWeapons`'s owned
  render and `sheet.js`'s play-mode row, just never into the picker's `sub`
  line), and armor's picker line was thinner than everything else on the tab
  — Ballistic/Impact/weight only, no ZR or Rarity, when both were sitting
  right there on the row. `posSub` and the two `armorHas*` flags are the
  regression guard: pull the picker's stat line for a known Oneshot pistol and
  a known armor piece and check the fields are actually in it.

  Part 2: every Polymer Oneshot pistol's row got "(POS)" appended to its
  `Weapon` name in `data.js`, so it reads unmistakably even without stopping
  to parse the stat line. A weapon resolves by name everywhere on a saved
  character (`RULES.RENAMED_WEAPONS`'s own doc comment explains why), so the
  rename ships with seven new entries there — old name in, new name out,
  forever, the same contract `RENAMED_AUGMENTS`/`RENAMED_SPIRITS`/
  `RENAMED_SPELLS` already keep. `migratedName` is that guard: build a
  character with the OLD "Teen Dreem" name and confirm `mergeDefaults` hands
  back "Teen Dreem (POS)", not an orphaned weapon pricing at ㄓ0. P06-046
  through P06-049 (the Loadout hand-assignment suite) already exercised the
  renamed `KL-89 "Klaw" (POS)` end to end — picker option text, `.name ===`
  lookups on `play.kit.weapons`, all updated and re-verified against a real
  headless-Chromium run before this landed, so this case doesn't repeat that
  ground.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Clean up

```js
(async () => { for (const n of ["QA Collision", "QA Finalize Test"]) { try { await closeTabByName(n); } catch (e) {} localStorage.removeItem("sinless:char:" + STORAGE.sanitizeName(n)); } return "clean"; })()
```

## Wrapping up

Every case should PASS. P05-005 and P05-010 used to be JUDGEMENT / leak cases;
JC-003 and JC-014 were ruled on and both are now correctness cases. P05-008 was
always a PASS and stays one — JC-002 kept the warning and only made it
unreachable through the UI.

P05-007 is the load-bearing one — if an error stops disabling Finalize, every
validation rule in the engine becomes advisory and the whole gate is gone.
