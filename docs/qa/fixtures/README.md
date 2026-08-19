# Fixtures

Ten canonical characters the pass docs load instead of building state by hand.
Each is a complete character in the app's own save format. Load one per
[`P00 §4`](../passes/P00-setup.md).

Values below were re-observed from `RULES.calculate` after the rulings in
[`../JUDGEMENT-CALLS.md`](../JUDGEMENT-CALLS.md) landed. If a fixture's profile
no longer matches, that is either a real regression or a deliberate rules change
— check before "fixing" the fixture.

Counts are for the character **unfinalized** (see the probe below), so the
finalized fixtures are described by their real validity rather than by what the
play sheet chooses to show.

| File | What it is | errors / warnings |
|---|---|---|
| `fresh-default.json` | `RULES.defaultCharacter()` verbatim | **3 / 0** — invalid on purpose |
| `min-mundane.json` | Point-buy house rule, every budget at the floor, Human, Squatter ×1 | 0 / 0 |
| `maxed-mage.json` | Archmage at magic priority 4, spell at the Force cap, Sorcery deliberately at 7 | 0 / **1** |
| `synthetic-augmented.json` | Synthetic carrying **both** Bone Lacing tiers at once | **1** / 0 — invalid since JC-008 |
| `speaker-spirits.json` | Speaker, 2 relationships, 2 bond slots | 0 / 0 |
| `decker-two-decks.json` | **Finalized.** Two decks, a Hacking program matched to each, one equipped | 0 / 0 |
| `rigger-drones.json` | **Finalized.** VCR + 2 drones + a vehicle, martial art, **`zr: houserule`** | 0 / 0 |
| `kitchen-sink-final.json` | **Finalized.** Every chargen tab populated, play state in use | 0 / 0 |
| `hostile-payloads.json` | **Finalized.** Inert XSS probes in every renderable string | 0 / 0 |
| `wildling-pools.json` | **Finalized.** Green Wildling + Adrenal Pump + three live doses | 0 / 0 |

### `wildling-pools.json` — what it's for

Added 2026-08-19. **No other fixture exercises a conditional pool effect at
all** — the other nine all return an empty `CALC.pool_effects`, which means the
whole switchable-effects path, including `setPoolEffect` and therefore the only
route to those switches, had no coverage. This one carries all three sources at
once.

| | |
|---|---|
| Heritage | **Green**, one Boon: **Wildling** (priority 4, the minimum Green allows) |
| Augment | **Adrenal Pump** — BI 5 against Body 6, ㄓ60,000 of a ㄓ250,000 budget |
| Doses carried | Cram ×4, Sixgun, Kamakazi ×2, ACTH |
| Doses **live** in play | 3 × Cram, Sixgun, Kamakazi — five entries, three names |
| Switched **on** | Adrenal Pump only. Wildling ships **off**, so both branches have a base |
| Damage | 3 physical, 2 stun — so the shift's `healOnShift` has something to heal |
| Base pools | Brawn 11 · Finesse 9 · Focus 7 · Resolve 8 |

The five enumerated effects and what each is worth:

| id | source | pools |
|---|---|---|
| `heritage:Wildling` | Heritage | Brawn +6, Finesse +6, Focus −3, Resolve −3 |
| `augment:Adrenal Pump` | Augment | Brawn +2, Finesse +2, Resolve +2 |
| `gear:Cram` | Gear (dose, max 4) | Focus +2 |
| `gear:Sixgun` | Gear (dose, max 1) | Focus +4 |
| `gear:Kamakazi` | Gear (dose, max 2) | Brawn +2, Finesse +2 |

Live pool totals, both ways, all observed:

| | Brawn | Finesse | Focus | Resolve |
|---|---|---|---|---|
| as shipped (Pump + doses) | 15 | 13 | 17 | 10 |
| shifted as well | **21** | **19** | **14** | **7** |

Four things make this fixture worth its weight, none of which any other fixture
can reach:

**Wildling is the only source of *negative* pool dice.** Focus and Resolve go
*down* on shifting, so this is the one character that can test the clamp in
`poolState`: spend 9 of Resolve's 10, shift, and it reads 7/7 with 0 remaining
while `play.pool_used.Resolve` is still 9 — shift back out and the 9 returns.
Dice a shift shrinks away are never written off.

**Cram at 3 of a 4 cap tests dose stacking on both sides of the cap.** The Focus
swing at 1/3/4/5/6 Crams is +6/+10/+12/+12/+12 (Sixgun's +4 included), so the
same fixture proves the multiply and the clamp.

**Sixgun's effect text has two clauses** — `+4d Focus Pool for 3 hours. If
addicted, instead -2d Focus Pool without it.` — which is the first-clause-wins
rule in `parsePoolDice`. A parser that netted them would read +2.

**The shift heals.** `healOnShift` rolls 1d6 against physical damage only, so
the 3 physical / 2 stun it ships with makes the roll observable and proves stun
is left alone.

Doses carry explicit `uid`s (`qa-dose-1-cram` …). That is not decoration:
`dismissDose` removes by uid, and a dose list written by hand without them used
to delete itself wholesale on the first click. See
[`../findings/2026-08-19-P06.md`](../findings/2026-08-19-P06.md) NEW-002.

ㄓ187,300 of the Resources-2 budget is deliberately unspent. The character owns
no weapons, armour, deck or drones — those are covered elsewhere, and the
headroom leaves room for play-mode purchase tests.

### `rigger-drones.json` — what it's for

Added 2026-08-05 alongside a coverage audit that found **six subsystems with no
fixture at all**: rigs, drones, vehicles, martial arts, ritual skills and Amp
powers. This one closes four of them, and is the **only fixture that isn't
`zr: classic`** — it runs the ZR Casting Penalty rule, so a two-engine sweep
finally has a second economy to diff against.

| | |
|---|---|
| Rig | Advanced VCR + Input Validation + Bonus Link (2 of 2 mod slots) |
| Effective rig stats | Bonus 4d, Hardening 2, **Links 3** (2 base + Bonus Link), Double core |
| Drones | Roto-Drone "Kestrel" — grenade launcher, Extended Magazine bound to weapon 0, Armor; Orb "Peeper" — Hardening |
| Vehicle | Battle Cycle + Armor |
| Linked in play | both the Roto-Drone and the Battle Cycle; the Roto-Drone carries 2 physical damage |
| Martial art | **Weirding Way 4** → dodge **+2** — the escalating-tier parser |
| Rigging exploit actions | **2** — `Advanced VCR (Double core)` |
| ZR | gear ZR 2, and ZP **5.8** — the house rule docking cyber ZR from ZP |
| Budget | 204,650 spent of 250,000 (Resources 2) |

Weirding Way is deliberate rather than flavourful: rank 4 is the tier that
*replaces* rank 1's bonus, so `dodge_bonus` of 2 is the one number that catches
the martial-art stat parser being switched between max and sum. It was switched
in both directions on the day this fixture was written, with nothing to catch it.

### `decker-two-decks.json` — what it's for

Added 2026-08-05, because **no other fixture owns a deck at all**. Every decking
rule — Hacking programs, thread capacity, deck mod slots, the equipped deck's
exploit actions — had zero fixture coverage, which is why two-engine sweeps kept
reporting "zero drift" through changes that rewrote the whole subsystem.

What it exercises, and the numbers to expect:

| | |
|---|---|
| Equipped deck | **Fujitsu Edge** (MCP 8, Triple core, 9 threads, 1 mod slot) |
| Carried but not equipped | MasterDeck (MCP 3) — proves the non-equipped deck is inert |
| Hacking programs | **Hacking 4** in the Edge (needs 4), **Hacking 1** in the MasterDeck (needs 1) |
| Deck mod | Range Extension, 1 of the Edge's 1 slot |
| Loaded in play | Analysis Locus 1, Crack Encryption 1 (both `I/O: Yes`, so 2 of 9 threads) |
| Owned but not loaded | Acid Burn 1 (`N/A`) and Vent Gas 1 (`No`) — always-on, no thread |
| Decking exploit actions | **3** — `Fujitsu Edge (Triple core)` |
| Gear ZR | **3** |
| Budget | 466,050 spent of 600,000 (Resources 3) |

The two Hacking programs are the point. Three mutations worth knowing, all
observed:

| Mutation | Result |
|---|---|
| `decks[1].hacking = "Hacking 1"` | warning — `Fujitsu Edge: Hacking 1 is under ½ MCP — needs rating 4 for MCP 8.` |
| `decks[1].hacking = ""` | error — `Fujitsu Edge: no Hacking program slotted — the deck will not run.` |
| `play.decking.active_deck = "MasterDeck"` | Decking exploits drop **3 → 1** (Single core) |

Note the third leaves **gear ZR at 3 either way** — both decks are ZR 1 and every
program here is ZR 0, so only the exploit count moves. That is correct, not a
bug: if you need a fixture where the equipped deck changes the ZR too, give one
of them a mod that carries ZR.

## Reading the error/warning counts

A finalized character reports only the **play-relevant** subset of its problems
(JC-012): augment conflicts and tiers, Body Index over Body, a martial art above
Unarmed Combat, an overdrawn `play.cash`, and what it currently has on. Creation
budgets stop being reported, so a finalized character that overspent its skill
points says nothing about it. To see a fixture's *full* validity, set
`finalized = false` before calculating:

```js
(() => { const c = RULES.mergeDefaults(JSON.parse(JSON.stringify(CHAR))); c.finalized = false; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings }; })()
```

Both finalized fixtures are genuinely valid under that probe, so they are safe
bases. If you need an *invalid* finalized character, build one in the test that
needs it rather than editing a fixture.

## Per-fixture notes

**`fresh-default.json`** — deliberately invalid: a brand-new character has no
valid priority spread, no heritage and no lifestyle. Its three errors are the
baseline "what a blank character complains about". Since JC-016 the heritage one
reads `"Choose a heritage (available at priority 0: Human, Replicant)."`; it
used to render with a blank subject.

**`min-mundane.json`** — the only fixture using the `point` priorities house
rule. Everything is at its floor with all 10 priority points unspent, so any
non-zero derived value on this character came from somewhere other than
character choices. Good for isolating heritage/augment contributions.

**`maxed-mage.json`** — exactly one warning, and it is the over-cap skill. Use it
to check that cap breaches warn rather than block: it finalizes successfully
despite Sorcery 7.

**`synthetic-augmented.json`** — holds `Bone Lacing-Plastic` **and**
`Bone Lacing-Titanium`. It reaches that state the only way left: by import,
bypassing the picker. Since JC-008 the engine re-checks tier exclusivity, so it
now raises exactly one error —

```
Bone Lacing: only one tier may be installed — remove all but one of Bone Lacing-Plastic, Bone Lacing-Titanium.
```

— which is what it is for: the fixture that proves the engine no longer takes
the picker's word for it. Deliberately **not** repaired. It also shows Synthetic
zeroing `zoetics.augment_zr` (0) while `zoetics.cyber_zr` still tracks the real
**5.25** — its four augments summed, with nothing absorbed. (This said 4.75
until 2026-08-05; that was a documentation error, not a behaviour change.)

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
