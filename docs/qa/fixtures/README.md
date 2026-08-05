# Fixtures

Seven canonical characters the pass docs load instead of building state by hand.
Each is a complete character in the app's own save format. Load one per
[`P00 §4`](../passes/P00-setup.md).

Values below were observed from `RULES.calculate` at app commit `794d60a`. If a
fixture's profile no longer matches, that is either a real regression or a
deliberate rules change — check before "fixing" the fixture.

| File | What it is | errors / warnings |
|---|---|---|
| `fresh-default.json` | `RULES.defaultCharacter()` verbatim | **3 / 0** — invalid on purpose |
| `min-mundane.json` | Point-buy house rule, every budget at the floor, Human, Squatter ×1 | 0 / 0 |
| `maxed-mage.json` | Archmage at magic priority 4, spell at the Force cap, Sorcery deliberately at 7 | 0 / **1** |
| `synthetic-augmented.json` | Synthetic carrying **both** Bone Lacing tiers at once | 0 / 0 |
| `speaker-spirits.json` | Speaker, 2 relationships, 2 bond slots | 0 / 0 |
| `kitchen-sink-final.json` | **Finalized.** Every chargen tab populated, play state in use | 0 / 0 |
| `hostile-payloads.json` | **Finalized.** Inert XSS probes in every renderable string | 0 / 0 |

## Reading the error/warning counts

A finalized character always reports `0 / 0` — `rules.js` blanks both lists once
`finalized` is true. To see a finalized fixture's *real* validity, set
`finalized = false` before calculating:

```js
(() => { const c = RULES.mergeDefaults(JSON.parse(JSON.stringify(CHAR))); c.finalized = false; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()
```

Both finalized fixtures are genuinely valid under that probe, so they are safe
bases. If you need an *invalid* finalized character, build one in the test that
needs it rather than editing a fixture.

## Per-fixture notes

**`fresh-default.json`** — the only fixture that is invalid, and deliberately so:
a brand-new character has no valid priority spread, no heritage and no lifestyle.
Its three errors are the baseline "what a blank character complains about". Note
the second one currently renders with a blank subject (`" requires a higher
Heritage priority…"`) because no heritage is chosen — see JC-016.

**`min-mundane.json`** — the only fixture using the `point` priorities house
rule. Everything is at its floor with all 10 priority points unspent, so any
non-zero derived value on this character came from somewhere other than
character choices. Good for isolating heritage/augment contributions.

**`maxed-mage.json`** — exactly one warning, and it is the over-cap skill. Use it
to check that cap breaches warn rather than block: it finalizes successfully
despite Sorcery 7.

**`synthetic-augmented.json`** — holds `Bone Lacing-Plastic` **and**
`Bone Lacing-Titanium`. The picker UI hides lower tiers of an owned family, but
the engine never re-checks, so this loads with zero complaints. That is the
point. It also shows Synthetic zeroing `zoetics.augment_zr` (0) while
`zoetics.cyber_zr` still tracks the real 4.75.

**`kitchen-sink-final.json`** — the default base for play-mode passes. Carries a
kismet ledger entry with an `undo` descriptor of kind `attribute`, one attribute
advance and one skill advance, 4 physical and 2 stun damage, and an AP round
loaded in the rifle so ammo-modified stats are visible immediately.

**`hostile-payloads.json`** — never sanitised, never "fixed". Every string is
`"><img src=x onerror=window.__xss=1>`. `play.images[0].url` is a `javascript:`
URL and `[1]` is an off-origin URL, both of which reach `img@src` unvalidated on
an imported or shared character. It also carries `unknownField` and
`alsoUnknown` to prove undefined keys survive a save/load round trip.

## Regenerating

Fixtures are plain JSON and can be hand-edited, but keep them faithful to the
current `RULES.defaultCharacter()` shape. The reliable way to refresh the base
shape is to read it from the running app:

```js
JSON.stringify(RULES.defaultCharacter(), null, 2)
```

then re-apply each fixture's diff as described in the table above. Always
re-verify the errors/warnings profile afterwards.
