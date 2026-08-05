# P01 — Engine core: budgets, validation, derived stats

**Preconditions for every case:** P00 complete.
**Effort:** 45–60 min. **Fixture:** none — every case builds its own character.

This pass tests `RULES.calculate()` directly. No UI interaction, no fixtures, no
clicking: each Check is a self-contained expression you paste into
`javascript_tool` exactly as written. That makes the pass fast and makes any
failure unambiguous.

Two things to know before you start:

- **Priorities must be a permutation of 0–4** under the default `classic` house
  rule. If you mistype one and repeat a number, you get the priority error
  instead of whatever the case was testing. Several Expected values below would
  look "wrong" for exactly that reason — do not edit the priority spreads.
- **Errors block finalize; warnings do not.** The distinction is the whole point
  of cases P01-012 and P01-013. Record which list a message lands in, not just
  that a message appeared.

The currency glyph in error messages is `ㄓ` (U+3113). Copy it verbatim.

---

### P01-001: A valid classic priority spread produces no errors and the documented budgets
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type = "Human"; c.lifestyles = [{name:"Squatter",months:1}]; const k = RULES.calculate(c); return { errors: k.errors.length, attr: k.attr_points.budget, skill: k.skill_points.budget, cash: k.priorities.starting_cash }; })()

- **Expected:** `{ "errors": 0, "attr": 32, "skill": 36, "cash": 1200000 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-002: A repeated priority letter is an error
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:1,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type = "Human"; c.lifestyles = [{name:"Squatter",months:1}]; return RULES.calculate(c).errors; })()

- **Expected:** `["Classic priorities: assign each letter A–E exactly once (no repeats)."]`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-003: Out-of-range priority values are silently clamped, never reported
- **Type:** judgement-probe
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:9,magic:-4,attributes:2,skills:3,resources:0}; c.heritage.type = "Human"; c.lifestyles = [{name:"Squatter",months:1}]; return RULES.calculate(c).priorities.values; })()

- **Expected:** `{ "heritage": 4, "magic": 0, "attributes": 2, "skills": 3, "resources": 0 }`
- **Note:** `9` becomes `4` and `-4` becomes `0` with no message. A corrupted or
  hand-edited character therefore silently changes its own budgets. (The clamp
  here also creates a duplicate `0`, so this character *does* report the
  priority error — from the clamping, not from what was written.)
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-004: Point-buy overspend is an error
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.house_rules.priorities = "point"; c.priorities = {heritage:4,magic:4,attributes:4,skills:4,resources:4}; c.heritage.type = "Human"; c.lifestyles = [{name:"Squatter",months:1}]; return RULES.calculate(c).errors; })()

- **Expected:** `["Priorities overspent by 10 point(s)."]`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-005: A magic type not allowed at that priority is silently downgraded
- **Type:** judgement-probe
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:1,magic:0,attributes:2,skills:3,resources:4}; c.heritage.type = "Human"; c.magic.chosen_type = "Archmage"; c.lifestyles = [{name:"Squatter",months:1}]; const k = RULES.calculate(c); return { type: k.magic.type, errors: k.errors.length, warnings: k.warnings.length }; })()

- **Expected:** `{ "type": "Hedge", "errors": 0, "warnings": 0 }`
- **Note:** The character asked for Archmage and got Hedge with no message at
  all. If you think a player should be told, file a JC.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-006: Attribute cost and maximum
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:1,magic:0,attributes:4,skills:3,resources:2}; c.heritage.type = "Human"; c.attributes.Strength = 5; c.lifestyles = [{name:"Squatter",months:1}]; const k = RULES.calculate(c); return { spent: k.attr_points.spent, max: k.attributes.Strength.max, final: k.attributes.Strength.final }; })()

- **Expected:** `{ "spent": 4, "max": 20, "final": 5 }`
- **Note:** `spent` is 4, not 5 — every character gets a refund covering the six
  attributes' mandatory first level.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-007: Overspending attributes errors; exceeding the maximum only warns
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:2,magic:1,attributes:0,skills:3,resources:4}; c.heritage.type = "Human"; c.attributes.Strength = 24; c.lifestyles = [{name:"Squatter",months:1}]; const k = RULES.calculate(c); return { budget: k.attr_points.budget, spent: k.attr_points.spent, errors: k.errors, warnings: k.warnings }; })()

- **Expected:**

      { "budget": 27, "spent": 46,
        "errors": ["Attribute points overspent by 19."],
        "warnings": ["Strength 24 exceeds its maximum of 20."] }

- **Note:** Both fire, in different lists. Being over the maximum is advisory —
  see JC-002.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-008: Condition tracks are 6 + max(1, floor(attribute / 2))
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:1,magic:0,attributes:4,skills:3,resources:2}; c.heritage.type = "Human"; c.attributes.Body = 7; c.attributes.Willpower = 4; c.lifestyles = [{name:"Squatter",months:1}]; return RULES.calculate(c).condition; })()

- **Expected:** `{ "physical": 9, "stun": 8 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-009: Knowledge is 2 × Intelligence, etiquette 2 × Charisma, each capped at 6 per entry
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:1,magic:0,attributes:4,skills:3,resources:2}; c.heritage.type = "Human"; c.attributes.Intelligence = 4; c.attributes.Charisma = 3; c.knowledge_skills = [{name:"Test",points:9}]; c.etiquettes = {Street:7}; c.lifestyles = [{name:"Squatter",months:1}]; return RULES.calculate(c).errors; })()

- **Expected:**

      ["Knowledge skill points overspent.",
       "Knowledge Test: maximum 6 points.",
       "Etiquette points overspent.",
       "Etiquette Street: maximum 6 points."]

- **Note:** Order matters — these are pushed in this sequence.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-010: Melee damage adds the weapon's share of Strength
- **Type:** correctness
- **Check:**

      (() => { const w = n => DATA.tables.weapons.find(x => x.Weapon === n); return { katana: RULES.meleeDamage(w("Katana"), 5), powerFist: RULES.meleeDamage(w("Power Fist"), 5), whip: RULES.meleeDamage(w("Monofilament Whip*"), 5) }; })()

- **Expected:** `{ "katana": "5", "powerFist": "11", "whip": "12" }`
- **Note:** Katana takes half Strength (the default), Power Fist takes all of it,
  the whip's damage is fixed and ignores Strength entirely. Values are
  **strings**, not numbers.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-011: Cash overspend is an error and the remainder goes negative
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:1,magic:2,attributes:4,skills:3,resources:0}; c.heritage.type = "Human"; c.weapons = [{name:'Militech AM-3 "Anti-Matter Rifle"',smart:false,mods:[],equipped:true,qty:1}]; c.lifestyles = [{name:"Squatter",months:1}]; const k = RULES.calculate(c); return { start: k.priorities.starting_cash, spent: k.budget.spent, remaining: k.budget.remaining, errors: k.errors }; })()

- **Expected:**

      { "start": 25000, "spent": 35000, "remaining": -10000,
        "errors": ["Cash overspent by ㄓ10,000."] }

- **Note:** Nothing clamps the remainder at zero. Overspending is a reachable
  state that only the finalize gate refuses.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-012: A skill above the rank cap warns but does not error
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:1,magic:0,attributes:4,skills:3,resources:2}; c.heritage.type = "Human"; c.skills = {Athletics:7}; c.lifestyles = [{name:"Squatter",months:1}]; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:** `{ "errors": [], "warnings": ["Athletics: maximum 6 skill points at creation."] }`
- **Note:** Empty `errors` means this character finalizes. See JC-002.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-013: Finalizing drops the creation-only problems and keeps the rest
- **Type:** correctness
- **Check:** (identical to P01-012 except `finalized = true`)

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:1,magic:0,attributes:4,skills:3,resources:2}; c.heritage.type = "Human"; c.skills = {Athletics:7}; c.finalized = true; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:** `{ "errors": [], "warnings": [] }`
- **Note:** JC-012, ruled **B**. Both of this character's problems — no lifestyle
  and an over-cap skill — are creation rules, and creation is over, so silence is
  correct here. What changed is that the lists are no longer blanked
  *unconditionally*: P01-013b is the other half.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-013b: A finalized character still reports what stays illegal in play
- **Type:** correctness
- **Check:**

      (() => { const d = RULES.defaultCharacter(); d.priorities = {heritage:1,magic:0,attributes:4,skills:3,resources:2}; d.heritage.type = "Human"; d.skills = {Athletics:7, "Unarmed Combat": 1}; d.martial_arts = [{style: "Gun-Kata", rank: 4}]; d.play.cash = -1500; d.finalized = true; const k = RULES.calculate(d); return { errors: k.errors, warnings: k.warnings }; })()

- **Expected:**

      { "errors": ["Martial Arts (Gun-Kata) rank 4 cannot exceed Unarmed Combat rank 1.",
                   "Overdrawn by ㄓ1,500."],
        "warnings": [] }

- **Note:** Same character, plus a martial art above its Unarmed Combat and an
  overdrawn wallet. Athletics 7 is still silent (creation rule); these two aren't
  (they stay wrong at the table). The overdraw is measured against `play.cash`,
  **not** the creation budget — after Finalize the creation budget no longer
  means anything, because play purchases are appended to the same arrays.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-014: A character with no lifestyle cannot finalize
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type = "Human"; return RULES.calculate(c).errors; })()

- **Expected:** `["Choose a lifestyle with at least 1 prepaid month."]`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-015: A lifestyle with zero prepaid months does not satisfy the requirement
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type = "Human"; c.lifestyles = [{name:"Low",months:0}]; return RULES.calculate(c).errors; })()

- **Expected:** `["Choose a lifestyle with at least 1 prepaid month."]`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-016: Skill specializations cost nothing, but need a rank to sit on
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = {heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type = "Human"; c.lifestyles = [{name:"Squatter",months:1}]; const before = RULES.calculate(c).skill_points.spent; const d = JSON.parse(JSON.stringify(c)); d.skill_specializations = { Athletics: {on:true,text:"Running"}, Firearms: {on:true,text:"Rifles"}, Sorcery: {on:true,text:"Fire"} }; const k = RULES.calculate(d); return { before, after: k.skill_points.spent, errors: k.errors, warnings: k.warnings.length }; })()

- **Expected:**

      { "before": 0, "after": 0, "warnings": 0,
        "errors": ["Athletics: a specialization needs at least 1 rank in the skill.",
                   "Firearms: a specialization needs at least 1 rank in the skill.",
                   "Sorcery: a specialization needs at least 1 rank in the skill."] }

- **Note:** JC-001, ruled **B**. `after` is still `0` — specializations remain
  free and uncapped, which is the half of the old behaviour that was kept — but
  all three sit on skills with no ranks, and each is now an error.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P01-017: Martial-art dodge tiers add; soak tiers take the best
- **Type:** correctness
- **Check:**

      (() => { const build = (style, rank) => { const c = RULES.defaultCharacter(); c.name = "MA"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.martial_arts = [{ style, rank }]; return RULES.calculate(c).combat; }; return { weirdingDodge: [1, 3, 4, 6].map(r => build("Weirding Way", r).dodge_bonus), tankDodge: build("Way of the Tank", 5).dodge_bonus, shibumiSoak: build("Shibumi", 6).soak_bonus }; })()

- **Expected:** `{ "weirdingDodge": [1, 1, 2, 2], "tankDodge": 0, "shibumiSoak": 6 }`
- **Note:** Three different rules in one place, and they are deliberately not
  the same.

  **Dodge adds.** Weirding Way grants +1d at L1 and another +1d at L4, for +2d.
  Until 2026-08-05 the L4 row read `"+2d to Dodge (replace level 1)"` and the
  parser took the highest tier — same answer, but the data had to be written as
  a running total, which breaks the moment a third tier or a second
  dodge-granting style exists. The row now reads `"Gain additional +1d to
  dodge"` and the parser sums. **Both halves had to change together:** the new
  wording under the old max rule would have given +1d.

  **Conditional dodge is flavour text.** Way of the Tank L2 is `"+4d to Dodge vs
  1 Tgt"`, and the `vs`/`if` guard keeps it out of the flat bonus — `tankDodge`
  must be `0`.

  **Soak still takes the best.** Shibumi escalates 1→2→4→6 as a replacement
  ladder, so a rank-6 character has +6d, not the +13d a sum would give. If
  `shibumiSoak` comes back `13`, the soak line has been made additive too.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

Expected non-PASS results on a healthy build: **P01-003 and P01-005 are
JUDGEMENT**, not FAIL — they document decided-but-unruled behaviour and neither
has been filed as a JC yet. P01-013 and P01-016 used to be on that list; both
were ruled on (JC-012 and JC-001) and are now correctness cases, joined by the
new P01-013b. Everything else should PASS.

If a *correctness* case fails, that is a real regression in the engine and worth
reporting immediately rather than at the end of the session.
