# P00 — Session setup

**Run this first, every session.** Every other pass doc's Preconditions line says
only "P00 complete" and assumes everything below is done.

Read [`../TEMPLATE.md`](../TEMPLATE.md) once before your first pass. It defines
the test-case format, the four result states, and the findings file.

This doc has no test cases and produces no findings of its own. If a step here
fails, stop and report it — do not proceed into a pass with a broken harness.

---

## 1. Serve the app

The app is a static PWA with no build step. There is **no Node, PHP or MySQL on
this machine** — do not try `npm`, `node` or `php`.

Bash tool:

```bash
"$LOCALAPPDATA/Programs/Python/Python314/python.exe" -m http.server 8753 --directory /c/Users/cheep/Claude/sinless-app
```

PowerShell tool:

```powershell
& "$env:LOCALAPPDATA\Programs\Python\Python314\python.exe" -m http.server 8753 --directory C:\Users\cheep\Claude\sinless-app
```

Run it in the **background** (`run_in_background: true`). The Bash tool's working
directory resets between calls, so always pass `--directory` rather than `cd`.

## 2. Open the app and clear the cache

Open the browser pane:

- `preview_start` with `url: "http://localhost:8753/index.html"`

Then **always** clear the service worker and its caches before your first
assertion. The SW is network-first for app code but the disk cache is aggressive,
and a stale `data.js` will make correct code look broken:

```js
(async () => { if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map(r => r.unregister())); } const keys = await caches.keys(); await Promise.all(keys.map(k => caches.delete(k))); return { unregistered: true, cleared: keys }; })()
```

Then navigate with a fresh query string and `force: true`:

- `navigate` with `url: "http://localhost:8753/index.html?v=<anything-new>"`, `force: true`

**Expected:** the page shows the character generator (or the play sheet, if a
character was left finalized). If you see a login screen, stop — the app thinks a
server backend is present, which it should not be on localhost.

## 3. Stub the modal dialogs

`confirm()` and `alert()` block the automation. Stub them **before** any test
that buys, deletes, finalizes or reverts:

```js
(() => { window.__alerts = []; window.confirm = () => true; window.alert = m => { window.__alerts.push(String(m)); }; return "stubbed"; })()
```

Stubbing `confirm` to `true` means every "are you sure?" is answered **yes**.
Alerts are captured in `window.__alerts` rather than discarded — several tests
assert on the message text, so read that array instead of expecting a popup.

Re-run this after every page navigation; a reload throws the stubs away.

## 4. Load a fixture

Fixtures live in [`../fixtures/`](../fixtures/) and are described in
[`../fixtures/README.md`](../fixtures/README.md). Load one through the app's own
code path — this is the canonical snippet, used by every pass doc:

```js
(async () => { const raw = await (await fetch("docs/qa/fixtures/FIXTURE.json", { cache: "reload" })).json(); await openCharacter(RULES.mergeDefaults(raw)); return { name: CHAR.name, errors: CALC.errors.length, warnings: CALC.warnings.length }; })()
```

Replace `FIXTURE` with the filename stem. `{ cache: "reload" }` is required —
without it the service worker will keep serving an old copy of a fixture you have
edited.

**Verify it worked** before running the pass: the returned `name` must match the
fixture, and `errors`/`warnings` must match the profile in the fixtures README.
If they do not, you are testing the wrong state.

## 5. Switch between chargen and play mode

Fixtures are saved in whichever mode they were built. To move:

**Into play mode:**

```js
(async () => { CHAR.finalized = true; await recalc(); showActiveTab(); return { finalized: CHAR.finalized, sheetHidden: document.getElementById("sheet").hidden }; })()
```

**Back to chargen:**

```js
(async () => { CHAR.finalized = false; await recalc(); showActiveTab(); return { finalized: CHAR.finalized, appHidden: document.getElementById("app").hidden }; })()
```

`showActiveTab()` is the app's own switcher — it hides and shows the right
container, calls `ensurePlay()` and seeds lifestyles on the way into play, and
re-renders. Use it rather than touching the containers yourself.

**Never set `style.display` on `#app` or `#sheet`.** The app toggles them with
the `hidden` *attribute*; an inline `display` style overrides that permanently
and leaves both panes invisible with no error. If you end up with a blank page,
that is almost certainly the cause — reload and use `showActiveTab()`.

Setting `finalized` directly **bypasses** the finalize gate. That is what you
want for setup, but it means you are not testing `finalizeCharacter()` — P05 and
P06 exercise the real button.

**Selecting a tab:** chargen tabs are `activeTab` + `renderPanel()`; play tabs
are `sheetTab` + `renderSheet()`. Valid values:

- chargen: `priorities`, `heritage`, `stats`, `knowledge`, `magic`, `speaker`,
  `augments`, `weapons`, `decks`, `drones`, `gear`
- play: `overview`, `skills`, `kismet`, `gear`, `augments`, `magic`, `decking`,
  `rigging`, `actions`, `notes`

```js
(async () => { activeTab = "weapons"; await recalc(); renderTabs(); renderPanel(); return activeTab; })()
```

## 6. Reset between cases

**Only ever delete `QA-` keys.** This machine's browser holds real characters
from ordinary use; a blanket `localStorage.clear()` destroys them. Every fixture
name sanitises to a key starting with `QA-`, so this is safe and sufficient:

```js
(() => { const gone = Object.keys(localStorage).filter(k => k.startsWith("sinless:char:QA-")); gone.forEach(k => localStorage.removeItem(k)); return { removed: gone }; })()
```

Workspace tabs accumulate across sessions and will already number in the dozens.
That is normal and harmless — tabs are keyed per character. To close just the QA
ones:

```js
(async () => { const names = WORKSPACE.tabs.map(t => t.char.name).filter(n => /^QA /.test(n)); for (const n of names) await closeTabByName(n); return { closed: names, remaining: WORKSPACE.tabs.length }; })()
```

Never sign out, and never touch `sinless:u<id>:` keys — those belong to a
signed-in account.

## 7. Open a findings file

Before running the pass, create
`docs/qa/findings/YYYY-MM-DD-P<NN>.md` with the header from
[`../TEMPLATE.md`](../TEMPLATE.md#findings-file). Get both commit hashes with:

```bash
git -C /c/Users/cheep/Claude/sinless-app log -1 --format=%h
```

Write results **as you go**, not from memory at the end.

---

## Caveats that will otherwise waste your time

- **Screenshots time out intermittently on this app.** They are not required by
  any pass. Use `javascript_tool` and `read_page` to read the DOM. If a case
  seems to need a screenshot, it is asking you to read text — read it as text.
- **`CALC` is stale until you recalculate.** Mutating `CHAR` does not update
  `CALC`. Always `await recalc()` before asserting on derived values.
- **`errors` and `warnings` are empty whenever `finalized` is true.** This is
  deliberate in `rules.js`, not a bug in your setup. To see a finalized
  character's real validity, copy it, set `finalized = false`, and calculate the
  copy — see [`../fixtures/README.md`](../fixtures/README.md#reading-the-errorwarning-counts).
- **`CHAR`, `CALC`, `DATA` and the render functions are globals.** You can read
  and call them directly from `javascript_tool`; no imports, no module wrapper.
- **The app is subpath-safe and uses relative paths**, which is why the fixture
  fetch above has no leading slash. Keep it that way.
- **Do not edit application code.** If a pass tempts you to fix something,
  record it as a finding instead.
