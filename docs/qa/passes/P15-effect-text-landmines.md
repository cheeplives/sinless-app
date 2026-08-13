# P15 — Effect-text landmines

**Preconditions for every case:** P00 complete.
**Effort:** 15 min. **Fixture:** none — each check builds its own character.

Three cells in `data.js` are worded "wrong" on purpose, and correcting any of
them changes what a character sheet computes. They read as typos or as
abbreviations someone forgot to expand, which is exactly why they are dangerous:
the fix looks like tidying and lands as a rules change.

Every one was found during the effect-text standardization pass, where a style
guide that says "spell out `vs`" and "use the canonical sense name" would have
walked into all three. That document is a temporary working file and will be
deleted when the pass is done. This pass is where the knowledge survives.

Each case has the same shape: run the shipped text, then run the "corrected"
text, and show that the two differ. The second half is the point — a case that
only asserted the current value would pass just as happily after someone made
the change, because the *data* would have moved with it.

Every check restores the cell it mutated and reports `restored: true`. If a check
throws part-way, reload the page before running anything else — `DATA.tables` is
shared, in-memory, and the next pass would be reading edited data.

---

## Senses

### P15-001: Nature Bound's `UV` must not be expanded to "ultraviolet"
- **Type:** correctness
- **Check:**

      (() => { const mk = () => { const c = RULES.defaultCharacter(); c.priorities = {heritage:2, magic:0, attributes:1, skills:3, resources:4}; c.heritage.type = "Green"; c.heritage.features = ["Green Skin", "Nature Bound"]; c.lifestyles = [{ name: "Squatter", months: 1 }]; return c; }; const row = DATA.tables.heritage_features.find(r => r.Name === "Nature Bound"); const before = row.Effects; const shipped = RULES.calculate(mk()).combat.senses; row.Effects = before.replace(/\bUV\b/, "ultraviolet"); const expanded = RULES.calculate(mk()).combat.senses; row.Effects = before; return { shippedText: before, shipped, expanded, restored: row.Effects === before }; })()

- **Expected:**

      { "shippedText": "Cannot cross running water. Skin blisters/burns in UV light. -1d on actions in bright light",
        "shipped": [],
        "expanded": [ { "capability": "Ultraviolet vision",
                        "sources": [ { "name": "Nature Bound", "from": "Heritage" } ] } ],
        "restored": true }

- **Note:** Nature Bound is a **Bane**. The sentence says UV light *burns this
  character*, and `SENSE_CAPABILITIES` (rules.js:2666) matches the literal word
  `ultraviolet` with no notion of whether the clause is a grant or a
  vulnerability. Expanding the abbreviation therefore hands the character
  Ultraviolet vision — a benefit, sourced from their own weakness, shown on the
  Enhanced Senses banner.

  `shipped: []` is the assertion. The empty array is not "nothing to see"; it is
  the whole safety margin, and it holds only because the cell says `UV`.

  A real fix exists and is bigger than a rewrite: the sense parser would need to
  read polarity, so that "burns in ultraviolet light" and "can see in ultraviolet"
  stop being the same string to it. Until that exists, leave the abbreviation
  alone.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Martial arts

### P15-002: Way of the Tank's literal `vs` must not become "versus"
- **Type:** correctness
- **Check:**

      (() => { const mk = () => { const c = RULES.defaultCharacter(); c.priorities = {heritage:2, magic:0, attributes:1, skills:3, resources:4}; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.martial_arts = [{ style: "Way of the Tank", rank: 2 }]; return c; }; const row = DATA.tables.martial_arts.find(r => r.Style === "Way of the Tank" && r.Level === "2"); const before = row.Effect; const s = RULES.calculate(mk()).combat; row.Effect = before.replace(/\bvs\b/, "versus"); const c2 = RULES.calculate(mk()).combat; row.Effect = before; return { text: before, shipped: { dodge: s.dodge_bonus, notes: s.martial_notes, sources: s.dodge_sources }, canonicalized: { dodge: c2.dodge_bonus, notes: c2.martial_notes, sources: c2.dodge_sources }, restored: row.Effect === before }; })()

- **Expected:**

      { "text": "+4d to Dodge vs 1 Tgt",
        "shipped":       { "dodge": 0, "notes": [], "sources": [] },
        "canonicalized": { "dodge": 4, "notes": ["+4d Dodge"], "sources": ["Way of the Tank +4"] },
        "restored": true }

- **Note:** `martialArtStatMods` (rules.js:4196) vetoes a dodge bonus whose
  clause contains a literal `\bvs\b` or `\bif\b`, because those words mark it as
  conditional — here, +4d against **one** target, not against everything. The
  veto is the only thing standing between this row and a permanent +4d Dodge, and
  it is triggered by a two-letter abbreviation that any style guide would tell
  you to spell out.

  `dodge: 0` versus `dodge: 4` is a four-dice swing on every dodge test the
  character ever makes, arriving silently, from a change that reads as
  proofreading.

  Note what the veto costs: the conditional bonus is not applied *or reported*.
  A player reading the sheet sees no trace of it. That is a separate gap worth
  closing — a `Skill Note`-style rider would show the +4d and still not sum it —
  but closing it means restructuring the row, not respelling the word.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Drones

### P15-003: VSTOL Bird's `Stealth` must not be corrected to `Shadow`
- **Type:** correctness
- **Check:**

      (() => { const mk = () => { const c = RULES.defaultCharacter(); c.priorities = {heritage:2, magic:0, attributes:1, skills:3, resources:4}; c.heritage.type = "Human"; c.lifestyles = [{ name: "Squatter", months: 1 }]; c.drones = [{ name: "VSTOL Bird" }]; c.finalized = true; c.play = { rigging: { active: { "drones:0": true } } }; return c; }; const row = DATA.tables.drones.find(r => r.Drone === "VSTOL Bird"); const before = row.Effect; const pick = k => ({ Shadow: k.skills.Shadow.dice_bonus, Recon: k.skills.Reconnaissance.dice_bonus }); const shipped = pick(RULES.calculate(mk())); row.Effect = before.replace(/\bStealth\b/, "Shadow"); const renamed = pick(RULES.calculate(mk())); row.Effect = before; return { text: before, shipped, renamed, restored: row.Effect === before }; })()

- **Expected:**

      { "text": "+4 Recon, Stealth (-6d to target)",
        "shipped": {                "Recon": 4 },
        "renamed": { "Shadow": -6,  "Recon": 4 },
        "restored": true }

  (`shipped` has **no** `Shadow` key. The skill's `dice_bonus` is `undefined`
  because nothing ever set it, and the console drops undefined values — an absent
  key here is the pass condition, not a truncated result.)

- **Note:** `Stealth` is not a skill in this game — `SKILLS` has **Shadow** — so
  the drone's `-6d` currently matches nothing and is inert. That looks like a bug
  to fix, and fixing it inverts the mechanic.

  The `-6d` is a penalty applied to whoever is **shooting at the drone**,
  confirmed by the repo owner. `droneSkillDice` (rules.js:2563) has no concept of
  a target-side modifier: it splits the Effect on `[,.;]` and hands every number
  it finds to the drone's **operator**. Rename the skill and the pilot takes -6d
  on their own Shadow tests, for owning a stealthy drone.

  `Recon: 4` in both columns is the control. That clause is a genuine operator
  bonus and is unaffected either way, which is what shows the difference is the
  skill name and nothing else about the row.

  So the misspelling is load-bearing, and that is an unstable place to leave it.
  The row cannot be fixed without somewhere for a target-side penalty to live —
  there is no such column today. Until there is, `Stealth` stays.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

All three should PASS, and all three pass for an uncomfortable reason: the data
is worded badly and the engine's blind spots happen to cancel out. None of these
is a design anyone would choose.

What each actually needs:

| Row | The real fix |
|---|---|
| Nature Bound | a sense parser that reads polarity, so a vulnerability and a grant stop being the same string |
| Way of the Tank | a way to show a conditional bonus without summing it, so the veto stops being invisible |
| VSTOL Bird | a column for a target-side penalty, so the number stops depending on a misspelling |

Until one of those lands, this pass is the guard. If you are here because a case
FAILED, the likely cause is someone standardizing effect text — check whether the
cell was "corrected" before assuming the engine regressed.
