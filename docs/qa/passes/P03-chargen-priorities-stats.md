# P03 — Chargen UI: priorities, heritage, stats, knowledge

**Preconditions for every case:** P00 complete, chargen mode.
**Effort:** 60 min. **Fixture:** `min-mundane.json`.

The first of three chargen UI passes. These test that what you click changes
`CHAR`, that `CALC` follows, and that the screen tells you the truth about both.

Load the fixture and put it in chargen mode:

```js
(async () => { const raw = await (await fetch("docs/qa/fixtures/min-mundane.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); CHAR.finalized = false; await recalc(); showActiveTab(); return { name: CHAR.name, rule: CHAR.house_rules.priorities }; })()
```

**Expected:** `{ "name": "QA Min Mundane", "rule": "point" }`

## The stepper helper

Steppers are `<span class="stepper"><button>–</button><span class="sv">N</span><button>+</button></span>`
inside a table row that begins with the thing's name. Install this helper once
per session — the cases below use it, and it is far more reliable than clicking
by coordinate:

```js
(() => { window.qaStep = (label, dir, times = 1) => { const tr = [...document.querySelectorAll("#panel tr")].find(r => r.textContent.trim().startsWith(label)); if (!tr) throw new Error("no row: " + label); const btn = tr.querySelector(".stepper").querySelectorAll("button")[dir === "+" ? 1 : 0]; for (let i = 0; i < times; i++) btn.click(); return tr.querySelector(".stepper .sv").textContent; }; return "installed"; })()
```

Clicking the real buttons by hand is equally valid — the helper only saves time.

---

## Priorities

### P03-001: The Priorities tab reports the remaining pool
- **Type:** correctness
- **Steps:**
  1. Click the **Priorities** tab.
- **Check:**

      (async () => { activeTab = "priorities"; await recalc(); renderTabs(); renderPanel(); return document.querySelector("#panel h2").textContent.trim(); })()

- **Expected:** `"Set Starting Priorities 10 left"`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-002: Spending priority points reduces the remainder
- **Type:** correctness
- **Steps:**
  1. On the Priorities tab, raise **Attributes** to 4 and **Skills** to 3.
- **Check:**

      (async () => { CHAR.priorities.attributes = 4; CHAR.priorities.skills = 3; await recalc(); renderPanel(); return { remaining: CALC.priorities.remaining, heading: document.querySelector("#panel h2").textContent.trim(), attrBudget: CALC.attr_points.budget, skillBudget: CALC.skill_points.budget }; })()

- **Expected:** `{ "remaining": 3, "heading": "Set Starting Priorities 3 left", "attrBudget": 46, "skillBudget": 36 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-003: Overspending the pool is an error and shows in the rail
- **Type:** correctness
- **Check:**

      (async () => { CHAR.priorities = { heritage: 4, magic: 4, attributes: 4, skills: 4, resources: 4 }; await recalc(); renderTabs(); renderPanel(); return { errors: CALC.errors, railAlerts: [...document.querySelectorAll("#rail-alerts .alert")].map(n => n.textContent.trim()) }; })()

- **Expected:** `errors` contains `"Priorities overspent by 10 point(s)."` and the
  same text appears in `railAlerts`.
- **Note:** If the error is in `CALC` but not in the rail, the rail is not
  rendering errors and that is a real FAIL — the player would never see it.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-004: Switching to the classic rule asks before rewriting priorities
- **Type:** correctness
- **Check:**

      (async () => { const restore = CHAR; window.CHAR = RULES.defaultCharacter(); CHAR.priorities = { heritage: 2, magic: 2, attributes: 2, skills: 2, resources: 2 }; CHAR.house_rules.priorities = "classic"; RULES.setHouseRule("priorities", "classic"); const before = JSON.parse(JSON.stringify(CHAR.priorities)); window.confirm = () => false; seedClassicPriorities(true); const declined = JSON.parse(JSON.stringify(CHAR.priorities)); window.confirm = () => true; seedClassicPriorities(true); const accepted = JSON.parse(JSON.stringify(CHAR.priorities)); await recalc(); const errors = CALC.errors.length; window.CHAR = restore; await recalc(); return { before, declined, accepted, errors }; })()

- **Expected:** `declined` is identical to `before` (all `2`s — the player's
  allocation survives a cancel), `accepted` is
  `{ heritage: 1, magic: 0, attributes: 4, skills: 3, resources: 2 }`, and
  `errors` is `0`.
- **Note:** JC-021. The rewrite used to happen silently on the switch. It now
  asks, and only the switch asks — opening the Priorities tab passes
  `ask = false`, so declining doesn't re-prompt on every render. A character
  with **nothing** allocated is still seeded without asking; to see that, set
  every priority to `0` first and expect no prompt.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Heritage

### P03-005: Only heritages allowed at the current priority are selectable
- **Type:** correctness
- **Check:**

      (async () => { CHAR.house_rules.priorities = "classic"; CHAR.priorities = { heritage: 0, magic: 1, attributes: 2, skills: 3, resources: 4 }; activeTab = "heritage"; await recalc(); renderPanel(); const opts = [...document.querySelectorAll("#panel select option")].map(o => ({ v: o.value, disabled: o.disabled })); return { allowed: CALC.priorities.allowed_heritages, enabled: opts.filter(o => !o.disabled && o.v).map(o => o.v) }; })()

- **Expected:** `allowed` is `["Human","Replicant"]` and `enabled` contains only
  those two.
- **Note:** If a heritage outside `allowed` is selectable, a player can build an
  illegal character through the UI — a real FAIL.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-006: Raising the heritage priority widens the list
- **Type:** correctness
- **Check:**

      (async () => { CHAR.priorities = { heritage: 4, magic: 1, attributes: 2, skills: 3, resources: 0 }; await recalc(); renderPanel(); return CALC.priorities.allowed_heritages; })()

- **Expected:** `["Blighted","Green","Uplift","Synthetic","Human"]`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Attributes

### P03-007: A stepper writes through to CHAR and CALC
- **Type:** correctness
- **Steps:**
  1. Click the **Stats & Skills** tab.
  2. Click **+** on the **Strength** row three times.
- **Check:**

      (async () => { activeTab = "stats"; await recalc(); renderPanel(); const shown = qaStep("Strength", "+", 3); await recalc(); return { shown, char: CHAR.attributes.Strength, calc: CALC.attributes.Strength.final, spent: CALC.attr_points.spent }; })()

- **Expected:** `{ "shown": "4", "char": 4, "calc": 4, "spent": 3 }`
- **Note:** `spent` is 3 rather than 4 — the mandatory first level of all six
  attributes is refunded.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-008: The stepper clamps at its minimum
- **Type:** correctness
- **Check:**

      (async () => { activeTab = "stats"; await recalc(); renderPanel(); const shown = qaStep("Strength", "–", 20); await recalc(); return { shown, char: CHAR.attributes.Strength }; })()

- **Expected:** `{ "shown": "1", "char": 1 }`
- **Note:** Twenty decrements from 4 must stop at 1, not go to 0 or negative.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-009: The attribute budget chip turns negative rather than blocking
- **Type:** correctness
- **Check:**

      (async () => { CHAR.priorities = { heritage: 4, magic: 1, attributes: 0, skills: 3, resources: 2 }; CHAR.attributes.Strength = 24; activeTab = "stats"; await recalc(); renderPanel(); return { remaining: CALC.attr_points.remaining, heading: document.querySelector("#panel h2").textContent.trim(), errors: CALC.errors, warnings: CALC.warnings }; })()

- **Expected:** `remaining` is `-19`, the heading shows a negative number,
  `errors` contains `"Attribute points overspent by 19."` and `warnings`
  contains `"Strength 24 exceeds its maximum of 20."`
- **Note:** Nothing stops you reaching this state — the finalize gate is the only
  enforcement. Confirm the heading is styled as a problem (red), not just
  showing a minus sign.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Skills and specializations

### P03-010: A skill above the cap warns but the tab still works
- **Type:** correctness
- **Check:**

      (async () => { CHAR.priorities = { heritage: 4, magic: 1, attributes: 2, skills: 3, resources: 0 }; CHAR.attributes.Strength = 1; CHAR.skills = { Athletics: 7 }; activeTab = "stats"; await recalc(); renderPanel(); return { warnings: CALC.warnings, errors: CALC.errors, final: CALC.skills.Athletics.final }; })()

- **Expected:** `errors` is `[]`, `warnings` contains
  `"Athletics: maximum 6 skill points at creation."`, `final` is `7`.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-011: A specialization is free, but needs a rank in its skill
- **Type:** correctness
- **Steps:**
  1. On the Stats tab, find a skill the character has **0** ranks in.
  2. Confirm there is **no Spec toggle** on that row.
  3. Step it up to 1 and confirm the toggle appears without a manual refresh.
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = { heritage: 1, magic: 0, attributes: 2, skills: 3, resources: 4 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.skills = { Sorcery: 2 }; c.skill_specializations = { Sorcery: { on: true, text: "Fire" }, Archery: { on: true, text: "Longbow" } }; const k = RULES.calculate(c); return { spent: k.skill_points.spent, errors: k.errors, sorceryFinal: k.skills.Sorcery.final }; })()

- **Expected:**

      { "spent": 2,
        "errors": ["Archery: a specialization needs at least 1 rank in the skill."],
        "sorceryFinal": 2 }

- **Note:** JC-001, ruled **B**. Specializations stay free and uncapped — `spent`
  counts only the two Sorcery ranks — but the one on Archery (0 ranks) is an
  error. The stored flag is deliberately not cleared, so a skill dropped to 0 and
  raised again keeps its specialization.

  The Check builds its own character rather than touching the loaded one — a
  dangling specialization on the shared `CHAR` would show up as a phantom error
  in P03-012 and P03-013.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Knowledge and etiquette

### P03-012: Knowledge and etiquette budgets track their attributes
- **Type:** correctness
- **Check:**

      (async () => { CHAR.attributes.Intelligence = 4; CHAR.attributes.Charisma = 3; activeTab = "knowledge"; await recalc(); renderPanel(); return { knowledgeBudget: CALC.knowledge.budget, etiquetteBudget: CALC.etiquette_points.budget, heading: document.querySelector("#panel h2").textContent.trim() }; })()

- **Expected:** `knowledgeBudget` is `8` (2 × Intelligence) and
  `etiquetteBudget` is `6` (2 × Charisma).
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-013: Overspending either one is an error, and per-entry caps apply
- **Type:** correctness
- **Check:**

      (async () => { CHAR.knowledge_skills = [{ name: "Test", points: 9 }]; CHAR.etiquettes = { Street: 7 }; await recalc(); return CALC.errors; })()

- **Expected:**

      ["Knowledge skill points overspent.",
       "Knowledge Test: maximum 6 points.",
       "Etiquette points overspent.",
       "Etiquette Street: maximum 6 points."]

- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-014: Gear etiquette bonuses apply, and only while the gear is worn
- **Type:** correctness
- **Check:**

      (() => { const mk = active => { const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:0, attributes:4, skills:2, resources:3 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.attributes.Charisma = 3; c.etiquettes = { Corporate: 2 }; c.armor = [{ name: "Armored Coat", style: "Business wear", material: "", extras: [], active }]; return RULES.calculate(c).etiquette_points; }; const on = mk(true), off = mk(false); return { worn: on.final, notWorn: off.final, adjust: on.adjust, bought: on.values, spent: on.spent, budget: on.budget }; })()

- **Expected:**

      { "worn": { "Civic": 1, "Corporate": 4 }, "notWorn": { "Corporate": 2 },
        "adjust": { "Civic": 1, "Corporate": 2 }, "bought": { "Corporate": 2 },
        "spent": 2, "budget": 6 }

- **Note:** Business wear states "+2 Corp, +1 Civic" in the `armor_styles`
  `Etiquette Bonus` column. Three things are being asserted at once and all three
  matter:

  `notWorn` is the case. The same coat with `active: false` contributes nothing —
  a wardrobe in a closet doesn't change how a room reads you. This mirrors the
  host test `tallyMountedAugments` already uses (`e.active !== false` for armor,
  `equipped` for weapons, `carried` for gear).

  `Civic` appears in `worn` at 1 despite **zero** points bought. An etiquette you
  can only roll because of what you're wearing still has to show up, or the bonus
  is unusable.

  `spent` (3) and `budget` (6) are unmoved by the bonus. Points are what Charisma
  buys; a bonus is neither bought nor spent, so it sits outside both the budget
  and the per-entry cap of 6 — the same way an augment can push an attribute past
  what chargen would sell you. A `spent` of 5 here would mean bonuses are being
  charged to the character.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-015: Sources stack, except Bling with itself
- **Type:** correctness
- **Check:**

      (() => { const base = () => { const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:0, attributes:4, skills:2, resources:3 }; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.attributes.Charisma = 3; return c; }; const two = base(); two.armor = [{ name: "Armored Coat", style: "Business wear", material: "", extras: [], active: true }, { name: "Leather jacket", style: "High Fashion", material: "", extras: [], active: true }]; const mixed = base(); mixed.armor = [{ name: "Armored Coat", style: "Business wear", material: "Superchic (personal designer)", extras: [], active: true }]; const bling = base(); bling.weapons = [{ name: "Militech Whisper 1000", mods: ["Bling"], equipped: true, qty: 1 }, { name: "Militech Whisper 1000", mods: ["Bling"], equipped: true, qty: 1 }]; const spirit = base(); spirit.speaker = { relationships: ["Eriphe the Menad"] }; return { twoCorpSources: RULES.calculate(two).etiquette_points.final.Corporate, styleAndMaterial: RULES.calculate(mixed).etiquette_points.adjust, twoBlingGuns: RULES.calculate(bling).etiquette_points.final.Street, spiritAll: RULES.calculate(spirit).etiquette_points.final }; })()

- **Expected:**

      { "twoCorpSources": 4,
        "styleAndMaterial": { "Aristocratic": 1, "Civic": 1, "Corporate": 2 },
        "twoBlingGuns": 2,
        "spiritAll": { "Aristocratic": 4, "Civic": 4, "Corporate": 4,
                       "Criminal": 4, "Military": 4, "Street": 4, "Wasteland": 4 } }

- **Note:** Two different rules, deliberately: ordinary sources **stack**
  (Business wear +2 Corp and High Fashion +2 Corp make 4), while **Bling** does
  not stack with itself — two blinged guns are still one look, so Street is 2 and
  not 4. Bling's collapsed number then stacks with everything else like any other
  source, so the no-stacking rule stays scoped to Bling.

  `styleAndMaterial` shows a Style and a Material on one piece both landing.
  Superchic reads "+2 to Charisma tests, +1 to Aristocratic etiquette" — if
  Aristocratic comes back as **2** the parser is attaching the Charisma number to
  the wrong clause.

  `spiritAll` covers the "all" keyword. Eriphe the Menad's rider was "+4d to all
  Etiquette Rolls" until v196; it is now stated as a standard modifier so it
  applies like every other source rather than being prose nobody could use.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P03-016: A Markdown round trip restores bought points, not the boosted total
- **Type:** correctness
- **Check:** run on the **play sheet** (`buildMarkdown` lives in `sheet.js`), on a
  finalized character wearing a Business wear piece with Corporate 2 bought.

      (() => { const line = (buildMarkdown().split("\n").find(l => l.startsWith("**Etiquettes:**")) || ""); const parsed = {}; for (const item of line.replace("**Etiquettes:** ", "").split(" · ")) { const em = /^(.+?)\s+(\d+)(?:\s*\([^)]*\))?$/.exec(item.trim()); if (em && +em[2] > 0) parsed[em[1].trim()] = +em[2]; } return { line, parsed, bought: CALC.etiquette_points.values }; })()

- **Expected:** `line` reads `**Etiquettes:** Civic 0 (+1 gear = 1) · Corporate 2
  (+2 gear = 4)`, and `parsed` equals `bought` — `{ "Corporate": 2 }`.
- **Note:** The **bought** value leads and the total follows in parentheses, and
  that order is load-bearing. The importer reads the leading number, so a round
  trip has to restore 2. Exporting the total there would bake the gear bonus into
  the purchased points, and re-applying the gear would then count it twice —
  Corporate 4 becomes 6, then 8, once per trip.

  `Civic 0` parsing to nothing is deliberate: zero bought points is the same as
  no entry, so the cycle stays byte-stable instead of accumulating explicit
  zeroes. The separate `**Etiquette bonuses**` attribution line is derived and is
  skipped on import — it must not appear in `report.unparsedLines` (P14-004).
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

Every case should PASS. P03-004 and P03-011 used to be judgement-probes; both
were ruled on (JC-021 and JC-001) and are now correctness cases.

P03-003 and P03-005 are the two worth escalating immediately if they fail —
between them they are the whole reason a player cannot accidentally build an
illegal character through the UI.
