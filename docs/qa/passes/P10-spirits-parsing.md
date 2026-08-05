# P10 — Spirit text parsing

**Preconditions for every case:** P00 complete.
**Effort:** 30 min. **Fixture:** `speaker-spirits.json` for the render cases.

Spirit writeups are free-form prose parsed at render time by three helpers in
`app.js` — `splitSpiritEntries`, `parseSpiritServices` and `withForce` — plus
`infusionStatMods` in `rules.js`, which extracts mechanical effects from prose
with regexes.

Every one of these fails **silently**: a clause that matches no pattern is not
applied and not reported. This pass measures where the boundaries are, so the
data authors know what they must not write.

The conventions are documented in `docs/DATA.md` under `speaker_spirits`.

---

## Entry splitting

### P10-001: `" | "` separates multiple entries
- **Type:** correctness
- **Check:**

      splitSpiritEntries("Alpha: does a thing | Beta: does another")

- **Expected:** `["Alpha: does a thing", "Beta: does another"]`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P10-002: A pipe inside prose creates a spurious entry
- **Type:** correctness
- **Check:**

      splitSpiritEntries("Gains +2 | loses 1 when tired")

- **Expected:** `["Gains +2", "loses 1 when tired"]`
- **Note:** That was one sentence, and it became two list items. The split is on
  a bare `|` with no escaping — a pipe can never appear in spirit prose. Confirm
  `docs/DATA.md` says so; if it does not, that is a documentation gap worth
  recording.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Service labelling

### P10-003: `Name: text` splits into a labelled service
- **Type:** correctness
- **Check:**

      parseSpiritServices("Blessing: grants +2 Brawn")

- **Expected:** `[{ "name": "Blessing", "text": "grants +2 Brawn" }]`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P10-004: A colon inside the first 40 characters is mistaken for a label
- **Type:** correctness
- **Check:**

      parseSpiritServices("Meet at 10:00 sharp and the spirit appears")

- **Expected:** `[{ "name": "Meet at 10", "text": "00 sharp and the spirit appears" }]`
- **Note:** A time, a ratio, or any early colon silently becomes a service name
  and the text is truncated at it. The 40-character window is the only guard.
  This is a real mis-render with no error — record it as a **FAIL** if any
  shipped spirit text trips it, and as a documented limitation otherwise.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P10-005: Prose with no colon becomes an unnamed entry
- **Type:** correctness
- **Check:**

      parseSpiritServices("A very long descriptive sentence with no colon at all here")

- **Expected:** `[{ "name": "", "text": "A very long descriptive sentence with no colon at all here" }]`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P10-006: No shipped spirit text trips the colon trap
- **Type:** correctness
- **Check:**

      (() => { const bad = []; for (const s of DATA.tables.speaker_spirits) { for (const col of ["Bound Services", "Attacks", "Special"]) { for (const e of splitSpiritEntries(s[col] || "")) { const at = e.indexOf(":"); if (at > 0 && at <= 40 && /^\d+$/.test(e.slice(at + 1, at + 3))) bad.push({ spirit: s.Spirit, col, entry: e.slice(0, 60) }); } } } return bad; })()

- **Expected:** `[]`
- **Note:** This scans the real data for entries whose "label" is followed by
  digits — the `10:00` shape. A non-empty result names spirits that are
  currently rendering wrongly in the app.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Force substitution

### P10-007: `[F]` becomes the bond's Force
- **Type:** correctness
- **Check:**

      (() => withForce("Deals [F]d6 damage", 5).map(n => (typeof n === "string" ? n : n.textContent)).join(""))()

- **Expected:** `"Deals 5d6 damage"`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P10-008: An unset Force renders a placeholder, not a zero
- **Type:** correctness
- **Check:**

      (() => withForce("Deals [F]d6 damage", 0).map(n => (typeof n === "string" ? n : n.textContent)).join(""))()

- **Expected:** `"Deals Fd6 damage"`
- **Note:** `"Deals 0d6 damage"` would be a FAIL — it reads as a real value
  rather than "you have not set this yet".
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P10-009: No shipped spirit writes the literal word "Force"
- **Type:** correctness
- **Check:**

      (() => DATA.tables.speaker_spirits.filter(s => ["Bound Services","Attacks","Special","Firearm","Protection","Drone","Digital","Physical"].some(c => /\bForce\b/.test(String(s[c] || "")) && !/\[F\]/.test(String(s[c] || "")))).map(s => s.Spirit))()

- **Expected:** `[]`
- **Note:** A spirit that spells out "Force" instead of using `[F]` will never
  substitute the bond's actual value. Record any names returned.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Effect extraction

### P10-010: Unmatched infusion clauses are dropped without a message
- **Type:** leak
- **Steps:**
  1. Load `speaker-spirits.json`, enter play mode, and place a spirit in an
     infusion slot on the **Magic** tab.
- **Check:**

      (async () => { CHAR.finalized = true; ensurePlay(); CHAR.play.infusion_spirits = { Firearm: "Terra Factorem" }; await recalc(); return { resolved: CALC.infusions, mods: CALC.infusion_mods }; })()

- **Expected:** `resolved` names the spirit. Inspect `mods` for an `unapplied`
  collection — anything listed there is prose the regexes could not read and
  which therefore has **no mechanical effect**.
- **Note:** Record the contents of `unapplied` verbatim. That list is the real
  deliverable of this case: every entry is a spirit benefit a player believes
  they have and does not.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P10-011: A relationship naming an unknown spirit is silently ignored
- **Type:** leak
- **Check:**

      (() => { const c = RULES.defaultCharacter(); c.priorities = { heritage:1, magic:4, attributes:3, skills:2, resources:0 }; c.heritage.type = "Human"; c.magic.chosen_type = "Speaker"; c.speaker.relationships = ["Nonexistent Spirit"]; c.lifestyles = [{ name: "Squatter", months: 1 }]; const k = RULES.calculate(c); return { errors: k.errors, warnings: k.warnings, relationshipPoints: k.magic.relationship_pts }; })()

- **Expected:** `{ "errors": [], "warnings": [], "relationshipPoints": { "budget": 11, "spent": 0, "remaining": 11 } }`
- **Note:** The unknown spirit costs nothing and is never mentioned. A renamed
  spirit that `RENAMED_SPIRITS` does not cover would vanish from a character this
  way — silently, and only visible as a blank tile on the sheet.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

### P10-012: Spirits with no statblock are intentional, not broken
- **Type:** correctness
- **Check:**

      (() => DATA.tables.speaker_spirits.filter(s => !s["Statblock Of"] && !s.Condition && !s.Attacks).map(s => ({ spirit: s.Spirit, hasSpecial: !!s.Special })))()

- **Expected:** every entry returned has `hasSpecial: true` — a spirit with no
  stats must at least explain itself in `Special`.
- **Note:** `Miasma` and `Stormwing` are the known cases and both say so in
  `Special`. A spirit with neither stats nor `Special` renders an empty panel.
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED

---

## Wrapping up

**P10-002, P10-004, P10-010 and P10-011** document silent failures. Whether they
matter depends entirely on the shipped data, which is what P10-006, P10-009 and
P10-012 measure — those three are the cases that turn "this could break" into
"this is broken today". Run them even if you are short on time.
