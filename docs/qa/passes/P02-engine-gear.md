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

### P02-002: A deck contributes gear ZR unconditionally
- **Type:** leak
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.decks=[{name:"MasterDeck",mods:[]}]; return { deckZR: DATA.tables.decks.find(d=>d.Name==="MasterDeck").ZR, gearZr: RULES.calculate(c).zoetics.gear_zr }; })()

- **Expected:** `{ "deckZR": "1", "gearZr": 1 }`
- **Note:** There is no equipped/carried flag on a deck at all — merely owning
  one adds its ZR. Compare with P02-001, where an owned-but-unequipped weapon
  adds nothing. This is JC-004; mark **JUDGEMENT**.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-003: A rig never contributes gear ZR during creation
- **Type:** leak
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.rigs=[{name:"Basic VCR",mods:[]}]; const k=RULES.calculate(c); return { rigZR: DATA.tables.rigs.find(r=>r["Rig Type"]==="Basic VCR").ZR, gearZr: k.zoetics.gear_zr, activeRig: c.play.rigging.active_rig }; })()

- **Expected:** `{ "rigZR": "1", "gearZr": 0, "activeRig": "" }`
- **Note:** The rig has a ZR of 1 in the data but contributes 0, because rigs are
  filtered on `play.rigging.active_rig` — which is empty for the whole of
  character creation. This is JC-005; mark **JUDGEMENT**.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-004: The two rules side by side
- **Type:** leak
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:false,mods:[],equipped:false,qty:1}]; c.decks=[{name:"MasterDeck",mods:[]}]; return RULES.calculate(c).zoetics.gear_zr; })()

- **Expected:** `1`
- **Note:** One unequipped rifle (ZR 2, excluded) plus one deck (ZR 1, included)
  on the same character. If you rule on JC-004, this is the case that changes.
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

- **Note:** Both copies apply in full. It warns, it does not block, and nothing
  deduplicates. This is JC-007; mark **JUDGEMENT**.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-006: Deactivating the duplicate correctly removes it
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.armor=[{name:"Heavy leathers",active:true,extras:[]},{name:"Heavy leathers",active:false,extras:[]}]; const k=RULES.calculate(c); return { B: k.combat.ballistic_armor, warnings: k.warnings }; })()

- **Expected:** `{ "B": 2, "warnings": [] }`
- **Note:** This is the control for P02-005 — the `active` flag *is* respected
  for armor. Proves the stacking above is about duplicates, not broken gating.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P02-007: Both augment tiers of one family coexist
- **Type:** leak
- **Fixture:** may also be observed with `synthetic-augmented.json`
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.augments=[{name:"Bone Lacing-Plastic",count:1,target:"",slotted:false,alpha:false},{name:"Bone Lacing-Titanium",count:1,target:"",slotted:false,alpha:false}]; const k=RULES.calculate(c); return { errors: k.errors, warnings: k.warnings, cyberZr: k.zoetics.cyber_zr }; })()

- **Expected:** `{ "errors": [], "warnings": [], "cyberZr": 2.75 }`
- **Note:** The picker UI hides a lower tier once a higher one is owned, but the
  engine never re-checks, so a character built by import, homebrew or hand-edited
  JSON keeps both. This is JC-008; mark **JUDGEMENT**.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Smartlink

### P02-008: Smartlink grants +1 Accuracy to a smart weapon
- **Type:** correctness
- **Check:**

      (() => { const mk = withAug => { const c = RULES.defaultCharacter(); c.priorities={heritage:1,magic:2,attributes:3,skills:0,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.weapons=[{name:"Kalishnikov A-80",smart:true,mods:[],equipped:true,qty:1}]; if (withAug) c.augments=[{name:"Smartlink",count:1,target:"",slotted:false,alpha:false}]; const w = RULES.calculate(c).weapons[0]; return { acc: w.Accuracy, smartlink: !!w.smartlink }; }; return { without: mk(false), with: mk(true) }; })()

- **Expected:** `{ "without": { "acc": "1", "smartlink": false }, "with": { "acc": "2", "smartlink": true } }`
- **Note:** The match is on augment **name only** — it does not check whether the
  Smartlink is mounted on uncarried gear or otherwise inactive. That gap is
  JC-009; this case only confirms the bonus itself works.
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

On a healthy build, **P02-002, P02-003, P02-005 and P02-007 are JUDGEMENT** —
each documents a known inconsistency with an existing JC entry. Everything else
should PASS.

If P02-001 or P02-006 fails, the equipped/active filtering has broken and that is
a real regression — the whole "leak" premise of this pass depends on those two
being the cases that work correctly.
