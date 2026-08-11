# P14 — Markdown (Scabard) import

Restoring a character from an exported `.md`. Two paths share one destination:
the character generator, unfinalized, with everything owned as build items.

- **Exact** — the export ends with `<!-- sinless-restore v1 <base64> -->` holding
  the build. Present ⇒ nothing is guessed.
- **Prose** — no payload (a file exported before v184), so the dossier text is
  read back. Lossy by nature; the report says where.

Setup per [`P00`](P00-setup.md). The parser lives in `static/md-import.js` and is
coupled to `buildMarkdown()` (`sheet.js`) with nothing enforcing it — **P14-004 is
the canary**: it fails the day the export format changes.

## Harness

Round-trip helper used by 001-004. Paste once, then call per fixture.

```js
window.__roundTrip = async (fixtureUrl) => {
  const raw = await (await fetch(fixtureUrl, { cache: "reload" })).json();
  await openCharacter(RULES.mergeDefaults(raw));
  if (!CHAR.finalized) { CHAR.finalized = true; await recalc(); }
  const md = buildMarkdown().replace(/<!-- sinless-restore v1 [^>]*-->/, "");
  const srcAttr = Object.fromEntries(Object.entries(CALC.attributes).map(([k,v]) => [k, v.final]));
  const srcSkills = Object.fromEntries(Object.entries(CALC.skills).filter(([,s]) => s.final > 0).map(([k,s]) => [k, s.final]));
  const srcPools = Object.assign({}, CALC.pools);
  const owned = cat => [...(CHAR.play.kit?.[cat] ?? CHAR[cat] ?? []),
                        ...((CHAR.play.purchases||{})[cat] || [])].map(x => x.name || x);
  const hr = JSON.parse(JSON.stringify(CHAR.house_rules));
  const p = mdParseCharacter(md); const d = p.draft; d.house_rules = hr;
  RULES.calculate(JSON.parse(JSON.stringify(d)));
  mdSeedPriorities(d);
  mdDeriveBases(d, p.finals, p.skillFinals, p.report);
  mdInferChaPool(d, p.poolLine, p.report);
  mdInferPriorities(d, p.report);
  const after = mdVerifyFinals(d, p.finals, p.skillFinals, p.report);
  const res = {
    attrDiff: Object.entries(srcAttr).filter(([k,v]) => after.attributes[k].final !== v),
    skillDiff: Object.entries(srcSkills).filter(([k,v]) => (after.skills[k]||{}).final !== v),
    poolDiff: Object.entries(srcPools).filter(([k,v]) => after.pools[k] !== v),
    unparsed: p.report.unparsedLines, unmatched: p.report.unmatched,
    unknownSections: p.report.unknownSections,
    items: Object.fromEntries(["weapons","armor","gear","augments","decks","programs","rigs","drones","vehicles"]
      .map(c => [c, [owned(c).length, (d[c]||[]).length]])),
  };
  await recalc();   // MANDATORY: calculate() repoints the engine's house rules
  return res;
};
```

## Cases

| # | Case | Expected |
|---|---|---|
| P14-001 | Exact path: export `kitchen-sink-final`, read `mdReadPayload(md)` | every owned category deep-equals `kit ∪ purchases`, including `style`/`material`/`extras`, `alpha`, `quality`, `qty`, `link`, `min_str`; `finalized:false`; `play` has only `notes` |
| P14-002 | Payload size | markdown grows by < 15 KB; measured 7.1 KB base64 on Candor (11.6 KB file) |
| P14-003 | Prose round trip, per fixture | `attrDiff`, `skillDiff`, `poolDiff` all empty; item counts equal per category |
| P14-004 | Prose round trip, format canary | `unparsed`, `unknownSections` both `[]` for every fixture |
| P14-005 | Derived rows aren't duplicated | no `Cybergun — …`, no heritage-granted weapon in `draft.weapons`; `Heavy Torso`/`No Head` mount rows land in `heritage.*_mount(s)` instead |
| P14-006 | Skills granted rather than bought | a skill whose export rating comes from group fallback or a Skillsoft imports at **0 points**, reported as approximated |
| P14-007 | Priorities guess | legal, ≥ the minima the heritage and magic type imply; reported as a guess |
| P14-008 | Magic stays switched on | an Amp character's `Attribute Increase` still applies during derivation (seeded priorities), so attributes rebuild exactly |
| P14-009 | Clobber | original save untouched and still `finalized:true`; tabs +1; name suffixed `(imported)`, then `(imported 2)` |
| P14-010 | Cancel (either modal) | `RULES.houseRule(...)` and `DATA.skills` unchanged; no tab, no save |
| P14-011 | Notes impersonating sections | notes containing `## Weapons` + a plausible weapon row create no item; notes survive verbatim |
| P14-012 | Junk file | `# Shopping list` → alert naming the missing `## Skills`; no tab |
| P14-013 | Truncated export | parses what exists; if a Weapons section has rows but none carries `· Conceal `, reports "Every weapon" lost rather than importing none silently |
| P14-014 | Over-budget explained | an advanced character reports "This build comes out over budget … baked into them", matching the rail's error |

## Results — 2026-08-11 (v184)

All cases pass. `min-mundane`, `maxed-mage`, `speaker-spirits`, `synthetic-augmented`,
`kitchen-sink-final`, `fresh-default` and both real characters (Candor, Jimmy Chan)
round-trip with **zero** attribute, skill, pool or item differences and zero unparsed lines.

Two fixtures report unmatched names, and both are **stale fixture data, not import bugs** —
the names are absent from the data tables, which is exactly what the report exists to say:

- `decker-two-decks`, `rigger-drones` — armor `"Armor Jacket"` (table has `Leather jacket`,
  `Light armor jacket`); the app already prices it 0B/0I.
- `rigger-drones` — drone weapon `"Underbarrel mounted grenade launcher (40mm)"`
  (drone tables have `Grenade Launcher`).
