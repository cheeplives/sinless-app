# QA conventions

Every pass doc in `docs/qa/passes/` follows the rules on this page. Read it once
per session; the pass docs do not repeat them.

## The three standing rules

1. **Never edit application code.** You are testing, not fixing. If you find a
   bug, record it — do not repair it.
2. **Every non-PASS result goes in a findings file.** A FAIL you only mention in
   chat is a FAIL that never happened.
3. **Never silently decide an ambiguity.** If a test's expected behaviour is
   genuinely unclear, or the code does something defensible that nobody has
   ruled on, file it in [`JUDGEMENT-CALLS.md`](JUDGEMENT-CALLS.md) and mark
   the result JUDGEMENT. Do not guess what the author intended.

## Test case format

Cases look exactly like this. Copy the shape; do not invent variations.

```markdown
### P06-014: Damage stays inside the track when max Body drops
- **Type:** leak
- **Fixture:** kitchen-sink-final.json (load per P00 §4)
- **Preconditions:** P00 complete; play mode
- **Steps:**
  1. Click the **Overview** tab.
  2. Click the 10th box of the Physical condition track.
- **Check** (paste into javascript_tool, exactly):
      CHAR.play.physical_damage
- **Expected:** `10`
- **Result:** [ ] PASS  [ ] FAIL  [ ] JUDGEMENT  [ ] BLOCKED
```

### Fields

| Field | Rules |
|---|---|
| Heading | `### <ID>: <one line saying what is being tested>` |
| **Type** | one of `correctness`, `leak`, `security`, `usability`, `judgement-probe` |
| **Fixture** | a filename from `docs/qa/fixtures/`, or `none` |
| **Preconditions** | always starts `P00 complete`; then the mode and any setup |
| **Steps** | numbered, literal, physical actions. "Set the Strength stepper to 6 by clicking **+** three times" — never "configure attributes" |
| **Check** | exactly ONE JavaScript expression, pasted into `javascript_tool` unmodified, returning something JSON-serializable |
| **Expected** | one literal value, in backticks |
| **Result** | the four checkboxes, verbatim |

Some cases need no UI interaction at all — engine cases are usually just a Check.
Some need no Check — a usability case may be a visual judgement. Both are fine;
omit the field that does not apply rather than padding it.

### ID scheme

`P<doc number>-<three digits>`, e.g. `P01-007`, `P13-002`. IDs are permanent. If
a case is withdrawn, leave the heading in place and mark it `RETIRED` rather than
renumbering — old findings files reference these IDs by number.

## Result states

| State | Means |
|---|---|
| **PASS** | The Check returned exactly the Expected value. |
| **FAIL** | It did not. Record the actual output verbatim. |
| **JUDGEMENT** | The code behaves as the doc describes, but whether that is *right* is an open question — or you could not determine the intended behaviour. File a JC entry. |
| **BLOCKED** | You could not execute the case: a tool failed, a prerequisite was missing, no deployed host. Say why. Never guess a result. |

"Close enough" is a FAIL. `"5"` is not `5`; `[1,2]` is not `[2,1]` unless the
Expected says order does not matter. If an Expected value looks wrong to you,
that itself is a JUDGEMENT — the doc may have baked in a bug.

## Findings file

One file per pass doc per session:

```
docs/qa/findings/YYYY-MM-DD-P<NN>[-<tag>].md
```

The `-<tag>` suffix is optional and only needed if the same pass is run twice in
one day (use `-b`, `-c`, or a runner name). Files are **append-only** — never
edit a previous session's file, even to correct it. Write a new one.

Header and body:

```markdown
# P06 — finalize / play boundary
- **Date:** 2026-08-04
- **Pass doc commit:** a3f55e1
- **App commit:** 794d60a
- **Environment:** in-app browser, python http.server 8753
- **Viewport:** 1280x800 (omit unless the pass is viewport-sensitive)

Executed: 22 · PASS: 19 · FAIL: 2 · JUDGEMENT: 1 · BLOCKED: 0

### P06-004 — FAIL
Expected `0`, got:

    -3

### P06-011 — FAIL
Expected `[]`, got:

    ["Cash overspent by ㄓ1,200."]

### P06-017 — JUDGEMENT → JC-011
Behaves as documented. Filed because removing a bought item does not refund
cash, and nobody has ruled on whether that is intended.
```

Only non-PASS results get a block. PASSes are counted in the summary line and
nothing more — that is what keeps these files short enough to aggregate. To
sweep every failure across every session:

```bash
grep -rn "FAIL$" docs/qa/findings/
```

Get both commit hashes with:

```bash
git log -1 --format=%h
```

(The pass-doc commit and app commit are the same hash unless you are running an
older copy of the suite against newer code.)

## Writing a Check that a weak model can run

- **One expression.** No `let`, no multi-statement bodies unless wrapped in an
  IIFE that returns a value.
- **Return data, not a boolean.** `CALC.errors.length` beats
  `CALC.errors.length === 0` — when it fails you learn the real number instead
  of just `false`.
- **Sort anything unordered.** `Object.keys(x).sort()`, not `Object.keys(x)`.
- **Never depend on a screenshot.** Screenshots time out intermittently on this
  app. Read the DOM with `javascript_tool` or `read_page` instead.
- **Await recalculation.** After changing `CHAR`, the derived `CALC` is stale
  until `await recalc()`. Wrap in
  `(async () => { ...; await recalc(); return ...; })()`.
