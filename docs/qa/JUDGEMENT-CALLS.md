# Judgement calls

Open questions about behaviour that is **defensible but undecided**. A test that
lands here is not a bug report — it is a request for a ruling from the owner.

Testers **append**; only the owner fills in `RULING`. Never resolve one of these
yourself, and never "fix" the code to match your guess.

## When to file one

File a JC when any of these is true:

- The code does something consistent and deliberate-looking, but whether it is
  *correct* depends on a rules decision nobody has written down.
- Two parts of the app disagree and neither is obviously wrong.
- A cap or limit exists as a warning in one place and an error in another.
- You cannot determine the intended behaviour from the code, comments or docs.

Do **not** file a JC for something that is plainly broken — a crash, a wrong sum,
a leak. That is a FAIL, and it goes in the findings file.

## Entry format

```markdown
## JC-0NN: <short title>
- **Status:** OPEN
- **Where:** <file:line>
- **Observed:** <what the code does today, 2-3 sentences>
- **Question:** <the single decision needed>
- **Options:** A) … B) … C) …
- **Raised by:** <test IDs>
- **RULING (owner only):** _
- **Follow-up on ruling:** <what changes once this is decided>
```

Number sequentially from the highest existing JC. Never reuse a number.

---

## JC-001: Skill specializations are free, uncapped and unprerequisited
- **Status:** OPEN
- **Where:** `static/app.js` (`tabStats`, the specialization inputs); `character.skill_specializations`
- **Observed:** A specialization is written straight onto the character and costs
  nothing. There is no point cost, no limit on how many skills may be
  specialized, and no check that the skill has any ranks. `weaponSpecAdjust()`
  then consumes it for a real ±1 dice swing.
- **Question:** Should specializations cost something, be capped in number, or
  require at least 1 rank in the parent skill?
- **Options:** A) Leave free and uncapped — they are a flavour split, not power.
  B) Require ≥1 rank in the skill. C) Cap the count (e.g. one per skill group).
  D) Charge a skill point.
- **Raised by:** P03
- **RULING (owner only):** _
- **Follow-up on ruling:** If anything other than (A), add validation in
  `rules.js` and a P03 case asserting it.

## JC-002: Rank and attribute caps warn but do not block
- **Status:** OPEN
- **Where:** `static/rules.js` — skill cap ~L1606, attribute max ~L1523
- **Observed:** Exceeding `SKILL_RANK_CAP` (6) or an attribute's maximum produces
  a *warning*. Warnings do not disable the Finalize button, so a character can be
  finalized above both caps. `maxed-mage.json` finalizes with Sorcery 7.
- **Question:** Are creation caps advisory or binding?
- **Options:** A) Keep as warnings — the GM adjudicates. B) Promote to errors so
  finalize is blocked. C) Keep as warnings but clamp the stepper so the state is
  unreachable through the UI.
- **Raised by:** P01, P03
- **RULING (owner only):** _
- **Follow-up on ruling:** (B) means moving the pushes from `warnings` to
  `errors`; several fixtures would need new profiles.

## JC-003: Deck / drone / vehicle limit breaches are finalizable
- **Status:** OPEN
- **Where:** `static/rules.js` — `checkVehicleLimits`, `checkDroneLimits`, deck and rig pricing
- **Observed:** Exceeding a rig's drone capacity, a vehicle's mod limits or a
  deck's slot count warns but does not block finalize.
- **Question:** Same as JC-002 but for equipment limits — advisory or binding?
- **Options:** A) Advisory. B) Binding. C) Binding only where the limit is
  physical (slots) and advisory where it is a guideline.
- **Raised by:** P05
- **RULING (owner only):** _
- **Follow-up on ruling:** —

## JC-004: Gear ZR counts unowned-state items inconsistently
- **Status:** OPEN
- **Where:** `static/rules.js` `gearZoeticRating` (~L2606)
- **Observed:** Weapons contribute only when `equipped`, armor only when
  `active` — but **decks, programs, drones and vehicles contribute
  unconditionally**, whether or not they are carried or in use.
- **Question:** Should ZR come from what you are *carrying* or from what you
  *own*?
- **Options:** A) Carried — filter decks/programs/drones/vehicles the way
  weapons and armor are filtered. B) Owned — remove the equipped/active filters
  so everything counts. C) Intentional as-is: some gear is always "on you".
- **Raised by:** P02
- **RULING (owner only):** _
- **Follow-up on ruling:** Under the `zr: houserule` setting this directly
  changes the spellcasting dice penalty, so any change needs a P02 re-run.

## JC-005: No rig ever contributes gear ZR during chargen
- **Status:** OPEN
- **Where:** `static/rules.js` `gearZoeticRating`; keyed on `play.rigging.active_rig`
- **Observed:** Rigs contribute ZR only when they are the *active* rig, and
  `active_rig` is `""` for the whole of character creation. A rig bought in
  chargen therefore contributes nothing until play begins.
- **Question:** Should a rig's ZR count during creation?
- **Options:** A) Yes — treat an owned rig as active during chargen. B) No —
  current behaviour is correct, ZR is about what is jacked in. C) Yes, and add a
  chargen-side active-rig selector.
- **Raised by:** P02
- **RULING (owner only):** _
- **Follow-up on ruling:** Interacts with JC-004; rule on both together.

## JC-006: Mounted augments combine with mixed add-vs-max semantics
- **Status:** OPEN
- **Where:** `static/rules.js` `mergeMountedAugments` (~L1382)
- **Observed:** When a gear-mounted augment duplicates a body one, attributes,
  move, recoil, impact and ballistic **add**, while dodge, melee-exploit,
  `ballistic_armor_max` and damage reduction take the **max**. Skill bonuses take
  the max but their notes concatenate.
- **Question:** Is the add/max split per stat intentional, and is it documented
  anywhere a player could find?
- **Options:** A) Intentional — document it. B) Should be uniform (all max).
  C) Should be uniform (all add).
- **Raised by:** P02
- **RULING (owner only):** _
- **Follow-up on ruling:** —

## JC-007: Duplicate items are never deduplicated
- **Status:** OPEN
- **Where:** `static/rules.js` `priceArmor` (~L2364) and the gear pricing generally
- **Observed:** The same armor row can be added twice and both copies count as
  `active`, summing their armor values. This only warns ("More than one X armor
  piece is active"). The same is true of duplicate gear, decks and programs.
- **Question:** Should identical duplicates stack, or should the engine collapse
  them?
- **Options:** A) Stack — the player is responsible. B) Collapse duplicates when
  computing armor. C) Promote the warning to an error.
- **Raised by:** P02, P05
- **RULING (owner only):** _
- **Follow-up on ruling:** —

## JC-008: Augment tier exclusivity is enforced only in the picker
- **Status:** OPEN
- **Where:** UI: `static/app.js` `augmentAvailability` / `NAMED_TIERS`. Engine: nothing.
- **Observed:** The picker hides lower tiers of an owned family (Bone Lacing,
  Wired Reflexes), but `rules.js` never re-checks. A character that acquires both
  tiers by import, homebrew or hand-edited JSON keeps both and gets both effects.
  `synthetic-augmented.json` demonstrates this and loads with zero complaints.
- **Question:** Should tier exclusivity be a rule the engine enforces, or a UI
  affordance only?
- **Options:** A) Engine rule — add an error. B) UI only — accept that imported
  characters can hold both. C) Engine warning rather than error.
- **Raised by:** P02, P08
- **RULING (owner only):** _
- **Follow-up on ruling:** (A) would make `synthetic-augmented.json` invalid; the
  fixture and its README profile would need updating.

## JC-009: Smartlink is matched by name only
- **Status:** OPEN
- **Where:** `static/rules.js` `priceWeapons` (~L2151)
- **Observed:** The +1 Accuracy for a smart weapon checks only that an augment
  named `Smartlink` appears in `character.augments`. It does not check whether
  that Smartlink is gear-mounted, on an uncarried host, or otherwise inactive.
- **Question:** Should an inactive or unmounted Smartlink still grant its bonus?
- **Options:** A) No — gate it the way mounted augments are gated elsewhere.
  B) Yes — an implanted Smartlink is always live. C) Depends on where it is
  installed; needs a rules decision first.
- **Raised by:** P02
- **RULING (owner only):** _
- **Follow-up on ruling:** —

## JC-010: Play-mode weapon and armor purchases land in the chargen arrays
- **Status:** OPEN
- **Where:** `static/sheet.js` `shGear` (weapon and armor buy paths)
- **Observed:** Gear, augments, amp powers, spells and hacking levels bought in
  play go into `CHAR.play.purchases.*`. **Weapons and armor do not** — they are
  pushed straight onto `CHAR.weapons` / `CHAR.armor`, the same arrays chargen
  uses. Going Back to Chargen therefore charges them against the creation cash
  budget, and `revertToChargenEnd()` does not remove them.
- **Question:** Should play purchases of weapons and armor be tracked separately
  like every other category?
- **Options:** A) Yes — move them into `play.purchases` for consistency.
  B) No — but then Back to Chargen must exclude them from the budget.
  C) Accept the leak; Back to Chargen is a rare escape hatch.
- **Raised by:** P06
- **RULING (owner only):** _
- **Follow-up on ruling:** This is the single most likely source of "my cash is
  wrong after going back to chargen" reports.

## JC-011: Cash purchases have no refund path
- **Status:** OPEN
- **Where:** `static/sheet.js` — `logCash` is append-only; item removal splices without crediting
- **Observed:** Kismet spends of kind `attribute`, `skill`, `martial_art`,
  `ritual` and `zp` all have working Undo. Cash purchases do not: removing a
  bought item deletes the row without refunding. The only exceptions are two
  Knowledge Skillsoft paths, which do credit back.
- **Question:** Should removing a play-mode purchase refund its cash?
- **Options:** A) Yes — mirror the kismet undo. B) No — cash spent is spent; add
  a manual adjustment instead. C) Yes, but only within the same session.
- **Raised by:** P06
- **RULING (owner only):** _
- **Follow-up on ruling:** Note the two Skillsoft paths already behave as (A),
  so today the app is internally inconsistent whichever way this is ruled.

## JC-012: Errors and warnings are blanked once finalized
- **Status:** OPEN
- **Where:** `static/rules.js` ~L3526
- **Observed:** `calculate` returns empty `errors` and `warnings` arrays whenever
  `finalized` is true. An illegal state introduced in play — Body Index over
  Body, cash overdrawn, martial rank above Unarmed — is therefore completely
  invisible. Only the inline `confirm()` prompts in the buy paths push back.
- **Question:** Should the play sheet surface validity problems?
- **Options:** A) Keep blanked — creation rules stop applying after finalize.
  B) Show a reduced set that still makes sense in play (cash, Body Index).
  C) Show everything but style it as advisory.
- **Raised by:** P06
- **RULING (owner only):** _
- **Follow-up on ruling:** This is why the fixtures README documents a
  `finalized = false` probe to see a finalized character's real validity.

## JC-013: Import validation is a single truthiness check, and advances are unclamped
- **Status:** OPEN
- **Where:** `static/sheet.js` (the import file input); `static/rules.js` `applyPlayAdvances`
- **Observed:** Character import accepts anything that parses as JSON, is a
  non-array object, and has a truthy `.attributes`. `applyPlayAdvances` then
  applies `skill_advances` / `attribute_advances` with no cap check — it only
  verifies the key exists. Ritual advances, spell force advances, purchases and
  `pool_kismet` are not key-checked at all.
- **Question:** How much should import trust a file?
- **Options:** A) Validate shape and clamp advances to the same caps the UI
  enforces. B) Trust the file — hand-editing is a feature for a local-first app.
  C) Trust it but surface a warning banner on an out-of-range character.
- **Raised by:** P08
- **RULING (owner only):** _
- **Follow-up on ruling:** Interacts with JC-012 — under (B) an invalid imported
  character is also silent, which is the worst combination.

## JC-014: Finalizing does not check name uniqueness
- **Status:** OPEN
- **Where:** `static/app.js` `finalizeCharacter`; `static/storage.js` `sanitizeName`
- **Observed:** Finalize requires a non-empty name and no errors, but does not
  check whether that name is already taken. Saving keys on the sanitised name, so
  finalizing under an existing name silently **overwrites** the other character.
  Note `"Ada Lovelace"` and `"Ada-Lovelace"` sanitise identically.
- **Question:** Should saving over an existing character require confirmation?
- **Options:** A) Yes — prompt on collision. B) Yes — auto-uniquify the way
  `uniqueCopyName` does for duplicates. C) No — overwriting is the expected
  behaviour of a save.
- **Raised by:** P05, P08
- **RULING (owner only):** _
- **Follow-up on ruling:** This is a silent data-loss path, so it likely
  outranks the other open items.

## JC-015: Read endpoints are not rate limited
- **Status:** OPEN
- **Where:** `api/lib.php` `rate_limit`; call sites in `api/*.php`
- **Observed:** Rate limiting covers `login`, `callback`, authenticated `write`
  and `admin`. Plain GETs — including the shared-character and homebrew
  galleries — are not limited, so an approved member can enumerate them freely.
- **Question:** Is unlimited read acceptable for a members-only instance?
- **Options:** A) Yes — every reader is an approved member already. B) Add a
  read bucket. C) Limit only the gallery endpoints.
- **Raised by:** P12
- **RULING (owner only):** _
- **Follow-up on ruling:** Low severity while signup is approval-gated.

## JC-016: Heritage priority error renders with a blank subject
- **Status:** OPEN
- **Where:** `static/rules.js` `resolvePriorities` (~L719)
- **Observed:** With no heritage chosen, the error reads
  `" requires a higher Heritage priority (available at priority 0: Human,
  Replicant)."` — leading space, no subject. `fresh-default.json` shows it.
  The message is only sensible once a heritage has actually been picked.
- **Question:** Should an unchosen heritage produce this error at all?
- **Options:** A) Suppress it while `heritage.type` is empty and rely on a
  "choose a heritage" error instead. B) Keep the check but name the subject
  ("No heritage chosen requires…" is still wrong — needs new wording).
  C) Cosmetic only; leave it.
- **Raised by:** P01 (found while authoring the fixtures)
- **RULING (owner only):** _
- **Follow-up on ruling:** Whatever is chosen, `fresh-default.json`'s documented
  3-error profile changes and its README entry needs updating.

## JC-017: Touch targets are far below any tablet guideline
- **Status:** OPEN
- **Where:** `static/style.css` — stepper and small-button sizing
- **Observed:** Measured identically at 834×1194, 1194×834 and 1024×1366: on the
  play Overview 47 of 65 visible buttons are under 32 px tall with a minimum of
  **11 px**; on the chargen Stats tab **107 of 108** are under 32 px. Controls
  are sized in fixed pixels and do not respond to viewport or pointer type. No
  horizontal overflow at any viewport, and no overlapping targets — the issue is
  purely size.
- **Question:** Should the app enlarge hit areas on touch devices?
- **Options:** A) Leave as-is — density is the point and tablet users can zoom.
  B) Add a `@media (pointer: coarse)` block enlarging stepper and icon-button hit
  areas without changing the desktop layout. C) Enlarge everywhere.
- **Raised by:** P13-004
- **RULING (owner only):** _
- **Follow-up on ruling:** (B) is the only option that does not change the
  desktop density the app was designed around.

## JC-018: Imported image URLs are not restricted to data:
- **Status:** OPEN
- **Where:** `static/sheet.js` — the images card sets `src` from `play.images[].url`
- **Observed:** Images added locally are re-encoded through a canvas and are
  always `data:` URLs. An **imported or shared** character's URLs are never
  re-validated, so an arbitrary string reaches `img@src`. A `javascript:` URL
  does not execute there, but an off-origin URL is fetched — disclosing the
  viewer's IP and that they opened that character. The deployed CSP
  (`img-src 'self' data:`) blocks it; a plain static host has no CSP.
- **Question:** Should imported image URLs be restricted?
- **Options:** A) Accept only `data:` on import, dropping anything else.
  B) Keep as-is and rely on CSP. C) Keep the URL but require confirmation before
  loading an off-origin image.
- **Raised by:** P11-004
- **RULING (owner only):** _
- **Follow-up on ruling:** (B) leaves GitHub Pages and local installs exposed,
  since neither serves the `.htaccess` CSP.

## JC-019: Two definitions of the play object disagree
- **Status:** OPEN
- **Where:** `RULES.defaultCharacter().play` vs `ensurePlay()` in `static/sheet.js`
- **Observed:** Neither key set is a superset of the other. Only in
  `defaultCharacter`: `dodge_dice`, `martial_art_advances`,
  `replicant_lifespan_months`, `ritual_advances`. Only in `ensurePlay`:
  `armor_worn`, `bond_slots`, `images`, `infusion_spirits`, `pool_boost`,
  `pool_kismet`. Which keys a character has depends on whether it was created
  fresh or topped up on entry to the sheet.
- **Question:** Should there be one definition?
- **Options:** A) Make `ensurePlay` merge `defaultCharacter().play` so there is a
  single source of truth. B) Keep both but document why they differ.
- **Raised by:** P08-007
- **RULING (owner only):** _
- **Follow-up on ruling:** Related: `mergeDefaults` fills an absent heritage with
  `"Human"` while `defaultCharacter()` leaves it empty (P08-005), so the same
  character differs by which door it came through.

## JC-020: A Mage with no school can take any spell
- **Status:** OPEN
- **Where:** `static/rules.js` — the school check is `if (row && school && …)`
- **Observed:** Choosing no school is only a warning, and with `school` empty the
  out-of-school check is skipped entirely. A schoolless Mage can therefore take
  spells from every school and still finalize.
- **Question:** Should a Mage be required to choose a school?
- **Options:** A) Promote the missing-school warning to an error. B) Treat an
  empty school as "no spells permitted". C) Leave it.
- **Raised by:** P04-004
- **RULING (owner only):** _
- **Follow-up on ruling:** —

## JC-021: Switching the priorities house rule rewrites the character
- **Status:** OPEN
- **Where:** `static/app.js` `tabPriorities` — auto-seeds a permutation on switch
- **Observed:** Changing from point-buy to classic silently overwrites
  `CHAR.priorities` with a valid permutation. The player's previous allocation is
  gone with no prompt and no undo.
- **Question:** Should the rewrite be confirmed first?
- **Options:** A) Prompt before rewriting. B) Keep the old values and let the
  resulting error guide the player. C) Leave as-is — the rewrite is a
  convenience.
- **Raised by:** P03-004
- **RULING (owner only):** _
- **Follow-up on ruling:** —

## JC-022: Homebrew rows get no schema validation and name collisions are silent
- **Status:** OPEN
- **Where:** `static/homebrew.js` `mergeCustomContent` / `HB_COLLISIONS`
- **Observed:** A homebrew weapon with almost no columns is accepted, costs 0,
  contributes 0 ZR, and raises nothing — missing numerics read as 0 via
  `asNumber`. Separately, a homebrew row whose name matches a core row is
  dropped by the first-writer-wins rule and recorded only in `HB_COLLISIONS`,
  which has no UI at all.
- **Question:** Should authoring mistakes be surfaced?
- **Options:** A) Validate required columns per table and warn in the editor.
  B) Surface `HB_COLLISIONS` in the homebrew UI. C) Both. D) Neither — homebrew
  is expert-only.
- **Raised by:** P09-003, P09-005
- **RULING (owner only):** _
- **Follow-up on ruling:** (B) is cheap and covers the more confusing of the two
  failure modes — content that simply never appears.

## JC-023: Spirit prose has unescapable characters
- **Status:** OPEN
- **Where:** `static/app.js` `splitSpiritEntries` / `parseSpiritServices`
- **Observed:** Entries split on a bare `|` with no escape, so a pipe can never
  appear in spirit prose. A colon within the first 40 characters is treated as a
  service label, so `"Meet at 10:00 sharp"` renders as a service named
  `"Meet at 10"` with body `"00 sharp"`. The shipped data trips neither today
  (P10-006, P10-009 both return empty).
- **Question:** Should the parsers be hardened, or the constraint documented?
- **Options:** A) Document the two forbidden shapes in `docs/DATA.md` and leave
  the parsers alone. B) Add escaping. C) Add a `check_data.py` rule that fails on
  either shape.
- **Raised by:** P10-002, P10-004
- **RULING (owner only):** _
- **Follow-up on ruling:** (C) makes the constraint enforceable at commit time,
  which is where the existing data conventions are already checked.
