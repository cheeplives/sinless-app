---
name: homebrew-column-sync
description: Keeps the homebrew editor in step with the game data tables in the sinless-app repo. Use this whenever you add, rename or remove a column/field on any table in static/data.js — a new stat, flag or note column on weapons, armor, augments, gear, drones, vehicles, spells, spirits, mods or any other table — and also when a change request mentions giving items a new property, marking items with a new flag, or storing something new on a data row. The engine can read a new column the moment it exists, but the homebrew editor builds its form from a hand-written list, so a column that isn't added there is silently unfillable for homebrew authors.
---

# Keeping homebrew in step with the data tables

## Why this exists

`static/data.js` holds the game's tables. `calculate()` reads columns straight
off a row, so the moment you add one the engine can use it.

The homebrew editor does **not** work that way. `HOMEBREW_CONFIG` in
`static/homebrew.js` is a hand-written list of the fields each table's form
shows. A column that isn't in that list simply doesn't appear — a homebrew
author gets a form that can't express the row shape the core data uses, and
nothing anywhere says so. Their custom weapon quietly lacks the flag every core
weapon has.

The failure is silent and arrives late, usually as "why can't I set X on my own
gear?" long after the column landed. That's what this catches.

## The check

```bash
python .claude/skills/homebrew-column-sync/scripts/check_homebrew_columns.py --repo .
```

It parses every table in `data.js`, takes the **union of keys across all rows**
(not just the first — a column used by three of a hundred rows is exactly the
case worth catching), and compares against the field keys declared for that
table in `HOMEBREW_CONFIG`. Exit status is 1 when something is missing, so it
works in a hook.

It reports three things:

- **Missing** — a data column with no editor field. This is the failure. Fix it.
- **Extra** — an editor field no row currently uses. Usually fine: an author can
  be the first to set one. Worth a glance for a typo'd key.
- **No editor** — tables with no homebrew form at all (`priorities`,
  `heritage_features`, `lifestyles`…). By design; reference data isn't authorable.

## Adding the field

Find the table in `HOMEBREW_CONFIG` and add an entry to its `fields` array, in
the position where a reader would expect the column — next to related stats,
not appended to the end. Pick the input that fits what the column holds:

| Column holds | Use | Example |
|---|---|---|
| free text / a number | `hint` describing the format | `{ key: "ZR", hint: "number" }` |
| one of a fixed set | `select` + `optionLabel` | `{ key: "Oneshot", select: () => ["", "1"], optionLabel: v => v === "1" ? "1 (sealed — cannot be reloaded)" : "(reloads normally)" }` |
| a name from another table | `datalist` | `{ key: "Integrated Mods", datalist: () => hbDistinct("weapon_mods", "Modification") }` |
| a sentence or more | `ta: true` | `{ key: "Notes", ta: true }` |

Two things make these fields actually usable, and both are easy to skip:

**A flag needs labelled options, not a bare "1".** `select: () => ["", "1"]`
alone tells an author nothing about which is which. `optionLabel` is what turns
it into a choice they can make — say what each value *does*, as the Integrated
Smart and Oneshot fields do.

**A hint should say the format and any constraint the engine assumes.** If the
value is comma-separated, say so. If it only applies to one weapon type, say so.
The engine will read whatever it's given; the hint is the only place an author
learns what it expects. Compare `{ key: "StrCost", hint: "Bows only — cost per
point of Minimum Strength. Setting it makes the weapon STR-rated: leave Cost,
Damage and Rarity blank" }` with a bare `hint: "number"` — the first prevents a
broken row, the second doesn't.

## After adding it

Re-run the check; it should report every column covered. Then confirm the field
actually renders, because a typo in the key gives you a form control bound to
nothing:

```js
HOMEBREW_CONFIG.weapons.fields.filter(f => /YourColumn/.test(f.key))
```

Bump `CACHE_VERSION` in `sw.js` and `APP_VERSION` in `static/rules.js` — editing
`homebrew.js` is a client change like any other.

## Renames and removals

The check finds missing columns; it can't tell a rename from an add-plus-remove.
When you rename a column, update the editor field key to match in the same
change, and remember that existing saved homebrew rows still carry the old key —
homebrew is stored per user in `localStorage` and synced, so a rename orphans
their data exactly the way a renamed data row orphans a character's reference.
The repo's convention for that is a rename map applied in `mergeDefaults`
(`RENAMED_AUGMENTS`, `RENAMED_SPIRITS`, `RENAMED_AMMO`) — follow it rather than
leaving authors to re-enter the value.
