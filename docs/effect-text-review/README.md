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

**Status:** applied in full. `apply_review.py` has written all 592 approved
cells into `static/data.js`, `Lick` and `Rage` included (a separate, later
approval — see [REVIEW.md's Status section](REVIEW.md#status)). Nothing in this
pass's scope is still open; `check_originals.py` will now report every applied
row as a "mismatch" if run, and that's expected — it's comparing current
`data.js` against this document's historical Original, which is exactly what
changed. Two renames outside this pass's scope (`Name` column, needing a
`RENAMED_*` map) are the only thing standing between this bundle and
`git rm -r docs/effect-text-review`.

## What's here

| File | |
|---|---|
| `REVIEW.md` | the proposal — 684 cells, each original beside its replacement |
| `style-guide.md` | the canonical vocabulary the rewrites apply |
| `probe.py` | which `rules.js` parsers fire on which cell of `data.js` |
| `verify.py` | re-runs the probe over every *proposed* rewrite and diffs |
| `check_originals.py` | every Original still matches `static/data.js` |
| `apply_review.py` | writes Proposed cells into `static/data.js`, one row per line |
| `column_drift.py` | where prose and the structured column disagree |
| `column_echo.py` | where prose and the structured column agree — a number said twice |
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

Today that's three rows — `Lick` and `Rage` gain the pool toggle they've never
had, and `Create Darkenbeast` loses one it should never have granted (it was
landing on the caster instead of the summoned animal) — and nothing else:

```
684 rows across 22 tables, 591 reworded

change  decl  table       row                  parser hit
GAINED  yes   misc_gear   Lick                 pool Finesse+4
GAINED  yes   misc_gear   Rage                 pool Brawn+4
LOST    yes   spells      Create Darkenbeast   pool Brawn+3, Finesse+3, Resolve+3

No undeclared parser changes (3 declared).
```

That output is the whole claim of this pass: 681 of 684 rewrites are formatting,
demonstrated rather than asserted.

## The other one to run

```bash
python docs/effect-text-review/check_originals.py
```

The Original column is the review's factual record of what the data says today,
and everything rests on it — the Proposed text is judged against it, and
`verify.py` diffs parser hits between the two. An Original that drifts means the
document is reviewing something that doesn't exist, and a real behaviour change
can hide inside the mismatch.

It is easy to break by accident. A row whose Original and Proposed are identical
has the same text twice on one line, so a search-and-replace aimed at the
Proposed cell can land on the Original instead. That is exactly how the
Aztechnologies Dazzleray and Boosted Reflexes rows were corrupted, and how they
were found again. Run it after any bulk edit to the tables.

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

`column_echo.py` asks the opposite question: where do they agree so exactly that
the sentence is a *copy* of the column? Those are the rows the style guide wants
reworded to name the stat and let the column hold the value. By default it reads
the Proposed text out of `REVIEW.md`, since the originals are full of these and
removing them is the point of the pass; `--data` scans `static/data.js` instead.

It exists because two rows slipped the main sweep — `rig_mods` Bonus Link and
`heritage_features` Rat — and both for the same reason: that sweep worked from a
hand-written list of columns which nobody had added `Link` or `All` to. This one
takes the column names from the data, so it can't fall behind the schema.

`near_miss.py` separates two things that look alike:

- **near miss** — the column *is* wired to a parser and the row talks about that
  mechanic, but the phrasing misses by a hair. `Lick`'s `Increase Finesse by 4`
  needs a signed number. These are bugs a rewrite fixes for free.
- **not wired** — the phrasing is fine but nothing hands that column to that
  parser. Only a `rules.js` change fixes those. `Dorf` used to be the standing
  example: `misc_gear` was never passed to `removesWoundPenalty`
  (`rules.js:4987`), so no amount of rewording could turn on its wound
  immunity. That got a `rules.js` change (`liveDoseRows`, gated on the dose
  being *live* rather than merely carried) rather than staying a rewrite, and
  `WIRING` in `probe.py` was updated to match — a reminder that this
  transcription drifts the moment the code it describes changes, in either
  direction.

## Applying a row

```bash
python docs/effect-text-review/apply_review.py            # dry run — report only
python docs/effect-text-review/apply_review.py --apply    # write static/data.js
```

`data.js` is one JSON object per line and must stay that way, so `apply_review.py`
edits each row's own line with a targeted regex rather than re-serializing the
table — `git diff` shows exactly the cells that changed. It re-checks each
row's current text against the doc's Original immediately before writing (so a
stale review can't silently clobber a row someone else already changed), and
`--exclude table:Row,table:Row` holds specific rows back — used once already,
for `Lick` and `Rage`, whose rewrite is a declared **NEW BEHAVIOUR** and needed
a decision from the repo owner rather than a mechanical apply.

Run `verify.py` first regardless — `apply_review.py` trusts the doc's Notes
column exactly as much as `verify.py` already validated it, no more. After
applying, run `tools/check_data.py`: it catches things this bundle's own
scripts don't, such as a rewrite introducing a Unicode glyph (`—`, `≥`, `≤`)
outside `data.js`'s four sanctioned ones — which happened, in 20 cells, the
first time this ran.

If you accept a rewrite that adds a *column* rather than changing text, the
homebrew editor needs the matching field — see the `homebrew-column-sync` skill,
which is the permanent tool; this bundle is the temporary one.
