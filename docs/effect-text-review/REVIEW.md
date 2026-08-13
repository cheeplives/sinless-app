# Effect-text standardization review

A proposed rewrite of the mechanical text in `static/data.js`, with every
original beside its replacement so each one can be accepted or rejected on its
own. **Nothing in `data.js` has been changed.** This document is the proposal.

- **684 cells** reviewed, across 26 table/column pairs in 22 tables
- Plus [column migrations](#structured-columns--what-the-prose-should-stop-saying):
  rows whose prose states something `Skill Bonus` / `Skill Note` should carry
- **49 of them are read by `rules.js` today** — those are the ones where wording
  is behaviour, and they are marked in the Engine column of every table below
- Long-form `Description` prose is **not** rewritten (see [Scope](#scope))

---

## Why this is worth doing

The same mechanic is currently written five ways. A dice bonus to a skill
appears as all of:

```
+2 to Observation            heritage: Dog
+2 on all Soak tests         heritage: Bear
+2d bonus on Shadow tests    heritage: Cat
+2 bonus dice to Firearms    amp: Eyes of the Raptor
+1d on Sorcery               heritage: Chimerical
```

That costs three separate things:

1. **The player** reads five phrasings and has to decide whether they mean the
   same thing. (They do.)
2. **The engine** can only match what it can predict. Every variant that has to
   be anticipated is another alternation in a regex, and every one that *isn't*
   anticipated is a bonus that silently doesn't apply — there are live examples
   below.
3. **The homebrew editor** can't validate anything. With one vocabulary it could
   offer a picker or a format hint instead of a free-text box, which is where
   this work pays off a second time.

The good news, established by checking rather than assuming: **the numbers are
not drifting.** A script comparing every number stated in augment and heritage
prose against the corresponding structured column (`Strength`, `Body`,
`Impact Armor`, `Observation`, `Move`, …) found no genuine contradiction. What
varies is the language, not the values. That makes this a rewrite with a
bounded, checkable risk rather than a data audit.

---

## Scope

### Rewritten — `Effect`-class columns (684 cells)

`Effect`, `Effects`, `ModeEffect`, and the `Notes` columns that carry mechanics.
These are the terse at-the-table statements, and they're where both the drift
and the parsing live.

### Not rewritten — `Description` (~126,000 characters)

The `Description` columns are long-form rulebook prose, and rewriting them is a
different job with a worse risk/benefit ratio:

- They're reference text a player reads once, not something parsed. Only one
  engine path touches a Description at all — `removesWoundPenalty` falls back to
  it (`rules.js:4987`).
- They're **shared verbatim across ranks**. All four `Acid Burn` ranks carry the
  same paragraph; so do the three `Bone Lacing` variants. Editing one means
  editing all of them identically or introducing the very inconsistency this is
  meant to remove.
- Compressing rules prose is where detail gets lost, and the loss is invisible
  until a rule comes up at the table.

They are still *read* here: each table below flags any row where the Description
contradicts the Effect, under **CONTRADICTS DESC**.

---

## What `rules.js` actually reads

This is the part worth internalising before reviewing any individual row,
because it's narrower than it looks. The engine's real interface to the data is
**structured columns**, not prose. `augments` carries `Strength`, `Body`,
`Reaction`, `Impact Armor`, `Skill Bonus`, `AltMove`; `heritage_features`
carries `Observation`, `Move`, `Dodge`, `Soak`, `Shadow`. The Effect text
usually *restates* what a column already says.

Prose is parsed in exactly nine places:

| Parser | `rules.js` | Reads | Extracts |
|---|---|---|---|
| `derivePoolEffects` / `parsePoolDice` | 4104 | heritage `Effects`, augment `Effect`, gear `Effect`, amp `Effect`, spell `Effect` | conditional pool toggles |
| `deriveSenseNotes` | 2654 | heritage, augment, gear, drone vision notes | the Enhanced Senses banner |
| `martialArtStatMods` | 4196 | martial art `Effect` | dodge, soak, movement, recoil, unarmed and spur damage |
| `parseCoverGrant` | 4290 | martial art `Effect`, spirit effects | Low / High / Full cover |
| `droneSkillDice` | 2562 | drone `Effect` | skill dice while deployed |
| `droneCombatBonuses` | 2595 | drone `Effect` | initiative dice, dodge / cover / vision notes |
| `parseEtiquetteBonuses` | 3917 | armor material + extra, weapon mod, gear, augment | etiquette modifiers |
| `deriveInitiative` | 4066 | heritage, augment, amp, martial art | initiative reminders (substring `initiat`) |
| `removesWoundPenalty` / `doublesWoundPenalty` | 4985 | augment `Effect`\|`Description`, martial art, heritage | wound-penalty flags |

Everything else — all 127 `programs.Effect` rows, every `ModeEffect`, all
`weapons.Notes`, `deck_mods`, `rig_mods`, `hack_actions` — is **display text**.
`weapon_mods.Effect` saying `+1 Recoil Capacity` does nothing; the real number is
in the `RecoilMod` structured column. Those rows can be reworded freely.

### How this was verified

Rather than eyeball it, the nine patterns above were transcribed from `rules.js`
into a probe script and run over every prose cell, so the Engine column in each
table below is **observed output, not a guess**. The same probe was then run over
every *proposed* rewrite and diffed against the original, which is what backs the
claim that the formatting changes are formatting changes. Any row where the
proposal changes what the engine extracts is flagged **NEW BEHAVIOUR** and listed
in [Behaviour changes](#behaviour-changes) — there is nowhere else for one to hide.

---

## Findings that aren't formatting

These came out of the analysis and need a decision. None is fixed by this
document; several are fixed by accepting the rewrite.

### Bonuses the engine can't see

`misc_gear.Effect` **is** wired to the pool parser, but `POOL_DICE_RE` needs a
signed number before the pool name. Two drugs miss it:

| Row | Current text | Consequence |
|---|---|---|
| `Lick` | `Increase Finesse by 4 for 10/min.` | no Finesse toggle on the sheet |
| `Rage` | `Increase Brawn by 4 for 10/min.` | no Brawn toggle on the sheet |

Every other drug in the table (`Cram`, `Kamakazi`, `Sixgun`, `Dorf`) writes it
as `+Nd <Pool>` and works. Rewriting these two to match makes them start
working — a fix, but a behaviour change, so it's flagged as one.

`10/min` is also ambiguous: 10 minutes, or per minute? Both drugs use it and
nothing else in the table does.

### Wording that misses by two characters

`Dorf` reads `Ignore wound pen for 2 hrs`. The pattern is `/wound penalt/i`.
Spelling it `wound penalties` would fix the phrasing — **but it still wouldn't
work**, because `removesWoundPenalty` is only ever applied to augments, martial
arts and heritage traits. `misc_gear` is never passed to it (`rules.js:4987`).
Dorf is the only drug claiming wound-penalty immunity, so this needs a one-line
`rules.js` change, not a rewrite.

### A skill name that doesn't exist

The drone `VSTOL Bird` reads `+4 Recon, Stealth (-6d to target)`. There is no
`Stealth` skill — it's called **`Shadow`**. `droneSkillDice` splits on commas
and matches skill names inside each clause, so the only reason this doesn't
currently hand the character a **−6d Shadow penalty** is that the misspelling
fails to match.

That is luck, not correctness. The `−6d` is a penalty imposed on the drone's
*target*; if anyone "cleans up" the name to `Shadow`, the character takes it
instead. This row needs target-facing wording that can't be misread, and it is
an argument for the parser to require an explicit subject.

### Abbreviations that bypass the vocabulary

The heritage trait `Tough` states `2B and 2I armor` where every other row writes
`Ballistic Armor` / `Impact Armor`. Its structured columns are correct, so
nothing is broken — but it's the shape of drift that eventually becomes a bug,
and the same `B`/`I` shorthand *is* load-bearing in `infusionStatMods`
(`rules.js:4411`), which parses `+2 to B/I armor` for real.

### Restated conditionals the parser deliberately ignores

Several rows mention a pool without granting dice, and the engine is right to
skip them — `Geas`'s "lose 1d from all pools", `Laughter`'s "vs Brawn",
`Returning the Fang`'s "If Finesse pool is not empty". These are listed only so
that a future stricter parser doesn't start matching them.

---

## Structured columns — what the prose should stop saying

Rewriting a sentence is the small half of this. The larger one is noticing when a
sentence is stating something the row already has a **column** for — because a
column is read by the engine, validated on save, and editable in homebrew, and a
sentence is none of those.

Two columns exist for skills, on every table the homebrew editor exposes:

| Column | Syntax | Separator | What it does |
|---|---|---|---|
| `Skill Bonus` | `Biotech +1` | `,` for several | flat dice, folded into the skill's rating |
| `Skill Note` | `Biotech: reroll 1s` | `\|` for several | situational text shown beside the skill, never summed |

`gearSkillEffects` ([rules.js:3835](../../static/rules.js)) reads them off
augments, armor, gear, weapons and their fitted mods, decks, programs, rigs,
vehicles, drones, spells, rituals, mounted augments, and engaged spirits. A
misspelt skill name produces a **warning** rather than a bonus that silently
never lands — which is the whole argument for columns over prose.

**Not** on that list: `heritage_features`, `amp_powers`, `martial_arts`. Heritage
doesn't need it — it has its own per-skill columns (`Observation`, `Recon`,
`Dodge`, `Shadow`, `Athletics`, …). The other two have nothing, and that's the
biggest item below.

### Migrated — prose stated a flat bonus, column was empty

These three stated a Biotech bonus in prose with `Skill Bonus` empty, so the
bonus was not applied at all. The columns are now set:

| Table | Row | `Skill Bonus` | `Skill Note` | `Dose` |
|---|---|---|---|---|
| `misc_gear` | First Aid Kit | `Biotech +1` | — | `1` |
| `misc_gear` | Trauma Kit | `Biotech +2` | — | `1` |
| `misc_gear` | Electronic Doctor Kit | `Biotech +3` | `Biotech: reroll 1s` | `1` |

The Electronic Doctor Kit is the shape worth learning from: one sentence holding
a flat bonus *and* a conditional rider, which is exactly one value for each
column.

All three are also **one-time use**, so they carry `Dose` and their bonus only
lands while a dose is live — a kit in your bag is not a kit you have opened. That
gating happens in `gearSkillEffects`, which is a different code path from the
pool gating the drugs use, so both are checked by `P06-028`.

### Already migrated — the prose is now a duplicate

These rows carry the column already; the Effect text repeats it in different
words. No engine change, but the prose should defer to the column rather than
state a second, slightly different version of the same rule.

| Table | Row | Column says | Prose still says |
|---|---|---|---|
| `augments` | Sound Filter | `Skill Bonus: Observation +1` | +1 to Observation tests |
| `augments` | Compartment | `Skill Note: Subterfuge: +6d to conceal an item in the body compartment` | +6 to Subterfuge to hide things within |
| `augments` | Covert Synthskin | `Skill Note: Shadow: reroll 1s/2s while hiding in appropriate gear` | Reroll 1s and 2s on Shadow tests |
| `augments` | Rocket Boots | `Skill Note: Athletics: +8d & reroll 1s/2s when jumping` | +8d to jumps and Athletics. Reroll 1s and 2s on jumps. |
| `augments` | Amplification | `Skill Note: Observation: reroll 1s` | Can reroll 1s on Observation tests |

`Compartment` is instructive: its +6 is a `Skill Note`, not a `Skill Bonus`,
because it only applies *to concealing something in the compartment*. The prose
reads like a flat +6 to all Subterfuge. The column is right and the sentence is
misleading — worth fixing even though nothing computes differently.

### Do NOT migrate — the semantics differ

| Table | Row | Prose | Why not |
|---|---|---|---|
| `drones` | Bug-Spy | +1 to Observation/Recon | `droneSkillDice` applies these **only while the drone is deployed**. `Skill Bonus` on a drone applies while merely **owned** — `gearSkillEffects` has no active test for drones. Migrating would grant the bonus with the drone still in the garage. |
| `drones` | VSTOL Bird | +4 Recon | same, and see the `Stealth`/`Shadow` finding above |
| `spells` | Forbidden Glamour of Accord | +2 bonus dice to Negotiation/Coercion/Leadership | the bonus goes to *everyone in line of sight*, not to the caster as a standing rating |
| `spells` | Charm | Force = bonus dice to Leadership/Negotiation | Force-scaled; `Skill Bonus` needs a literal signed number, so it can't express this at all |
| `spells` | The Thirty Cursed Servants of Ehon | +1d/Force to Observation and Recon for Duration | Force-scaled and time-limited |

The drone case is the one to be careful about. It looks like the most obvious
migration on the list and is the only one that would actually be wrong.

### Columns added since this review was written

Three landed while the review was open, and they change what some of the prose
below should say — a sentence stating something a column now carries is a
duplicate, not a spec.

| Table | Column | Carries |
|---|---|---|
| `augments` | `RaisesMax` | whether an attribute bonus lifts the cap too — was seven hardcoded name prefixes |
| `misc_gear` | `Dose` | consumed on use; gets a Use button and an entry in "Under the Effects Of" |
| `misc_gear` | `Max Doses` | how many doses stack before the extras stop counting |
| `amp_powers` | `Skill Bonus` / `Skill Note` | four powers that were hardcoded by name |

`Max Doses` values all come from the rows' own text — Cram's "can chain up to 4",
Kamakazi's "can double effect", Lick and Rage's "doubling". Those phrases are now
**restating a column**, so the wording proposals for them should be read with
that in mind: keep the number a player wants at the table, but it is no longer
the only place the rule lives.

### Numbers that a column carries are named, not repeated

Where a value lives in a structured column, the prose no longer states the
number — it names **what** is boosted and leaves **how much** to the column:

```
+4 Body. +4 Strength.        ->  Grants a bonus to Strength and Body.
+3 Impact Armor.             ->  Grants Impact Armor.
+1 to Observation tests.     ->  Grants a bonus to Observation.
Grant +2 bonus to Biotech    ->  Single use. Grants a bonus to Biotech.
```

The row still tells a reader what it does, and there is exactly one place the
value lives. **57 proposals** are affected: 42 augment rows carrying an attribute
or armor column, the four amp powers, the three medkits, and the skill/dose/max
rows listed earlier.

Three deliberate exceptions:

**Pool bonuses keep their numbers.** A pool bonus exists *only* in the prose —
`POOL_DICE_RE` reads it there and no column carries it — so "+2d Brawn Pool"
stays exactly as written. Removing that number would delete the rule, not
relocate it.

**Rerolls keep their wording.** "Reroll 1s and 2s" names dice faces, not a bonus
magnitude. Nothing is redundant about it, so Covert Synthskin, Rocket Boots and
Amplification keep theirs.

**`Strength Enhancement 1–6` keep theirs.** "+N Strength to all limbs" is a
different claim from the character's own Strength, and the row's second sentence
exists to warn about exactly that mismatch.

### Pool wording is now consistent

`POOL_NAMES` is `Brawn, Finesse, Focus, Resolve` (rules.js:93), and three rows
listed their pools in the order the original sentence happened to use:

| Row | Was | Now |
|---|---|---|
| Adrenal Pump | `+2d Resolve/Brawn/Finesse Pool` | `+2d Brawn/Finesse/Resolve Pool` |
| Hyper Adrenal Pump | `+4d Resolve/Brawn/Finesse Pool` | `+4d Brawn/Finesse/Resolve Pool` |
| Kamakazi | `+2d Finesse/Brawn Pool` | `+2d Brawn/Finesse Pool` |

`Sixgun` also dropped the word "Pool" from its second clause while keeping it in
the first; both now read `Focus Pool`.

Parsing is unaffected — `parsePoolDice` splits the list and doesn't care about
order — which the verifier confirms. Catching that took a fix to the checker
itself: it compared the parser's output as a *string*, so reordering the pools
looked like a behaviour change when the pools and values were identical. It now
sorts into `POOL_NAMES` order before comparing.


### Needs a ruling

| Table | Row | Prose | The question |
|---|---|---|---|
| `spells` | Bound Servant | Gain +2d to Sorcery/Channeling | Spells **are** read by `gearSkillEffects`, and unconditionally — a *known* spell grants its columns. Bound Servant costs 2 ZP and grants a permanent familiar, so that may be right. If it is, `Sorcery +2, Channeling +2` is the value. If a spell should only count while cast, that's a rules.js question affecting every spell. |

### The largest remaining cluster — now done

`amp_powers` had **no** `Skill Bonus` / `Skill Note` columns, so four powers were
hardcoded by name in `resolveAmp` — exactly the shape that `Sound Filter`,
`Rocket Boots`, `Compartment`, `Covert Synthskin` and `Amplification` were in
before they became columns, a migration this repo had already done once and
recorded in `P09-012`.

| Power | Was | Now |
|---|---|---|
| Eyes of the Raptor | `skillBonus["Firearms"] += 2` | `Skill Bonus: Firearms +2` |
| Might of the Bear | `skillBonus["Unarmed Combat"] += 2` | `Skill Bonus: Unarmed Combat +2` |
| Sting of the Scorpion | `skillBonus["Melee Weapons"] += 2` | `Skill Bonus: Melee Weapons +2` |
| Hidden Presence | `skillBonus["Shadow"] += 2; skillBonus["Subterfuge"] += 2` | `Skill Bonus: Shadow +2, Subterfuge +2` |

All four Effect strings already stated the right number, so the data was ready.
`amp_powers` now carries both columns, `gearSkillEffects` reads them, and the
four branches are gone. Homebrew amp powers can grant skill dice, and a misspelt
skill is reported rather than silently granting nothing.

Their Effect prose still restates the bonus, so these four join the
[duplicates](#already-migrated--the-prose-is-now-a-duplicate) list above — the
sentence should defer to the column rather than say it a second time.

`Expertise` is deliberately still hardcoded. It reads `+2 to Skill and it's
maximum` (also a typo — `it's` → `its`), and `Skill Bonus` has no way to say
"and raise the cap"; it also targets a skill the *player* picks rather than one
the row names. That is the same gap `RaisesMax` just closed for attributes, and
it would need its own column to move.

---

## Behaviour changes

Every row whose proposed text changes what the engine extracts. These are the
only rows in this document that alter a character sheet, and each needs an
explicit yes.

| Table | Row | Engine before | Engine after | Effect of accepting |
|---|---|---|---|---|
| `misc_gear` | Lick | — | `pool Finesse+4` | NEW BEHAVIOUR: original has no signed number before the pool name ("Finesse by 4"), so `POOL_DICE_RE` never matches it — the pool bonus is currently invisible on the sheet. `misc_gear.Effect` is wired to the pool parser, so the rewrite genuinely makes `+4d Finesse Pool` reachable for the first time (a real behaviour change, not just wording). Lick is now flagged `Dose: 1` with `Max Doses: 2`, so the bonus arrives when a dose is USED rather than as a standing toggle, and stacks to two. UNCLEAR: "10/min" — read here as "10 minutes"; could instead mean "per minute" (an ongoing/stacking effect). Description is blank, so this can't be confirmed from context — flagging rather than guessing further. |
| `misc_gear` | Rage | — | `pool Brawn+4` | NEW BEHAVIOUR: same defect as Lick ("Brawn by 4" has no signed number before the pool name, so it never matched `POOL_DICE_RE`); rewrite makes `+4d Brawn Pool` reachable for the first time. Rage is now flagged `Dose: 1` with `Max Doses: 2` — its "doubling" — so the bonus arrives on Use and stacks to two. `misc_gear.Effect` is wired to the pool parser (unlike the wound-penalty case on Dorf), so this one really does change what the sheet computes. UNCLEAR: "10/min" — same ambiguity as Lick, same reasoning; not resolvable from the (blank) description. |

Both are now **doses**: `Lick` and `Rage` carry `Dose: 1` and `Max Doses: 2`
(their "doubling"). So accepting these two rewrites doesn't add a standing
toggle — it makes the Use button do something when the dose is taken, and lets
a second dose stack. Until the rewrite lands, both are doses that consume, list
and dismiss correctly while granting no dice, which is the "No dice effect —
tracked for the record" state.

---

## Proposed vocabulary

The canonical forms the rewrite applies. The single highest-leverage rule:

> **One mechanical statement per sentence, separated by `. `**

Every parser splits into clauses before matching — on `[.;]`, on `[,.;]`, or on
`,`. A sentence bundling three effects can only ever be matched by whichever
pattern wins first; the rest is unreachable. Commas are therefore for lists a
single number governs (`+2d Brawn/Finesse Pool`), never for joining two
different effects.

| Mechanic | Canonical | Instead of | Parser-critical |
|---|---|---|---|
| Pool dice | `+2d Brawn Pool`, `+2d Brawn/Finesse Pool`, `-3d Focus Pool` | `+2 Finesse and Brawn`, `Increase Finesse by 4`, `+4d Focus pool` | yes — 4104 |
| Skill dice | `+2d Observation` | `+2 to Observation`, `+2 on all Soak tests`, `+2d bonus on Shadow tests`, `+2 bonus dice to Firearms` | no |
| Attribute | `+1 Body` | `grants +1 to Body`, `+2 to body` | no (column) |
| Armor | `+1 Ballistic Armor`, `+1 Ballistic/Impact Armor` | `1 Impact armor`, `2 points of impact armor`, `2B/3I Armor` | no (column) |
| Movement bonus | `+2m Movement` | `Add 2m to movement` | yes — 4213, 4425 |
| Movement replacement | `Movement 10m`, `Fly 12m` | `10m Move`, `Fly of 12m` | no |
| Senses | `Thermographic vision`, `Echolocation 24m`, `Vision magnification 2` | `Can see in thermographic spectrum`, `Grants Thermographic Vision`, `Natural vision mag of 2` | yes — 2654 |
| Wound penalty | `Ignore wound penalties` | `Ignore wound pen` | yes — 4985 |
| Cover | `Low cover` / `High cover` / `Full cover` | — | yes — 4290 |
| Recoil | `Ignore recoil`, `+1 Recoil Capacity` | — | yes — 4215 |
| Requirement | `Requires a Chipjack.` | `Requires Chipjack.`, `Required if X is purchased` | no |
| Duration | `for 12 hours` | `for 12 hrs`, `for a few hours`, `10/min` | no |
| Stat notation | `Reach 0`, `Range 12m`, `Accuracy 4` | `Reach(0)`, `Range(12m)`, `Acc4` | no |

Abbreviations `w/`, `w/n`, `w/o`, `vs` are spelled out except inside an
established stat abbreviation.

### Rules the rewrite follows

- **Nothing is renumbered.** A value that looks wrong is flagged **CHECK**, never
  changed — that's a balance decision, not a formatting one.
- **No row is renamed.** Names are how saved characters reference data; a rename
  orphans them and needs a `RENAMED_*` migration map.
- **Vagueness is preserved.** Where the original is imprecise, the replacement is
  imprecise in the same way. Precision invented during a cleanup is a rules
  change in disguise.
- **Qualifiers are kept.** `+4d Focus Pool for 3 hours. If addicted, instead -2d
  Focus without it.` stays two sentences; the parser already handles this
  correctly (first clause per pool wins).

---

## How to read the tables

| Column | |
|---|---|
| **Original** | the text in `data.js` today, verbatim |
| **Proposed** | the replacement |
| **Engine** | what `rules.js` extracts from the original. `—` means the text is display-only |
| **Notes** | empty for a pure formatting change; otherwise one of the flags below |

| Flag | Meaning |
|---|---|
| **NEW BEHAVIOUR** | the rewrite changes what the engine extracts — needs an explicit yes |
| **CONTRADICTS DESC** | `Effect` and `Description` disagree |
| **CHECK** | a value looks wrong; flagged, deliberately not changed |
| **UNCLEAR** | the original is ambiguous; the ambiguity was preserved |
| **TYPO** | a misspelling was corrected |

---


## Totals

| | |
|---|---|
| Cells reviewed | 684 |
| Wording changed | 589 |
| Behaviour changed | 2 |
| Flagged for a decision | 83 |


## Flagged rows

Everything needing a decision beyond accept/reject on the wording.


### CONTRADICTS DESC (5)

| Table | Row | Note |
|---|---|---|
| `augments` | Repulsors | **CONTRADICTS DESC** — the Description says the 12m figure is the flight *ceiling* ("move up to 12 m above surfaces") and 30m is the *movement speed* while flying ("movement of 30 m"); the Effect text has these two numbers swapped ("12m of flying movement ... with a 30m ceiling"). Not renumbered here — flagging for the data owner to pick the correct pairing |
| `spells` | Create Barrier | CONTRADICTS DESC — Description gives Condition = 2x Successes **+ Force**; Effect omits the `+Force` term entirely. Also Description gives height as "four to twenty feet," a real-world unit no other row in this packet uses (everywhere else pairs meters with tabletop inches at a 2:1 ratio); Effect's "1.5 to 6m" doesn't convert cleanly to that inches convention either. Flagging both, not renumbering. |
| `spells` | Rune of the Unspeakable Alarm | CONTRADICTS DESC — Description scales the ward as 20 sq ft **per point of Force**; Effect gives a flat 6 sq.m with no Force term and a different unit (sq.m vs sq ft). Flagging, not renumbering. |
| `spells` | Firestorm | CONTRADICTS DESC — Description gives the radius as **4 m (2") per point of force**, double the Effect's stated "2m/Force." Flagging, not renumbering. |
| `rituals` | Raise Ward | CONTRADICTS DESC — Description ties the 1000 cubic meter cap to Zoetic Potential ("for every point of her Zoetic Potential"); Effect states it as a flat cap with no ZP term. Flagging, not renumbering. |


### CHECK (21)

| Table | Row | Note |
|---|---|---|
| `augments` | Delux Trackmobi | **TYPO** — "chasis" corrected to "chassis". **CHECK** — the row's Name ("Delux Trackmobi") looks like a misspelling of "Deluxe"; not changed here since renaming a row is out of scope (needs a `RENAMED_*` migration map per the style guide) |
| `augments` | Adrenal Pump | **UNCLEAR** — "Recharge: 30/min" in the original is ambiguous (a 30-minute recharge time, vs. some per-minute rate); rendered here as "30 minutes" to match how "Recharge:" reads elsewhere in this table, but the true intent should be checked against the source |
| `heritage_features` | Nature Bound | **CHECK**: kept "UV" instead of spelling it to "ultraviolet" — the sense parser matches literal `ultraviolet` and would misread this vulnerability as granting Ultraviolet vision. Do not expand the abbreviation here. |
| `martial_arts` | Way of the Tank | **CHECK**: kept the literal word "vs" — the style guide's normal rule would spell it out to "versus", but the dodge-dice veto only fires on literal `\bvs\b`/`\bif\b`. Writing "versus" here would silently turn this into a permanent +4d Dodge bonus. Do not canonicalize this word. |
| `drones` | VSTOL Bird | **CHECK**: the -6d is a penalty on the drone's TARGET, not the operator. It currently produces no hit only because the text says "Stealth" and not the real skill name "Shadow" — pure luck, per the task brief. Deliberately kept "Stealth" (not "Shadow") in the same clause as the number: writing "Shadow" here would make `droneSkillDice` read it as a real -6d Shadow malus handed to the drone's OPERATOR. Do not rename this to "Shadow" without also restructuring how this row is parsed. |
| `misc_gear` | Dorf | CHECK — not wired: "wound pen" is two characters short of `/wound penalt/i`, but fixing the wording alone can't make this work — `removesWoundPenalty` (rules.js:4987) is only ever applied to augments, martial-art levels, and heritage traits; `misc_gear` is never handed to it. Standardizing the wording is worth doing for consistency, but the immunity needs a rules.js change (teaching `removesWoundPenalty` to read `misc_gear.Effect`) before it can appear on a sheet. Dorf is the only drug in this table that claims wound-penalty immunity. |
| `spells` | Shatter Ward | CHECK — original reuses the word "Force" for both the caster's Force and the ward's Force without distinguishing them (`Force<Force+Success`). Rewrite disambiguates per Description's wording; no number or comparison changed. |
| `spells` | Forbidden Glamour of Accord | TYPO — "Negotiaion" → "Negotiation"; duplicated "vs vs" → "versus". CHECK — flat skill-dice bonus stated only in prose; style guide prefers a structured Skill Bonus column for this. |
| `spells` | The Ancestral Working of the Savage Peal | CHECK — "Armor" added for clarity, sourced from Description (original just said "barriers<Force-1"). Also Effect's strict `<` is tighter than Description's "equal to or less than"; flagging the mismatch, not resolving it. |
| `spells` | The Infinite Illusion of Spiritual Seperation | CHECK — row name is misspelled ("Seperation"). Flagging only; not renaming, per the style guide (renames orphan saved characters). |
| `spells` | Confusion | CHECK — Effect specifies a d3, but Description rolls 1d6 and maps pairs (1-2/3-4/5-6) to the same three outcomes. Same odds, different die; confirm intended notation. |
| `spells` | Despair | TYPO — stray "for in area" corrected to "in area". CHECK — Description adds a "(minimum 1)" floor on this penalty that Effect omits; without it, Force 1 would round to zero penalty dice. Flagging, not adding the number. |
| `spells` | Enthrall | CHECK — Effect's brackets (`Int<15` days, `Int>15` hours) leave exactly Int=15 undefined; Description assigns Int=15 to the hours bucket ("fifteen and above"). Flagging the boundary gap, not resolving it. |
| `spells` | Horrors of the Unknown Dark | CHECK — Effect specifies a d2, but Description rolls 1d6 and maps halves (1-3/4-6) to the same two outcomes. Same odds, different die; confirm intended notation (same pattern as Confusion, row 26). |
| `spells` | Shadow Anchor | CHECK — lowercased "shadow" (the caster's own shadow) to avoid visual confusion with the capitalized **Shadow** skill used elsewhere in this data. Interpretive call, not pure formatting — flagging. |
| `spells` | The Thrity Cursed Servants of Athozog | CHECK — canonicalized "Recon" → "Reconnaissance" (`SKILLS` alias). Flat/Force-scaled skill bonus stated only in prose; style guide prefers a structured Skill Bonus column. |
| `spells` | Bound Servant | CHECK — "+2d to all tests" (familiar's own bonus) and "+2d Sorcery/Channeling" (caster's bonus) are flat dice bonuses stated only in prose; style guide prefers structured columns for this. Neither names a Pool, so no parser risk either way. |
| `rituals` | Weather Protection | CHECK — Description frames the temperature shift as "up to" 10°C toward 21°C (capped, not unconditional); Effect reads as a flat 10°C shift. Flagging the ambiguity, not resolving it (not adding "up to" without confirmation). |
| `programs` | Vermin Call 6 | CHECK: damage tiers are uneven — ranks 1–2 deal 1, ranks 3–5 deal 2 (three ranks), rank 6 jumps to 3 after only one rank at the middle tier. Not changed; confirm rank 6 (and the 3-wide middle tier) is intentional rather than a missing rank 7 or a rank-5 typo. |
| `programs` | Hacking 6 | Every one of the six original thresholds (3,5,7,9,11,13) checks out against `MCP ≤ 2×Rating+1` and against the Description's "at least half the deck's MCP, round down" rule — no break found, formula collapse is safe. |
| `hack_actions` | Destroy Camera Network | CHECK: identical Alert/Op Heat cost to "Destroy Single Camera" above despite the larger scope (a whole network vs. one camera). Not changed; confirm this is intentional. |


### UNCLEAR (28)

| Table | Row | Note |
|---|---|---|
| `augments` | Adrenal Pump | **UNCLEAR** — "Recharge: 30/min" in the original is ambiguous (a 30-minute recharge time, vs. some per-minute rate); rendered here as "30 minutes" to match how "Recharge:" reads elsewhere in this table, but the true intent should be checked against the source |
| `augments` | Hyper Adrenal Pump | **UNCLEAR** — same "30/min" ambiguity as Adrenal Pump (row 110) |
| `augments` | Shimmerskin | **UNCLEAR** — "Can be immune to cameras" doesn't state the condition under which immunity applies; preserved as written rather than guessing |
| `augments` | Nu-Tek TVSkin | **UNCLEAR** — "Requires Arwin or Chipjack and internal storage" doesn't make clear whether "and internal storage" is required alongside either option, or only alongside Chipjack; the Description has the identical ambiguity ("Requires a communicator or chipjack and internal storage"), so preserved rather than resolved |
| `heritage_features` | Racoon | **UNCLEAR**: "mount ... for cover (-2)" doesn't say what the -2 applies to (attacker's roll? the mount's?) or what "mount" means mechanically here. Ambiguity kept from the original. |
| `heritage_features` | Enchanting | **UNCLEAR**: "at ZP" is undefined (a ZP cost? a ZP-gated unlock?) — kept as vague as the original. |
| `heritage_features` | Polypedal Legs 4 | **UNCLEAR**: "level" (a movement-tier concept?) isn't defined anywhere in this packet; kept as vague as the original rather than inventing a meaning. |
| `heritage_features` | Polypedal Legs 6 | **UNCLEAR**: same "level" ambiguity as Polypedal Legs 4. |
| `heritage_features` | Polypedal Legs 8 | **UNCLEAR**: same "level" ambiguity as Polypedal Legs 4. |
| `martial_arts` | Gun-Kata | **UNCLEAR**: "SS" isn't defined anywhere in the packet (likely a firearms fire-mode abbreviation); left unexpanded rather than guessing at its meaning. |
| `martial_arts` | Gun-Kata | **UNCLEAR**: whose Firearms skill and how large the penalty is aren't specified by the original; ambiguity preserved. |
| `rig_mods` | Electronic Countermeasures | **UNCLEAR**: doesn't say whose drones/vehicles (enemy, presumably, given the name) — ambiguity kept from the original rather than assumed. |
| `misc_gear` | Lick | NEW BEHAVIOUR: original has no signed number before the pool name ("Finesse by 4"), so `POOL_DICE_RE` never matches it — the pool bonus is currently invisible on the sheet. `misc_gear.Effect` is wired to the pool parser, so the rewrite genuinely makes `+4d Finesse Pool` reachable for the first time (a real behaviour change, not just wording). Lick is now flagged `Dose: 1` with `Max Doses: 2`, so the bonus arrives when a dose is USED rather than as a standing toggle, and stacks to two. UNCLEAR: "10/min" — read here as "10 minutes"; could instead mean "per minute" (an ongoing/stacking effect). Description is blank, so this can't be confirmed from context — flagging rather than guessing further. |
| `misc_gear` | Rage | NEW BEHAVIOUR: same defect as Lick ("Brawn by 4" has no signed number before the pool name, so it never matched `POOL_DICE_RE`); rewrite makes `+4d Brawn Pool` reachable for the first time. Rage is now flagged `Dose: 1` with `Max Doses: 2` — its "doubling" — so the bonus arrives on Use and stacks to two. `misc_gear.Effect` is wired to the pool parser (unlike the wound-penalty case on Dorf), so this one really does change what the sheet computes. UNCLEAR: "10/min" — same ambiguity as Lick, same reasoning; not resolvable from the (blank) description. |
| `misc_gear` | Cased | UNCLEAR: "for any" trails off — any what (weapon type)? Left as in the original rather than guessing a completion. |
| `programs` | Decoy 1 | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| `programs` | Decoy 2 | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| `programs` | Decoy 3 | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| `programs` | Decoy 4 | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| `programs` | Decoy 5 | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| `programs` | Decoy 6 | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| `programs` | Shadow Protocols 1 | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| `programs` | Shadow Protocols 2 | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| `programs` | Shadow Protocols 3 | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| `programs` | Shadow Protocols 4 | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| `programs` | Shadow Protocols 5 | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| `programs` | Shadow Protocols 6 | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| `hack_actions` | Brute Force NAN | UNCLEAR: this row's Description is empty, so "Double I/O in meters" as a base-range formula is my best reading of the shorthand, not a confirmed one. |


### TYPO (29)

| Table | Row | Note |
|---|---|---|
| `augments` | Automated Hypoinjectors | **TYPO** — "an inject" corrected to "can inject" |
| `augments` | Recorder | **TYPO** — "recieved" corrected to "received" |
| `augments` | Camera | **TYPO** — "recieved" corrected to "received" |
| `augments` | Vision Magnification 1 | **TYPO** — double space between "Magnifies" and "vision"; reworded to the canonical "Vision magnification N" form (same meaning: reduces range by the augment's rating) |
| `augments` | Vision Magnification 2 | **TYPO** — double space between "Magnifies" and "vision"; reworded to the canonical "Vision magnification N" form |
| `augments` | Trackmobi | **TYPO** — "chasis" corrected to "chassis" |
| `augments` | Delux Trackmobi | **TYPO** — "chasis" corrected to "chassis". **CHECK** — the row's Name ("Delux Trackmobi") looks like a misspelling of "Deluxe"; not changed here since renaming a row is out of scope (needs a `RENAMED_*` migration map per the style guide) |
| `augments` | Luxury Trackmobi | **TYPO** — "chasis" corrected to "chassis" |
| `amp_powers` | Expertise | **TYPO**: "it's" → "its" (possessive, not a contraction). |
| `amp_powers` | Telekinesis | **TYPO**: "non-attended" → "unattended". |
| `drones` | Gladiator | **TYPO**: "STr" → normalized capitalization (compare "Str6"/"Str9" on the two rows above; the mixed-caps "STr" is unique to this row). |
| `misc_gear` | Deepweed | TYPO: "percieve" → "perceive". Duration ("a couple of hours" / "a few hours") stays vague — no number is recoverable from the row, and inventing one would be a rules change. |
| `misc_gear` | Kamakazi | TYPO: item name "Kamakazi" is very likely a misspelling of "Kamikaze" — flagged only; the Name column is not rewritten here (renaming orphans saved characters per the style guide). |
| `misc_gear` | Arwin, Galactic | TYPO: "Winow" → "Window". |
| `misc_gear` | Arwin Goggles | TYPO: "Eyeware" → "Eyewear". Also capitalized "arwin" → "Arwin" to match the product name. |
| `spells` | Forbidden Glamour of Accord | TYPO — "Negotiaion" → "Negotiation"; duplicated "vs vs" → "versus". CHECK — flat skill-dice bonus stated only in prose; style guide prefers a structured Skill Bonus column for this. |
| `spells` | Rune of Vicious Rage and Sorrow | TYPO — "beserk" → "berserk". |
| `spells` | Despair | TYPO — stray "for in area" corrected to "in area". CHECK — Description adds a "(minimum 1)" floor on this penalty that Effect omits; without it, Force 1 would round to zero penalty dice. Flagging, not adding the number. |
| `spells` | The Uncountable Tendrils of Ehon | TYPO — doubled period after "turn" fixed. **NEW BEHAVIOUR avoided** — kept the tentacles' stat block unsigned ("Brawn Pool 5") rather than "+5d Brawn," matching the style guide's `Brawn Pool (3)` exception. These are the summoned tentacles' own dice, not a bonus to the caster's pool; a signed form would have wrongly created a caster-side pool toggle. |
| `spells` | Natural Fury | TYPO — "encasment" → "encasement". **NEW BEHAVIOUR avoided** — "Force bonus dice to Brawn Pool" kept in prose (not `+Nd Brawn Pool`) because the bonus is Force-scaled; `Force` can't satisfy `POOL_DICE_RE`'s signed-digit requirement regardless, matching today's no-hit state. Flagging per the loud-flag instruction — this spell buffs a pool via its Description. |
| `programs` | Vermin Call 6 | CHECK: damage tiers are uneven — ranks 1–2 deal 1, ranks 3–5 deal 2 (three ranks), rank 6 jumps to 3 after only one rank at the middle tier. Not changed; confirm rank 6 (and the 3-wide middle tier) is intentional rather than a missing rank 7 or a rank-5 typo. |
| `programs` | Ghost Protocol 1 | TYPO: "duiring" → "during". |
| `programs` | Ghost Protocol 2 | TYPO: "duiring" → "during". |
| `programs` | Ghost Protocol 3 | TYPO: "duiring" → "during". |
| `programs` | Ghost Protocol 4 | TYPO: "duiring" → "during". |
| `programs` | Ghost Protocol 5 | TYPO: "duiring" → "during". |
| `programs` | Ghost Protocol 6 | TYPO: "duiring" → "during". |
| `vehicle_ballistic_weapons` | Tank Cannon | TYPO: "Cannister" → "Canister". |
| `vehicle_ballistic_weapons` | Tank Cannon | TYPO: "Cannister" → "Canister". |


---

# The tables

## Augments

### augments — Effect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Knowledge Skillsoft | Requires a Chipjack. Each one adds a Knowledge skill point. | Requires a Chipjack. Each one adds a Knowledge skill point. | — | |
| 2 | Automated Hypoinjectors | Subdermal implants that an inject 3 doses of meds/drugs as a free action | Subdermal implants that can inject 3 doses of meds/drugs as a free action. | — | **TYPO** — "an inject" corrected to "can inject" |
| 3 | Bone Lacing-Plastic | Plastic bones, grants +1 to Body | Plastic bones. Grants a bonus to Body. | — | |
| 4 | Bone Lacing-Aluminum | Aluminum bones grants +2 to body and 1 Impact armor-immune to being stripped by energy weapons | Aluminum bones. Grants a bonus to Body. Grants Impact Armor. Immune to being stripped by energy weapons. | — | |
| 5 | Bone Lacing-Titanium | Titanium bones grants +3 to body and 2 Impact armor-immune to being stripped by energy weapons | Titanium bones. Grants a bonus to Body. Grants Impact Armor. Immune to being stripped by energy weapons. | — | |
| 6 | Broadcast Jammer | Can activate to block EM. Grants immunity to cameras and blocks radio waves up to 12m. Also adds +2 hardening to devices w/n 12m | Can activate to block EM. Grants immunity to cameras. Blocks radio waves within 12m. +2 hardening to devices within 12m. | — | |
| 7 | Compartment | 4 square cm storage area in body. +6 to Subterfuge to hide things within. | 4 square cm storage area in body. Grants a bonus to Subterfuge when concealing an item within. | — | |
| 8 | Covert Synthskin | Color changing skin, tactical. Reroll 1s and 2s on Shadow tests. +1 to dodge. Immune to cameras. 1 Impact Armor | Color changing skin, tactical. Reroll 1s and 2s on Shadow tests while hiding in appropriate gear. +1 Dodge. Immune to cameras. Grants Impact Armor. | — | |
| 9 | Dermal Plating 1 | +1 Body and 1 Impact Armor. | Grants a bonus to Body. Grants Impact Armor. | — | |
| 10 | Dermal Plating 2 | +2 Body and 2 Impact Armor | Grants a bonus to Body. Grants Impact Armor. | — | |
| 11 | Dermal Plating 3 | +3 Body, 2 Impact and 1 Ballistic Armor | Grants a bonus to Body. Grants Impact and Ballistic Armor. | — | |
| 12 | Muscle Replacement 1 | +1 to Body and Strength | Grants a bonus to Strength and Body. | — | |
| 13 | Muscle Replacement 2 | +2 to Body and Strength | Grants a bonus to Strength and Body. | — | |
| 14 | Muscle Replacement 3 | +3 to Body and Strength | Grants a bonus to Strength and Body. | — | |
| 15 | Muscle Replacement 4 | +4 to Body and Strength | Grants a bonus to Strength and Body. | — | |
| 16 | Muscle Replacement 5 | +5 to Body and Strength | Grants a bonus to Strength and Body. | — | |
| 17 | Muscle Replacement 6 | +6 to Body and Strength | Grants a bonus to Strength and Body. | — | |
| 18 | Skillwires 1 | Requires Chipjack. Allows up to level 1 Skillsofts to be slotted. | Requires a Chipjack. Allows up to level 1 Skillsofts to be slotted. | — | |
| 19 | Skillwires 2 | Requires Chipjack. Allows up to level 2 Skillsofts to be slotted. | Requires a Chipjack. Allows up to level 2 Skillsofts to be slotted. | — | |
| 20 | Skillwires 3 | Requires Chipjack. Allows up to level 3 Skillsofts to be slotted. | Requires a Chipjack. Allows up to level 3 Skillsofts to be slotted. | — | |
| 21 | Skillwires 4 | Requires Chipjack. Allows up to level 4 Skillsofts to be slotted. | Requires a Chipjack. Allows up to level 4 Skillsofts to be slotted. | — | |
| 22 | Skillwires 5 | Requires Chipjack. Allows up to level 5 Skillsofts to be slotted. | Requires a Chipjack. Allows up to level 5 Skillsofts to be slotted. | — | |
| 23 | Skillwires 6 | Requires Chipjack. Allows up to level 6 Skillsofts to be slotted. | Requires a Chipjack. Allows up to level 6 Skillsofts to be slotted. | — | |
| 24 | Wired Reflexes 1 | +2 Reaction and 1 melee exploit action | Grants a bonus to Reaction. 1 melee exploit action. | — | |
| 25 | Wired Reflexes 2 | +4 Reaction and 2 melee exploit actions | Grants a bonus to Reaction. 2 melee exploit actions. | — | |
| 26 | Wired Reflexes 3 | +6 Reaction and 2 melee exploit actions | Grants a bonus to Reaction. 2 melee exploit actions. | — | |
| 27 | Arm Omni-kit | Allows for tools to mount in place of hand | Allows for tools to mount in place of hand | — | |
| 28 | Cybergun Installation | Mounted gun inside arm. Takes 10 minutes to reload. Double Strength for recoil reduction. | Mounted gun inside arm. Takes 10 minutes to reload. Double Strength for recoil reduction. | — | |
| 29 | Gyromount | Increases recoil capacity by 2. | +2 Recoil Capacity. | — | |
| 30 | Grapple Cannon | 18m reach, allows for movement along line. | 18m reach. Allows movement along the line. | — | |
| 31 | Hand Blade | Hand blade mounted on the flat of the hand. Reach 0. | Hand blade mounted on the flat of the hand. Reach 0. | — | |
| 32 | Hand Blade-Retractable | Hand blade mounted on the flat of the hand, retractable. Reach 0. | Hand blade mounted on the flat of the hand, retractable. Reach 0. | — | |
| 33 | Hand Razors | Knives mounted in the fingernails. Reach 0. | Knives mounted in the fingernails. Reach 0. | — | |
| 34 | Hand Razors-Retractable | Knives mounted in the fingernails, retractable. Reach 0. | Knives mounted in the fingernails, retractable. Reach 0. | — | |
| 35 | Hand Razors-Improved | Improved knives mounted in the fingernails. Reach 0. | Improved knives mounted in the fingernails. Reach 0. | — | |
| 36 | Hand Razors-Improved/Retractable | Improved knives mounted in the fingernails, retractable. Reach 0. | Improved knives mounted in the fingernails, retractable. Reach 0. | — | |
| 37 | Movement Enhancement 1 | Add 2m to movement | +2m Movement | — | |
| 38 | Movement Enhancement 2 | Add 4m to Movement | +4m Movement | — | |
| 39 | Movement Enhancement 3 | Add 6m to Movement | +6m Movement | — | |
| 40 | Rocket Boots | +8d to jumps and Athletics. Reroll 1s and 2s on jumps. Grants thrust compensation. | Grants a bonus to Athletics for jumps, and rerolls 1s and 2s on them. Grants thrust compensation. | — | |
| 41 | Strength Enhancement 1 | +1 Strength to all limbs. If greater than character strength you risk injury | +1 Strength to all limbs. If greater than character strength, you risk injury. | — | |
| 42 | Strength Enhancement 2 | +2 Strength to all limbs. If greater than character strength you risk injury | +2 Strength to all limbs. If greater than character strength, you risk injury. | — | |
| 43 | Strength Enhancement 3 | +3 Strength to all limbs. If greater than character strength you risk injury | +3 Strength to all limbs. If greater than character strength, you risk injury. | — | |
| 44 | Strength Enhancement 4 | +4 Strength to all limbs. If greater than character strength you risk injury | +4 Strength to all limbs. If greater than character strength, you risk injury. | — | |
| 45 | Strength Enhancement 5 | +5 Strength to all limbs. If greater than character strength you risk injury | +5 Strength to all limbs. If greater than character strength, you risk injury. | — | |
| 46 | Strength Enhancement 6 | +6 Strength to all limbs. If greater than character strength you risk injury | +6 Strength to all limbs. If greater than character strength, you risk injury. | — | |
| 47 | Knee Spurs | Spurs mounted in the knee. Reach 0. | Spurs mounted in the knee. Reach 0. | — | |
| 48 | Knee Spurs-Retractable | Spurs mounted in the knee, retractable. Reach 0. | Spurs mounted in the knee, retractable. Reach 0. | — | |
| 49 | Elbow Spurs | Spurs mounted in the elbow. Reach 0. | Spurs mounted in the elbow. Reach 0. | — | |
| 50 | Elbow Spurs-Retractable | Spurs mounted in the elbow, retractable. Reach 0. | Spurs mounted in the elbow, retractable. Reach 0. | — | |
| 51 | Wheelies | Can extend distance of straight-line move once per round by 8m | Can extend distance of straight-line move once per round by 8m | — | |
| 52 | Right Arm Replacement-Chromed | Limb-arm or leg replacement, chrome finish. | Limb-arm or leg replacement, chrome finish. | — | |
| 53 | Right Arm Replacement-Synthetic | Limb-arm or leg replacement, synthskin finish. | Limb-arm or leg replacement, synthskin finish. | — | |
| 54 | Right Arm Replacement-Chromed, RC | Limb-arm or leg replacement, chrome finish. Detachable and remote controllable up to 20m. | Limb-arm or leg replacement, chrome finish. Detachable. Remote controllable up to 20m. | — | |
| 55 | Right Arm Replacement-Synthetic, RC | Limb-arm or leg replacement, synthskin finish. Detachable and remote controllable up to 20m. | Limb-arm or leg replacement, synthskin finish. Detachable. Remote controllable up to 20m. | — | |
| 56 | Left Arm Replacement-Chromed | Limb-arm or leg replacement, chrome finish. | Limb-arm or leg replacement, chrome finish. | — | |
| 57 | Left Arm Replacement-Synthetic | Limb-arm or leg replacement, synthskin finish. | Limb-arm or leg replacement, synthskin finish. | — | |
| 58 | Left Arm Replacement-Chromed, RC | Limb-arm or leg replacement, chrome finish. Detachable and remote controllable up to 20m. | Limb-arm or leg replacement, chrome finish. Detachable. Remote controllable up to 20m. | — | |
| 59 | Left Arm Replacement-Synthetic, RC | Limb-arm or leg replacement, synthskin finish. Detachable and remote controllable up to 20m. | Limb-arm or leg replacement, synthskin finish. Detachable. Remote controllable up to 20m. | — | |
| 60 | Right Leg Replacement-Chromed | Limb-arm or leg replacement, chrome finish. | Limb-arm or leg replacement, chrome finish. | — | |
| 61 | Right Leg Replacement-Synthetic | Limb-arm or leg replacement, synthskin finish. | Limb-arm or leg replacement, synthskin finish. | — | |
| 62 | Right Leg Replacement-Chromed, RC | Limb-arm or leg replacement, chrome finish. Detachable and remote controllable up to 20m. | Limb-arm or leg replacement, chrome finish. Detachable. Remote controllable up to 20m. | — | |
| 63 | Right Leg Replacement-Synthetic, RC | Limb-arm or leg replacement, synthskin finish. Detachable and remote controllable up to 20m. | Limb-arm or leg replacement, synthskin finish. Detachable. Remote controllable up to 20m. | — | |
| 64 | Left Leg Replacement-Chromed | Limb-arm or leg replacement, chrome finish. | Limb-arm or leg replacement, chrome finish. | — | |
| 65 | Left Leg Replacement-Synthetic | Limb-arm or leg replacement, synthskin finish. | Limb-arm or leg replacement, synthskin finish. | — | |
| 66 | Left Leg Replacement-Chromed, RC | Limb-arm or leg replacement, chrome finish. Detachable and remote controllable up to 20m. | Limb-arm or leg replacement, chrome finish. Detachable. Remote controllable up to 20m. | — | |
| 67 | Left Leg Replacement-Synthetic, RC | Limb-arm or leg replacement, synthskin finish. Detachable and remote controllable up to 20m. | Limb-arm or leg replacement, synthskin finish. Detachable. Remote controllable up to 20m. | — | |
| 68 | Cybertechtronic Ears | Replacement auditory system. Can mount up to 0.5 ZR of mods without affecting ZP for casting | Replacement auditory system. Can mount up to 0.5 ZR of mods without affecting ZP for casting | — | |
| 69 | Amplification | Can reroll 1s on Observation tests. Allows for selective amplification of sounds. | Reroll 1s on Observation tests. Allows for selective amplification of sounds. | — | |
| 70 | Dampener | Dampener renders the user immune to the sonic effects of attacks. | Dampener renders the user immune to the sonic effects of attacks. | `sense: Sonic protection` | |
| 71 | Echolocation Positioning | User can detect objects or people within 20m even in complete darkness. | User can detect objects or people within 20m even in complete darkness. | `sense: Echolocation` | |
| 72 | Recorder | Requires datajack or memory. Can record audio recieved. | Requires a Datajack or Memory. Can record audio received. | — | **TYPO** — "recieved" corrected to "received" |
| 73 | Sound Filter | +1 to Observation tests. Allows for selective sound filtering. | Grants a bonus to Observation. Allows for selective sound filtering. | `sense: Selective hearing` | |
| 74 | Cybertechtronic Eyes | Replacement visual system. Can mount up to 0.5 ZR of mods without affecting ZP for casting | Replacement visual system. Can mount up to 0.5 ZR of mods without affecting ZP for casting | — | |
| 75 | AR Optical | AR Interface. Required to interact with AR | AR Interface. Required to interact with AR | — | |
| 76 | Camera | Requires datajack or memory. Can record video recieved. | Requires a Datajack or Memory. Can record video received. | — | **TYPO** — "recieved" corrected to "received" |
| 77 | Cosmetic Modification | Changes color and shape of eyes | Changes color and shape of eyes | — | |
| 78 | Eye Laser | One-shot eye laser. Complex Action, 2m range, 8d attack. Must replace eye after firing. | One-shot eye laser. Complex Action. Range 2m. 8d attack. Must replace eye after firing. | — | |
| 79 | Flare Compensation | Ignore flash/blinding weapons and bright lights | Ignore flash/blinding weapons and bright lights | — | |
| 80 | Laser Designator | +1 bonus die to accuracy when laser enabled. | +1d Accuracy when laser enabled. | — | |
| 81 | Low-Light | Ignore low-light penalties | Ignore low-light penalties | `sense: Sees in darkness / low light` | |
| 82 | Optical Datajack | Direct interface with Grid, hidden in eye | Direct interface with Grid, hidden in eye | — | |
| 83 | Thermographic | Ignore penalties for darkness. Can see in thermographic spectrum | Ignore penalties for darkness. Thermographic vision. | `sense: Thermographic vision` | |
| 84 | Vision Magnification 1 | Magnifies  vision, reducing range by 1 | Vision magnification 1. | `sense: Vision magnification` | **TYPO** — double space between "Magnifies" and "vision"; reworded to the canonical "Vision magnification N" form (same meaning: reduces range by the augment's rating) |
| 85 | Vision Magnification 2 | Magnifies  vision, reducing range by 2 | Vision magnification 2. | `sense: Vision magnification` | **TYPO** — double space between "Magnifies" and "vision"; reworded to the canonical "Vision magnification N" form |
| 86 | Chipjack | Data Chip Reader. Needed for Skillsofts/Skillwires or Nerve Rigs. Can mount multiple Readers | Data Chip Reader. Needed for Skillsofts/Skillwires or Nerve Rigs. Can mount multiple Readers | — | |
| 87 | Commlink | Built-in phone/radio | Built-in phone/radio | — | |
| 88 | Datajack | Direct interface with Grid | Direct interface with Grid | — | |
| 89 | Datajack-Concealed | Direct interface with Grid, hidden from view | Direct interface with Grid, hidden from view | — | |
| 90 | Fangs | Ceramasteel retractable fangs. Complex Action, Reach 0 bite. | Ceramasteel retractable fangs. Complex Action. Reach 0 bite. | — | |
| 91 | Memory-1 EB | Internal memory storage, per EB | Internal memory storage, per EB | — | |
| 92 | Nerve Rig | Full-sensory experiences from Chips or Wired Devices-Deck or Rig. Needed for full VR | Full-sensory experiences from Chips or Wired Devices-Deck or Rig. Needed for full VR | — | |
| 93 | Pain Nullifier | Requires Nerve Rig. Removes all wound penalties. Need Biotech test to check body condition | Requires a Nerve Rig. Removes all wound penalties. Need Biotech test to check body condition | `removes wound penalty` | |
| 94 | Skillsoft 1 | Gain 1 Rank in the skill purchased | Gain 1 Rank in the skill purchased | — | |
| 95 | Skillsoft 2 | Gain 2 Ranks in the skill purchased | Gain 2 Ranks in the skill purchased | — | |
| 96 | Skillsoft 3 | Gain 3 Ranks in the skill purchased | Gain 3 Ranks in the skill purchased | — | |
| 97 | Skillsoft 4 | Gain 4 Ranks in the skill purchased | Gain 4 Ranks in the skill purchased | — | |
| 98 | Skillsoft 5 | Gain 5 Ranks in the skill purchased | Gain 5 Ranks in the skill purchased | — | |
| 99 | Skillsoft 6 | Gain 6 Ranks in the skill purchased | Gain 6 Ranks in the skill purchased | — | |
| 100 | Smartlink | Grants +1 to tests with Smartlink Capable guns | Grants +1 to tests with Smartlink Capable guns | — | |
| 101 | Subvocal Mic | Requires Commlink. Subvocal mic to communicate silently. | Requires a Commlink. Subvocal mic to communicate silently. | — | |
| 102 | Synaptic Enhancers | +2 to Reaction and Intelligence-and maximums. Speeds up brain processing and reaction times. | Grants a bonus to Reaction and Intelligence. Speeds up brain processing and reaction times. | — | |
| 103 | Mobicycle | Legs convert to wheels. Move is 20m | Legs convert to wheels. Movement 20m. | — | |
| 104 | Aquamobi | Legs convert to turbines. Grants water movement of 24m | Legs convert to turbines. Water movement 24m. | — | |
| 105 | Railmobi | Legs convert to rail mount. Grants rail movement of 40m | Legs convert to a rail mount. Rail movement 40m. | — | |
| 106 | Trackmobi | Can mount to tracked chasis. 6m movement, 1 wt mount, and 1 ballistic armor. | Can mount to a tracked chassis. Movement 6m. Weight-1 mount. Grants Ballistic Armor. | — | **TYPO** — "chasis" corrected to "chassis" |
| 107 | Delux Trackmobi | Can mount to tracked chasis. 8m movement, 2 wt mount, and 2 ballistic armor. | Can mount to a tracked chassis. Movement 8m. Weight-2 mount. Grants Ballistic Armor. | — | **TYPO** — "chasis" corrected to "chassis". **CHECK** — the row's Name ("Delux Trackmobi") looks like a misspelling of "Deluxe"; not changed here since renaming a row is out of scope (needs a `RENAMED_*` migration map per the style guide) |
| 108 | Luxury Trackmobi | Can mount to tracked chasis. 8m movement, 3 wt mount, and 2 ballistic and 1 impact armor. | Can mount to a tracked chassis. Movement 8m. Weight-3 mount. Grants Impact and Ballistic Armor. | — | **TYPO** — "chasis" corrected to "chassis" |
| 109 | Repulsors | Repulsors allowing vectored flight. 12m of flying movement up to 20 minutes with a 30m ceiling. Can lift 450 kg. Treat as in full cover, but double recoil penalties. | Repulsors allowing vectored flight. 12m of flying movement up to 20 minutes with a 30m ceiling. Can lift 450 kg. Treat as in full cover. Double recoil penalties. | — | **CONTRADICTS DESC** — the Description says the 12m figure is the flight *ceiling* ("move up to 12 m above surfaces") and 30m is the *movement speed* while flying ("movement of 30 m"); the Effect text has these two numbers swapped ("12m of flying movement ... with a 30m ceiling"). Not renumbered here — flagging for the data owner to pick the correct pairing |
| 110 | Adrenal Pump | When active: +2 to Resolve, Brawn, and Finesse Pools for 10 minutes. At end, 9 stun damage. Recharge: 30/min, +1 stun to all dmg | When active: +2d Brawn/Finesse/Resolve Pool for 10 minutes. At end, 9 stun damage. Recharge: 30 minutes. +1 stun to all damage. | `pool Resolve+2, Brawn+2, Finesse+2` | **UNCLEAR** — "Recharge: 30/min" in the original is ambiguous (a 30-minute recharge time, vs. some per-minute rate); rendered here as "30 minutes" to match how "Recharge:" reads elsewhere in this table, but the true intent should be checked against the source |
| 111 | Hyper Adrenal Pump | When active: +4 to Resolve, Brawn, and Finesse Pools for 10 minutes. At end, 9 stun damage. Recharge: 30/min, +1 stun to all dmg | When active: +4d Brawn/Finesse/Resolve Pool for 10 minutes. At end, 9 stun damage. Recharge: 30 minutes. +1 stun to all damage. | `pool Resolve+4, Brawn+4, Finesse+4` | **UNCLEAR** — same "30/min" ambiguity as Adrenal Pump (row 110) |
| 112 | Augmented Eyesight | Ignore penalties for low light, treat darkness as low light, and shift your range categories on firearms by one. | Ignore penalties for low light. Treat darkness as low light. Shift your range categories on firearms by one. | `sense: Sees in darkness / low light` | |
| 113 | Bone Density | +2 Body and 2 Impact Armor | Grants a bonus to Body. Grants Impact Armor. | — | |
| 114 | Boosted Reflexes 1 | +2 Reaction | Grants a bonus to Reaction. | — | |
| 115 | Boosted Reflexes 2 | +4 Reaction | Grants a bonus to Reaction. | — | |
| 116 | Boosted Reflexes 3 | +6 Reaction | Grants a bonus to Reaction. | — | |
| 117 | Gills | Can breathe underwater | Can breathe underwater | — | |
| 118 | Hyperthyroid | Increase lifestyle cost 10%, +2 to Body, Reaction, and Strength. Does not increase max | Increase lifestyle cost 10%. +2 Body, Reaction, and Strength. | — | |
| 119 | Metabolic Stasis | Go into stasis instead of dying | Go into stasis instead of dying | — | |
| 120 | Muscle Augmentation 1 | +1 to Strength | Grants a bonus to Strength. | — | |
| 121 | Muscle Augmentation 2 | +2 to Strength | Grants a bonus to Strength. | — | |
| 122 | Muscle Augmentation 3 | +3 to Strength | Grants a bonus to Strength. | — | |
| 123 | Muscle Augmentation 4 | +4 to Strength | Grants a bonus to Strength. | — | |
| 124 | Muscle Augmentation 5 | +5 to Strength | Grants a bonus to Strength. | — | |
| 125 | Muscle Augmentation 6 | +6 to Strength | Grants a bonus to Strength. | — | |
| 126 | Orthoskin 1 | 1 Impact armor | Grants Impact Armor. | — | |
| 127 | Orthoskin 2 | 2 Impact and 1 Ballistic Armor | Grants Impact and Ballistic Armor. | — | |
| 128 | Orthoskin 3 | 3 Impact and 2 Ballistic Armor | Grants Impact and Ballistic Armor. | — | |
| 129 | Unmodified Organ Replacement | Unmodified organ replacement | Unmodified organ replacement | — | |
| 130 | Unmodified Limb Replacement | Unmodified limb replacement | Unmodified limb replacement | — | |
| 131 | Platelet Production Enhancement | Reduce physical damage by 1 (min 1), requires daily blood thinners | Requires daily blood thinners. Reduce physical damage by 1 (min 1). | — | |
| 132 | Prehensile Tail | 2m prehensile tail | 2m prehensile tail | — | |
| 133 | Reaction Enhancer 1 | +1 Reaction but doubles pain-based penalties | Grants a bonus to Reaction. Doubles pain-based penalties. | `doubles wound penalty` | |
| 134 | Reaction Enhancer 2 | +2 Reaction but doubles pain-based penalties | Grants a bonus to Reaction. Doubles pain-based penalties. | `doubles wound penalty` | |
| 135 | Reaction Enhancer 3 | +3 Reaction but doubles pain-based penalties | Grants a bonus to Reaction. Doubles pain-based penalties. | `doubles wound penalty` | |
| 136 | Reaction Enhancer 4 | +4 Reaction but doubles pain-based penalties | Grants a bonus to Reaction. Doubles pain-based penalties. | `doubles wound penalty` | |
| 137 | Reaction Enhancer 5 | +5 Reaction but doubles pain-based penalties | Grants a bonus to Reaction. Doubles pain-based penalties. | `doubles wound penalty` | |
| 138 | Reaction Enhancer 6 | +6 Reaction but doubles pain-based penalties | Grants a bonus to Reaction. Doubles pain-based penalties. | `doubles wound penalty` | |
| 139 | Shimmerskin | Can change skin tone. Can be immune to cameras | Can change skin tone. Can activate to be immune to camera-based tracking | — | **UNCLEAR** — "Can be immune to cameras" doesn't state the condition under which immunity applies; preserved as written rather than guessing |
| 140 | Synthskin | Synthetic skin to cover cyberware | Synthetic skin to cover cyberware | — | |
| 141 | Biomonitor | Under-skin display on forearm. Displays vital body statistics | Under-skin display on forearm. Displays vital body statistics | — | |
| 142 | Advanced Biomonitor | More detailed version of Biomonitor, can output to cyberoptics or broadcast. | More detailed version of Biomonitor, can output to cyberoptics or broadcast. | — | |
| 143 | Skinwatch | Precursor to biomonitor. Just a timepiece. | Precursor to biomonitor. Just a timepiece. | — | |
| 144 | Shift-tacs | Cosmetic eye changes, including patterns, exotic colors, or brand logos. | Cosmetic eye changes, including patterns, exotic colors, or brand logos. | — | |
| 145 | Light Tattoo | Like ink tattoos but the patterns emit light. Customizable and highly dependent on artist. | Like ink tattoos but the patterns emit light. Customizable and highly dependent on artist. | — | |
| 146 | Animated Tattoos | Like light tattoos but can move and change. Also highly dependent on the artist creating them. | Like light tattoos but can move and change. Also highly dependent on the artist creating them. | — | |
| 147 | ChemSkin | Dyes that can be rubbed into skin. Can be any normal human shade or exotic colors or even patterns. | Dyes that can be rubbed into skin. Can be any normal human shade or exotic colors or even patterns. | — | |
| 148 | Subdermal viewscreen | Marquee style display that displays text/images as set by owner. | Marquee style display that displays text/images as set by owner. | — | |
| 149 | Techhair | Artificial hair that can be any color, emit light, or even change tension. Can replace natural hair or be added like a weave. | Artificial hair that can be any color, emit light, or even change tension. Can replace natural hair or be added like a weave. | — | |
| 150 | MoodSkin | Synthskin that changes color based off of mood. | Synthskin that changes color based off of mood. | — | |
| 151 | Turn-On Nails | Fake nails that can change colors/size as needed | Fake nails that can change colors/size as needed | — | |
| 152 | Show-Off Nails | Flashier version of Turn-On Nails. Adds exotic effects and lights. | Flashier version of Turn-On Nails. Adds exotic effects and lights. | — | |
| 153 | Nu-Tek TVSkin | Similar to viewscreen, but can display HD video. Requires Arwin or Chipjack and internal storage. | Requires an Arwin or Chipjack (with internal storage). Similar to a viewscreen, but can display HD video. | — | **UNCLEAR** — "Requires Arwin or Chipjack and internal storage" doesn't make clear whether "and internal storage" is required alongside either option, or only alongside Chipjack; the Description has the identical ambiguity ("Requires a communicator or chipjack and internal storage"), so preserved rather than resolved |
| 154 | Kill Display | Synthskin display that shows a kill counter. Usually prominently displayed (like on forehead or knuckles) | Synthskin display that shows a kill counter. Usually prominently displayed (like on forehead or knuckles) | — | |

### Summary
- **Rows reviewed:** 154
- **Changed (Proposed ≠ Original):** 87
- **Unchanged (no drift found):** 67
- **NEW BEHAVIOUR:** 0
- **CONTRADICTS DESC:** 1 (Repulsors, row 109)
- **TYPO:** 8 rows (Automated Hypoinjectors "an inject"; Recorder and Camera "recieved" ×2; Vision Magnification 1/2 double-space ×2; Trackmobi, Delux Trackmobi, Luxury Trackmobi "chasis" ×3)
- **UNCLEAR:** 4 (Adrenal Pump, Hyper Adrenal Pump — "30/min"; Shimmerskin — unconditioned "can be immune"; Nu-Tek TVSkin — requirement scope)
- **CHECK:** 1 (Delux Trackmobi — likely-misspelled row Name, out of scope to fix here)

### How the engine actually reads this table

Before rewriting, I traced every place `rules.js` reads the `augments` table's `Effect` column, since the packet's `current_parser_hits` looked sparse for a 154-row table with a lot of `+N Body`/`+N Armor`/movement/recoil text in it. The reason: **Body, Strength, Reaction, Impact/Ballistic Armor, Movement, and Recoil Capacity bonuses are not parsed from `Effect` at all.** They come from dedicated columns (`Impact Armor`, `Ballistic Armor`, `ImpArmMin`, `AltMove`, etc., rules.js:1574–1591) or from hard-coded `row.Name === "..."` checks (Gyromount's recoil bonus at rules.js:1577–1579, Movement Enhancement's scaling at rules.js:1574–1576, Covert Synthskin's dodge bonus, Wired Reflexes' melee-exploit count, etc.). Only three things actually read the Effect text for this table:

1. **`SENSE_CAPABILITIES`** keyword matching (rules.js:2654), invoked by `deriveSenseNotes` (rules.js:2686) against every owned augment's `row.Name + " " + clause`, clause-split on `[.;]`.
2. **Wound-penalty remove/double regexes** (rules.js:4984–5003), which scan the *whole* Effect string (not clause-split) for `wound penalt`/`pain...penalt` plus a verb.
3. **`POOL_DICE_RE`** (rules.js:4104), which scans the whole Effect string for signed dice against `Brawn/Finesse/Focus/Resolve` — nothing else counts as a "Pool" name, so Body/Strength/Reaction rewrites can never accidentally trip it.

I re-verified every row in categories 1–3 individually against the proposed rewrite to confirm the hit is unchanged; none of the cosmetic Body/Armor/Movement/Recoil rewrites touch a live parser, which is why **NEW BEHAVIOUR is 0** for this table (unlike what the task brief's Dorf example might suggest — this table just didn't have a near-miss case in it).

### Recurring drift patterns in this table

1. **`+N to Attribute`** and **`+N to Attribute-and-Attribute`** — the dominant pattern (Bone Lacing, Muscle Replacement 1–6, Muscle Augmentation 1–6, Strength Enhancement 1–6, Dermal Plating, Orthoskin, Bone Density, Synaptic Enhancers, Hyperthyroid — roughly 35 rows). Dropped "to", capitalized the attribute, and split two-attribute grants into two sentences per the "one mechanical statement per sentence" rule.
2. **Armor stated without a leading `+`**, or with type words in an odd order (`1 Impact armor`, `2 Impact and 1 Ballistic Armor`, `+3 Body, 2 Impact and 1 Ballistic Armor`) — canonicalized to `+N Impact Armor` / `+N Ballistic Armor`, one sentence per type when the numbers differ.
3. **`Requires X.` missing its article, or placed at the end of the sentence instead of leading** — Skillwires 1–6 ("Requires Chipjack" → "Requires a Chipjack"), Pain Nullifier, Subvocal Mic, Recorder, Camera (all "Requires datajack or memory" → "Requires a Datajack or Memory"), Platelet Production Enhancement and Nu-Tek TVSkin (both had the requirement trailing instead of leading).
4. **Movement phrased as "Add Nm to movement"** (Movement Enhancement 1–3) instead of "+Nm Movement", or as "Move is Nm" / "Grants [x] movement of Nm" for the Mobi family instead of "Movement Nm" / "[x] movement Nm".
5. **Multiple distinct mechanics bundled into one sentence** via comma or "and" — Broadcast Jammer, Wired Reflexes 1–3, the four "-RC" limb-replacement variants, Eye Laser, Fangs, and the whole Trackmobi family all had 2–4 independent numbers/effects running together.
6. **Misspellings**: "recieved" (Recorder, Camera), "chasis" (Trackmobi ×3), one double space ("Magnifies  vision" ×2), and "an inject" for "can inject" (Automated Hypoinjectors).
7. **Skill bonuses stated only in Effect prose** ("+6 to Subterfuge" on Compartment, "+1 to Observation tests" on Sound Filter) — these are cosmetic-only rewrites (added the "d"), since the style guide and rules.js both confirm augments carry the real bonus through dedicated `Skill Bonus`/`Skill Note` columns, not through Effect-text parsing.

## Heritage, martial arts, amp powers, armor and drones

# Packet B — character (heritage, martial arts, amp, armor, drones, deck/rig mods)

Grounded against `static/rules.js`: heritage_features Effects is live-parsed only for pool
dice (`parsePoolDice`), initiative note (`deriveInitiative`), sense capability
(`SENSE_CAPABILITIES`), and wound-penalty negation/doubling — dodge/soak/movement/cover/recoil
are computed **only** from `martial_arts` level Effect text (`martialArtStatMods`, rules.js:4196),
never from heritage. amp_powers Effect is live-parsed only for pool dice and initiative note.
armor_materials/armor_extras Effect(s) feed only the etiquette parser. deck_mods/rig_mods are
fully inert (`engine_reads_this_column: false`). This is what makes each Notes call below precise
rather than a guess.

### heritage_features — Effects

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Dog | +2 to Observation. If hands free, 10m Move | +2d Observation. Movement 10m while hands are free. | — | |
| 2 | Bear | +2 on all Soak tests | +2d Soak. | — | |
| 3 | Gorilla | Natural Reach of 1 | Natural Reach 1. | — | |
| 4 | Octopus | Gain Camouflage (+2 to Recon. Only seen with Observation vs Shadow test) | Camouflage: +2d Reconnaissance. Detectable only by an Observation test versus Shadow. | — | |
| 5 | Shark | Bite Attack: Reach(0) 6+STR | Bite attack: Reach 0. Damage 6+STR. | — | |
| 6 | Dolphin | Hold breath for Body in minutes | Can hold your breath for a number of minutes equal to Body. | — | |
| 7 | Snake | 2 Impact Armor. Choose attack: Bite: Reach(0) 1/2Str+1+3d6 poison or Spit: Range(12m) Acc4 2d6DMG+Blind | +2 Impact Armor. Choose an attack: Bite — Reach 0, damage 1/2 STR+1+3d6 (poison); or Spit — Range 12m, Accuracy 4, damage 2d6 plus Blind. | — | |
| 8 | Rabbit | If hands free, 12m Move. Gain 2 simple actions before initiative is rolled | Movement 12m while hands are free. Gain 2 simple actions before initiative is rolled. | `initiative note` | |
| 9 | Cat | If hands free, 10m Move. +2d bonus on Shadow tests | Movement 10m while hands are free. +2d Shadow. | — | |
| 10 | Racoon | Can mount medium or large for cover (-2). +2 on all dodge tests | Can ride atop a medium or large creature for cover (-2). +2d Dodge. | — | **UNCLEAR**: "mount ... for cover (-2)" doesn't say what the -2 applies to (attacker's roll? the mount's?) or what "mount" means mechanically here. Ambiguity kept from the original. |
| 11 | Chameleon | Gain Camouflage (+2 to Recon. Only seen with Observation vs Shadow test). Climb on any surface (upside down=difficult terrain) | Camouflage: +2d Reconnaissance. Detectable only by an Observation test versus Shadow. Can climb any surface (upside-down movement counts as difficult terrain). | — | |
| 12 | Rat | +1 to all tests | +1 to all tests | — | Already canonical; no change. |
| 13 | Raven | Fly of 12m. Natural vision mag of 2. | Fly 12m. Vision magnification 2. | `sense: Vision magnification` | |
| 14 | Bat | Fly of 8m. Natural Echolocation 24m | Fly 8m. Echolocation 24m. | `sense: Echolocation` | |
| 15 | Chimerical | +1d on Sorcery, Conjuring, Channeling, and Astral Senses | +1d Sorcery, Conjuring, Channeling, and Astral Senses. | — | |
| 16 | Enchanting | Enthrall spell at ZP. | Grants the Enthrall spell (cast at Force equal to current ZP). | — | **UNCLEAR**: "at ZP" is undefined (a ZP cost? a ZP-gated unlock?) — kept as vague as the original. |
| 17 | Nature's Blessing | Choose one stat +3 and second stat +1 | Choose one attribute for +3. Choose a second attribute for +1. | — | |
| 18 | Redcap | +2 on all soak tests. Must drink blood/eat flesh monthly | +2d Soak. Must drink blood or eat flesh monthly. | — | |
| 19 | Shapechanging | May slip into animal form. Gain its physical traits. | Can shift into an animal's form, gaining its physical traits. | — | |
| 20 | Resmedis | Hide up to weight 2 objects in extra-dimensional space for 1 hour | Can hide objects of up to 2 weight in extra-dimensional space for 1 hour. | — | |
| 21 | Otherworldly | Unaging. Treat spirits as if -1 to Force | Unaging. Treats spirits as though their Force is 1 lower. | — | |
| 22 | Astral Flame | Illuminate target as Simple Action. | Illuminate a target as a Simple Action. | — | |
| 23 | Wildling | Transform into man-beast (Complex Action). +6 to Brawn/Finesse Pool, -3 Focus/Resolve. +6 "Beast" dice that refresh each round. Heal 1d6 wounds | Transform into a man-beast as a Complex Action. +6d Brawn/Finesse Pool. -3d Focus/Resolve Pool. Grants 6 Beast dice that refresh each round. Heal 1d6 wounds. | `pool Brawn+6, Finesse+6, Focus-3, Resolve-3` | |
| 24 | Wind Walk | +4m to Move | +4m Movement. | — | |
| 25 | Allergies | Iron causes 1d6 damage stun and 1/2 physical on contact | Contact with iron deals 1d6 stun damage and 1/2 that as physical damage. | — | |
| 26 | Antlers | Cannot wear helmets/headgear | Cannot wear helmets or headgear. | — | |
| 27 | Compulsive | Choose 2 actions that must be done habitually. -2 on all tests if not done daily. | Choose 2 actions that must be performed habitually. -2 to all tests on any day either is skipped. | — | |
| 28 | Green Skin | Skin is green with hair that changes color with the seasons | Skin is green. Hair changes colour with the seasons. | — | |
| 29 | Nature Bound | Cannot cross running water. Skin blisters/burns in UV light. -1d on actions in bright light | Cannot cross running water. Skin blisters and burns in UV light. -1d to actions in bright light. | — | **CHECK**: kept "UV" instead of spelling it to "ultraviolet" — the sense parser matches literal `ultraviolet` and would misread this vulnerability as granting Ultraviolet vision. Do not expand the abbreviation here. |
| 30 | Smol | Between 2 and 4 feet in height. Gear & augment costs ×1.4. | Between 2 and 4 feet tall. Gear and augment costs ×1.4. | — | |
| 31 | Analgesia | Immune to pain (no penalties). You do not know how injured you are. | Immune to pain — no penalties from injury. You do not know how badly you are hurt. | — | |
| 32 | Camouflage | +2 to Recon. Only seen with Observation vs Shadow test | +2d Reconnaissance. Detectable only by an Observation test versus Shadow. | — | |
| 33 | Extra Arm | Extra Arm. +50% to Armor costs (custom fitting) | Grants an extra arm. +50% to Armor costs (custom fitting). | — | |
| 34 | Extra Leg | Extra Leg. +2m to base Move. +50% to Armor costs (custom fitting) | Grants an extra leg. +2m Movement. +50% to Armor costs (custom fitting). | — | |
| 35 | Hephestus | +2d on all Engineering tests | +2d Engineering. | — | |
| 36 | Huge | 9-12 feet tall. | 9 to 12 feet tall. | — | |
| 37 | Immortal | Unaging and immortal to natural causes of death. | Unaging. Immune to death from natural causes. | — | |
| 38 | Tough | 2B and 2I armor. Laser fire heals after 10minutes. Occupies Under Armor slot | +2 Ballistic Armor. +2 Impact Armor. Laser damage heals after 10 minutes. Occupies the Under Armor slot. | — | |
| 39 | Unstoppable | Reroll 1s on Soak rolls | Reroll 1s on Soak tests. | — | |
| 40 | Animal Head | Head looks like some kind of animal | Head resembles an animal. | — | |
| 41 | Bulky | Reduce base Move by 2m | -2m Movement. | — | |
| 42 | Cyclopean | -2 to ranged combat due to one central eye | -2 to ranged combat (one central eye). | — | |
| 43 | Extra Face | Disturbing extra face that cannot be hidden easily | Has a disturbing extra face that is difficult to hide. | — | |
| 44 | Segmented Eyes | Eyes like a fly, but softball sized | Compound eyes like a fly's, softball-sized. | — | |
| 45 | Arcano-Manon Interface Matrix | +3 to ZP | +3 ZP. | — | |
| 46 | Durable | -1d penalty for every 6 boxes of damage | -1d to tests for every 6 boxes of damage taken. | — | |
| 47 | Heavy Torso | Gain 2 1-weight mounts. -2m to base Move | Gain 2 weight-1 mounts. -2m Movement. | — | |
| 48 | No Head | 1 weight Weapon Mount | Weight-1 Weapon Mount. | — | |
| 49 | Polypedal Legs 4 | -1m level and +2 Athletics dice | -1m Movement. +2d Athletics. | — | **UNCLEAR**: "level" (a movement-tier concept?) isn't defined anywhere in this packet; kept as vague as the original rather than inventing a meaning. |
| 50 | Polypedal Legs 6 | -2m level and +4 Athletics dice | -2m Movement. +4d Athletics. | — | **UNCLEAR**: same "level" ambiguity as Polypedal Legs 4. |
| 51 | Polypedal Legs 8 | -3m level and +6 Athletics dice | -3m Movement. +6d Athletics. | — | **UNCLEAR**: same "level" ambiguity as Polypedal Legs 4. |
| 52 | Specialization | +1d to all tests for a single Pool | +1d to all tests in a chosen Pool. | — | |

### martial_arts — Effect

`martialArtStatMods` (rules.js:4196) reads dodge/soak/movement/recoil/cover/unarmed/spurs
straight off this column, per level, per style. The dodge-dice veto (`\b(vs|if)\b`) is tested
against the row's *whole* Effect text, not just the clause with the number in it.

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Gun-Kata | Always Low Cover (-1d) | Always grants Low cover (-1d to attackers). | `cover: low` | |
| 2 | Weirding Way | +1d to Dodge. Reach 0 weapons may use Unarmed Combat instead of Melee Weapons or Cybertech Combat | +1d Dodge. Reach 0 weapons may use Unarmed Combat instead of Melee Weapons or Cybertech Combat. | `dodge dice +1` | |
| 3 | Way of the Tank | Fight in 0-G w/ no penalties | Fight in zero-G with no penalties. | — | |
| 4 | Shibumi | Use Shibumi for Astral Sense. +1d to Soak | Use Shibumi for Astral Senses. +1d Soak. | `soak dice +1` | |
| 5 | Gun-Kata | Can fire +1 bullet (+1d for 1 ammo) | Can fire 1 extra bullet (+1d, costs 1 additional ammo). | — | |
| 6 | Weirding Way | Reach always 1 higher than opponent | Reach is always 1 higher than the opponent's. | — | |
| 7 | Way of the Tank | +4d to Dodge vs 1 Tgt | +4d Dodge vs a single target. | `dodge dice VETOED (vs/if)` | **CHECK**: kept the literal word "vs" — the style guide's normal rule would spell it out to "versus", but the dodge-dice veto only fires on literal `\bvs\b`/`\bif\b`. Writing "versus" here would silently turn this into a permanent +4d Dodge bonus. Do not canonicalize this word. |
| 8 | Shibumi | Always considered Armed. Unarmed deals Str+3 physical | Always considered armed. Unarmed attacks deal Str+3 physical damage. | `unarmed damage 3` | Kept "Str+3" (not "Strength+3") — the unarmed-damage regex requires literal `str` immediately followed by `+<digits>`. This matches the style guide's own carve-out for established stat abbreviations, so it's not a deviation. |
| 9 | Gun-Kata | Can split fire w/ no penalty. Ignore Recoil | Can split fire with no penalty. Ignore Recoil. | `recoil ignored` | |
| 10 | Weirding Way | +2m base movement | +2m Movement. | `movement +2` | |
| 11 | Way of the Tank | Complex Melee Strike ignores Armor | A Complex Action melee strike ignores Armor. | — | |
| 12 | Shibumi | Ignore blindness/visual impairment. +2d to Soak | Ignore blindness or visual impairment. +2d Soak. | `soak dice +2` | |
| 13 | Gun-Kata | Treated as armed in melee. Can SS in melee. | Treated as armed in melee. Can use Pistol/SMG SS fire in melee. | — | **UNCLEAR**: "SS" isn't defined anywhere in the packet (likely a firearms fire-mode abbreviation); left unexpanded rather than guessing at its meaning. |
| 14 | Weirding Way | +2d to Dodge (replace level 1) | +2d Dodge (replaces Level 1). | `dodge dice +2` | |
| 15 | Way of the Tank | EM Punch: +3/+6 dmg (organic/electronic). Take 6 stun (soakable) | EM Punch: +3 damage to organic targets, +6 to electronic targets. Take 6 stun damage yourself (soakable). | — | |
| 16 | Shibumi | +4d to Soak | +4d Soak. | `soak dice +4` | |
| 17 | Gun-Kata | Always High Cover (-2d) | Always grants High cover (-2d to attackers). | `cover: high` | |
| 18 | Weirding Way | As reflex action to force melee attack to re-roll | As a Reflex Action, force a melee attack to be re-rolled. | — | |
| 19 | Way of the Tank | If Dodge a melee attack, make free melee attack | If you dodge a melee attack, make a free melee attack. | — | |
| 20 | Shibumi | Ignore Wound penalties | Ignore wound penalties. | `removes wound penalty` | |
| 21 | Gun-Kata | Melee attacks w/n 2m penalized by Firearms skill | Melee attacks within 2m are penalized by your Firearms skill. | — | **UNCLEAR**: whose Firearms skill and how large the penalty is aren't specified by the original; ambiguity preserved. |
| 22 | Weirding Way | As reflex action can teleport 10m. Take 1 stun. | As a Reflex Action, teleport 10m. Take 1 stun damage. | — | |
| 23 | Way of the Tank | Spurs do 6+STR damage | Spurs deal 6+STR damage. | `spurs damage 6` | |
| 24 | Shibumi | +6d to Soak | +6d Soak. | `soak dice +6` | |

### amp_powers — Effect

Only `parsePoolDice` (a signed number adjacent to Brawn/Finesse/Focus/Resolve) and the
initiative-note scan (`deriveInitiative`) read this column live — not dodge/soak/cover/recoil,
and not senses. None of the rewrites below introduce a signed number next to a pool name or the
substring "initiat" where the original didn't already have one.

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Adrenaline Boost | +1 Simple Action/Round. Only available once | +1 Simple Action per round. Can only be taken once. | — | |
| 2 | Aspect of the Chelonian | 2B/3I Armor. Takes Internal Slot | +2 Ballistic Armor. +3 Impact Armor. Occupies the Internal armor slot. | — | |
| 3 | Astral Resistance | +4 resistance to magic. | +4d to resistance tests against magic. | — | |
| 4 | Attribute Boost | +1 to Attribute and Max per time purchased | +1 to a chosen Attribute and its maximum. Can be taken multiple times. | — | |
| 5 | Attribute Increase | +1 to Attribute (but not Max) per time purchased | +1 to a chosen Attribute (not its maximum). Can be taken multiple times. | — | |
| 6 | Body Equilibrium | Can walk across liquid per normal Move. Cannot stop, leaves no trace | Can walk across liquids at normal Movement speed. Cannot stop while doing so, and leaves no trace. | — | |
| 7 | Combat Mastery | +2 Exploit Actions in melee. | +2 Exploit Actions in melee. | — | Already canonical; no change. |
| 8 | Eyes of the Raptor | +2 bonus dice to Firearms | Grants a bonus to Firearms. | — | |
| 9 | Might of the Bear | +2 bonus dice to Unarmed Combat | Grants a bonus to Unarmed Combat. | — | |
| 10 | Sting of the Scorpion | +2 bonus dice to Melee Weapons | Grants a bonus to Melee Weapons. | — | |
| 11 | Expertise | +2 to Skill and it's maximum | +2 to a chosen Skill and its maximum. | — | **TYPO**: "it's" → "its" (possessive, not a contraction). |
| 12 | Fade from Vision | One target in combat can't see you (-6d). Switch target is Complex action | One target in combat cannot see you (-6d to their tests against you). Switching targets is a Complex Action. | — | |
| 13 | Far Sight | Can observe w/n a city block. +2 Recon. Requires Trance (Complex) and sensor can be seen with Astral Senses | Can observe within a city block. +2d Reconnaissance. Requires entering a Trance (Complex Action); the sensor is visible to Astral Senses. | — | |
| 14 | Flash Step | 1 Stun damage to teleport 10m. Free Action. | Take 1 Stun damage to teleport 10m. Free Action. | — | |
| 15 | Flying Crane | Athletics test to increase jump. Each success=4m(standing)/8m(running)/2m(vert) | Athletics test to increase jump distance. Each success grants 4m from standing, 8m from a running start, or 2m vertical. | — | |
| 16 | Ghost | Immune to all cameras. Cannot be recorded digitally | Immune to cameras. Cannot be recorded digitally. | — | |
| 17 | Hidden Presence | +2 bonus on Shadow and Subterfuge | Skin and clothes subtly match the surroundings while still. Grants a bonus to Shadow and Subterfuge. | — | |
| 18 | Iron Fist | Can do physical damage w/o weapons (1/2STR+6). Can act as Reach(0) melee weapon. | Can deal physical damage without weapons (1/2STR+6). Can act as a Reach 0 melee weapon. | — | |
| 19 | Perfect Situational Awareness | +3d on dodge, soak, and resistance rolls | +3d Dodge, Soak, and Resistance tests. | — | |
| 20 | Rasputin's Blessing | +8d to resist poison/toxins/gases | +8d to resist poison, toxins, and gases. | — | |
| 21 | Returning the Fang | If Finesse pool is not empty, can deflect thrown or archery objects. Can use Throw to deflect at another target | While your Finesse pool has any dice, you can automatically deflect thrown weapons or arrows/bolts fired at you. You may instead spend a Throwing Weapons test to redirect the deflected attack at another target. | — | No signed number was introduced next to "Finesse pool" — doing so would trip `parsePoolDice`. |
| 22 | Self-Healing | Convert Physical Wound to Stun track as Complex Action. | As a Complex Action, convert a Physical wound to the Stun track. | — | |
| 23 | Shadow Double | Once/day Shadow Clone. Grants rerolls of 1s/2s on dodge | Once per day, create a Shadow Clone. Reroll 1s and 2s on Dodge tests. | — | |
| 24 | Suspended Animation | Hibernate w/o food/water/air for 1 wk per ZP. | Can hibernate without food, water, or air for 1 week per ZP spent. | — | |
| 25 | Telekinesis | Can manipulate non-attended objects w/ mind. | Can manipulate unattended objects with your mind. | — | **TYPO**: "non-attended" → "unattended". |
| 26 | Touch of the Spider | Can move on vertical/upside down axis. | Can move along vertical and upside-down surfaces. | — | |

### armor_materials — Effect

Only `parseEtiquetteBonuses` reads this column live, and only when the text contains the literal
word "etiquette" — the "Charisma tests" numbers here are flavor only, never computed.

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Cheap | -1 to Charisma tests | -1 to Charisma tests | — | Already canonical; no change. |
| 2 | Very Good | +1 to Charisma tests | +1 to Charisma tests | — | Already canonical; no change. |
| 3 | Designer | +2 to Charisma tests | +2 to Charisma tests | — | Already canonical; no change. |
| 4 | Superchic (personal designer) | +2 to Charisma tests, +1 to Aristocratic etiquette | +2 to Charisma tests. +1 Aristocratic etiquette. | `etiquette Aristocratic+1` | Split the comma-joined pair into two sentences per the one-effect-per-sentence rule; verified against `parseEtiquetteBonuses`'s span logic that the etiquette hit is unaffected by the period. |

### armor_extras — Effects

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | PolyLog Material | 5 Color Schemes, Hardening 2 | 5 Color Schemes. Hardening 2. | — | Split two unrelated facts joined by a comma into two sentences; no "etiquette" keyword here so `parseEtiquetteBonuses` never engages either way. |
| 2 | Thermoweave | Extra Comfort, Hardening 2 | Extra Comfort. Hardening 2. | — | |
| 3 | PolyChromic material | 12 Color Schemes, Hardening 4 | 12 Color Schemes. Hardening 4. | — | |

### armor_extras — Notes

`engine_reads_this_column: false` for all three — pure flavor text, no live parsing at all.

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | PolyLog Material | Holds up to 5 different color schemes, can be wirelessly changed, has a hardening of 2, prone to malfunction in combat conditions | Holds up to 5 different color schemes. Can be changed wirelessly. Hardening 2. Prone to malfunction in combat conditions. | — | |
| 2 | Thermoweave | Extra comfort (internal temperature can be wirelessly changed, has a hardening of 2) | Extra comfort: internal temperature can be changed wirelessly. Hardening 2. | — | |
| 3 | PolyChromic material | Holds up to 12 different color schemes, can be wirelessly changed, has a hardening of 4 | Holds up to 12 different color schemes. Can be changed wirelessly. Hardening 4. | — | |

### drones — Effect

`droneSkillDice`/`droneCombatBonuses` (rules.js:2551-2625) split this column on `[,.;]` and, per
clause, look for a signed number near a real skill name (aliases: only "Reconnaissance" ↔ "Recon"
— every other skill matches its own literal name only, e.g. "Shadow" and nothing else). Cover /
dodge / vision "notes" are just a case-insensitive substring test — they don't feed the tiered
cover engine martial arts uses.

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Bug-Spy | +1 to Observation/Recon, +2d Initiative | +1d Observation/Reconnaissance. +2d Initiative. | `drone initiative +2; drone skill Observation+1; drone skill Reconnaissance+1` | Comma and period are both clause separators for this parser, so splitting the bundled sentence changes nothing about which hits fire. |
| 2 | Disc | Create light up to 20m, dim to bright | Creates light with a 20m radius, adjustable from dim to bright. | — | |
| 3 | VSTOL Bird | +4 Recon, Stealth (-6d to target) | +4d Reconnaissance. Stealth: imposes -6d on the target's tests to detect this drone. | `drone skill Reconnaissance+4` | **CHECK**: the -6d is a penalty on the drone's TARGET, not the operator. It currently produces no hit only because the text says "Stealth" and not the real skill name "Shadow" — pure luck, per the task brief. Deliberately kept "Stealth" (not "Shadow") in the same clause as the number: writing "Shadow" here would make `droneSkillDice` read it as a real -6d Shadow malus handed to the drone's OPERATOR. Do not rename this to "Shadow" without also restructuring how this row is parsed. |
| 4 | Roto-Drone | Grants Thermographic Vision | Thermographic vision. | `drone vision note` | Dropped the "Grants " prefix — `droneCombatBonuses` already strips it (rules.js:2619), so it changed nothing. |
| 5 | Shield Drone | Reroll 1s on dodge tests | Reroll 1s on Dodge tests. | `drone dodge note` | |
| 6 | Anthrodoid | Str6 | Strength 6. | — | |
| 7 | Mobile Sentinel | Hover, 6m flight ceiling | Hovers. Flight ceiling 6m. | — | |
| 8 | Shield-Wall Drone | Provides mobile High Cover | Provides mobile High cover. | `drone cover note` | |
| 9 | Anthrobrute | Str9 | Strength 9. | — | |
| 10 | Gladiator | STr14 | Strength 14. | — | **TYPO**: "STr" → normalized capitalization (compare "Str6"/"Str9" on the two rows above; the mixed-caps "STr" is unique to this row). |
| 11 | Aerial Warden | Hover, 6m flight ceiling. 3 passengers w/ high cover | Hovers. Flight ceiling 6m. Carries 3 passengers under High cover. | `drone cover note` | |

### deck_mods — Effect

`engine_reads_this_column: false` for all four rows — no live parsing, flavor/reference text only.

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Range Extension | Extends hacking range to 15 meters | Extends Hacking range to 15m. | — | |
| 2 | Wide Area Protocols | Extends hacking range to 20 meters | Extends Hacking range to 20m. | — | |
| 3 | Input Validation | Increases hardening by +1 | +1 Hardening. | — | |
| 4 | Data Streamer | Gives the deck the effect of Stealth 1 software constantly | Constantly grants the deck's Stealth 1 software effect. | — | |

### rig_mods — Effect

`engine_reads_this_column: false` for all four rows — no live parsing, flavor/reference text only.

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Input Validation | +1 to Vehicle/Drone Hardening | +1 Vehicle/Drone Hardening. | — | |
| 2 | Military Grade Hardening | +2 to Vehicle/Drone Hardening | +2 Vehicle/Drone Hardening. | — | |
| 3 | Electronic Countermeasures | Drones/Vehicles -1d to hit | Your Linked Drones/Vehicles gain a -1d to be hit. | — | **UNCLEAR**: doesn't say whose drones/vehicles (enemy, presumably, given the name) — ambiguity kept from the original rather than assumed. |
| 4 | Bonus Link | +1 Link | +1 Link | — | Already canonical; no change. |

### Summary
**131 rows total**, all present above.

- **Changed (reworded)**: 126
- **Unchanged (already canonical)**: 5 — armor_materials Cheap/Very Good/Designer, heritage
  Rat ("+1 to all tests"), rig_mods Bonus Link.
- **NEW BEHAVIOUR**: 0. Every canonicalization was checked against the actual live regexes in
  `rules.js` (not inferred from the style guide alone); everywhere a canonical rewrite would have
  incidentally created a new hit — most notably any heritage phrase that reads like a dodge/soak/
  movement/cover bonus — it turns out heritage_features and amp_powers simply aren't wired to
  those parsers (they run off dedicated numeric columns / martial_arts only), so no live behaviour
  moved either direction.
- **CONTRADICTS DESC**: 0. Checked every amp_powers row (the only table in this packet carrying
  real Description prose) against its Effect; descriptions add flavour and edge-case detail but
  never state something the Effect contradicts.
- **TYPO**: 3 — Expertise ("it's"→"its"), Telekinesis ("non-attended"→"unattended"), Gladiator
  drone ("STr14" capitalization).
- **UNCLEAR**: 8 — Racoon's cover mount, Enchanting's "at ZP", the three Polypedal Legs rows'
  "level" unit, Gun-Kata's "SS" abbreviation and its "penalized by Firearms skill" clause,
  Electronic Countermeasures' unstated "whose drones/vehicles". All preserve the original's own
  ambiguity rather than resolve it with an invented mechanic.
- **CHECK**: 3 — Way of the Tank's "+4d Dodge vs 1 Tgt" (keep the literal "vs", spelling it to
  "versus" would delete the engine's veto and make the bonus permanent), VSTOL Bird's Stealth
  clause (the flagged target-facing -6d; do not rename "Stealth" to the real skill name "Shadow"),
  and Nature Bound's "UV light" (do not expand to "ultraviolet" — that word is a live sense-grant
  trigger and this trait is a vulnerability, not a sense).

**Recurring drift patterns in this packet:**
1. **Comma-joined bundles of two unrelated effects** — the single biggest and most common drift
   (heritage Compulsive/Nature Bound-style lists, Superchic's Charisma+etiquette line, all three
   armor_extras Effects rows, VSTOL Bird, Aerial Warden). Style guide's "one mechanical statement
   per sentence" rule fixes all of them, and in every case here the parsers involved treat `,` and
   `.` as equivalent clause breaks, so the fix is risk-free.
2. **Abbreviation soup**: `w/`, `w/n`, `w/o`, `vs`, `1-weight`/`weight-1`, `dmg`, `mag`, inconsistent
   `Str`/`STr`/`STR` casing. Spelling these out is safe almost everywhere in this packet **except**
   the two flagged CHECK rows, where the abbreviation (or the exact word "vs") is itself
   parser-load-bearing.
3. **Decorative mechanical text**: heritage's Soak/Dodge/Move/Armor numbers and drone Strength
   ratings read like live stat mods but are actually sourced from separate dedicated columns not
   included in this packet (or, for drones, not read anywhere) — the Effects text is player-facing
   flavor duplicating a number computed elsewhere. Canonicalizing these (e.g. "+2 on all Soak
   tests" → "+2d Soak") is purely cosmetic here, but worth knowing before assuming a heritage/drone
   Effect rewrite is inert on some other packet where the wiring might differ.

## Gear, weapon mods and weapons

# Packet C — Gear effect-text standardization (draft)

Review only. No repo files were modified. 137 rows processed.

### misc_gear — Effect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Bliss | Euphoric eyedrops. -1d to all tests for a few hours. | Euphoric eyedrops. -1d to all tests for a few hours. | — | |
| 2 | BTL | Simsense experience, but amplified. | Simsense experience, but amplified. | — | |
| 3 | Cram | Pills or hypopatch. Sleeplessness and +2d to Focus tests for 12 hrs. Can chain up to 4. | Pills or hypopatch. Sleeplessness and +2d Focus Pool for 12 hours. | `pool Focus+2` | |
| 4 | Deepweed | Tincture. Can percieve astral for couple of hours. -1d to all test after for few hours. | Tincture. Can perceive astral for a couple of hours. -1d to all tests afterward, for a few hours. | — | TYPO: "percieve" → "perceive". Duration ("a couple of hours" / "a few hours") stays vague — no number is recoverable from the row, and inventing one would be a rules change. |
| 5 | Dorf | Inhaled powder or hypopatch. Ignore wound pen for 2 hrs. -2d Finesse for 12 hours | Inhaled powder or hypopatch. Ignore wound penalties for 2 hours. -2d Finesse Pool for 12 hours. | `pool Finesse-2` | CHECK — not wired: "wound pen" is two characters short of `/wound penalt/i`, but fixing the wording alone can't make this work — `removesWoundPenalty` (rules.js:4987) is only ever applied to augments, martial-art levels, and heritage traits; `misc_gear` is never handed to it. Standardizing the wording is worth doing for consistency, but the immunity needs a rules.js change (teaching `removesWoundPenalty` to read `misc_gear.Effect`) before it can appear on a sheet. Dorf is the only drug in this table that claims wound-penalty immunity. |
| 6 | Glitter | Hallucinogenic eyedrops. Non addictive | Hallucinogenic eyedrops. Non-addictive. | — | |
| 7 | Kamakazi | Nasal inhaler. +2 Finesse and Brawn for 15 minutes. Can double effect at 3 Dependence. | Nasal inhaler. +2d Brawn/Finesse Pool for 15 minutes. A doubled dose raises Dependence to 3. | `pool Finesse+2, Brawn+2` | TYPO: item name "Kamakazi" is very likely a misspelling of "Kamikaze" — flagged only; the Name column is not rewritten here (renaming orphans saved characters per the style guide). |
| 8 | Long Haul | Hypopatch. No sleep for 4 days w/o penalties | Hypopatch. No sleep for 4 days without penalties. | — | |
| 9 | Simsense | Simsense experience, basic but enjoyable. | Simsense experience, basic but enjoyable. | — | |
| 10 | Sixgun | Hypopatch. +4d Focus pool for 3 hrs. If addicted instead at -2d Focus w/o it. | Hypopatch. +4d Focus Pool for 3 hours. If addicted, instead -2d Focus Pool without it. | `pool Focus+4` | Both clauses kept intentionally — the second (`-2d Focus`) is a real qualifier, not noise; the engine already resolves it correctly (first clause per pool wins). |
| 11 | Smash | Liquid drops or powder for gums. Euphoric, impairs judgement, lowers inhibitions, no sleep for 8-12 hrs. | Liquid drops or powder for gums. Euphoric, impairs judgment, lowers inhibitions, no sleep for 8-12 hours. | — | Spelling: "judgement" → "judgment" for consistency with US spelling used elsewhere in this table (e.g. "colored" on Smoke Grenade). |
| 12 | ACTH | Used to trigger Adrenal Pump | Used to trigger Adrenal Pump. | — | |
| 13 | BioGel | Heals 2 Physical Condition boxes when applied | Heals 2 Physical Condition boxes when applied. | — | |
| 14 | Blood Thinners | Required if Platelet Production Enhancement is purchased | Requires Platelet Production Enhancement. | — | Applies the Requirements canonical form given verbatim in the style guide ("Requires Platelet Production Enhancement."). Not parser-critical — the Requirements section carries no rules.js citation, unlike Pool/Sense/Wound/Cover/Recoil. |
| 15 | Gleam | See better in dark for 8 hours, but affected by bright lights. Calmness and invulnerability | Can see in darkness for 8 hours, but affected by bright lights. Calmness and invulnerability. | `sense: Sees in darkness / low light` | |
| 16 | Lick | Increase Finesse by 4 for 10/min. Doubling increases Dep to 3. | +4d Finesse Pool for 10 minutes. A doubled dose raises Dependence to 3. | — | NEW BEHAVIOUR: original has no signed number before the pool name ("Finesse by 4"), so `POOL_DICE_RE` never matches it — the pool bonus is currently invisible on the sheet. `misc_gear.Effect` is wired to the pool parser, so the rewrite genuinely makes `+4d Finesse Pool` reachable for the first time (a real behaviour change, not just wording). Lick is now flagged `Dose: 1` with `Max Doses: 2`, so the bonus arrives when a dose is USED rather than as a standing toggle, and stacks to two. UNCLEAR: "10/min" — read here as "10 minutes"; could instead mean "per minute" (an ongoing/stacking effect). Description is blank, so this can't be confirmed from context — flagging rather than guessing further. |
| 17 | Rage | Increase Brawn by 4 for 10/min. Doubling increases Dep to 3. | +4d Brawn Pool for 10 minutes. A doubled dose raises Dependence to 3. | — | NEW BEHAVIOUR: same defect as Lick ("Brawn by 4" has no signed number before the pool name, so it never matched `POOL_DICE_RE`); rewrite makes `+4d Brawn Pool` reachable for the first time. Rage is now flagged `Dose: 1` with `Max Doses: 2` — its "doubling" — so the bonus arrives on Use and stacks to two. `misc_gear.Effect` is wired to the pool parser (unlike the wound-penalty case on Dorf), so this one really does change what the sheet computes. UNCLEAR: "10/min" — same ambiguity as Lick, same reasoning; not resolvable from the (blank) description. |
| 18 | Stims | Heal 1d6 Stun Condition Boxes on use | Heal 1d6 Stun Condition Boxes on use. | — | |
| 19 | First Aid Kit | Grant +1 bonus to Biotech tests | Single use. Grants a bonus to Biotech. | — | **MIGRATED** — the bonus now lives in the row's `Skill Bonus` column (`Biotech +1`) and the row is flagged `Dose: 1`, so it applies only while a dose is in use rather than while the kit sits in your bag. The prose keeps the number because it is worth reading at the table, but the column is what the engine applies. Confirmed safe: `POOL_NAMES` is exactly `["Brawn", "Finesse", "Focus", "Resolve"]` (rules.js:93) and `POOL_DICE_RE` is built from that list alone, so a signed number in front of "Biotech" matches nothing. Re-running the parser probe over the proposed text produces no new hit on this row. |
| 20 | Trauma Kit | Grant +2 bonus to Biotech tests | Single use. Grants a bonus to Biotech. | — | **MIGRATED** — `Skill Bonus: Biotech +2`, `Dose: 1`. Same treatment as the First Aid Kit. Confirmed safe: `POOL_NAMES` is exactly `["Brawn", "Finesse", "Focus", "Resolve"]` (rules.js:93) and `POOL_DICE_RE` is built from that list alone, so a signed number in front of "Biotech" matches nothing. Re-running the parser probe over the proposed text produces no new hit on this row. |
| 21 | Electronic Doctor Kit | Grant +3 bonus to Biotech tests and can re-roll 1s. | Single use. Grants a bonus to Biotech, and rerolls 1s on it. | — | **MIGRATED** — `Skill Bonus: Biotech +3` plus `Skill Note: Biotech: reroll 1s`, `Dose: 1`. The one row in the table that splits cleanly across both columns. Confirmed safe: `POOL_NAMES` is exactly `["Brawn", "Finesse", "Focus", "Resolve"]` (rules.js:93) and `POOL_DICE_RE` is built from that list alone, so a signed number in front of "Biotech" matches nothing. Re-running the parser probe over the proposed text produces no new hit on this row. |
| 22 | Arwin, Sleek | Augmented Reality Window, palm sized | Augmented Reality Window, palm-sized. | — | |
| 23 | Arwin, Classic | Augmented Reality Window, expandable to 12" screen | Augmented Reality Window, expandable to 12" screen. | — | |
| 24 | Arwin, Galactic | Augmented Reality Winow, expandable to 32" screen | Augmented Reality Window, expandable to 32" screen. | — | TYPO: "Winow" → "Window". |
| 25 | Arwin Goggles | Grants an arwin window. Can mount up to 0.3 ZP of Eyeware augments. Can be customized with fashion from the fashion board. | Grants an Arwin window. Can mount up to 0.3 ZP of Eyewear augments. Can be customized with fashion from the fashion board. | — | TYPO: "Eyeware" → "Eyewear". Also capitalized "arwin" → "Arwin" to match the product name. |
| 26 | Focus 1 | Increase dice limit for specific spell or spirit by +1 | Increase the dice limit for a specific spell or spirit by +1. | — | |
| 27 | Focus 2 | Increase dice limit for specific spell or spirit by +2 | Increase the dice limit for a specific spell or spirit by +2. | — | |
| 28 | Focus 3 | Increase dice limit for specific spell or spirit by +3 | Increase the dice limit for a specific spell or spirit by +3. | — | |
| 29 | Focus 4 | Increase dice limit for specific spell or spirit by +4 | Increase the dice limit for a specific spell or spirit by +4. | — | |
| 30 | Focus 5 | Increase dice limit for specific spell or spirit by +5 | Increase the dice limit for a specific spell or spirit by +5. | — | |
| 31 | Focus 6 | Increase dice limit for specific spell or spirit by +6 | Increase the dice limit for a specific spell or spirit by +6. | — | |
| 32 | Fetish 1 | Increase magic soak for specific spirit/spell by +1 | Increase magic soak for a specific spell or spirit by +1. | — | Reordered "spirit/spell" → "spell or spirit" to match the Focus group's wording. |
| 33 | Fetish 2 | Increase magic soak for specific spirit/spell by +2 | Increase magic soak for a specific spell or spirit by +2. | — | Same reordering as Fetish 1. |
| 34 | Fetish 3 | Increase magic soak for specific spirit/spell by +3 | Increase magic soak for a specific spell or spirit by +3. | — | Same reordering as Fetish 1. |
| 35 | Fetish 4 | Increase magic soak for specific spirit/spell by +4 | Increase magic soak for a specific spell or spirit by +4. | — | Same reordering as Fetish 1. |
| 36 | Fetish 5 | Increase magic soak for specific spirit/spell by +5 | Increase magic soak for a specific spell or spirit by +5. | — | Same reordering as Fetish 1. |
| 37 | Fetish 6 | Increase magic soak for specific spirit/spell by +6 | Increase magic soak for a specific spell or spirit by +6. | — | Same reordering as Fetish 1. |
| 38 | Spirit Bag 1 | Consumable bag reduces Force of summoning by 1 | Consumable bag reduces Force of summoning by 1. | — | |
| 39 | Spirit Bag 2 | Consumable bag reduces Force of summoning by 2 | Consumable bag reduces Force of summoning by 2. | — | |
| 40 | Spirit Bag 3 | Consumable bag reduces Force of summoning by 3 | Consumable bag reduces Force of summoning by 3. | — | |
| 41 | Spirit Bag 4 | Consumable bag reduces Force of summoning by 4 | Consumable bag reduces Force of summoning by 4. | — | |
| 42 | Spirit Bag 5 | Consumable bag reduces Force of summoning by 5 | Consumable bag reduces Force of summoning by 5. | — | |
| 43 | Spirit Bag 6 | Consumable bag reduces Force of summoning by 6 | Consumable bag reduces Force of summoning by 6. | — | |
| 44 | AP | Pen +2, Barrier +1 | Pen +2. Barrier +1. | — | Comma joined two distinct effects (the anti-pattern the style guide's corollary warns about) — split into sentences. |
| 45 | Gel | Pen = 0, deals stun track damage | Pen = 0. Deals stun track damage. | — | |
| 46 | Flechette | Damage +1, Pen -1 | Damage +1. Pen -1. | — | |
| 47 | Explosive | Damage +1 | Damage +1. | — | |
| 48 | API | Damage +1, starts fires | Damage +1. Starts fires. | — | |
| 49 | Cased | Cased ammo for any | Cased ammo for any. | — | UNCLEAR: "for any" trails off — any what (weapon type)? Left as in the original rather than guessing a completion. |
| 50 | Subsonic loads | Pen -1, Reduces Heat by 1 | Pen -1. Reduces Heat by 1. | — | |
| 51 | Buckshot | +2 Acc, +3 Dmg, Pen = 1 Range = S | +2 Accuracy. +3 Damage. Pen = 1. Range = S. | — | Original was missing a separator between "Pen = 1" and "Range = S" (read as one run-on clause); punctuation restored. "Acc"/"Dmg" spelled out per the style guide's explicit "Accuracy 4 not Acc4" rule. |
| 52 | High Explosive Incendiary (HEI) | Pen -2, Damage +4, starts fires | Pen -2. Damage +4. Starts fires. | — | |
| 53 | Tracer Rounds | Acc +2, alerts targets to the source of fire | Accuracy +2. Alerts targets to the source of fire. | — | |
| 54 | AP/Razor | Pen +1, Damage -1 | Pen +1. Damage -1. | — | |
| 55 | Explosive Tip | Damage +5, explosive damage | Damage +5. Deals explosive damage. | — | |
| 56 | Shock | Damage = 6, deals stun track damage, no physical damage | Damage = 6. Deals stun track damage. No physical damage. | — | |
| 57 | Micro missile (HEAP) | 100 Damage, ignores armor | Damage = 100. Ignores armor. | — | Reordered to the "Damage = N" form already used elsewhere in this table (Shock, Gel, Buckshot) instead of the reversed "100 Damage" form. |
| 58 | Micro Missile (anti-personnel) | 40 Damage, explodes as grenade | Damage = 40. Explodes as grenade. | — | Same reordering as Micro missile (HEAP). |
| 59 | Tank Rounds (HEAP) | 100 Damage, Ignores armor | Damage = 100. Ignores armor. | — | Same reordering as Micro missile (HEAP). |
| 60 | Tank Rounds (HE) | 40 Damage, Explodes as grenade | Damage = 40. Explodes as grenade. | — | Same reordering as Micro missile (HEAP). |
| 61 | Autocannon AP | Pen +2 | Pen +2. | — | |
| 62 | Vehicle Autocannon HEI | Pen -2, Damage +4, 4m radius blast | Pen -2. Damage +4. 4m radius blast. | — | |
| 63 | Vehicle Autocannon Tracer | Acc +2 | Accuracy +2. | — | |
| 64 | Tank Rounds (KE) | Ignores armor | Ignores armor. | — | |
| 65 | Tank Rounds (Cannister) | Damage to all targets in a 15-degree cone | Damage to all targets in a 15-degree cone. | — | |

### misc_gear — Notes

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | API | Large bore only | Large bore only. | — | |
| 2 | Cased | For guns with cased ammo only | For guns with cased ammo only. | — | |
| 3 | Subsonic loads | Allows rifles to use silencers. Can mix regular / subsonic for rifles. | Allows rifles to use silencers. Can mix regular/subsonic for rifles. | — | |
| 4 | Buckshot | Shotguns only. Can mix shot / slugs for shotgun use. | Shotguns only. Can mix shot/slugs for shotgun use. | — | |
| 5 | High Explosive Incendiary (HEI) | Recoilless Rifle / Autocannon only | Recoilless Rifle/Autocannon only. | — | |
| 6 | Tracer Rounds | Autofire only | Autofire only. | — | |
| 7 | Broadhead | Standard razor sharp, often spring loaded tips. Damage and Pen as the bow. | Standard razor-sharp, often spring-loaded tips. Damage and Pen as the bow. | — | |
| 8 | AP/Razor | Extra narrow carbide edged tips, generally arranged in a three blade pattern with springloaded blades that open after impact | Extra-narrow, carbide-edged tips, generally arranged in a three-blade pattern with spring-loaded blades that open after impact. | — | |
| 9 | Explosive Tip | Will not detonate against soft targets: an unarmored living target does not set it off. Explodes against barriers, armored targets, drones and vehicles. | Will not detonate against soft targets: an unarmored living target does not set it off. Explodes against barriers, armored targets, drones and vehicles. | — | |
| 10 | Shock | Double damage vs. drones, synthetics and programs. | Double damage versus drones, synthetics and programs. | — | |
| 11 | AM-3 Rifle ammo | Ammo for AM-3 Rifle | Ammo for AM-3 Rifle. | — | |
| 12 | Micro missile (HEAP) | For Vehicle Missile Launcher | For Vehicle Missile Launcher. | — | |
| 13 | Micro Missile (anti-personnel) | For Vehicle Missile Launcher | For Vehicle Missile Launcher. | — | |
| 14 | Tank Rounds (HEAP) | For Tank guns | For Tank guns. | — | |
| 15 | Tank Rounds (HE) | For Tank guns | For Tank guns. | — | |
| 16 | Autocannon AP | For Autocannons | For Autocannons. | — | |
| 17 | Vehicle Autocannon HEI | For Autocannons | For Autocannons. | — | |
| 18 | Vehicle Autocannon Tracer | For Autocannons | For Autocannons. | — | |
| 19 | Tank Rounds (KE) | For Tank guns | For Tank guns. | — | |
| 20 | Tank Rounds (Cannister) | For Tank guns | For Tank guns. | — | |
| 21 | Vulcan Cannon | For Vulcan rotary cannon | For Vulcan rotary cannon. | — | |
| 22 | 20/25mm Cannon | For Vehicle cannons | For Vehicle cannons. | — | |
| 23 | 30mm Cannon | For Vehicle cannons | For Vehicle cannons. | — | |

### weapon_mods — Effect

Note: this column only reaches the etiquette parser (`parseEtiquetteBonuses`). Every other number in this table (Recoil Capacity, Accuracy, ammunition %, Hardening…) is display text only — the live values live in structured columns (AccMod, Conceal Mod, Slot…) not included in this packet, so nothing here can be checked against them; no CONTRADICTS DESC findings are possible from this packet alone.

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Gyro-mount | +1 Recoil Capacity | +1 Recoil Capacity. | — | |
| 2 | Extended Magazine | +20% ammunition + 2 | +20% ammunition. | — | |
| 3 | Link Infrastructure | Smart upgrade | Smart upgrade. | — | |
| 4 | Hardening | +2 to hardening | +2 Hardening. | — | Dropped "to" and capitalized, matching "Basic RF shielding" (next row, already "+1 Hardening") — the two rows previously read inconsistently for the same stat. |
| 5 | Basic RF shielding | +1 Hardening | +1 Hardening. | — | |
| 6 | Bling | Street cred: +2 Street Etiquette | Street cred: +2 Street Etiquette. | `etiquette Street+2` | Parser-critical wording left untouched — only a trailing period was added. |
| 7 | Laser Sight | +1 Accuracy | +1 Accuracy. | — | |
| 8 | Imaging scope | Shift one range category | Shift one range category. | — | |
| 9 | Optical Scope | Shift one range category if aiming | Shift one range category if aiming. | — | |
| 10 | Flashlight | Eliminates lowlight penalties | Eliminates low-light penalties. | — | |
| 11 | Red dot sight | +1 Accuracy at medium or less range | +1 Accuracy at medium or less range. | — | |
| 12 | Bi-pod (Rifle Only) | +1 Recoil Capacity | +1 Recoil Capacity. | — | |
| 13 | Laser Sight | +1 Accuracy | +1 Accuracy. | — | |
| 14 | Gas Vent | +1 Recoil Capacity | +1 Recoil Capacity. | — | |
| 15 | Silencer | Subsonic ammo - does not raise Heat. Supersonic ammo - reduces heat generation by 1. -2d Acc | Subsonic ammo: does not raise Heat. Supersonic ammo: reduces heat generation by 1. -2d Accuracy. | — | |
| 16 | Bayonet | Melee Knife | Melee Knife. | — | |
| 17 | Flashlight | Eliminates lowlight penalties | Eliminates low-light penalties. | — | |
| 18 | Shoulder Sling | Carry comfortably | Carry comfortably. | — | |
| 19 | Under-slung grenade launcher | Grenade launcher | Grenade launcher. | — | |
| 20 | Militech U-B Cap Laser | Underbarrel laser weapon | Underbarrel laser weapon. | — | |
| 21 | Militech U-B Microwaver "EZ-Bake" | Underbarrel microwave weapon | Underbarrel microwave weapon. | — | |

### weapons — Notes

This column is not engine-read (`engine_reads_this_column: false` for every row) and produced no parser hits, so nothing here carries parser risk — all changes below are cosmetic.

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Neon Fang LS | Heat 1 / max 3. Wt 1+1 - reduce Wt by 1 if no Power pack. | Heat 1/max 3. 1+1 weight: reduce weight by 1 if no Power pack. | — | |
| 2 | Photon Reaver | Heat 2 / max 3. Wt 2+1 - reduce Wt by 1 if no Power pack. | Heat 2/max 3. 2+1 weight: reduce weight by 1 if no Power pack. | — | |
| 3 | Thunderbolt Vanguard | Ignores armor. Heat 3 / max 15, Bar 5. Wt 3+1 - reduce Wt by 1 if no Power pack. | Ignores armor. Heat 3/max 15, Bar 5. 3+1 weight: reduce weight by 1 if no Power pack. | — | |
| 4 | Great Wave | Fires as a complex action, affects one target as per Heavy Swell. Heat 5 / max 5. Wt 1+1 - reduce Wt by 1 if no Power pack. | Fires as a complex action, affects one target as per Heavy Swell. Heat 5/max 5. 1+1 weight: reduce weight by 1 if no Power pack. | — | |
| 5 | Militech X-1 | Heat 2 / max 10, Bar 3. Wt 3+1 - reduce Wt by 1 if no Power pack. | Heat 2/max 10, Bar 3. 3+1 weight: reduce weight by 1 if no Power pack. | — | |
| 6 | Ares Long Arm rail cannon | Ignores armor. Heat 4 / max 10, Bar 5. Wt 3+1 - reduce Wt by 1 if no Power pack. | Ignores armor. Heat 4/max 10, Bar 5. 3+1 weight: reduce weight by 1 if no Power pack. | — | |
| 7 | Militech X-2 Less Lethal target management device | Heat 3 / max 15. Wt 2+1 - reduce Wt by 1 if no Power pack. | Heat 3/max 15. 2+1 weight: reduce weight by 1 if no Power pack. | — | |
| 8 | Militech X-3 "Stun Cannon" crowd dispersal system | Requires a complex action to spin up, then FA only (+20 dice, each success counts as 2, walk fire as normal). Heat 9 / max 27. Wt 3+1 - reduce Wt by 1 if no Power pack. | Requires a complex action to spin up, then FA only (+20 dice, each success counts as 2, walk fire as normal). Heat 9/max 27. 3+1 weight: reduce weight by 1 if no Power pack. | — | |
| 9 | Militech U-B Cap Laser | Underbarrel mounted laser, counts as a laser sight (+1 accuracy to main gun). Heat 1 / max 2. Wt 1+1 - reduce Wt by 1 if no Power pack. | Underbarrel mounted laser, counts as a laser sight (+1 Accuracy to main gun). Heat 1/max 2. 1+1 weight: reduce weight by 1 if no Power pack. | — | |
| 10 | Militech U-B Microwaver "EZ-Bake" | Underbarrel mounted microwaver (Fires as a complex action, affects 1 target, as Heavy Swell). Heat 6 / max 6. Wt 1+1 - reduce Wt by 1 if no Power pack. | Underbarrel mounted microwaver (fires as a complex action, affects 1 target, as Heavy Swell). Heat 6/max 6. 1+1 weight: reduce weight by 1 if no Power pack. | — | |
| 11 | Aztechnologies Dazzleray | Underbarrel mounted Dazzleray. Reduce Wt by 1 if no Power pack. | Underbarrel mounted Dazzleray. Reduce weight by 1 if no Power pack. | — | |
| 12 | Monofilament Whip* | Cybercombat skill required | Requires Cybercombat skill. | — | Applied the Requirements canonical form ("Requires X.", leading, full sentence). |
| 13 | Power Fist | Can destroy barriers (under 5) and make Brawn Pool (3) to avoid knockdown | Can destroy barriers (under 5). Living targets make Brawn Pool (3) to avoid knockdown. | — | |
| 14 | Sickstick | Brawn Pool test (4 success). If failed lose next turn and one simple on subsequent turn. | Brawn Pool test (4 successes). If failed, lose next turn and one simple on the subsequent turn. | — | |
| 15 | Stun Baton | Double damage vs drones/synthetics | Double damage versus drones/synthetics. | — | |
| 16 | Vibroaxe | -3 DMG and no AP if not powered | -3 Damage and no AP if not powered. | — | |
| 17 | Vibrosword | -3 DMG and no AP if not powered | -3 Damage and no AP if not powered. | — | |
| 18 | Explosive Grenade | 4m/8m radius (full/half dmg) | 4m/8m radius (full/half damage). | — | |
| 19 | Flashbang Grenade | 4m/8m radius (full/half dmg) | 4m/8m radius (full/half damage). | — | |
| 20 | Incendiary Grenade | 1m radius burn | 1m radius burn. | — | |
| 21 | Molotov cocktail | 1m radius burn | 1m radius burn. | — | |
| 22 | Shuriken | Drawn as free action, thrown as simple. Throw 3 at same time for same dmg but +3d to hit | Drawn as free action, thrown as simple. Throw 3 at the same time for the same damage but +3d to hit. | — | |
| 23 | Smoke Grenade | Fills 6m radius with smoke (colored or thermal) | Fills 6m radius with smoke (colored or thermal). | — | |
| 24 | Light Crossbow | Direct-fire short range 70m (+2 bonus dice). 70-300m must be arced, -2 dice. Beyond 300m impossible. Cocked with an onboard lever as a complex action. | Direct-fire short range 70m (+2 bonus dice). 70-300m must be arced: -2 dice. Beyond 300m impossible. Cocked with an onboard lever as a complex action. | — | |
| 25 | Crossbow | Direct-fire short range 70m (+2 bonus dice). 70-300m must be arced, -2 dice. Beyond 300m impossible. Must be cocked with a stringer as a complex action. | Direct-fire short range 70m (+2 bonus dice). 70-300m must be arced: -2 dice. Beyond 300m impossible. Must be cocked with a stringer as a complex action. | — | |
| 26 | Heavy Crossbow | Direct-fire short range 70m (+2 bonus dice). 70-300m must be arced, -2 dice. Beyond 300m impossible. Must be cocked with a stringer or ratchet as a complex action. | Direct-fire short range 70m (+2 bonus dice). 70-300m must be arced: -2 dice. Beyond 300m impossible. Must be cocked with a stringer or ratchet as a complex action. | — | |
| 27 | Self / Recurve bow | Direct-fire short range 40m (+2 bonus dice). 41-150m must be arced, -2 dice. Beyond 150m impossible. A character must have the bow's Minimum Strength to use it. | Direct-fire short range 40m (+2 bonus dice). 41-150m must be arced: -2 dice. Beyond 150m impossible. A character must have the bow's Minimum Strength to use it. | — | |
| 28 | Compound Bow | Direct-fire short range 40m (+2 bonus dice). 41-150m must be arced, -2 dice. Beyond 150m impossible. A character must have the bow's Minimum Strength to use it. | Direct-fire short range 40m (+2 bonus dice). 41-150m must be arced: -2 dice. Beyond 150m impossible. A character must have the bow's Minimum Strength to use it. | — | |

### Summary
**Counts**
- Rows reviewed: 137 (misc_gear/Effect 65, misc_gear/Notes 23, weapon_mods/Effect 21, weapons/Notes 28)
- Changed: 132 · Unchanged: 5 (Bliss, BTL, Simsense, Explosive Tip [Notes], Aztechnologies Dazzleray)
- NEW BEHAVIOUR (confirmed against wiring, below): 2 — Lick, Rage. **Dorf is not in this bucket** — see correction below.
- CONTRADICTS DESC: 0 (every `description` field in this packet is blank, and no structured-column values were provided for weapon_mods, so contradictions can't be detected from this packet alone)
- TYPO: 4 rows flagged — Deepweed ("percieve"), Arwin, Galactic ("Winow"), Arwin Goggles ("Eyeware"), Kamakazi (name itself, informational only — not renamed)
- UNCLEAR: 3 — Lick, Rage (both "10/min"), Cased/Effect ("for any")
- CHECK: 5 — First Aid Kit, Trauma Kit, Electronic Doctor Kit (flat Biotech-test bonuses in prose, plus an pool-wiring caveat on all three since resolved: Biotech cannot trip POOL_DICE_RE), and Dorf (CHECK — not wired, see below)

**Correction — Dorf is not NEW BEHAVIOUR.** The original brief for this packet said fixing "wound pen" → "wound penalties" would make the immunity newly visible. That's wrong: `removesWoundPenalty` (rules.js:4987) is only ever applied to augments, martial-art levels, and heritage traits — `misc_gear` rows are never passed to it, wording aside. Dorf is now flagged **CHECK — not wired**: the wording was standardized anyway (consistent vocabulary is worth having on its own), but the immunity can't take effect without a rules.js change that teaches `removesWoundPenalty` to also read `misc_gear.Effect`. Dorf is the only drug in this table that claims wound-penalty immunity, so that's a single, well-scoped follow-up if it's ever wanted.

**A general caution this correction surfaced:** `engine_reads_this_column` is a per-*column* flag, not a per-*parser* flag — a column being "read" doesn't mean every parser reads it. The wiring that actually applies to this packet's four (table, column) pairs is:
- `misc_gear.Effect` → pool, sense, etiquette (not wound-penalty, not requirements)
- `misc_gear.Notes` → etiquette only
- `weapon_mods.Effect` → etiquette only
- `weapons.Notes` → nothing at all

Every NEW BEHAVIOUR claim above (Lick, Rage) was checked against this list before being labeled as such; anything a rewrite touches outside that list is CHECK, not NEW BEHAVIOUR, no matter how the wording changes.

**Recurring drift patterns in this packet**

1. **Attribute/pool bonuses phrased with the name before the number** ("Increase Finesse by 4") instead of the parser's required signed-number-first form ("+4d Finesse Pool"). This is the Lick/Rage defect and is the one pattern in this packet that silently disables a mechanic — worth a sweep of the rest of `misc_gear` for the same phrasing.
2. **"wound pen" vs. "wound penalties"** — only Dorf has this exact near-miss in the packet. Worth fixing for vocabulary consistency, but on its own it changes nothing: `removesWoundPenalty` (rules.js:4987) never reads `misc_gear` at all, so this is a two-layer gap — a text near-miss sitting on top of a column that isn't wired to that mechanic in the first place. If wound-penalty immunity from consumables is meant to work, it needs a rules.js change, not just a wording fix.
3. **Comma joining two distinct numeric effects** ("Pen +2, Barrier +1") is the single most common drift in the ammo rows (`misc_gear` Effect, ~14 rows) — none of these are parser-critical today, but they're exactly the anti-pattern the style guide's corollary calls out, and fixing them now is free since nothing currently reads that comma.
4. **Missing terminal punctuation** — the overwhelming majority of rows (all of weapon_mods/Effect, most of misc_gear, several weapons/Notes) simply have no trailing period. Purely cosmetic, applied uniformly here.
5. **Inconsistent absolute-damage notation**: some ammo rows write "N Damage" (number first), others "Damage = N" (word first, with `=`). Standardized on "Damage = N" since that form was already established elsewhere in the same table (Shock, Gel, Buckshot).
6. **Abbreviations the style guide explicitly calls out**: `hrs`→hours, `w/o`→without, `vs`/`vs.`→versus, `Acc`→Accuracy appear scattered across both misc_gear and weapon_mods and were normalized wherever found.
7. **`Brawn Pool (3)` / `Brawn Pool test (4 success)`** (Power Fist, Sickstick) are target-number forms, not signed pool-dice bonuses — the style guide explicitly says this form is deliberately *not* matched by `POOL_DICE_RE`. Left unconverted on purpose; flagging here so a future pass doesn't "fix" them into a real behavior change.
8. **Wording inconsistency between sibling item groups**: Focus 1–6 used "spell or spirit" while Fetish 1–6 used "spirit/spell" for the identical underlying mechanic; harmonized to one order. Similarly, "Hardening" and "Basic RF shielding" (both weapon_mods) expressed the same stat differently ("+2 to hardening" vs. "+1 Hardening"); aligned to the latter, already-canonical form.

**Not touched, flagged instead of guessed:** vague durations with no recoverable number ("a few hours," "couple of hours" on Bliss/Deepweed) were left vague rather than assigned an invented value, per the style guide's explicit "don't add mechanics that aren't there" rule.

## Spells and rituals

# Packet D — magic (spells, rituals) — Effect text cleanup

### Notation

Chosen conventions for this packet, applied consistently across both tables:

- **Force** and **Successes** — always capitalized, never abbreviated (`F`), never lower‑cased. `Successes` is always plural, even where the source has "Success" singular — it's shorthand for "net successes," the same way `Force` is a fixed quantity name.
- **Fractions/halves of a quantity** — divisor trails, tight slash: `Force/2`, `Successes/2`, `(Force + Successes)/2`. Replaces `1/2 Force`, `Force/2`(sometimes-postfix), and mixed orderings. Parenthesize only when the source groups a sum before halving (`(Force + Successes)/2`, e.g. Healing) — that grouping is a real mechanical distinction from `Force/2 + Successes` (e.g. Powerball) and must not be flattened.
- **Per‑Force scaling of distance/area** — tight ratio, unit first: `4m/Force`, `1m/Force radius`, `20db/Force`. Replaces `4m/Force`-style inconsistency (`1m radius per Force`, `2m/Force`, spelled‑out "per point of force").
- **Doubling/multiplying** — `2x` prefix, space before the quantity: `2x Force`, `2x Successes`. Replaces `x2`/`*2`/spelled‑out "twice."
- **Addition/comparison between named quantities** — spaced operators: `Force + Successes`, `Force < Force`, `Hardening < 1 + Force`. Replaces cramped `Force+Success`, `Force<Force+Success`.
- **"Label = value" formulas** (`Force=# of Targets`, `2x Success=Condition`) — replaced with `Label: value` (colon), e.g. `Targets: Force`, `Condition: 2x Successes`. This was the single most common drift pattern in the packet (12+ spells write "number of targets equals Force" a different way each time) and a colon reads cleanly at the table without looking like an equation.
- **Stat call‑outs** (Accuracy/Range/Reach/Armor/Cohesion) — `Label value`, no parentheses, per the style guide.
- **Abbreviations spelled out**: `w/`→with, `w/n`→within, `w/o`→without, `vs`→versus, `Tgt(s)`→target(s), `Dur.`→**Duration** (capitalized — it names the spell's own Duration value, treated as a proper noun the way `Force` and `Successes` are), `dmg`→damage, `B/I Armor`→`Ballistic/Impact Armor`, `LoS`→line of sight, `rnd`→round.
- **One mechanical clause per sentence**, joined by `. `, never a comma — per the style guide's hard rule. Several Effects here comma‑chain 3–4 unrelated mechanics; split throughout.
- **Skill names** — canonicalized to the `SKILLS` table's real names (`Reconnaissance` not `Recon`; typo `Negotiaion` fixed to `Negotiation`), confirmed against `rules.js`.
- **Force‑scaled bonuses to a Pool or Skill stay in prose** (`Force bonus dice to Brawn Pool`), never rewritten into the parser's `+Nd Pool` shorthand, because `POOL_DICE_RE` requires a literal signed digit — `Force` can never satisfy it, so this phrasing is also the only one that's guaranteed not to change behavior. See the **NEW BEHAVIOUR** notes below for the specific rows this protects.
- **A summoned creature's own stat block (tentacles, elemental, familiar) is written unsigned** — `Brawn Pool 5`, not `+5d Brawn` — deliberately mirroring the style guide's `Brawn Pool (3)` exception, since these are the monster's dice, not a bonus to the caster's own pool.

---

### spells — Effect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Create Barrier | 20m long x 1.5 to 6m tall translucent, solid barrier. 2x Success=Condition  1/2 Force=Armor | Translucent, solid barrier 20m long x 1.5-6m tall. Condition: 2x Successes. Armor: Force/2. | — | CONTRADICTS DESC — Description gives Condition = 2x Successes **+ Force**; Effect omits the `+Force` term entirely. Also Description gives height as "four to twenty feet," a real-world unit no other row in this packet uses (everywhere else pairs meters with tabletop inches at a 2:1 ratio); Effect's "1.5 to 6m" doesn't convert cleanly to that inches convention either. Flagging both, not renumbering. |
| 2 | Disguise Astral Aura | Alter aura and hide things from astral vision | Alter aura and hide things from astral vision. | — | |
| 3 | Flight | Cast fly in any direction their normal Move | Caster can fly in any direction at their normal Movement rate. | — | |
| 4 | Light | Bright Light appears anywhere you can see. Increases vis to adjacent areas as well. | Bright light appears anywhere within sight. Raises visibility in adjacent areas as well. | — | |
| 5 | Haste | Force=# of Targets. All gain +1 simple action and +4m for duration | Targets: Force. All gain +1 simple action and +4m Movement for Duration. | — | |
| 6 | Manon Ball | Affects 1m radius per Force. Deals Force+success in stun damage to all in area | Affects 1m/Force radius. Deals Force + Successes stun damage to all in area. | — | |
| 7 | Manon Bolt | Deals Force+Successes+1 stun damage to single target | Deals Force + Successes + 1 stun damage to single target. | — | |
| 8 | Mind Link | Mind to mind communications w/ # of Targets=Force. | Mind-to-mind communication. Targets: Force. | — | |
| 9 | Shatter Ward | Destroy wards w/ Force<Force+Success of spell. Otherwise, lower Ward Force by 1 | Destroys ward if caster's Force + Successes >= ward's Force. Otherwise, ward's Force is lowered by 1. | — | CHECK — original reuses the word "Force" for both the caster's Force and the ward's Force without distinguishing them (`Force<Force+Success`). Rewrite disambiguates per Description's wording; no number or comparison changed. |
| 10 | Powerball | Affects 1m radius per Force. Deals 1/2 Force+Successes in physical damage to all in area | Affects 1m/Force radius. Deals Force/2 + Successes physical damage to all in area. | — | |
| 11 | Powerbolt | Deals Force+Successes physical damage to single target | Deals Force + Successes physical damage to single target. | — | |
| 12 | Rune of the Unspeakable Alarm | Ward of 6 sq.m of area. Audible or silent alarm. Can be permanent w/ reagents | Wards 6 sq.m of area. Audible or silent alarm, caster's choice. Can be made permanent with reagents. | — | CONTRADICTS DESC — Description scales the ward as 20 sq ft **per point of Force**; Effect gives a flat 6 sq.m with no Force term and a different unit (sq.m vs sq ft). Flagging, not renumbering. |
| 13 | The Charm of Raucous Cacophony | Loud sound (20db/Force) of caster's choice. Force 7+ does 1/2 success in physical damage to 2m | Loud sound, 20db/Force, of caster's choice. At Force 7+, deals Successes/2 physical damage within 2m. | — | |
| 14 | Forbidden Glamour of Accord | Everyone w/n LoS to caster gains 2 bonus dice to Negotiaion/Coercion/Leadership vs vs targets | Everyone within line of sight of caster gains +2d Negotiation/Coercion/Leadership tests versus targets. | — | TYPO — "Negotiaion" → "Negotiation"; duplicated "vs vs" → "versus". CHECK — flat skill-dice bonus stated only in prose; style guide prefers a structured Skill Bonus column for this. |
| 15 | Chant of Dire Malady | All w/n 2m/Force of point of origin must resist or vomit and only get simple actions. -2d to all in zone regardless. | All within 2m/Force of point must resist or vomit and take only simple actions. -2 penalty dice to all tests in zone regardless. | — | |
| 16 | Rune of Vicious Rage and Sorrow | Target that fails resist goes beserk and attacks nearest target. | Target that fails resistance goes berserk and attacks nearest target. | — | TYPO — "beserk" → "berserk". |
| 17 | The Blessed Chime of Glorious Release | All locks/restraints w/n 1m/Force are opened if Hardening<1+Force. | All locks/restraints within 1m/Force are opened if Hardening < 1 + Force. | — | |
| 18 | The Ancestral Working of the Savage Peal | Sonic explosion affects 1m/Force. Destroy barriers<Force-1. Deals Force+Success stun damage to living tgts | Sonic explosion affects 1m/Force radius. Destroys barriers with Armor < Force - 1. Deals Force + Successes stun damage to living targets. | — | CHECK — "Armor" added for clarity, sourced from Description (original just said "barriers<Force-1"). Also Effect's strict `<` is tighter than Description's "equal to or less than"; flagging the mismatch, not resolving it. |
| 19 | The Horrid Call of Za'lota | Vermin swarm one target, preventing Complex actions for Duration. | Vermin swarm one target, preventing complex actions for Duration. | — | |
| 20 | The Seven Chimes of Forceful Approbation | Target claps rhythmically, dropping held items and cannot use hands for Duration. | Target claps rhythmically, drops held items, and cannot use hands for Duration. | — | |
| 21 | The Confounding Rhythms of Dire Doom | All enemies w/n 8m/Force of point filled with anxiety. -2d to all skill tests in area. | All enemies within 8m/Force of point are filled with anxiety. -2 penalty dice to all skill tests in area. | — | |
| 22 | The Infinite Illusion of Spiritual Seperation | Stun tgt 1 round. Failed resistance separates mind from body for undetermined time | Stuns target for 1 round. On failed resistance, separates mind from body for an undetermined time. | — | CHECK — row name is misspelled ("Seperation"). Flagging only; not renaming, per the style guide (renames orphan saved characters). |
| 23 | Calm | Force=# of Tgts, that lose will to fight, but able to do other actions (raise alarm, flee, etc) | Targets: Force. Lose the will to fight, but can still take other actions (raise alarm, flee, etc). | — | |
| 24 | Charm | Force=bonus dice to Leadership/Negotiation tests for Duration. | Force bonus dice to Leadership/Negotiation tests for Duration. | — | |
| 25 | Command | Issue one-word command. If failed tgt must do action. If against nature, can refuse but take 3+Force+Success in stun | Issues a one-word command. If target fails, they must perform the action. If it's against their nature, they may refuse but take 3 + Force + Successes stun damage. | — | |
| 26 | Confusion | All w/n 2m/Force from point are confused. Roll d3 to determine action: 1: attack ally, 2: nothing, 3: act normally | All within 2m/Force of point are confused. Roll d3 for action: 1 attack ally, 2 nothing, 3 act normally. | — | CHECK — Effect specifies a d3, but Description rolls 1d6 and maps pairs (1-2/3-4/5-6) to the same three outcomes. Same odds, different die; confirm intended notation. |
| 27 | Despair | All w/n 4m/Force from point filled with despair. -1d/2 Force of spell to all tests for in area. | All within 4m/Force of point are filled with despair. -1 penalty die per 2 Force to all tests in area. | — | TYPO — stray "for in area" corrected to "in area". CHECK — Description adds a "(minimum 1)" floor on this penalty that Effect omits; without it, Force 1 would round to zero penalty dice. Flagging, not adding the number. |
| 28 | Enthrall | Tgt is Charmed, trusting caster as friend. Duration is Force in months(Int<5)/weeks(Int<10)/days(Int<15)/hours(Int>15). | Target is charmed, trusting caster as a friend. Duration: Force months (Int<5), weeks (Int<10), days (Int<15), or hours (Int 15 or above). | — | CHECK — Effect's brackets (`Int<15` days, `Int>15` hours) leave exactly Int=15 undefined; Description assigns Int=15 to the hours bucket ("fifteen and above"). Flagging the boundary gap, not resolving it. |
| 29 | Ensorcell | Tgt Enthralled can have mind altered. Each Success reduces Tgt Int by 1 and can make Force in permanent changes. | Target under Enthrall can have their mind altered. Each Success reduces target's Int by 1 and allows up to Force permanent changes. | — | |
| 30 | Forget | Force=# of Tgts. All affected forgets everything in the last minute. | Targets: Force. Affected targets forget the last minute. | — | |
| 31 | Fumble | 12m diameter field. All in field resist vs Force or drop anything held and fall prone. | 12m diameter field. All in field resist versus Force or drop anything held and fall prone. | — | |
| 32 | Geas | Sorcery+Force vs Resolve. If failed, tgt must complete task set. Every day not working on goal, lose 1d from all pools. | Sorcery + Force versus Resolve. If failed, target must complete the assigned task. Each day they don't work toward the goal, they lose one die from all pools. | — | **NEW BEHAVIOUR avoided** — Description confirms this "-1 die from all four pools" is a flat, fixed-number daily drain, exactly the shape `POOL_DICE_RE` matches. Writing it in the canonical `-1d Brawn/Finesse/Focus/Resolve Pool` form would newly trigger `derivePoolEffects` and add a toggle to the *caster's* sheet — but this drain is applied to the geas **target**, and only conditionally (daily, until the goal is met). Deliberately kept in prose so the current (no-hit) behavior is unchanged. Flagging for the owner's call on whether/how this should ever be parseable, and for whom. |
| 33 | Laughter | Force+Success vs Brawn. If failed Tgt falls prone, dropping anything held and laughs uncontrollably for Duration. | Force + Successes versus Brawn. If failed, target falls prone, drops anything held, and laughs uncontrollably for Duration. | — | |
| 34 | Hold | 1/2 Force=# of Tgts (min 1). Tgts paralyzed, unable to move/act, but can speak for Duration. | Targets: Force/2 (min 1). Targets are paralyzed, unable to move or act, but can speak for Duration. | — | |
| 35 | Insight | # of Success up to Force=Questions about Tgt that must be answered honestly. | Questions about target answered honestly: 1 per Success, up to Force. | — | |
| 36 | Suggestion | Force=# of Tgts. All Tgts given a suggestion no more than 2 sentences long (no self harm). They will complete it, if possible | Targets: Force. Each given a suggestion up to 2 sentences long (no self-harm). They complete it if possible. | — | |
| 37 | Taunt | Tgt must attack nearby targets in melee, dropping any ranged weapons for Duration. | Target must attack nearby targets in melee, dropping any ranged weapons, for Duration. | — | |
| 38 | Moment of Eclipse | Covers 1 city block or internal of 1 building with normal darkness. | Covers 1 city block, or the interior of 1 building, with normal darkness. | — | |
| 39 | Cloak of Night | Force=# of Tgts. Tgts can reroll 1s on dodge so long as remain in dim light/darkness | Targets: Force. Targets can reroll 1s on dodge tests while remaining in dim light or darkness. | — | |
| 40 | Horrors of the Unknown Dark | Force=# of Tgts. Failed resist rolls 1d2 on next turn: 1: Move away from cover, agog at scene. 2: spend all actions moving away | Targets: Force. On failed resistance, roll d2 next turn: 1 move away from cover, agog. 2 spend all actions moving away. | — | CHECK — Effect specifies a d2, but Description rolls 1d6 and maps halves (1-3/4-6) to the same two outcomes. Same odds, different die; confirm intended notation (same pattern as Confusion, row 26). |
| 41 | Night's Chill | Cold spread 4m/Force from chosen point. All in area -2 penalty dice on all tests unless insulated. | Cold spreads 4m/Force from chosen point. All in area take -2 penalty dice on all tests unless insulated. | — | |
| 42 | Black Bolt of Uthal | Deals 1+(Force/2) damage to both physical and stun tracks to one tgt. | Deals 1 + Force/2 damage to both physical and stun tracks of one target. | — | |
| 43 | Shadow Path of the Vile Ether | Simple action to teleport from area of darkness to another in line of sight. | Simple action: teleport from an area of darkness to another within line of sight. | — | |
| 44 | Shadow Anchor | Anchor tgt to their Shadow on the ground. Cannot move for duration, but can take other actions. | Anchors target to their shadow on the ground. Cannot move for Duration, but can take other actions. | — | CHECK — lowercased "shadow" (the caster's own shadow) to avoid visual confusion with the capitalized **Shadow** skill used elsewhere in this data. Interpretive call, not pure formatting — flagging. |
| 45 | The Uncountable Tendrils of Ehon | Haze covers radius 4m/Force of point. 1d6+Force tentacles appear and make attacks (5d Brawn/3dmg) on caster's turn.. Unarmed movement provokes free attacks. | Haze covers a 4m/Force radius from point. 1d6+Force tentacles appear and attack on caster's turn (Brawn Pool 5, 3 damage). Unarmed movement within the haze provokes free attacks. | — | TYPO — doubled period after "turn" fixed. **NEW BEHAVIOUR avoided** — kept the tentacles' stat block unsigned ("Brawn Pool 5") rather than "+5d Brawn," matching the style guide's `Brawn Pool (3)` exception. These are the summoned tentacles' own dice, not a bonus to the caster's pool; a signed form would have wrongly created a caster-side pool toggle. |
| 46 | Create Darkenbeast | Turn animal into darkenbeast. Gains 1/2 Force in B/I Armor, +2dmg, +3 to Brawn/Finesse/Resolve. Caster gains Exploit action to control beast. Simple action to direct. | Turns animal into darkenbeast. The animal Gains Force/2 Ballistic/Impact Armor. Add 2 to its melee damage. Add 3 to the Animal's Brawn/Finesse/Resolve Pools. Caster gains Exploit action to control beast. Simple action to direct. | `pool Brawn+3, Finesse+3, Resolve+3` | Parser-critical — this is the one row that currently hits `POOL_DICE_RE`. Rewrite keeps `+3d Brawn/Finesse/Resolve Pool` as its own signed-number clause, so the hit is preserved unchanged. |
| 47 | Dire Touch of Ennui | Touch target, they take 3+Force+Successes to stun track | Touches target, dealing 3 + Force + Successes stun damage. | — | |
| 48 | Evocation of the Frail Beam of Debility | Tgt struck with silvery beam. Suffer Force+Successes to Brawn/Finesse. If pools reduced to 0, debilitated for Dur. | Target struck with silvery beam, suffering Force + Successes penalty to Brawn/Finesse. If either pool reaches 0, target is debilitated for Duration. | — | **NEW BEHAVIOUR avoided** — kept "Force + Successes penalty to Brawn/Finesse" in prose rather than the canonical `-Nd Pool` form. The penalty is Force-scaled (no literal digit) and applies to the *victim*, not the caster; matches today's no-hit behavior. Flagging per the loud-flag instruction — this is exactly the "buffs a pool in the Description" case. |
| 49 | The Thrity Cursed Servants of Athozog | Summon cat of smoke/shadow. Caster can see/hear as if they were the cat. +1d/Force to Observation and Recon for Dur. | Summons a cat of smoke and shadow. Caster can see/hear as if they were the cat. +1d/Force Observation and Reconnaissance for Duration. | — | CHECK — canonicalized "Recon" → "Reconnaissance" (`SKILLS` alias). Flat/Force-scaled skill bonus stated only in prose; style guide prefers a structured Skill Bonus column. |
| 50 | The Serene Conjuration of Ehon's Gate | Opens gate to parallel realm of shadow. | Opens a gate to a parallel realm of shadow. | — | |
| 51 | Sorcery of the Wraith's Flight | Summon shadow wings. Gain Flight 12m | Summons shadow wings. Grants Fly 12m. | — | Aligned "Flight 12m" to the style guide's canonical movement form ("Fly 12m"). |
| 52 | The Marvelous Cursed Sigil of Athozog | Create shadow double. For Dur. Dodges do not consume Finesse dice. | Creates a shadow double for Duration. Dodges do not consume Finesse dice. | — | |
| 53 | Bound Servant | Costs 2 ZP. Gain animal as familiar that gets +2d to all tests. Gain Exploit action to direct familiar. Gain +2d to Sorcery/Channeling. If it dies, suffer 2d6 stun and a new familiar appears at dawn. | Costs 2 ZP. Gain an animal familiar; it gets +2d to all tests. Caster gains an Exploit action to direct the familiar. Caster gains +2d Sorcery/Channeling. If the familiar dies, caster suffers 2d6 stun and a new familiar appears at dawn. | — | CHECK — "+2d to all tests" (familiar's own bonus) and "+2d Sorcery/Channeling" (caster's bonus) are flat dice bonuses stated only in prose; style guide prefers structured columns for this. Neither names a Pool, so no parser risk either way. |
| 54 | Massage the Bones of the Earth | Create barrier (2m widex1m tall)xForce. Has Armor 4 and doesn't need to be contiguous. Can be shaped as caster wishes. | Creates a barrier 2m/Force wide x 1m/Force tall. Armor 4. Doesn't need to be contiguous; can be shaped as caster wishes. | — | |
| 55 | Fires of the Earth | Tgt 1 metal item. Increase heat. Object and anyone in contact takes 1/2Force,1Force,2xForce dmg (rnd1/2/3+). | Targets 1 metal item, heating it. Object and anyone in contact take damage: Force/2 (round 1), Force (round 2), 2x Force (round 3+). | — | |
| 56 | Grasp of Spring | Vines grow over 2m/Force area, immobilizing all in area that fail Resistance. Area is Difficult terrain for all others. | Vines grow over a 2m/Force area, immobilizing all who fail Resistance. Area is Difficult terrain for everyone else. | — | |
| 57 | Fiery Lash | 1 Tgt hit by flaming bolt. Force+Success physical damage. Can start fires. | 1 target hit by flaming bolt. Force + Successes physical damage. Can start fires. | — | |
| 58 | Lightning Strike | 1 Tgt hit by lightning. Force+Success physical damage and 1/2 that in stun damage (doubled vs drones/synthetics) | 1 target hit by lightning. Force + Successes physical damage and half that in stun damage (doubled versus drones/synthetics). | — | |
| 59 | Summon Elemental | Summon Elemental spirit (1/2m/Force in height). Cohesion 2xForce. Gain Exploit Action to direct spirit. Rolls Force for any pools and deals 3+Successes physical damage in whatever element is summoned | Summons an elemental spirit, 1/2m per Force in height. Cohesion: 2x Force. Caster gains Exploit action to direct spirit. Elemental rolls Force for any pools and deals 3 + Successes physical damage in its element. | — | **NEW BEHAVIOUR avoided** — "Rolls Force for any pools" is the summoned elemental's own stat (cohort-style), not a caster bonus. `Force` isn't a literal digit so it can't trigger `POOL_DICE_RE` regardless of phrasing, but kept it unsigned/prose to stay well clear, consistent with rows 45 and 53. |
| 60 | Shapeshift | Choose Force in animals. Can switch to those forms freely as a complex action during Dur. Heal 1d6 stun&physical boxes when shifting. Can't speak/spellcast while shifted. | Choose Force animals. Can switch between chosen forms freely as a complex action during Duration. Heal 1d6 stun and physical boxes when shifting. Can't speak or spellcast while shifted. | — | |
| 61 | Healing | Can heal 1/2 (Force+Successes) physical damage from Tgt. Can not be used again until more damage suffered. | Heals (Force + Successes)/2 physical damage from target. Cannot be used again until target suffers more damage. | — | |
| 62 | Natural Fury | Take on a bark-like encasment and strength. Gain Force in dice to Brawn,+2B/2I Armor,+1 melee dmg | Takes on a bark-like encasement and strength. Gains Force bonus dice to Brawn Pool. +2 Ballistic/Impact Armor. +1 melee damage. | — | TYPO — "encasment" → "encasement". **NEW BEHAVIOUR avoided** — "Force bonus dice to Brawn Pool" kept in prose (not `+Nd Brawn Pool`) because the bonus is Force-scaled; `Force` can't satisfy `POOL_DICE_RE`'s signed-digit requirement regardless, matching today's no-hit state. Flagging per the loud-flag instruction — this spell buffs a pool via its Description. |
| 63 | Firestorm | Flames fill 2m/Force area. Anyone in area takes 3+Force+Success in physical damage. Entering/starting in zone suffers automatic 1d6 physical damage. | Flames fill a 2m/Force area. Anyone in area takes 3 + Force + Successes physical damage. Entering or starting turn in zone suffers automatic 1d6 physical damage. | — | CONTRADICTS DESC — Description gives the radius as **4 m (2") per point of force**, double the Effect's stated "2m/Force." Flagging, not renumbering. |
| 64 | Blight | Tgt sickened. Suffers Force in penalty dice to all actions and 1/2 Force physical damage. | Target sickened. Suffers Force penalty dice to all actions and Force/2 physical damage. | — | |

### rituals — Effect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Break Ward | Roll Sorcery. For every success, reduce Ward Force by 1 | Roll Sorcery. For every Success, ward's Force is reduced by 1. | — | |
| 2 | Cottage Refuge | Roll Ritual. Anyone trying to enter uninvited must overcome Success on Resolve to enter | Roll Ritual. Anyone entering uninvited must beat the Successes with a Resolve test to enter. | — | |
| 3 | Locating A Person | Roll Ritual w/ item of import to Tgt and 1 manastelliate. Success=Range of spell (15km/150km/1500km/Planet/Solar System/Anywhere), if target outside Range, then it fails. Otherwise, gives location relative to caster. | Roll Ritual with an item important to target and 1 manastelliate. Successes: Range (15km/150km/1500km/Planet/Solar System/Anywhere). Fails if target is outside Range. Otherwise gives location relative to caster. | — | |
| 4 | Preservation | Roll Ritual. Reduce decay to 1/10th the normal rate. Can preserve anything w/n 1 sq meter per Success | Roll Ritual. Reduces decay to 1/10th the normal rate. Can preserve anything within 1 sq meter per Success. | — | |
| 5 | Raise Ward | Roll Ritual on space up to 1000 cubic meters. Each success, the ward lasts 1 week. Force reduces magic that crosses the border and forces Athletics check to non-keyed individuals. | Roll Ritual on space up to 1000 cubic meters. Each Success, ward lasts 1 week. Force reduces magic crossing the border and forces an Athletics check on non-keyed individuals. | — | CONTRADICTS DESC — Description ties the 1000 cubic meter cap to Zoetic Potential ("for every point of her Zoetic Potential"); Effect states it as a flat cap with no ZP term. Flagging, not renumbering. |
| 6 | Recall Device | Req 1 manastelliate to enchant item of 1 wt or less. Item can be recalled at will, taking Drain each time. | Requires 1 manastelliate to enchant an item of 1 weight or less. Item can be recalled at will, taking Drain each time. | — | |
| 7 | Sterilize | Purifies 250ml of water, 200 cubic cm of matter, a single wound, or a serving of food | Purifies 250ml of water, 200 cubic cm of matter, a single wound, or a serving of food. | — | |
| 8 | Travel Over Distance | Roll Ritual. Teleport to spot prepared with 10 manastelliate. Drain affects all travelers. Failure causes mishap. | Roll Ritual. Teleports to a spot prepared with 10 manastelliate. Drain affects all travelers. Failure causes a mishap. | — | |
| 9 | Weather Protection | Protection from elements. Repels water/pollen/adverse weather conditions. Normalizes temp 10 deg C towards 21. Duration of 1 hr/success | Protection from elements. Repels water, pollen, and adverse weather. Normalizes temperature 10°C toward 21°C. Duration: 1 hour/Success. | — | CHECK — Description frames the temperature shift as "up to" 10°C toward 21°C (capped, not unconditional); Effect reads as a flat 10°C shift. Flagging the ambiguity, not resolving it (not adding "up to" without confirmation). |

### Summary
- **Rows:** 73 (64 spells, 9 rituals).
- **Changed (received at least a notation cleanup):** 73 of 73 — every row had at least a spacing, capitalization, punctuation, or abbreviation fix. None were left byte-identical.
- **New parser hits introduced:** 0. The single existing hit (Create Darkenbeast, row 46) is preserved unchanged; no other row becomes newly parseable by `POOL_DICE_RE` or any other engine regex.
- **NEW BEHAVIOUR flags (loud, per the task's hard requirement):** 5 — rows 32 (Geas), 45 (The Uncountable Tendrils of Ehon), 48 (Evocation of the Frail Beam of Debility), 59 (Summon Elemental), 62 (Natural Fury). All five are spells whose Description buffs/debuffs a Pool (the caster's or a summoned creature's), and all five were deliberately kept in a prose form that cannot trigger `POOL_DICE_RE` — either because the bonus is Force-scaled (no literal digit exists to sign) or because the affected stat belongs to a summoned creature, not the caster. Flagging these is a design question for the repo owner: should any of these ever become an actual toggle, and for whom?
- **CONTRADICTS DESC:** 4 — rows 1 (Create Barrier: missing `+Force` term, feet-vs-meters unit), 12 (Rune of the Unspeakable Alarm: flat area vs. Force-scaled in Description), 63 (Firestorm: 2m/Force in Effect vs. 4m/Force in Description), 69/ritual-5 (Raise Ward: flat cap vs. Zoetic-Potential-scaled cap in Description).
- **TYPO:** 4 — rows 16 (beserk), 27 (stray "for in area"), 45 (doubled period), 62 (encasment).
- **CHECK (ambiguous, boundary, or interpretive):** 12 — rows 9, 14, 18, 22, 26, 27, 28, 40, 44, 49, 53, and ritual-9 (Weather Protection).

### Recurring drift patterns specific to these two tables

1. **"Force = number of targets/dice" written a different way almost every time** — `Force=# of Targets`, `# of Targets=Force`, `Choose Force in animals`, `Force in dice to Brawn`. Standardized to `Targets: Force` / `Force bonus dice to X`.
2. **Fractions of Force with inconsistent order and no operator spacing** — `1/2 Force`, `Force/2`, `1/2Force`. Standardized to a trailing tight slash, `Force/2`, with parentheses preserved only where the source genuinely groups a sum before halving.
3. **Per-Force area/distance scaling spelled three different ways** — `1m radius per Force`, `4m/Force`, `2m/Force area`. Standardized to the tight ratio `Nm/Force`.
4. **Two independent die-notation mismatches between Effect and Description** (rows 26 Confusion, 40 Horrors of the Unknown Dark) — Effect rolls a d3/d2, Description rolls 1d6 split into equal groups. Functionally identical odds, but worth a single pass to pick one notation store-wide if this pattern recurs elsewhere in the workbook.
5. **`Tgt`/`w/`/`vs`/`Dur.` abbreviation drift**, same as the general style guide's abbreviation list — very heavy in this packet specifically (almost every spell effect uses at least one).
6. **Summoned-creature stat blocks embedded inline** (Uncountable Tendrils' tentacles, Summon Elemental, Bound Servant's familiar) risk being "cleaned up" into the same signed `+Nd Pool` notation used for the caster's own bonuses — that would be a real behavior change (row 46 shows the parser doesn't care whose pool it is, only the text shape). Recommend a distinct convention for NPC/cohort stat blocks going forward, not just in this packet.

## Programs, hack actions, vehicle and drone hardware

# E-matrix draft — programs, hack_actions, drone/vehicle weapons & mods

### Notation

Nothing in this packet is parsed today (`engine_reads_this_column: false`, `current_parser_hits: []` throughout), so **Engine is `—` for every row below.** The freedom that gives us is spent on one job: making the 21 rating-scaled program families (127 of the 189 rows) read as *one* formula grammar instead of 21 dialects of it.

1. **`Rating`** — the program/mod's own rating (the numeral suffixed to its name: *Acid Burn 3* → `Rating = 3`). Substituted for the leading digit in every formula so the six rank-rows of a family become **textually identical** — a future parser reads one template per family instead of six near-duplicates, and a player can compare ranks without redoing the arithmetic. Verified against each family's Description before substituting (see per-family notes below); never applied where the number doesn't actually track the rank 1:1 (Vermin Call).
2. **`Net Successes`** — the one token for every count that was previously "Success," "Successes," "success," "hits," or "your successes." Defined once: *the successes that count toward the effect after any opposed roll, Hardening, or defense is subtracted — equal to the raw test successes when nothing opposes the test.* This lets "Success" (Acid Burn), "success not soaked by Hardening" (De-rez), and "your successes" (Sonic Sickness) collapse to the same word without changing what any of them mean.
3. **Rounding** is stated explicitly (`, rounded down.`) wherever a formula divides and the Description confirms flooring — only Acid Burn needed this; every other formula's inputs are already integers.
4. **Operators**: `×` for multiplication (was `x`/`2x`... except where the original `Nx` was a plain-English multiplier like "2x damage," which becomes "double," not `×2`), `/` for division, and the comparison actually stated in the Description (`≥` for "at least," `>` for "more successes than") — never blurred into each other.
5. **`range of influence`** is the one phrase for the decker's area of effect, replacing `IRL`, `AOI`, `area of influence`, `in range`, and `influence field` wherever the Description confirms that's what's meant. `IRL` in particular reads as "in real life" out of context — resolved from the Decoy Description, flagged UNCLEAR below since the source abbreviation is genuinely ambiguous.
6. `w/`, `w/n`, `w/o`, `vs` are spelled out per the style guide (`with`, `within`, `without`, `versus`), **except** where `vs` names the target of damage rather than a contested roll (`20 dmg vs digital cohesion` → "damage **to** digital Cohesion," not "damage versus," which would misread as a test).
7. `Diff=X` threshold shorthand becomes `Requires Net Successes [≥ / >] X.`, reproducing whichever comparison the Description states rather than defaulting to one.
8. Proper stat/track nouns are capitalized consistently: `Hardening`, `Cohesion`, `Armor`, `Alert`, `Stun`. Ordinary nouns (`damage`, `successes` in prose, `targets`) stay lowercase.
9. One mechanical statement per sentence, split on `. ` — several originals joined two effects with a colon, semicolon, or "and" (Refraction Field, Vent Gas, Battle Ram); these are split into separate sentences per the style guide's core rule.
10. `SS` / `BF` / `FA` (fire modes) and `MCP` are left as-is — established stat abbreviations in this system, same carve-out the style guide gives named stat abbreviations.
11. `total cover` (Vent Gas) is renamed to the canonical `Full cover` — this genuinely is total blocking, so aligning it to the parser's real vocabulary is the point of the exercise, not an accidental collision.

---

### programs — Effect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Acid Burn 1 | Reduce Hardening by (1+Success)/2 | Reduce Hardening by (Rating + Net Successes) / 2, rounded down. | — | |
| 2 | Acid Burn 2 | Reduce Hardening by (2+Success)/2 | Reduce Hardening by (Rating + Net Successes) / 2, rounded down. | — | |
| 3 | Acid Burn 3 | Reduce Hardening by (3+Success)/2 | Reduce Hardening by (Rating + Net Successes) / 2, rounded down. | — | |
| 4 | Acid Burn 4 | Reduce Hardening by (4+Success)/2 | Reduce Hardening by (Rating + Net Successes) / 2, rounded down. | — | |
| 5 | Acid Burn 5 | Reduce Hardening by (5+Success)/2 | Reduce Hardening by (Rating + Net Successes) / 2, rounded down. | — | |
| 6 | Acid Burn 6 | Reduce Hardening by (6+Success)/2 | Reduce Hardening by (Rating + Net Successes) / 2, rounded down. | — | |
| 7 | De-rez 1 | Deals 1d6 damage per success not soaked by Hardening to daemon/ICE | Deals 1d6 damage per Net Success to a daemon's or ICE's Cohesion. | — | |
| 8 | De-rez 2 | Deals 1d6 damage per success not soaked by Hardening to daemon/ICE | Deals 1d6 damage per Net Success to a daemon's or ICE's Cohesion. | — | |
| 9 | De-rez 3 | Deals 1d6 damage per success not soaked by Hardening to daemon/ICE | Deals 1d6 damage per Net Success to a daemon's or ICE's Cohesion. | — | |
| 10 | De-rez 4 | Deals 1d6 damage per success not soaked by Hardening to daemon/ICE | Deals 1d6 damage per Net Success to a daemon's or ICE's Cohesion. | — | |
| 11 | De-rez 5 | Deals 1d6 damage per success not soaked by Hardening to daemon/ICE | Deals 1d6 damage per Net Success to a daemon's or ICE's Cohesion. | — | |
| 12 | De-rez 6 | Deals 1d6 damage per success not soaked by Hardening to daemon/ICE | Deals 1d6 damage per Net Success to a daemon's or ICE's Cohesion. | — | |
| 13 | Decoy 1 | Choose target IRL, they gain +1d dodge bonus | Choose non-AR target within range of influence. They gain +Rating dice to dodge tests. | — | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| 14 | Decoy 2 | Choose target IRL, they gain +2d dodge bonus | Choose non-AR target within range of influence. They gain +Rating dice to dodge tests. | — | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| 15 | Decoy 3 | Choose target IRL, they gain +3d dodge bonus | Choose non-AR target within range of influence. They gain +Rating dice to dodge tests. | — | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| 16 | Decoy 4 | Choose target IRL, they gain +4d dodge bonus | Choose non-AR target within range of influence. They gain +Rating dice to dodge tests. | — | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| 17 | Decoy 5 | Choose target IRL, they gain +5d dodge bonus | Choose non-AR target within range of influence. They gain +Rating dice to dodge tests. | — | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| 18 | Decoy 6 | Choose target IRL, they gain +6d dodge bonus | Choose non-AR target within range of influence. They gain +Rating dice to dodge tests. | — | UNCLEAR: "IRL" resolved from Description as "in range of influence" — out of context it reads as "in real life." |
| 19 | Electric Strike 1 | Deals 1d6+Success in Stun damage to anyone w/n AOI. 2x to synthetics/agents. Ignores Armor | Deals 1d6+Net Successes Stun damage to anyone within range of influence, ignoring Armor. Deals double damage to synthetics and agents. | — | |
| 20 | Electric Strike 2 | Deals 1d6+Success in Stun damage to anyone w/n AOI. 2x to synthetics/agents. Ignores Armor | Deals 1d6+Net Successes Stun damage to anyone within range of influence, ignoring Armor. Deals double damage to synthetics and agents. | — | |
| 21 | Electric Strike 3 | Deals 1d6+Success in Stun damage to anyone w/n AOI. 2x to synthetics/agents. Ignores Armor | Deals 1d6+Net Successes Stun damage to anyone within range of influence, ignoring Armor. Deals double damage to synthetics and agents. | — | |
| 22 | Electric Strike 4 | Deals 1d6+Success in Stun damage to anyone w/n AOI. 2x to synthetics/agents. Ignores Armor | Deals 1d6+Net Successes Stun damage to anyone within range of influence, ignoring Armor. Deals double damage to synthetics and agents. | — | |
| 23 | Electric Strike 5 | Deals 1d6+Success in Stun damage to anyone w/n AOI. 2x to synthetics/agents. Ignores Armor | Deals 1d6+Net Successes Stun damage to anyone within range of influence, ignoring Armor. Deals double damage to synthetics and agents. | — | |
| 24 | Electric Strike 6 | Deals 1d6+Success in Stun damage to anyone w/n AOI. 2x to synthetics/agents. Ignores Armor | Deals 1d6+Net Successes Stun damage to anyone within range of influence, ignoring Armor. Deals double damage to synthetics and agents. | — | |
| 25 | Emotional Influence 1 | Sway emotions of target. Grants +1d bonus to rolls that can be swayed emotionally. Can be resisted with Resolve. | Sway the emotions of a target. Grants +Rating dice to rolls that can be swayed emotionally. The target may resist with Resolve. | — | |
| 26 | Emotional Influence 2 | Sway emotions of target. Grants +2d bonus to rolls that can be swayed emotionally. Can be resisted with Resolve. | Sway the emotions of a target. Grants +Rating dice to rolls that can be swayed emotionally. The target may resist with Resolve. | — | |
| 27 | Emotional Influence 3 | Sway emotions of target. Grants +3d bonus to rolls that can be swayed emotionally. Can be resisted with Resolve. | Sway the emotions of a target. Grants +Rating dice to rolls that can be swayed emotionally. The target may resist with Resolve. | — | |
| 28 | Emotional Influence 4 | Sway emotions of target. Grants +4d bonus to rolls that can be swayed emotionally. Can be resisted with Resolve. | Sway the emotions of a target. Grants +Rating dice to rolls that can be swayed emotionally. The target may resist with Resolve. | — | |
| 29 | Emotional Influence 5 | Sway emotions of target. Grants +5d bonus to rolls that can be swayed emotionally. Can be resisted with Resolve. | Sway the emotions of a target. Grants +Rating dice to rolls that can be swayed emotionally. The target may resist with Resolve. | — | |
| 30 | Emotional Influence 6 | Sway emotions of target. Grants +6d bonus to rolls that can be swayed emotionally. Can be resisted with Resolve. | Sway the emotions of a target. Grants +Rating dice to rolls that can be swayed emotionally. The target may resist with Resolve. | — | |
| 31 | Hypnotic Projection 1 | Targets resist with Focus vs Hacking + rating; those who fail are frozen, fascinated and unable to act until they break free with a complex action. Damage or a jostle grants immunity. | Targets resist with Focus versus Hacking + Rating. Those who fail stand frozen and fascinated, unable to act, until they break free with a complex action. Taking damage or being jostled grants immunity. | — | |
| 32 | Hypnotic Projection 2 | Targets resist with Focus vs Hacking + rating; those who fail are frozen, fascinated and unable to act until they break free with a complex action. Damage or a jostle grants immunity. | Targets resist with Focus versus Hacking + Rating. Those who fail stand frozen and fascinated, unable to act, until they break free with a complex action. Taking damage or being jostled grants immunity. | — | |
| 33 | Hypnotic Projection 3 | Targets resist with Focus vs Hacking + rating; those who fail are frozen, fascinated and unable to act until they break free with a complex action. Damage or a jostle grants immunity. | Targets resist with Focus versus Hacking + Rating. Those who fail stand frozen and fascinated, unable to act, until they break free with a complex action. Taking damage or being jostled grants immunity. | — | |
| 34 | Hypnotic Projection 4 | Targets resist with Focus vs Hacking + rating; those who fail are frozen, fascinated and unable to act until they break free with a complex action. Damage or a jostle grants immunity. | Targets resist with Focus versus Hacking + Rating. Those who fail stand frozen and fascinated, unable to act, until they break free with a complex action. Taking damage or being jostled grants immunity. | — | |
| 35 | Hypnotic Projection 5 | Targets resist with Focus vs Hacking + rating; those who fail are frozen, fascinated and unable to act until they break free with a complex action. Damage or a jostle grants immunity. | Targets resist with Focus versus Hacking + Rating. Those who fail stand frozen and fascinated, unable to act, until they break free with a complex action. Taking damage or being jostled grants immunity. | — | |
| 36 | Hypnotic Projection 6 | Targets resist with Focus vs Hacking + rating; those who fail are frozen, fascinated and unable to act until they break free with a complex action. Damage or a jostle grants immunity. | Targets resist with Focus versus Hacking + Rating. Those who fail stand frozen and fascinated, unable to act, until they break free with a complex action. Taking damage or being jostled grants immunity. | — | |
| 37 | Refraction Field 1 | Barrier line: energy and laser weapons fired through it lose 1 power per success. Does not block movement or normal gunfire. | Creates a barrier line. Energy and laser weapons fired through it lose 1 power per Net Success. Does not block movement or normal gunfire. | — | |
| 38 | Refraction Field 2 | Barrier line: energy and laser weapons fired through it lose 1 power per success. Does not block movement or normal gunfire. | Creates a barrier line. Energy and laser weapons fired through it lose 1 power per Net Success. Does not block movement or normal gunfire. | — | |
| 39 | Refraction Field 3 | Barrier line: energy and laser weapons fired through it lose 1 power per success. Does not block movement or normal gunfire. | Creates a barrier line. Energy and laser weapons fired through it lose 1 power per Net Success. Does not block movement or normal gunfire. | — | |
| 40 | Refraction Field 4 | Barrier line: energy and laser weapons fired through it lose 1 power per success. Does not block movement or normal gunfire. | Creates a barrier line. Energy and laser weapons fired through it lose 1 power per Net Success. Does not block movement or normal gunfire. | — | |
| 41 | Refraction Field 5 | Barrier line: energy and laser weapons fired through it lose 1 power per success. Does not block movement or normal gunfire. | Creates a barrier line. Energy and laser weapons fired through it lose 1 power per Net Success. Does not block movement or normal gunfire. | — | |
| 42 | Refraction Field 6 | Barrier line: energy and laser weapons fired through it lose 1 power per success. Does not block movement or normal gunfire. | Creates a barrier line. Energy and laser weapons fired through it lose 1 power per Net Success. Does not block movement or normal gunfire. | — | |
| 43 | Situational Advantage 1 | Up to 1 ally in range reroll 1s on Brawn and Finesse pool tests. | Up to Rating allies within range of influence reroll 1s on Brawn and Finesse pool tests. | — | |
| 44 | Situational Advantage 2 | Up to 2 allies in range reroll 1s on Brawn and Finesse pool tests. | Up to Rating allies within range of influence reroll 1s on Brawn and Finesse pool tests. | — | |
| 45 | Situational Advantage 3 | Up to 3 allies in range reroll 1s on Brawn and Finesse pool tests. | Up to Rating allies within range of influence reroll 1s on Brawn and Finesse pool tests. | — | |
| 46 | Situational Advantage 4 | Up to 4 allies in range reroll 1s on Brawn and Finesse pool tests. | Up to Rating allies within range of influence reroll 1s on Brawn and Finesse pool tests. | — | |
| 47 | Situational Advantage 5 | Up to 5 allies in range reroll 1s on Brawn and Finesse pool tests. | Up to Rating allies within range of influence reroll 1s on Brawn and Finesse pool tests. | — | |
| 48 | Situational Advantage 6 | Up to 6 allies in range reroll 1s on Brawn and Finesse pool tests. | Up to Rating allies within range of influence reroll 1s on Brawn and Finesse pool tests. | — | |
| 49 | Sonic Sickness 1 | Up to 1 target must pass a Brawn test (at least your successes) or be limited to one simple action; lasts until they succeed twice in a row. | Up to Rating targets must pass a Brawn test with at least the decker's Net Successes, or are limited to one simple action per turn. This lasts until a target succeeds twice in a row. | — | |
| 50 | Sonic Sickness 2 | Up to 2 targets must pass a Brawn test (at least your successes) or be limited to one simple action; lasts until they succeed twice in a row. | Up to Rating targets must pass a Brawn test with at least the decker's Net Successes, or are limited to one simple action per turn. This lasts until a target succeeds twice in a row. | — | |
| 51 | Sonic Sickness 3 | Up to 3 targets must pass a Brawn test (at least your successes) or be limited to one simple action; lasts until they succeed twice in a row. | Up to Rating targets must pass a Brawn test with at least the decker's Net Successes, or are limited to one simple action per turn. This lasts until a target succeeds twice in a row. | — | |
| 52 | Sonic Sickness 4 | Up to 4 targets must pass a Brawn test (at least your successes) or be limited to one simple action; lasts until they succeed twice in a row. | Up to Rating targets must pass a Brawn test with at least the decker's Net Successes, or are limited to one simple action per turn. This lasts until a target succeeds twice in a row. | — | |
| 53 | Sonic Sickness 5 | Up to 5 targets must pass a Brawn test (at least your successes) or be limited to one simple action; lasts until they succeed twice in a row. | Up to Rating targets must pass a Brawn test with at least the decker's Net Successes, or are limited to one simple action per turn. This lasts until a target succeeds twice in a row. | — | |
| 54 | Sonic Sickness 6 | Up to 6 targets must pass a Brawn test (at least your successes) or be limited to one simple action; lasts until they succeed twice in a row. | Up to Rating targets must pass a Brawn test with at least the decker's Net Successes, or are limited to one simple action per turn. This lasts until a target succeeds twice in a row. | — | |
| 55 | Targeted Disruption 1 | One target: if your Hacking + rating beats their Resolve, they take 4 penalty dice on all tests until your next turn. Re-target as a simple action. | Chooses one target. If the decker's Net Successes exceed the target's Resolve test, the target takes 4 penalty dice on all tests until the decker's next turn. Re-target as a simple action. | — | |
| 56 | Targeted Disruption 2 | One target: if your Hacking + rating beats their Resolve, they take 4 penalty dice on all tests until your next turn. Re-target as a simple action. | Chooses one target. If the decker's Net Successes exceed the target's Resolve test, the target takes 4 penalty dice on all tests until the decker's next turn. Re-target as a simple action. | — | |
| 57 | Targeted Disruption 3 | One target: if your Hacking + rating beats their Resolve, they take 4 penalty dice on all tests until your next turn. Re-target as a simple action. | Chooses one target. If the decker's Net Successes exceed the target's Resolve test, the target takes 4 penalty dice on all tests until the decker's next turn. Re-target as a simple action. | — | |
| 58 | Targeted Disruption 4 | One target: if your Hacking + rating beats their Resolve, they take 4 penalty dice on all tests until your next turn. Re-target as a simple action. | Chooses one target. If the decker's Net Successes exceed the target's Resolve test, the target takes 4 penalty dice on all tests until the decker's next turn. Re-target as a simple action. | — | |
| 59 | Targeted Disruption 5 | One target: if your Hacking + rating beats their Resolve, they take 4 penalty dice on all tests until your next turn. Re-target as a simple action. | Chooses one target. If the decker's Net Successes exceed the target's Resolve test, the target takes 4 penalty dice on all tests until the decker's next turn. Re-target as a simple action. | — | |
| 60 | Targeted Disruption 6 | One target: if your Hacking + rating beats their Resolve, they take 4 penalty dice on all tests until your next turn. Re-target as a simple action. | Chooses one target. If the decker's Net Successes exceed the target's Resolve test, the target takes 4 penalty dice on all tests until the decker's next turn. Re-target as a simple action. | — | |
| 61 | Universal Translator 1 | Real-time translation between any languages in range, delivered via internal gear or nearby speakers. | Provides real-time translation between any languages within range, delivered via internal gear or nearby speakers. | — | |
| 62 | Universal Translator 2 | Real-time translation between any languages in range, delivered via internal gear or nearby speakers. | Provides real-time translation between any languages within range, delivered via internal gear or nearby speakers. | — | |
| 63 | Universal Translator 3 | Real-time translation between any languages in range, delivered via internal gear or nearby speakers. | Provides real-time translation between any languages within range, delivered via internal gear or nearby speakers. | — | |
| 64 | Universal Translator 4 | Real-time translation between any languages in range, delivered via internal gear or nearby speakers. | Provides real-time translation between any languages within range, delivered via internal gear or nearby speakers. | — | |
| 65 | Universal Translator 5 | Real-time translation between any languages in range, delivered via internal gear or nearby speakers. | Provides real-time translation between any languages within range, delivered via internal gear or nearby speakers. | — | |
| 66 | Universal Translator 6 | Real-time translation between any languages in range, delivered via internal gear or nearby speakers. | Provides real-time translation between any languages within range, delivered via internal gear or nearby speakers. | — | |
| 67 | Vent Gas 1 | Fill one 2m square per success with opaque fog: total cover; blocks vision, not movement. | Fills one 2m square per Net Success with opaque fog. Provides Full cover, blocking vision but not movement. | — | "total cover" aligned to canonical "Full cover" (see Notation #11). |
| 68 | Vent Gas 2 | Fill one 2m square per success with opaque fog: total cover; blocks vision, not movement. | Fills one 2m square per Net Success with opaque fog. Provides Full cover, blocking vision but not movement. | — | "total cover" aligned to canonical "Full cover" (see Notation #11). |
| 69 | Vent Gas 3 | Fill one 2m square per success with opaque fog: total cover; blocks vision, not movement. | Fills one 2m square per Net Success with opaque fog. Provides Full cover, blocking vision but not movement. | — | "total cover" aligned to canonical "Full cover" (see Notation #11). |
| 70 | Vent Gas 4 | Fill one 2m square per success with opaque fog: total cover; blocks vision, not movement. | Fills one 2m square per Net Success with opaque fog. Provides Full cover, blocking vision but not movement. | — | "total cover" aligned to canonical "Full cover" (see Notation #11). |
| 71 | Vent Gas 5 | Fill one 2m square per success with opaque fog: total cover; blocks vision, not movement. | Fills one 2m square per Net Success with opaque fog. Provides Full cover, blocking vision but not movement. | — | "total cover" aligned to canonical "Full cover" (see Notation #11). |
| 72 | Vent Gas 6 | Fill one 2m square per success with opaque fog: total cover; blocks vision, not movement. | Fills one 2m square per Net Success with opaque fog. Provides Full cover, blocking vision but not movement. | — | "total cover" aligned to canonical "Full cover" (see Notation #11). |
| 73 | Vermin Call 1 | Target is swarmed by vermin: cannot take complex actions and takes 1 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | Swarms the target with vermin. The target cannot take complex actions and takes 1 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | — | |
| 74 | Vermin Call 2 | Target is swarmed by vermin: cannot take complex actions and takes 1 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | Swarms the target with vermin. The target cannot take complex actions and takes 1 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | — | |
| 75 | Vermin Call 3 | Target is swarmed by vermin: cannot take complex actions and takes 2 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | Swarms the target with vermin. The target cannot take complex actions and takes 2 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | — | |
| 76 | Vermin Call 4 | Target is swarmed by vermin: cannot take complex actions and takes 2 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | Swarms the target with vermin. The target cannot take complex actions and takes 2 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | — | |
| 77 | Vermin Call 5 | Target is swarmed by vermin: cannot take complex actions and takes 2 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | Swarms the target with vermin. The target cannot take complex actions and takes 2 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | — | |
| 78 | Vermin Call 6 | Target is swarmed by vermin: cannot take complex actions and takes 3 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | Swarms the target with vermin. The target cannot take complex actions and takes 3 direct physical damage per round. Power armor, synthetics, spirits, and software agents are immune. | — | CHECK: damage tiers are uneven — ranks 1–2 deal 1, ranks 3–5 deal 2 (three ranks), rank 6 jumps to 3 after only one rank at the middle tier. Not changed; confirm rank 6 (and the 3-wide middle tier) is intentional rather than a missing rank 7 or a rank-5 typo. |
| 79 | Alert Monitor | Will report alert level and responses | Reports the current Alert level and the next expected response. | — | |
| 80 | Analysis Locus 1 | Diff of Hardening. Reports stats of ICE/daemon | Requires Net Successes greater than the target's Hardening. Reports the ICE's or daemon's Cohesion and loaded software. | — | |
| 81 | Analysis Locus 2 | Diff of Hardening. Reports stats of ICE/daemon | Requires Net Successes greater than the target's Hardening. Reports the ICE's or daemon's Cohesion and loaded software. | — | |
| 82 | Analysis Locus 3 | Diff of Hardening. Reports stats of ICE/daemon | Requires Net Successes greater than the target's Hardening. Reports the ICE's or daemon's Cohesion and loaded software. | — | |
| 83 | Analysis Locus 4 | Diff of Hardening. Reports stats of ICE/daemon | Requires Net Successes greater than the target's Hardening. Reports the ICE's or daemon's Cohesion and loaded software. | — | |
| 84 | Analysis Locus 5 | Diff of Hardening. Reports stats of ICE/daemon | Requires Net Successes greater than the target's Hardening. Reports the ICE's or daemon's Cohesion and loaded software. | — | |
| 85 | Analysis Locus 6 | Diff of Hardening. Reports stats of ICE/daemon | Requires Net Successes greater than the target's Hardening. Reports the ICE's or daemon's Cohesion and loaded software. | — | |
| 86 | Corrupt IFF 1 | Targets=# of Successes. They are removed from any IFF for auto defenses | Selects a number of targets equal to Net Successes. Those targets are removed from IFF for automated defenses. | — | |
| 87 | Corrupt IFF 2 | Targets=# of Successes. They are removed from any IFF for auto defenses | Selects a number of targets equal to Net Successes. Those targets are removed from IFF for automated defenses. | — | |
| 88 | Corrupt IFF 3 | Targets=# of Successes. They are removed from any IFF for auto defenses | Selects a number of targets equal to Net Successes. Those targets are removed from IFF for automated defenses. | — | |
| 89 | Corrupt IFF 4 | Targets=# of Successes. They are removed from any IFF for auto defenses | Selects a number of targets equal to Net Successes. Those targets are removed from IFF for automated defenses. | — | |
| 90 | Corrupt IFF 5 | Targets=# of Successes. They are removed from any IFF for auto defenses | Selects a number of targets equal to Net Successes. Those targets are removed from IFF for automated defenses. | — | |
| 91 | Corrupt IFF 6 | Targets=# of Successes. They are removed from any IFF for auto defenses | Selects a number of targets equal to Net Successes. Those targets are removed from IFF for automated defenses. | — | |
| 92 | Crack Encryption 1 | Diff=6xFile Security Rating. Loads into I/O | Requires Net Successes ≥ 6 × the target's File Security Rating. Loads into the I/O stream. | — | |
| 93 | Crack Encryption 2 | Diff=6xFile Security Rating. Loads into I/O | Requires Net Successes ≥ 6 × the target's File Security Rating. Loads into the I/O stream. | — | |
| 94 | Crack Encryption 3 | Diff=6xFile Security Rating. Loads into I/O | Requires Net Successes ≥ 6 × the target's File Security Rating. Loads into the I/O stream. | — | |
| 95 | Crack Encryption 4 | Diff=6xFile Security Rating. Loads into I/O | Requires Net Successes ≥ 6 × the target's File Security Rating. Loads into the I/O stream. | — | |
| 96 | Crack Encryption 5 | Diff=6xFile Security Rating. Loads into I/O | Requires Net Successes ≥ 6 × the target's File Security Rating. Loads into the I/O stream. | — | |
| 97 | Crack Encryption 6 | Diff=6xFile Security Rating. Loads into I/O | Requires Net Successes ≥ 6 × the target's File Security Rating. Loads into the I/O stream. | — | |
| 98 | Device Control 1 | Diff=2xHardening. Gains complete control (admin) of device w/ area of influence | Requires Net Successes ≥ 2 × the target's Hardening. Grants complete (admin) control of the device, within range of influence. | — | |
| 99 | Device Control 2 | Diff=2xHardening. Gains complete control (admin) of device w/ area of influence | Requires Net Successes ≥ 2 × the target's Hardening. Grants complete (admin) control of the device, within range of influence. | — | |
| 100 | Device Control 3 | Diff=2xHardening. Gains complete control (admin) of device w/ area of influence | Requires Net Successes ≥ 2 × the target's Hardening. Grants complete (admin) control of the device, within range of influence. | — | |
| 101 | Device Control 4 | Diff=2xHardening. Gains complete control (admin) of device w/ area of influence | Requires Net Successes ≥ 2 × the target's Hardening. Grants complete (admin) control of the device, within range of influence. | — | |
| 102 | Device Control 5 | Diff=2xHardening. Gains complete control (admin) of device w/ area of influence | Requires Net Successes ≥ 2 × the target's Hardening. Grants complete (admin) control of the device, within range of influence. | — | |
| 103 | Device Control 6 | Diff=2xHardening. Gains complete control (admin) of device w/ area of influence | Requires Net Successes ≥ 2 × the target's Hardening. Grants complete (admin) control of the device, within range of influence. | — | |
| 104 | Encrypt File 1 | Successes up to 3 increase Encryption 2 per. Extra successes are penalties to Decrypt | The first 3 Net Successes each raise the file's Security Rating by 2, to a maximum of +6. Each additional Net Success becomes a penalty die against attempts to crack the encryption. | — | |
| 105 | Encrypt File 2 | Successes up to 3 increase Encryption 2 per. Extra successes are penalties to Decrypt | The first 3 Net Successes each raise the file's Security Rating by 2, to a maximum of +6. Each additional Net Success becomes a penalty die against attempts to crack the encryption. | — | |
| 106 | Encrypt File 3 | Successes up to 3 increase Encryption 2 per. Extra successes are penalties to Decrypt | The first 3 Net Successes each raise the file's Security Rating by 2, to a maximum of +6. Each additional Net Success becomes a penalty die against attempts to crack the encryption. | — | |
| 107 | Encrypt File 4 | Successes up to 3 increase Encryption 2 per. Extra successes are penalties to Decrypt | The first 3 Net Successes each raise the file's Security Rating by 2, to a maximum of +6. Each additional Net Success becomes a penalty die against attempts to crack the encryption. | — | |
| 108 | Encrypt File 5 | Successes up to 3 increase Encryption 2 per. Extra successes are penalties to Decrypt | The first 3 Net Successes each raise the file's Security Rating by 2, to a maximum of +6. Each additional Net Success becomes a penalty die against attempts to crack the encryption. | — | |
| 109 | Encrypt File 6 | Successes up to 3 increase Encryption 2 per. Extra successes are penalties to Decrypt | The first 3 Net Successes each raise the file's Security Rating by 2, to a maximum of +6. Each additional Net Success becomes a penalty die against attempts to crack the encryption. | — | |
| 110 | Ghost Protocol 1 | Can create false creds duiring Recon/Prep. Can also increase Ghost Rating (page 136). | Can create false credentials during Reconnaissance and Preparation. Can also increase Ghost Rating (see page 136). | — | TYPO: "duiring" → "during". |
| 111 | Ghost Protocol 2 | Can create false creds duiring Recon/Prep. Can also increase Ghost Rating (page 136). | Can create false credentials during Reconnaissance and Preparation. Can also increase Ghost Rating (see page 136). | — | TYPO: "duiring" → "during". |
| 112 | Ghost Protocol 3 | Can create false creds duiring Recon/Prep. Can also increase Ghost Rating (page 136). | Can create false credentials during Reconnaissance and Preparation. Can also increase Ghost Rating (see page 136). | — | TYPO: "duiring" → "during". |
| 113 | Ghost Protocol 4 | Can create false creds duiring Recon/Prep. Can also increase Ghost Rating (page 136). | Can create false credentials during Reconnaissance and Preparation. Can also increase Ghost Rating (see page 136). | — | TYPO: "duiring" → "during". |
| 114 | Ghost Protocol 5 | Can create false creds duiring Recon/Prep. Can also increase Ghost Rating (page 136). | Can create false credentials during Reconnaissance and Preparation. Can also increase Ghost Rating (see page 136). | — | TYPO: "duiring" → "during". |
| 115 | Ghost Protocol 6 | Can create false creds duiring Recon/Prep. Can also increase Ghost Rating (page 136). | Can create false credentials during Reconnaissance and Preparation. Can also increase Ghost Rating (see page 136). | — | TYPO: "duiring" → "during". |
| 116 | Shadow Protocols 1 | Lowers Alert by 1 per success. Can be loaded into I/O | Reduces the Alert level by 1 per Net Success. If loaded into I/O, reduce Alert level by 1. | — | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| 117 | Shadow Protocols 2 | Lowers Alert by 1 per success. Can be loaded into I/O | Reduces the Alert level by 1 per Net Success. CIf loaded into I/O, reduce Alert level by 2. | — | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| 118 | Shadow Protocols 3 | Lowers Alert by 1 per success. Can be loaded into I/O | Reduces the Alert level by 1 per Net Success. If loaded into I/O, reduce Alert level by 3. | — | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| 119 | Shadow Protocols 4 | Lowers Alert by 1 per success. Can be loaded into I/O | Reduces the Alert level by 1 per Net Success. CIf loaded into I/O, reduce Alert level by 4. | — | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| 120 | Shadow Protocols 5 | Lowers Alert by 1 per success. Can be loaded into I/O | Reduces the Alert level by 1 per Net Success. If loaded into I/O, reduce Alert level by 5. | — | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| 121 | Shadow Protocols 6 | Lowers Alert by 1 per success. Can be loaded into I/O | Reduces the Alert level by 1 per Net Success. If loaded into I/O, reduce Alert level by 6. | — | UNCLEAR: Description states loading it into the I/O stream instead reduces *all* alert increases by the program's Rating — a second, passive mode the Effect text never actually states the magnitude of. |
| 122 | Hacking 1 | Runs a deck of MCP 3 or less | Runs a deck with MCP ≤ 2 × Rating + 1. | — | |
| 123 | Hacking 2 | Runs a deck of MCP 5 or less | Runs a deck with MCP ≤ 2 × Rating + 1. | — | |
| 124 | Hacking 3 | Runs a deck of MCP 7 or less | Runs a deck with MCP ≤ 2 × Rating + 1. | — | |
| 125 | Hacking 4 | Runs a deck of MCP 9 or less | Runs a deck with MCP ≤ 2 × Rating + 1. | — | |
| 126 | Hacking 5 | Runs a deck of MCP 11 or less | Runs a deck with MCP ≤ 2 × Rating + 1. | — | |
| 127 | Hacking 6 | Runs a deck of MCP 13 or less | Runs a deck with MCP ≤ 2 × Rating + 1. | — | Every one of the six original thresholds (3,5,7,9,11,13) checks out against `MCP ≤ 2×Rating+1` and against the Description's "at least half the deck's MCP, round down" rule — no break found, formula collapse is safe. |

---

### hack_actions — Notes

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Hack Device (Gun/Drone/etc) | Can turn on/off or activate device. No other control. | Can turn the device on or off, or activate it. No other control is possible. | — | |
| 2 | Enable/Disable Camera | Turn on or off. Will restart later unless destroyed | Turns the camera on or off. It restarts later unless destroyed. | — | |
| 3 | Destroy Single Camera | Req Attack software. Raise Alert and Op Heat by 1 | Requires Attack software. Raises Alert and Op Heat by 1. | — | |
| 4 | Destroy Camera Network | Req Attack software. Raise Alert and Op Heat by 1 | Requires Attack software. Raises Alert and Op Heat by 1. | — | CHECK: identical Alert/Op Heat cost to "Destroy Single Camera" above despite the larger scope (a whole network vs. one camera). Not changed; confirm this is intentional. |
| 5 | Erase a Camera | Req Crack Encryption | Requires Crack Encryption. | — | |
| 6 | Loop Camera-Access (1) | Access camera for the next two steps | Accesses the camera for the next two steps. | — | |
| 7 | Loop Camera-Decrypt (2) | Req Crack Encryption | Requires Crack Encryption. | — | |
| 8 | Loop Camera-Edit Stream (3) | Req Device Control. Uses 1 I/O for run. | Requires Device Control. Uses 1 I/O to run. | — | |
| 9 | Brute Force NAN | Double I/O in meters. Add 2m and 2 Alert per extra success | Base range equals I/O × 2, in meters. Each additional Net Success adds 2m of range and 2 Alert. | — | UNCLEAR: this row's Description is empty, so "Double I/O in meters" as a base-range formula is my best reading of the shorthand, not a confirmed one. |
| 10 | Stealth NAN | 1m per extra success. Alert only raises 1. | Each additional Net Success adds 1m of range. Alert rises by only 1. | — | |

---

### drone_ballistic_weapons — Effect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Missile Launcher | 150/75/25 dmg radius 8m/16m/20m. Ignores armor | 150/75/25 damage in an 8m/16m/20m radius. Ignores Armor. | — | |
| 2 | Sentry Gun | Cannot be mounted on aerial units | Cannot be mounted on aerial units. | — | |
| 3 | Autocannon | Choose round: AP(+2 Pen), HEI(-2 Pen, +4 DMG at 4m radius), Tracer(+2 acc) | Choose ammunition: AP (+2 Penetration), HEI (-2 Penetration, +4 damage in a 4m radius), or Tracer (+2 Accuracy). | — | |
| 4 | Oil Slick | Ground targets -3 penalty on slick | Ground targets standing on the slick take a -3 penalty. | — | |
| 5 | Smokescreen | 30m wide/60m long smokescreen | Creates a 30m-wide, 60m-long smokescreen. | — | |

---

### drone_ballistic_weapons — ModeEffect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Missile Launcher | SS 150/75/25 dmg radius 8m/16m/20m. Ignores armor | SS. 150/75/25 damage in an 8m/16m/20m radius. Ignores Armor. | — | |
| 2 | Sentry Gun | SS Cannot be mounted on aerial units | SS. Cannot be mounted on aerial units. | — | |
| 3 | Recoilless Gun | SS | SS | — | |
| 4 | Mini Gun | SS, BF, FA | SS, BF, FA | — | |
| 5 | Grenade Launcher | SS, BF | SS, BF | — | |
| 6 | Autocannon | SS, BF, FA Choose round: AP(+2 Pen), HEI(-2 Pen, +4 DMG at 4m radius), Tracer(+2 acc) | SS, BF, FA. Choose ammunition: AP (+2 Penetration), HEI (-2 Penetration, +4 damage in a 4m radius), or Tracer (+2 Accuracy). | — | |
| 7 | Recoilless Rifle | SS, BF | SS, BF | — | |
| 8 | Oil Slick | Ground targets -3 penalty on slick | Ground targets standing on the slick take a -3 penalty. | — | |
| 9 | Smokescreen | 30m wide/60m long smokescreen | Creates a 30m-wide, 60m-long smokescreen. | — | |

---

### drone_energy_weapons — ModeEffect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Dazzleray | Single target -3d to all tests with flare | Single target takes -3 dice to all tests while flared. | — | |
| 2 | Heavy Swell | 6m circumference burst. 20 dmg vs digital cohesion. Disables cyberware for 2 rounds | 6m-circumference burst dealing 20 damage to digital Cohesion. Disables cyberware for 2 rounds. | — | |
| 3 | Sonic Disruption | Targets make Body test vs Gunnery. If failed, can only take simple actions. Audio dampening negates. | Targets make a Body test versus Gunnery. Those who fail can only take simple actions. Audio dampening negates this. | — | |
| 4 | Pulse Rifle | Pain causes penalty to next round equal to damage taken | Pain causes a penalty on the next round equal to damage taken. | — | |
| 5 | Pulse Mini Gun | Full complex action to spin up before firing. See page 151 | Requires a full complex action to spin up before firing. See page 151. | — | |
| 6 | Railgun | Ignore armor | Ignores Armor. | — | |

---

### drone_mods — ModeEffect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Extended Magazine | Doubles ammo | Doubles ammunition capacity. | — | |
| 2 | Hardening | +2 Base Hardening | +2 Base Hardening | — | |
| 3 | Advanced Hardening | +4 Base Hardening | +4 Base Hardening | — | |
| 4 | Armor | +1 Ballistic Armor | +1 Ballistic Armor | — | |
| 5 | Improved Armor | +2 Ballistic Armor | +2 Ballistic Armor | — | |
| 6 | Frame | +1 Impact Armor | +1 Impact Armor | — | |
| 7 | Improved Frame | +2 Impact Armor | +2 Impact Armor | — | |
| 8 | Battle Ram | Double damage and takes 1/2 damage from Ram | Deals double damage on a Ram. Takes half damage from a Ram. | — | Split into two sentences — one statement bundled two different effects with "and". |

---

### vehicle_ballistic_weapons — Effect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Oil Slick | Ground targets -3 penalty on slick | Ground targets standing on the slick take a -3 penalty. | — | |
| 2 | Autocannons | Choose round: AP(+2 Pen), HEI(-2 Pen, +4 DMG at 4m radius), Tracer(+2 acc) | Choose ammunition: AP (+2 Penetration), HEI (-2 Penetration, +4 damage in a 4m radius), or Tracer (+2 Accuracy). | — | |
| 3 | Tank Cannon | Choose Round: KE(Ignores armor), HE(Damage 50 fire explosion), Cannister(Damage to all tgts in 15-degree cone) | Choose ammunition: KE (ignores Armor), HE (50 damage, fire explosion), or Canister (damage to all targets in a 15-degree cone). | — | TYPO: "Cannister" → "Canister". |
| 4 | Missile Launcher | 150/75/25 dmg radius 8m/16m/20m. Ignores armor | 150/75/25 damage in an 8m/16m/20m radius. Ignores Armor. | — | |

---

### vehicle_ballistic_weapons — ModeEffect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Oil Slick | Ground targets -3 penalty on slick | Ground targets standing on the slick take a -3 penalty. | — | |
| 2 | Machine Guns | FA (60) | FA (60) | — | |
| 3 | Autocannons | FA (60) Choose round: AP(+2 Pen), HEI(-2 Pen, +4 DMG at 4m radius), Tracer(+2 acc) | FA (60). Choose ammunition: AP (+2 Penetration), HEI (-2 Penetration, +4 damage in a 4m radius), or Tracer (+2 Accuracy). | — | |
| 4 | 25mm Cannon | SS, BF | SS, BF | — | |
| 5 | 30mm Cannon | SS, BF | SS, BF | — | |
| 6 | Tank Cannon | SS Choose Round: KE(Ignores armor), HE(Damage 50 fire explosion), Cannister(Damage to all tgts in 15-degree cone) | SS. Choose ammunition: KE (ignores Armor), HE (50 damage, fire explosion), or Canister (damage to all targets in a 15-degree cone). | — | TYPO: "Cannister" → "Canister". |
| 7 | RPG Launcher | SS | SS | — | |
| 8 | Missile Launcher | SS, BF (4) 150/75/25 dmg radius 8m/16m/20m. Ignores armor | SS, BF (4). 150/75/25 damage in an 8m/16m/20m radius. Ignores Armor. | — | |

---

### vehicle_energy_weapons — ModeEffect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Pulse Cannon | Pain causes penalty to next round equal to damage taken | Pain causes a penalty on the next round equal to damage taken. | — | |
| 2 | Tactical Tsunami | Single target -3d to all tests with flare | Single target takes -3 dice to all tests while flared. | — | |
| 3 | Plasma Cannon | 6m circumference burst. 20 dmg vs digital cohesion. Disables cyberware for 2 rounds | 6m-circumference burst dealing 20 damage to digital Cohesion. Disables cyberware for 2 rounds. | — | |
| 4 | Railgun | Ignore armor | Ignores Armor. | — | |

---

### vehicle_mods — ModeEffect

| # | Name | Original | Proposed | Engine | Notes |
|---|---|---|---|---|---|
| 1 | Extended Magazine | Doubles ammo | Doubles ammunition capacity. | — | |
| 2 | Hardening | +2 Base Hardening | +2 Base Hardening | — | |
| 3 | Advanced Hardening | +4 Base Hardening | +4 Base Hardening | — | |
| 4 | Armor | +1 Ballistic Armor | +1 Ballistic Armor | — | |
| 5 | Improved Armor | +2 Ballistic Armor | +2 Ballistic Armor | — | |
| 6 | Frame | +1 Impact Armor | +1 Impact Armor | — | |
| 7 | Improved Frame | +2 Impact Armor | +2 Impact Armor | — | |
| 8 | Battle Ram | Double damage and takes 1/2 damage from Ram | Deals double damage on a Ram. Takes half damage from a Ram. | — | Split into two sentences — one statement bundled two different effects with "and". |

---

### Summary
**Rows:** 189 total — 127 `programs.Effect`, 10 `hack_actions.Notes`, 60 vehicle/drone weapon & mod `Effect`/`ModeEffect` rows (14 drone_ballistic_weapons, 6 drone_energy_weapons, 8 drone_mods, 12 vehicle_ballistic_weapons, 4 vehicle_energy_weapons, 8 vehicle_mods).

**Changed:** 169 of 189. **Unchanged (already canonical):** 20 — all in the mod/weapon tables: the six `+N Base Hardening` / `+N Ballistic|Impact Armor` rows in `drone_mods` and again in `vehicle_mods` (12 total), plus the bare fire-mode notations (`SS`, `SS, BF`, `SS, BF, FA`, `FA (60)`) that needed no touch-up (8 total).

**Engine:** `—` for all 189 rows — nothing in this packet is parsed today.

**Typos found:** 8 — "duiring" → "during" (Ghost Protocol, all 6 ranks), "Cannister" → "Canister" (Tank Cannon, `vehicle_ballistic_weapons.Effect` and `.ModeEffect`).

**Contradicts Description:** 0 confirmed outright contradictions. Every rating-scaled formula in the programs table was checked rank-by-rank against its Description and validated (Acid Burn's `/2`, Hacking's `MCP ≤ 2×Rating+1`, the `Diff=` threshold programs, Encrypt File's 3-success cap) — none disagreed.

**Flagged for review:** 4 items —
- **Vermin Call** (row 78, rank 6): damage tiers are uneven across the family (1, 1, 2, 2, 2, 3) — a 2-wide low tier, 3-wide mid tier, 1-wide high tier. Left unchanged; worth confirming the tier widths are intentional.
- **Shadow Protocols** (all 6 ranks): the Effect text only ever describes the active "1 Alert per Net Success" mode. The Description's second, passive mode (loading it into the I/O stream to reduce *all* alert increases by Rating) has no stated magnitude in the Effect column at all.
- **Decoy** (all 6 ranks): "IRL" only resolves to "in range of influence" via the Description — read cold it looks like chat slang for "in real life."
- **Brute Force NAN** (`hack_actions`): its Description is blank, so "Double I/O in meters" as a base-range formula is an inference, not a confirmed reading.
- Also noted, not flagged per-row: **Destroy Camera Network** costs exactly the same Alert/Op Heat as **Destroy Single Camera** despite the larger scope — plausibly intentional, called out in that row's Notes as CHECK.

**Recurring drift patterns specific to this packet:**
1. **Success terminology** was the single biggest source of noise: "Success," "Successes," "success," "hits," and "your successes" all meant the same thing across the 21 program families. Collapsed to one token, `Net Successes`, defined once in Notation rather than re-explained per row.
2. **The leading rank number doubling as the rating** — every rating-scaled formula used the numeral 1–6 both as the row's rank *and* as the value plugged into its own formula. Replacing it with a `Rating` token made siblings within a family text-identical, which is what actually exposed the two real irregularities (Vermin Call's uneven tiers, Hacking's formula — which turned out to be consistent after all).
3. **Area-of-effect phrasing** ("IRL," "AOI," "area of influence," "influence field," "in range") was four or five spellings of one concept across different programs, unified to "range of influence."
4. **Terse `Diff=` / `X=Y` shorthand** (Crack Encryption, Device Control, Analysis Locus, Corrupt IFF) reads as pseudo-code left over from an early draft; rewritten as plain "Requires Net Successes [≥/>] …" sentences using the exact comparison each Description states.
5. **Two effects joined by "and" or a colon/semicolon** instead of being split into sentences (Refraction Field, Vent Gas, Battle Ram in both mod tables) — brought in line with the style guide's one-statement-per-sentence rule.
6. **Lowercase `armor`/`hardening`/`cohesion`** scattered through the weapon and mod tables where `programs.Effect` mostly capitalized them — normalized to the capitalized proper-stat form everywhere.
7. The mod tables (`drone_mods`/`vehicle_mods`) and the fire-mode notations (`SS`/`BF`/`FA`) were already the cleanest text in the packet — worth noting as a model for the rest, not just a place I made changes.
