# P02 — Engine: gear, augments and data-apply leaks

**Preconditions for every case:** P00 complete.
**Effort:** 45–60 min. **Fixture:** none except where named.

This pass hunts **data-apply leaks**: a modifier that applies when it should not,
or fails to apply when it should. Most of these cases are deliberately built to
expose an inconsistency rather than a crash, so several are expected to end in
**JUDGEMENT** rather than FAIL. Read the Note under each case before deciding.

Every case uses `resources` priority 4 unless stated. That is not cosmetic — at
lower priorities a cash-overspend error appears and masks whatever the case was
actually testing.

---

## Gear Zoetic Rating: what counts, and when

### P02-001: An unequipped weapon contributes no gear ZR
- **Type:** correctness
- **Check:**

      (() => { const mk = eq => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:false,mods:[],equipped:eq,qty:1}]; return RULES.calculate(c).zoetics.gear_zr; }; return { equipped: mk(true), unequipped: mk(false) }; })()

- **Expected:** `{ "equipped": 2, "unequipped": 0 }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-002: A deck contributes gear ZR only while carried
- **Type:** correctness
- **Check:**

      (() => { const mk = carried => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.decks=[{name:"MasterDeck",mods:[],carried}]; return RULES.calculate(c).zoetics.gear_zr; }; const legacy = (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.decks=[{name:"MasterDeck",mods:[]}]; return RULES.calculate(c).zoetics.gear_zr; })(); return { deckZR: DATA.tables.decks.find(d=>d.Name==="MasterDeck").ZR, carried: mk(true), stashed: mk(false), legacy }; })()

- **Expected:** `{ "deckZR": "1", "carried": 1, "stashed": 0, "legacy": 1 }`
- **Note:** JC-004, ruled **A**. Decks, drones and vehicles now take the same
  permissive `carried !== false` flag misc gear uses, matching P02-001's
  treatment of weapons. `legacy` is the point of the third value: an entry with
  no flag at all — every character predating this — still counts, so nothing
  needed migrating.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-002b: Programs count only when there is a carried deck to run them on
- **Type:** correctness
- **Check:**

      (() => { const base = () => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.programs=["Acid Burn 1"]; return c; }; const noDeck = RULES.calculate(base()).zoetics.gear_zr; const d = base(); d.decks=[{name:"MasterDeck",mods:[],carried:true}]; return { noDeck, withDeck: RULES.calculate(d).zoetics.gear_zr }; })()

- **Expected:** `{ "noDeck": 0, "withDeck": 1 }`
- **Note:** Programs have no carried flag of their own — they are software, and
  the character owns them, not carries them — so JC-004 was applied by tying them
  to the deck. `withDeck` is 1 because `Acid Burn 1` has a blank ZR; the whole
  value is the deck's. Flagged in the JC-004 entry as the one place the ruling
  needed interpretation.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-003: An owned rig contributes gear ZR during creation
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.rigs=[{name:"Basic VCR",mods:[]}]; const k=RULES.calculate(c); return { rigZR: DATA.tables.rigs.find(r=>r["Rig Type"]==="Basic VCR").ZR, gearZr: k.zoetics.gear_zr, activeRig: c.play.rigging.active_rig }; })()

- **Expected:** `{ "rigZR": "1", "gearZr": 1, "activeRig": "" }`
- **Note:** JC-005, ruled **C**. `activeRig` is still `""` — nothing is flagged
  active during creation — but `gearZoeticRating` now resolves the rig through
  `activeGearRow`, which falls back to the first owned one. That is the same
  fallback `deriveExploitActions` and the Rigging tab already used, so all three
  agree. Chargen's Rigging tab gained an **Active rig** selector for choosing
  between several.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-004: The one rule, applied to both
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:false,mods:[],equipped:false,qty:1}]; c.decks=[{name:"MasterDeck",mods:[]}]; const bothOwned = RULES.calculate(c).zoetics.gear_zr; const d = JSON.parse(JSON.stringify(c)); d.decks[0].carried = false; return { bothOwned, deckStashed: RULES.calculate(d).zoetics.gear_zr }; })()

- **Expected:** `{ "bothOwned": 1, "deckStashed": 0 }`
- **Note:** One unequipped rifle (ZR 2, excluded) plus one deck (ZR 1). The deck
  counts while carried and stops when it isn't — the same rule the rifle was
  always under. Before JC-004 the deck counted either way.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Duplicates and stacking

### P02-005: Two copies of the same active armor stack
- **Type:** leak
- **Check:**

      (() => { const mk = n => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.armor = Array.from({length:n}, () => ({name:"Heavy leathers",active:true,extras:[]})); const k = RULES.calculate(c); return { B: k.combat.ballistic_armor, I: k.combat.impact_armor, errors: k.errors.length, warnings: k.warnings }; }; return { one: mk(1), two: mk(2) }; })()

- **Expected:**

      { "one": { "B": 2, "I": 2, "errors": 0, "warnings": [] },
        "two": { "B": 4, "I": 4, "errors": 0,
                 "warnings": ["More than one Outer armor piece is active."] } }

- **Note:** JC-007, ruled **A** — duplicates stack and the player is responsible.
  Both copies apply in full, it warns, it does not block, and nothing
  deduplicates. Unchanged by the ruling; what the ruling added is P02-005b.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-005b: Duplicate decks, programs and gear each warn once
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.decks=[{name:"MasterDeck",mods:[]},{name:"MasterDeck",mods:[]}]; c.programs=["Attack","Attack"]; c.gear=[{name:"Medkit",qty:1},{name:"Medkit",qty:1}]; return RULES.calculate(c).warnings.filter(w => w.includes("more than once")); })()

- **Expected:**

      ["Deck MasterDeck is listed more than once — the copies stack.",
       "Program Attack is listed more than once — the copies stack.",
       "Gear Medkit is listed more than once — the copies stack."]

- **Note:** JC-007's "make sure there are warnings" half. **Once** per repeated
  name, not once per copy — add a third MasterDeck and the list is unchanged.
  Armor is deliberately not in here: its per-slot warning (P02-005) is the more
  useful message, because `active` is what decides whether the copies sum.
  Filtering the warnings keeps the unrelated Hacking-rating message out.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-006: Deactivating the duplicate correctly removes it
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.armor=[{name:"Heavy leathers",active:true,extras:[]},{name:"Heavy leathers",active:false,extras:[]}]; const k=RULES.calculate(c); return { B: k.combat.ballistic_armor, warnings: k.warnings }; })()

- **Expected:** `{ "B": 2, "warnings": [] }`
- **Note:** This is the control for P02-005 — the `active` flag *is* respected
  for armor. Proves the stacking above is about duplicates, not broken gating.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-007: Holding both augment tiers of one family is an error
- **Type:** correctness
- **Fixture:** may also be observed with `synthetic-augmented.json`
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.augments=[{name:"Bone Lacing-Plastic",count:1,target:"",slotted:false,alpha:false},{name:"Bone Lacing-Titanium",count:1,target:"",slotted:false,alpha:false}]; const k=RULES.calculate(c); return { errors: k.errors, warnings: k.warnings, cyberZr: k.zoetics.cyber_zr }; })()

- **Expected:**

      { "errors": ["Bone Lacing: only one tier may be installed — remove all but one of Bone Lacing-Plastic, Bone Lacing-Titanium."],
        "warnings": [], "cyberZr": 2.75 }

- **Note:** JC-008, ruled **A**. The picker hid the lower tier and the engine
  used to take its word for it, so a character arriving by import, homebrew or
  hand-edited JSON kept both. `tallyAugments` now re-checks, using the same
  `augmentTier` / `augmentStacks` helpers the picker calls — so the two can't
  drift apart again. `cyberZr` is unchanged at 2.75: the error doesn't remove
  anything, it refuses to finalize. The error is also play-relevant (JC-012), so
  it survives Finalize.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Smartlink

### P02-008: Smartlink grants +1 Accuracy to a smart weapon
- **Type:** correctness
- **Check:**

      (() => { const mk = withAug => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:true,mods:[],equipped:true,qty:1}]; if (withAug) c.augments=[{name:"Smartlink",count:1,target:"",slotted:false,alpha:false}]; const w = RULES.calculate(c).weapons[0]; return { acc: w.Accuracy, smartlink: !!w.smartlink }; }; return { without: mk(false), with: mk(true) }; })()

- **Expected:** `{ "without": { "acc": "1", "smartlink": false }, "with": { "acc": "2", "smartlink": true } }`
- **Note:** JC-009 is ruled: the match is now against the augments that are
  actually **live** — body augments plus mounted ones whose host is worn — so an
  implanted Smartlink always counts and one mounted on an unworn host does not.
  This case covers the implanted half. The mounted half is not testable against
  the shipped data, because Smartlink is typed Headware and no host will mount
  one; see JC-025.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Ammunition and Barrier

### P02-009: Ammo prose adjusts Pen and Barrier, leaving no leftover note
- **Type:** correctness
- **Check:**

      RULES.ammoStatMods("Pen +1, Barrier +1")

- **Expected:** `{ "acc": 0, "damage": 0, "pen": 1, "bar": 1, "set": {}, "notes": [] }`
- **Note:** `notes` must be **empty**. A non-empty `notes` containing
  `"Barrier +1"` means the Barrier spelling stopped being recognised and the
  adjustment is being silently dropped.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-010: Applying that ammo raises both stats
- **Type:** correctness
- **Check:**

      RULES.applyAmmoStats({ acc: 1, damage: "7", pen: "5", bar: "4" }, RULES.ammoStatMods("Pen +1, Barrier +1"))

- **Expected:** `{ "acc": 1, "damage": "7", "pen": "6", "bar": "5" }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-011: Barrier reaches CALC.weapons
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:false,mods:[],equipped:true,qty:1}]; const w = RULES.calculate(c).weapons[0]; return { Pen: w.Pen, Bar: w.Bar }; })()

- **Expected:** `{ "Pen": "5", "Bar": "4" }`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-012: Barrier's blank-vs-zero convention holds in the data
- **Type:** correctness
- **Check:**

      (() => { const w = n => DATA.tables.weapons.find(x => x.Weapon === n); return { launcherType: w("Ares Grenade Launcher").Type, launcherBar: w("Ares Grenade Launcher").Bar, explosiveBar: w("Explosive Grenade").Bar, katanaBar: w("Katana").Bar, neonFangBar: w("Neon Fang LS").Bar }; })()

- **Expected:**

      { "launcherType": "GrenadeLauncher", "launcherBar": "", "explosiveBar": "5",
        "katanaBar": "", "neonFangBar": "0" }

- **Note:** Blank means "does not apply" (melee, and launchers which inherit from
  the chambered grenade); `"0"` means a real rating of zero. `launcherType` must
  be `GrenadeLauncher` — if it reads `Heavy`, the launcher cannot chamber a
  grenade at all and P06's inheritance cases will fail too.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-013: Every weapon row carries the Bar column
- **Type:** correctness
- **Check:**

      (() => ({ missing: DATA.tables.weapons.filter(r => !("Bar" in r)).map(r => r.Weapon), sentinelX: DATA.tables.weapons.filter(r => r.Bar === "X").map(r => r.Weapon), rows: DATA.tables.weapons.length }))()

- **Expected:** `{ "missing": [], "sentinelX": [], "rows": 106 }`
- **Note:** `Bar` must be present on row 0 or `promote_homebrew.base_columns()`
  silently drops it from promoted homebrew. An `"X"` reappearing means someone
  reintroduced the retired sentinel.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

Every case should PASS. P02-002, P02-003, P02-005 and P02-007 used to be
JUDGEMENT; JC-004, JC-005, JC-007 and JC-008 were all ruled on, and each of those
cases is now a correctness case for the ruled behaviour, joined by the new
P02-002b and P02-005b.

If P02-001 or P02-006 fails, the equipped/active filtering has broken and that is
a real regression — the whole "leak" premise of this pass depends on those two
being the cases that work correctly.
