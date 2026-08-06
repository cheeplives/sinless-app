# Sinless QA suite

A reusable regression suite for the character generator and character sheet,
written to be executed by a small model with no prior context. Each pass doc is
sized for one session and is self-contained: literal steps, one-expression
checks, and one literal expected value per check.

There is no automated test suite in this repo and this is not one. It is a set of
procedures a person or an agent follows in a browser, plus a place to record what
they found.

## Start here

1. Read [`TEMPLATE.md`](TEMPLATE.md) — the case format, the four result states,
   and the findings file. Once per session is enough.
2. Run [`passes/P00-setup.md`](passes/P00-setup.md) — serve the app, clear the
   service worker, stub the dialogs, load a fixture.
3. Pick a pass from the table below and work through it top to bottom.
4. Record every non-PASS in `findings/`, and every ambiguity in
   [`JUDGEMENT-CALLS.md`](JUDGEMENT-CALLS.md).

## The three standing rules

1. **Never edit application code.** You are testing, not fixing.
2. **Every non-PASS goes in a findings file.** A result mentioned only in chat
   did not happen.
3. **Never silently resolve an ambiguity.** File it in `JUDGEMENT-CALLS.md` and
   mark the result JUDGEMENT. Guessing the author's intent is the one failure
   mode this suite exists to prevent.

## The passes

Run in this order when doing a full sweep. Engine passes come first because they
are the cheapest and catch the most; the boundary passes come next because a bug
there invalidates everything downstream.

| # | Pass | Covers | Effort |
|---|---|---|---|
| — | [P00](passes/P00-setup.md) | Session setup. **Always first.** | 10–15 min |
| 1 | [P01](passes/P01-engine-core.md) | Budgets, validation, derived stats, the error/warning split | 45–60 min |
| 2 | [P02](passes/P02-engine-gear.md) | Gear, augments, ammo — the data-apply leaks | 45–60 min |
| 3 | [P06](passes/P06-finalize-play.md) | The chargen↔play boundary, kismet, condition tracks | 60–75 min |
| 4 | [P07](passes/P07-workspace-leaks.md) | Cross-character contamination via module state | 45 min |
| 5 | [P08](passes/P08-persistence.md) | Save, load, import, export, storage hygiene | 45 min |
| 6 | [P03](passes/P03-chargen-priorities-stats.md) | Priorities, heritage, stats, knowledge | 60 min |
| 7 | [P04](passes/P04-chargen-magic-augments.md) | Magic, speaker, augments | 60 min |
| 8 | [P05](passes/P05-chargen-gear-finalize.md) | Weapons, decks, drones, gear, the finalize gate | 60 min |
| 9 | [P09](passes/P09-homebrew.md) | Homebrew packs and custom content | 45 min |
| 10 | [P10](passes/P10-spirits-parsing.md) | Spirit prose parsing | 30 min |
| 11 | [P11](passes/P11-security-client.md) | XSS, storage, service worker, prototype pollution | 45 min |
| 12 | [P12](passes/P12-security-server.md) | **Checklist only — do not run unprompted** | 20 min |
| 13 | [P13](passes/P13-responsive.md) | Tablet and desktop readability at five viewports | 45–60 min |

Roughly 9–11 hours for a complete sweep across about 14 sessions. Passes 6–10 are
independent of each other and can be run in any order or in parallel sessions.

**P12 is different.** It targets the live deployed site and must not be run
unless the owner asks for it in that session. Reaching it by working down this
list is not authorisation — mark it BLOCKED and move on.

## Environment

This machine has **no Node, PHP or MySQL**. The app is a static PWA with no build
step, so none are needed:

```bash
"$LOCALAPPDATA/Programs/Python/Python314/python.exe" -m http.server 8753 --directory /c/Users/cheep/Claude/sinless-app
```

Drive it with the in-app browser tools. `javascript_tool` and `read_page` are the
workhorses; **screenshots time out intermittently on this app** and no pass
requires one.

`rules.js` also exports itself under Node (`module.exports = RULES`), so an agent
with Node available can run the P01 and P02 checks headlessly instead —
`require("./static/data.js"); require("./static/rules.js")`. The checks are
written to give identical results either way.

## Fixtures

Eight canonical characters in [`fixtures/`](fixtures/), described in
[`fixtures/README.md`](fixtures/README.md) along with the error/warning profile
each one should produce. Load them through the app's own code path — never by
writing localStorage directly.

**A two-engine sweep is only as good as its fixtures.** `decker-two-decks.json`
was added on 2026-08-05 after three separate changes to the decking rules all
reported "zero drift across all seven fixtures" — true, and meaningless, because
not one of them owned a deck. When you change a subsystem, check that some
fixture actually exercises it before trusting a clean diff.

`hostile-payloads.json` contains inert XSS probes. It is safe to load and is
meant to be loaded, but do not publish or share it.

## Findings

One file per pass per session in [`findings/`](findings/), named
`YYYY-MM-DD-P<NN>.md`, append-only. Only non-PASS results get written up;
passes are counted in a summary line. Sweep everything with:

```bash
grep -rn "FAIL$" docs/qa/findings/
```

## Judgement calls

[`JUDGEMENT-CALLS.md`](JUDGEMENT-CALLS.md) holds behaviour that is defensible but
undecided. Testers append; only the owner fills in a ruling. It is the one file
here that is live state rather than a point-in-time record.

**JC-001 … JC-025 are all ruled on and implemented.** Around a third of this
suite's cases were judgement-probes for them and are now correctness cases for
the ruled behaviour — a run that still finds the *old* behaviour is a regression,
not a rediscovery.

Four are ruled *no change*, and the entries record why so a run doesn't
re-litigate them: JC-008's picker half, JC-015, JC-018 and JC-025. **JC-018** is
the one to keep in view: the owner accepted relying on the CSP for imported
image URLs but asked for a second look, so keep recording what P11-004 shows.

## Keeping the suite honest

Every expected value in these docs was observed from the running app, not
predicted — first at commit `794d60a`, then re-observed for the cases the
JC-001…023 rulings changed. When the app changes deliberately, the expected
values change with it — update the doc in the same commit as the behaviour, and
say so in the commit message. A pass doc that disagrees with intended behaviour is worse
than no pass doc, because it trains the next runner to ignore failures.
