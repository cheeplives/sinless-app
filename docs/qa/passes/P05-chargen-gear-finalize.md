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

### P05-005: Equipment limit breaches warn but do not block
- **Type:** judgement-probe
- **Check:**

      (async () => { CHAR.priorities = { heritage: 1, magic: 2, attributes: 3, skills: 0, resources: 4 }; const drone = DATA.tables.drones[0].Drone; CHAR.rigs = [{ name: DATA.tables.rigs[0]["Rig Type"], mods: [] }]; CHAR.drones = Array.from({ length: 12 }, () => ({ name: drone, mods: [] })); await recalc(); return { errors: CALC.errors, warnings: CALC.warnings.filter(w => /drone|rig|capacit/i.test(w)) }; })()

- **Expected:** `errors` contains no drone/rig message; `warnings` does.
- **Note:** A character over its rig's drone capacity finalizes cleanly. This is
  JC-003 — mark **JUDGEMENT**.
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
- **Note:** This is JC-002 in the UI: a character can be finalized above the
  rank cap. The case PASSes — the *policy* is the open question.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-009: Finalize requires a name
- **Type:** correctness
- **Check:**

      (async () => { window.__alerts = []; const saved = CHAR.name; CHAR.name = ""; await recalc(); renderPanel(); await finalizeCharacter(); const r = { alerts: window.__alerts.slice(), finalized: CHAR.finalized }; CHAR.name = saved; return r; })()

- **Expected:** `finalized` is `false` and `alerts` contains a message about the
  name.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P05-010: Finalizing over an existing name overwrites it without asking
- **Type:** leak
- **Steps:**
  1. Run the Check. It saves a decoy character, then finalizes a **different**
     character under the same name.
- **Check:**

      (async () => { const decoy = RULES.mergeDefaults({ attributes: { Strength: 9 }, name: "QA Collision" }); STORAGE.cacheCharacter(decoy); const before = STORAGE.loadCharacter("QA Collision").attributes.Strength; CHAR.name = "QA Collision"; CHAR.attributes.Strength = 2; await recalc(); STORAGE.cacheCharacter(CHAR); const after = STORAGE.loadCharacter("QA Collision").attributes.Strength; return { before, after, overwritten: before !== after }; })()

- **Expected:** `{ "before": 9, "after": 2, "overwritten": true }`
- **Note:** No prompt, no rename, no warning — the decoy is gone. This is
  JC-014, and it is silent data loss. Mark **JUDGEMENT** only because the policy
  is undecided; flag it as high severity in your findings either way.
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

## Clean up

```js
(async () => { for (const n of ["QA Collision", "QA Finalize Test"]) { try { await closeTabByName(n); } catch (e) {} localStorage.removeItem("sinless:char:" + STORAGE.sanitizeName(n)); } return "clean"; })()
```

## Wrapping up

Expected JUDGEMENT: **P05-005, P05-008, P05-010**. Everything else should PASS.

P05-007 is the load-bearing one — if an error stops disabling Finalize, every
validation rule in the engine becomes advisory and the whole gate is gone.
