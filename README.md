# Sinless Character Dossier

A fully offline, client-side web app for building and running characters for
the Sinless RPG. It covers character generation (priorities, heritage,
attributes, skills, magic, gear) and an interactive play-mode sheet for use at
the table. No build step, no framework, no backend — it's static files plus a
service worker for offline use.

> This repository is the canonical source of truth for the app and its rules.
> An older Python/Flask version once served the same logic over HTTP; it is now
> out of date and is **not** the reference. Change behavior here.

## Running it

It's a static site — serve the repo root over HTTP (the service worker needs a
real origin, so opening `index.html` from `file://` won't fully work):

```sh
python -m http.server 8753
# then open http://localhost:8753
```

Any static file server works. The bundled `.claude/launch.json` uses the command
above.

## Architecture

The page (`index.html`) loads five scripts, in order:

| File | Role |
|------|------|
| `static/data.js` | All game data tables + rule constants, as the `DATA_BUNDLE` global. **Canonical, hand-maintained** (see below). |
| `static/rules.js` | The rules engine (`RULES`). Pure functions: character in, derived sheet out. The source of truth for all calculations. |
| `static/storage.js` | Character persistence (`STORAGE`) via `localStorage`, keyed by sanitized name. |
| `static/app.js` | Chargen UI. Builds the DOM directly via the `el()` helper (no innerHTML), mutates the in-memory `CHAR`, and re-derives `CALC` on each edit. |
| `static/sheet.js` | Interactive play-mode sheet, shown after a character is finalized. |

`sw.js` is the service worker: network-first for app code (freshest deploy wins
online), cache-first for immutable assets (fonts/icons). Bump `CACHE_VERSION`
in `sw.js` to force-drop old caches on deploy.

### Data flow

An input handler mutates `CHAR` → `scheduleRecalc()`/`refresh()` →
`RULES.calculate(CHAR)` returns `CALC` → the rail and active tab re-render from
`DATA`/`CHAR`/`CALC`. `CALC` is read-only and replaced wholesale each recalc.

## Editing game data

`static/data.js` is a single large JSON literal. It was originally generated
from a spreadsheet by a Python step, but that pipeline is out of date — the
tables here are now maintained by hand. To change a stat, feature, or price,
edit the relevant table entry directly in `static/data.js`. Keep the header
comment ASCII-only, and confirm the file still parses (it's plain JSON after the
`const DATA_BUNDLE =` prefix).

## Notes

- Entirely client-side: no accounts, no network calls, no secrets. Characters
  live in your browser's `localStorage`; use **Export JSON** to back one up.
- `rules.js` and `data.js` also load under Node (`require("./data.js")`), which
  is handy for scripting or testing the engine in isolation.
