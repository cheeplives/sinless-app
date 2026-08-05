# P08 — Persistence, import and export

**Preconditions for every case:** P00 complete, including the dialog stubs.
**Effort:** 45 min. **Fixtures:** `kitchen-sink-final.json`, `hostile-payloads.json`.

Characters are stored as raw JSON under `sinless:char:<sanitised name>` with **no
version or schema field**. Migration is by shape inspection inside
`mergeDefaults()`, and import validation is a single truthiness check. This pass
establishes what actually survives a round trip and what an untrusted file can
put into the app.

Nothing here should destroy real data — every case works on `QA-` keys. Do not
run `localStorage.clear()`.

---

## Round trip

### P08-001: Save and reload preserves the character exactly
- **Type:** correctness
- **Steps:**
  1. Load `kitchen-sink-final.json` per P00 §4.
- **Check:**

      (() => { const before = JSON.stringify(CHAR); STORAGE.cacheCharacter(CHAR); const after = JSON.stringify(STORAGE.loadCharacter(CHAR.name)); return { identical: before === after, bytes: before.length }; })()

- **Expected:** `{ "identical": true, "bytes": <any number> }`
- **Note:** Record the byte count in your findings even on a PASS — a sudden
  change in size between runs is a useful signal.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P08-002: Keys the schema does not define survive the round trip
- **Type:** correctness
- **Steps:**
  1. Load `hostile-payloads.json` per P00 §4.
- **Check:**

      (() => { STORAGE.cacheCharacter(CHAR); const back = RULES.mergeDefaults(STORAGE.loadCharacter(CHAR.name)); return { unknownField: back.unknownField, alsoUnknown: back.alsoUnknown, gotDefaults: "house_rules" in back && "play" in back }; })()

- **Expected:**

      { "unknownField": "\"><img src=x onerror=window.__xss=1>",
        "alsoUnknown": { "nested": "\"><img src=x onerror=window.__xss=1>" },
        "gotDefaults": true }

- **Note:** `mergeDefaults` fills in missing defaults but never strips unknown
  keys. Anything an import puts on a character stays there permanently.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P08-003: A corrupt entry is deleted rather than surfaced
- **Type:** correctness
- **Check:**

      (() => { localStorage.setItem("sinless:char:QA-Corrupt", "{not json"); const loaded = STORAGE.loadCharacter("QA Corrupt"); const stillThere = localStorage.getItem("sinless:char:QA-Corrupt") !== null; return { loaded, stillThere }; })()

- **Expected:** `{ "loaded": null, "stillThere": false }`
- **Note:** A half-written or hand-mangled save is silently dropped, not
  reported. The character is simply gone next time you look for it.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## What import accepts

### P08-004: The import gate checks the shape and names what's wrong
- **Type:** security
- **Check:** (`sheet.js`'s import handler calls exactly this)

      (() => { const v = RULES.validateCharacterShape; return { emptyObject: v({}).ok, justAttributes: v({attributes:{}}).ok, attributesAsString: v({attributes:"yes"}).problems, array: v([{attributes:{}}]).ok, nul: v(null).ok, weaponsString: v({attributes:{}, weapons:"sword"}).problems, badNumber: v({attributes:{Body:"x"}}).problems }; })()

- **Expected:**

      { "emptyObject": false, "justAttributes": true, "array": false, "nul": false,
        "attributesAsString": ["`attributes` is missing or not an object"],
        "weaponsString": ["`weapons` is not a list"],
        "badNumber": ["non-numeric attribute(s): Body"] }

- **Note:** JC-013, ruled **A**. The gate used to be `typeof v === "object" &&
  !Array.isArray(v) && !!v.attributes`, so `{attributes: "yes"}` was a character
  and `weapons: "sword"` got all the way to a render before failing somewhere
  unhelpful. It checks object-vs-list per key, numeric attributes, and
  `magic.spells` / `magic.amp_powers`, and returns **every** problem so the
  message can say what's wrong. `justAttributes` is still `true` on purpose: this
  is a shape check, not a rules check. An out-of-range character imports fine and
  is then told so by the normal errors — hand-editing a save is supported; being
  handed a file that isn't a character isn't.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P08-005: A minimal accepted object survives mergeDefaults into a usable character
- **Type:** correctness
- **Check:**

      (() => { const m = RULES.mergeDefaults({ attributes: { Strength: 3 }, name: "QA Minimal" }); const k = RULES.calculate(m); return { name: m.name, strength: k.attributes.Strength.final, hasPlay: "play" in m, heritageType: m.heritage.type, errors: k.errors }; })()

- **Expected:**

      { "name": "QA Minimal", "strength": 3, "hasPlay": true, "heritageType": "Human",
        "errors": ["Classic priorities: assign each letter A–E exactly once (no repeats).",
                   "Choose a lifestyle with at least 1 prepaid month."] }

- **Note:** Two errors, not the three `fresh-default.json` reports, and the
  reason turned out to be narrower than it first looked. `defaultCharacter()`
  sets `heritage.type: "Human"` and `mergeDefaults` fills an **absent** heritage
  from that same default, so the two agree. What differs is *empty* versus
  *absent*: `fresh-default.json` stores `"type": ""` explicitly, and
  `mergeDefaults` leaves a present key alone. Since JC-016 that difference is
  visible rather than silent — the fixture's third error reads `"Choose a
  heritage…"`. Recorded in the JC-019 follow-up.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P08-006: Hand-edited advances are clamped, not believed
- **Type:** correctness
- **Check:**

      (() => { const c = RULES.mergeDefaults({ attributes: { Strength: 4 }, name: "QA Cheater", finalized: true }); c.priorities={heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.skills={Athletics:3}; c.play.skill_advances={Athletics:40}; c.play.attribute_advances={Strength:40}; const k = RULES.calculate(c); return { athletics: k.skills.Athletics.final, strength: k.attributes.Strength.final, strengthMax: k.attributes.Strength.max, errors: k.errors, warnings: k.warnings }; })()

- **Expected:** `{ "athletics": 8, "strength": 29, "strengthMax": 20, "errors": [], "warnings": [] }`
- **Note:** This used to be the full attack path in one expression: import a
  file, get `Athletics: 43` and `Strength: 44`, and because the character is
  finalized never hear about it. JC-013 closed the first half — advances now
  clamp to the caps the Kismet buttons enforce. The second half stands by
  ruling: Strength 29 is still over its maximum of 20 and says nothing, because
  attribute maxima are creation warnings (JC-002) and JC-012 deliberately keeps
  creation rules out of the play set. What *would* show up here is an illegal
  implant or an overdrawn wallet — see P06-001b.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## The two play-shape definitions

### P08-007: ensurePlay() is a superset of defaultCharacter().play
- **Type:** correctness
- **Check:**

      (() => { const fromDefault = Object.keys(RULES.defaultCharacter().play).sort(); const saved = CHAR; const probe = RULES.defaultCharacter(); probe.play = {}; CHAR = probe; ensurePlay(); const fromEnsure = Object.keys(CHAR.play).sort(); CHAR = saved; return { onlyInDefault: fromDefault.filter(k => !fromEnsure.includes(k)), onlyInEnsure: fromEnsure.filter(k => !fromDefault.includes(k)) }; })()

- **Expected:**

      { "onlyInDefault": [],
        "onlyInEnsure": ["armor_worn","bond_slots","images","infusion_spirits","pool_boost","pool_kismet"] }

- **Note:** JC-019, ruled **A**. `onlyInDefault` being **empty** is the whole
  case: `ensurePlay` spreads `RULES.defaultCharacter().play`, so there is one
  definition of the shape and a character created fresh carries the same keys as
  one topped up on entry to the sheet. It used to also list `dodge_dice`,
  `martial_art_advances`, `replicant_lifespan_months` and `ritual_advances`.
  `onlyInEnsure` is expected to stay non-empty — those six are play-sheet fields
  the engine has no opinion about, and each is commented in `ensurePlay` saying
  so. A key appearing in `onlyInDefault` again means the spread was dropped.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Storage hygiene

### P08-008: Nothing secret is kept in localStorage
- **Type:** security
- **Check:**

      (() => { const keys = Object.keys(localStorage).filter(k => k.startsWith("sinless:")); const suspicious = keys.filter(k => /token|secret|password|csrf/i.test(k + String(localStorage.getItem(k)).slice(0, 400))); return { keyCount: keys.length, nonCharKeys: keys.filter(k => !k.includes(":char:")).sort(), suspicious }; })()

- **Expected:** `suspicious` is `[]`. `nonCharKeys` should contain only
  `sinless:theme`, `sinless:scheme`, `sinless:workspace`, and — if a server
  backend is present — `sinless:session`, `sinless:stamps`, `sinless:syncqueue`,
  `sinless:homebrew:packs`, `sinless:homebrew:subs`.
- **Note:** The CSRF token is held in memory only and the session is an HttpOnly
  cookie; neither should ever appear here. `sinless:session` caching
  `{id,name,email,is_admin}` is expected — flag it only if it holds more.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P08-009: Save keys are namespaced per user
- **Type:** security
- **Check:**

      (() => ({ prefix: (typeof SYNC !== "undefined" && SYNC.userPrefix) ? SYNC.userPrefix() : "(no SYNC)", sample: Object.keys(localStorage).filter(k => k.startsWith("sinless:")).slice(0, 3).sort() }))()

- **Expected:** on a local install with no backend, `prefix` is `"sinless:"`.
  Signed in, it is `"sinless:u<id>:"` and character keys carry that prefix.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Clean up

```js
(() => { const gone = Object.keys(localStorage).filter(k => k.startsWith("sinless:char:QA-")); gone.forEach(k => localStorage.removeItem(k)); return gone; })()
```

## Wrapping up

Every case should PASS. P08-004, P08-006 and P08-007 used to be JUDGEMENT;
JC-013 and JC-019 were ruled on and all three are now correctness cases.
P08-003 is worth a close look:
silently deleting a corrupt save is defensible, but if you can make it happen
with a *valid* file, that is a FAIL and a data-loss bug.
