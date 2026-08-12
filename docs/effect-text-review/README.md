# Effect-text review — working bundle

A one-off pass over the mechanical text in `static/data.js`: the proposal, the
style guide behind it, and the scripts that check it. Everything for this pass
lives in this directory and nothing outside it depends on it, so when the pass
is finished it comes out in one move:

```bash
git rm -r docs/effect-text-review
```

Nothing else needs unpicking — no hook registration, no import from app code, no
entry in `sw.js`. That's the point of keeping it together.

## What's here

| File | |
|---|---|
| `REVIEW.md` | the proposal — 684 cells, each original beside its replacement |
| `style-guide.md` | the canonical vocabulary the rewrites apply |
| `probe.py` | which `rules.js` parsers fire on which cell of `data.js` |
| `verify.py` | re-runs the probe over every *proposed* rewrite and diffs |
| `column_drift.py` | where prose and the structured column disagree |
| `near_miss.py` | text describing a mechanic the engine can't quite read |

## The one you'll actually run

```bash
python docs/effect-text-review/verify.py
```

Run it after editing `REVIEW.md` — accepting a row, tweaking a proposed string,
adding a row — and again before copying anything into `static/data.js`.

It reads every table in `REVIEW.md`, runs the parser patterns over both the
Original and the Proposed text, and reports any row where the two differ in what
the engine would extract. A row is allowed to change engine behaviour only if its
Notes column says **NEW BEHAVIOUR**; anything else exits 1.

Today that's two rows — `Lick` and `Rage`, which gain the pool toggle they've
never had — and nothing else:

```
684 rows across 22 tables, 585 reworded

change  decl  table       row     parser hit
GAINED  yes   misc_gear   Lick    pool Finesse+4
GAINED  yes   misc_gear   Rage    pool Brawn+4

No undeclared parser changes (2 declared).
```

That output is the whole claim of this pass: 682 of 684 rewrites are formatting,
demonstrated rather than asserted.

## Why a probe rather than reading the code

Only **49 of 684** cells are read by `rules.js` at all. The engine's real
interface to the data is structured columns — `augments` carry `Strength`,
`Body`, `Impact Armor`, `Skill Bonus`; `heritage_features` carry `Observation`,
`Move`, `Dodge`, `Soak` — and the Effect prose usually just restates them.

But which 49, and what exactly each one yields, is not something to hold in your
head while editing 684 rows. `probe.py` transcribes the nine parsers that read
prose (`derivePoolEffects`, `deriveSenseNotes`, `martialArtStatMods`,
`parseCoverGrant`, `droneSkillDice`, `droneCombatBonuses`,
`parseEtiquetteBonuses`, `deriveInitiative`, and the wound-penalty pair) and runs
them over every cell, so the Engine column in `REVIEW.md` is observed output.

```bash
python docs/effect-text-review/probe.py --only-hits    # the 49 that matter
python docs/effect-text-review/probe.py --table drones
python docs/effect-text-review/probe.py --json
```

Just as important is the wiring map at the bottom of `probe.py`: a parser only
ever sees the table and column it's handed. `weapon_mods.Effect` reaches the
etiquette parser and nothing else, so `+1 Recoil Capacity` there is display text
however machine-readable it looks — the real number is in the `RecoilMod` column.

### The transcription caveat

`probe.py` is a **Python transcription** of the `rules.js` regexes, not an
execution of them, because there's no Node on this machine. Each pattern carries
the `rules.js` line it came from. It is therefore only as current as the day it
was written: if a parser changes, this drifts silently.

Treat a surprising result as a reason to open `rules.js` rather than as fact. If
this bundle outlives a change to any of those nine functions, re-check the
transcription before trusting a run.

## The other two

Both were used to write the Findings section of `REVIEW.md`, and both are worth
re-running if you change the data:

```bash
python docs/effect-text-review/column_drift.py
python docs/effect-text-review/near_miss.py
```

`column_drift.py` compares every number stated in augment and heritage prose
against the structured column holding the same value. It currently finds no
genuine contradiction — the numbers agree, and it's the language that varies,
which is what made this pass a bounded rewrite rather than a data audit.

`near_miss.py` separates two things that look alike:

- **near miss** — the column *is* wired to a parser and the row talks about that
  mechanic, but the phrasing misses by a hair. `Lick`'s `Increase Finesse by 4`
  needs a signed number. These are bugs a rewrite fixes for free.
- **not wired** — the phrasing is fine but nothing hands that column to that
  parser. `Dorf`'s wound immunity is unreachable no matter how it's spelled,
  because `misc_gear` is never passed to `removesWoundPenalty`
  (`rules.js:4987`). Only a `rules.js` change fixes those.

## Applying a row

`data.js` is one JSON object per line and must stay that way. When copying an
accepted `Proposed` string in, keep the row on its own line, re-parse the file
before committing, and run `verify.py` first.

If you accept a rewrite that adds a *column* rather than changing text, the
homebrew editor needs the matching field — see the `homebrew-column-sync` skill,
which is the permanent tool; this bundle is the temporary one.
