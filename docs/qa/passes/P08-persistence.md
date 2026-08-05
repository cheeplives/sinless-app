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

### P08-004: The import gate is one truthiness check
- **Type:** security
- **Check:** (this mirrors the real condition in `sheet.js`'s import handler)

      (() => { const accepts = v => (typeof v === "object" && v !== null && !Array.isArray(v) && !!v.attributes); return { emptyObject: accepts({}), justAttributes: accepts({attributes:{}}), attributesAsString: accepts({attributes:"yes"}), array: accepts([{attributes:{}}]), nul: accepts(null) }; })()

- **Expected:**

      { "emptyObject": false, "justAttributes": true,
        "attributesAsString": true, "array": false, "nul": false }

- **Note:** `{attributes: "yes"}` is accepted as a character. Nothing checks the
  shape of anything. This is JC-013 — mark **JUDGEMENT**.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P08-005: A minimal accepted object survives mergeDefaults into a usable character
- **Type:** correctness
- **Check:**

      (() => { const m = RULES.mergeDefaults({ attributes: { Strength: 3 }, name: "QA Minimal" }); const k = RULES.calculate(m); return { name: m.name, strength: k.attributes.Strength.final, hasPlay: "play" in m, heritageType: m.heritage.type, errors: k.errors }; })()

- **Expected:**

      { "name": "QA Minimal", "strength": 3, "hasPlay": true, "heritageType": "Human",
        "errors": ["Classic priorities: assign each letter A–E exactly once (no repeats).",
                   "Choose a lifestyle with at least 1 prepaid month."] }

- **Note:** Two errors, not the three `fresh-default.json` reports — because
  `mergeDefaults` fills an absent heritage with `"Human"`, while
  `defaultCharacter()` leaves `heritage.type` empty. The same character arrives
  in a different state depending on which door it came through. Worth a JC if
  there is not one already.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P08-006: Hand-edited advances bypass every cap
- **Type:** leak
- **Check:**

      (() => { const c = RULES.mergeDefaults({ attributes: { Strength: 4 }, name: "QA Cheater", finalized: true }); c.priorities={heritage:0,magic:1,attributes:2,skills:3,resources:4}; c.heritage.type="Human"; c.lifestyles=[{name:"Squatter",months:1}]; c.skills={Athletics:3}; c.play.skill_advances={Athletics:40}; c.play.attribute_advances={Strength:40}; const k = RULES.calculate(c); return { athletics: k.skills.Athletics.final, strength: k.attributes.Strength.final, strengthMax: k.attributes.Strength.max, errors: k.errors.length, warnings: k.warnings.length }; })()

- **Expected:** `{ "athletics": 43, "strength": 44, "strengthMax": 20, "errors": 0, "warnings": 0 }`
- **Note:** This is the full attack path in one expression: import a file, get
  arbitrary advances, and because the character is finalized nothing is ever
  reported. JC-013 combined with JC-012.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## The two play-shape definitions

### P08-007: ensurePlay() and defaultCharacter().play define different key sets
- **Type:** correctness
- **Check:**

      (() => { const fromDefault = Object.keys(RULES.defaultCharacter().play).sort(); const saved = CHAR; const probe = RULES.defaultCharacter(); probe.play = {}; CHAR = probe; ensurePlay(); const fromEnsure = Object.keys(CHAR.play).sort(); CHAR = saved; return { onlyInDefault: fromDefault.filter(k => !fromEnsure.includes(k)), onlyInEnsure: fromEnsure.filter(k => !fromDefault.includes(k)) }; })()

- **Expected:**

      { "onlyInDefault": ["dodge_dice","martial_art_advances","replicant_lifespan_months","ritual_advances"],
        "onlyInEnsure": ["armor_worn","bond_slots","images","infusion_spirits","pool_boost","pool_kismet"] }

- **Note:** Two sources of truth for the same object. Which keys a character has
  depends on whether it was created fresh or topped up on entry to the sheet.
  Neither list is a superset of the other. File a JC if there is not one already.
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

**P08-004, P08-006 and P08-007 are JUDGEMENT.** P08-003 is worth a close look:
silently deleting a corrupt save is defensible, but if you can make it happen
with a *valid* file, that is a FAIL and a data-loss bug.
