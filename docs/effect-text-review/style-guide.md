# Effect-text style guide (draft — for the data.js cleanup review)

The goal is one vocabulary across every table, so that the same mechanic reads
the same way wherever it appears, and so a parser can be pointed at it later
without a new special case per row.

## The one rule that matters most

**One mechanical statement per sentence, separated by `. `**

Every parser in `rules.js` that reads this text splits it into clauses first:

| Parser | Splits on | rules.js |
|---|---|---|
| `senseClauses` (Enhanced Senses) | `(?<=[.;])\s+` | 2677 |
| `droneCombatBonuses` / `droneSkillDice` | `[,.;]` | 2569, 2608 |
| `infusionStatMods` | `,` | 4336 |
| `parseEtiquetteBonuses` | stops a span at `[.;]` | 3931 |

A sentence that bundles three effects can only ever be matched by whichever
pattern wins first; the rest is invisible. Splitting them is what makes the text
addressable at all.

Corollary: **do not use a comma between two different effects.** Commas are for
lists of things a single number governs (`+2d Brawn/Finesse Pool`), never for
joining `+2 Body, 2 Impact armor`.

## Canonical forms

Anything marked **parser-critical** must keep matching — the regex is live today
and a rewrite that breaks it silently changes a character sheet.

### Pool dice — parser-critical (`POOL_DICE_RE`, rules.js:4104)

```
+2d Brawn Pool                      one pool
+2d Brawn/Finesse Pool              several pools, one number
-3d Focus Pool                      a penalty
```

List several pools in **`POOL_NAMES` order — Brawn, Finesse, Focus, Resolve** —
not the order the old sentence happened to use. Parsing doesn't care; a reader
comparing two rows does. Always say "Pool", in every clause: a row that writes
`+4d Focus Pool` and then `-2d Focus` is describing the same thing two ways.

Drives the conditional pool toggles (Adrenal Pump, drugs, the Wildling shift).
The number **must be signed** — `Brawn Pool (3)` is read as a target number and
is deliberately not matched.

Never write `Increase Finesse by 4` or `+4 Finesse pool` without the `d`: the
first doesn't match at all (see the Lick finding), the second does match but
reads inconsistently beside its neighbours.

### Skill dice

Prose mirrors the **column syntax**, so the two never drift into different
dialects and moving one to the other is a copy rather than a translation:

```
Observation +2                      a flat bonus   -> Skill Bonus "Observation +2"
Observation +2, Recon +1            several        -> comma-separated, as the column is
Shadow: reroll 1s and 2s in cover   conditional    -> Skill Note "Shadow: reroll 1s and 2s in cover"
Athletics: +8d when jumping         a conditional number, still a note
```

The distinction is the mechanism, not the wording: a **flat, unconditional**
bonus is a `Skill Bonus` and gets folded into the rating; anything gated on a
circumstance is a `Skill Note` and is shown beside the skill, never summed. If a
sentence has both — "+3 to Biotech tests and can re-roll 1s" — that's one value
for each column.

Where an Effect states a flat skill bonus that a column could carry, **flag it
for migration** rather than leaving the number to live only in prose. `rules.js`
does not parse skill dice out of Effect text anywhere except drone Effects, and
that one is deliberately scoped to deployed drones — see the migration section
of the review before assuming a drone bonus can move to a column.

Use the skill's real name; the column parser rejects anything else with a
warning. `SKILLS` has **Shadow**, not "Stealth", and **Reconnaissance** (alias
"Recon") as the canonical form.

### Numbers a column already carries

State **what** is boosted; leave **how much** to the column.

```
Grants a bonus to Strength and Body.     augments: the attribute columns
Grants Impact and Ballistic Armor.       augments: the armor columns
Grants a bonus to Observation.           any table: Skill Bonus
```

The column is what the engine applies, so a number repeated in prose can only
agree with it or be wrong — and drift is invisible until someone reads one and
trusts it. Naming the stat keeps the row readable without a second source of
truth.

This does **not** apply to pool dice. A pool bonus lives only in the prose
(`POOL_DICE_RE` reads it there), so its number is the rule, not a copy of one.
Nor to rerolls: "reroll 1s and 2s" names dice faces, not a magnitude.

### Attributes

Augments carry `Strength`, `Body`, `Reaction`, `Intelligence`, `Willpower` and
`Charisma` columns, so the prose names them and stops:

```
Grants a bonus to Body.
Grants a bonus to Strength and Body.
```

Not `grants +1 to Body`, `+2 to body`, or `+1 Body` — see *Numbers a column
already carries*. Capitalise the attribute; drop `grants … to` in favour of the
one form above.

Where a table has **no** column for the value (heritage traits' Dodge riders, an
amp's simple-action grant), keep the number — it has nowhere else to live.

### Armor

`Impact Armor` and `Ballistic Armor` are columns on augments and armor, so again
the prose names them:

```
Grants Impact Armor.
Grants Impact and Ballistic Armor.
```

Not `1 Impact armor`, `2 points of impact armor`, `+1B Armor`, or `2B/3I Armor`.

The `B`/`I` shorthand is load-bearing elsewhere — `infusionStatMods`
(rules.js:4411) parses `+2 to B/I armor` from spirit effects for real — so don't
introduce it in tables that have the columns.

### Movement

```
+2m Movement                        a bonus — parser-critical for martial arts
                                    (rules.js:4213) and infusions (4425)
Movement 10m                        a replacement, not a bonus
Fly 12m
```

`10m Move` and `Add 2m to movement` are the same thing said two ways; the second
also fails `/\+(\d+)\s*m\b[^.]*?mov/i` because it has no `+`.

### Senses — parser-critical (`SENSE_CAPABILITIES`, rules.js:2654)

Use the capability name exactly; the banner groups sources by it.

```
Thermographic vision
Infrared vision
Ultraviolet vision
Echolocation 24m
Vision magnification 2
Sound filtering                     -> "Selective hearing"
Can see in darkness
```

Drop the `Grants ` prefix — `senseClauses` already strips it, so writing it adds
nothing and makes two sources of one sense look different.

### Wound penalties — parser-critical (rules.js:4985)

```
Ignore wound penalties
Wound penalties are doubled
```

`Ignore wound pen` (Dorf) does **not** match `/wound penalt/i` — it's two
characters short. Note though that fixing the spelling alone doesn't make Dorf
work: `removesWoundPenalty` is only ever applied to augments, martial-art levels
and heritage traits, never to `misc_gear` (`rules.js:4987`). Standardize the
wording anyway for consistency, but that row needs a `rules.js` change to have
any effect. See `near_miss.py` for the near-miss / not-wired distinction.

### Cover — parser-critical (`parseCoverGrant`, rules.js:4290)

```
Low cover  |  High cover  |  Full cover
```

### Recoil — parser-critical (rules.js:4215)

```
Ignore recoil
+1 Recoil Capacity
```

### Mount capacity

```
Weight-1 mount            sentence-initial
Gain 2 weight-1 mounts    mid-sentence
```

One hyphenated form, the number attached to the word it qualifies. The table
currently holds `1 wt mount`, `1-weight mounts` and `1 weight Weapon Mount` for
the same idea. Note this is the mount's **capacity**, not an item's `Weight`
stat — the energy weapons' `Wt 3+1` is a different quantity and keeps its own
notation.

### Durations and quantities

```
for 12 hours          not "for 12 hrs", "for a few hours", "10/min"
for 15 minutes
Reach 0               not "Reach(0)", "Reach 0."
Range 12m             not "Range(12m)"
Accuracy 4            not "Acc4"
```

Spell out `w/`, `w/n`, `w/o`, `vs` → `with`, `within`, `without`, `versus`,
except inside an established stat abbreviation.

### Requirements and dependencies

```
Requires a Chipjack.
Requires Platelet Production Enhancement.
```

One shape, always leading, always a full sentence. Today these appear as
`Requires a Chipjack.`, `Requires Chipjack.` and
`Required if Platelet Production Enhancement is purchased`.

## What NOT to do

- **Don't add mechanics that aren't there.** If the original is vague
  ("Simsense experience, but amplified"), keep it vague. Precision you invent is
  a rules change wearing a cleanup's clothes.
- **Don't drop a qualifier to make a sentence match a pattern.** `+4d Focus pool
  for 3 hrs. If addicted instead at -2d Focus without it.` keeps both sentences;
  the parser already handles this correctly (first clause per pool wins).
- **Don't renumber.** If a value looks wrong, flag it; changing it is a balance
  decision, not a formatting one.
- **Don't rename the row.** Names are how characters reference data; a rename
  orphans saved characters and needs a `RENAMED_*` migration map.
