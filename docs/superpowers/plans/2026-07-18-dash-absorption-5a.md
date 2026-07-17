# Dash Absorption 5a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Absorb dash's unique capabilities into the ui system — shared payload vocabulary (kpi/markdown/image + the figure/theme internals moved into ui.js), `ui.widget("navn")` handles, `ui.play`, the `cols=` cell attribute, and the publish-document generalization — per `docs/superpowers/specs/2026-07-18-dash-absorption-design.md` §§1-5 (plan 5b rewrites examples and removes dash).

**Architecture:** ui.js becomes the single owner of payload rendering (`Ui.renderPayload` with text/error/table/figure/kpi/markdown/image; theme observer; format helpers) — dash.js's `D.renderPayload` becomes a thin delegate until 5b deletes it. Widget handles are a thin JS quartet (`Ui.widgetLookup/widgetSet/widgetVisible/widgetNode`) + a python `WidgetHandle` mirroring `Ui.value`'s name-lookup. `ui.play` joins `_BUILDERS` with dash's three-way timer hygiene. `cols=` is a cell attr applying a content grid on `.nb-output-body`. Publish keeps its mechanism, gains notebook support + `#options.view = output-only` injection + new name.

**Tech Stack:** ES5 var-style JS, python facade twins, webr/ui.R registry channel, node + pytest.

## Global Constraints

- ui/notebook behavior unchanged for existing documents (pull model; data-ui-shown lifecycle; run-gated imports; legacy registerControl shapes).
- `ui.widget(...).set(v)` NEVER fires on_change/rerun (documented). `ui.play`'s timer can never leak (cleared on pause, manual input, and disconnect-checked in the tick; 200ms floor).
- One rendering implementation: after Task 1, dash.js contains NO duplicated payload logic (delegation only). Facade twins byte-mirror (documented dialects). R handles = polite pattern only.
- index.html inline changes browser-smoked in the same task; rerun ×3 standard; cross-IIFE via window.md*.
- Baselines: node 633/637 + 4 known ENOENT; pytest 1506 + 1 known; per-file: ui-dom 128, ui.test 55, cells 131, cells-dom ~105+, test_ui_module 133, brython 131, mpy 131, dash.test 287-lines suite (count at run), test_pyodide_dash 10, test_dash_mpy 21.
- Every task: full node suite at (new) baseline; record counts.

---

### Task 1: Payload vocabulary moves into ui.js

**Files:** Modify `js/ui.js` (new `Ui.renderPayload` + helpers; `_renderFigure`/`renderEventResult` route through it), `js/dash.js` (D.renderPayload → delegate; remove moved helpers), `css/dash.css`→`app.css` (move `.dash-kpi`/markdown/image-relevant card styles under new `ui-`/generic class names — read dash.css first, move ONLY payload-content styles, keep dash-grid/card-frame styles in dash.css for 5b), `js/i18n/en.js` if any strings; Test `tests/js/ui.test.js` (pure helpers) + `tests/js/ui-dom.test.js` (render branches) + `tests/js/dash.test.js` (delegation intact)

**Interfaces (produced):**
- `Ui.renderPayload(p, hostEl)` — kinds: `text`/`error` (pre), `table` (innerHTML), `figure` (Plotly with theme defaults + isConnected guard — MOVED from dash.js:297-314), `kpi` ({value, unit?, fmt?, ref?, bra?, delta?, label?} — formatNumber/computeDelta moved from dash.js:79-108), `markdown` (mdToHtml moved from dash.js:165-168), `image` ({src|dataUri, alt?}), unknown → warn. Pure helpers exported for tests: `Ui.formatNumber`, `Ui.computeDelta`.
- Theme: `themeColor` + the `body[data-theme]` observer (dash.js:183-240) move in; observer relayouts connected ui-rendered figures (keep dash's registered figures working via the delegation until 5b).
- `renderEventResult` switches its branches to `Ui.renderPayload`; `_renderFigure`'s `_loadDash` lazy-load DIES (figure now native) — keep `_loadDash` only if dash.js still needs it elsewhere (it doesn't — remove).
- dash.js: `D.renderPayload = function (p, nodeEl) { … node-kind (dash-only) … else Ui.renderPayload(p, host) }` — verify the `node` kind and dash's card-DOM expectations still hold (read addCard/updateCard callers).

Steps: TDD — node tests for formatNumber/computeDelta parity (port the assertions from tests/js/dash.test.js for those helpers — they must MOVE, not duplicate: the dash.test assertions repoint to Ui.*), render-branch tests (kpi DOM shape incl. delta arrow/direction classes, markdown innerHTML, image src) → implement move + delegation → dash.test.js still green via delegation → full suites → commit `feat(ui): payload-vokabularet flyttet inn — kpi/markdown/image/figur + tema-observer, dash delegerer`.

---

### Task 2: `ui.widget("navn")` handles

**Files:** Modify `js/ui.js` (the quartet), `pyodide/ui.py` + twins (WidgetHandle + `widget(name)`), tests ×4 suites

**Interfaces:**
- `Ui.widgetLookup(name)` → controlKey|null (the `Ui.value` suffix-match incl. duplicate warn — factor the shared lookup out of `Ui.value`).
- `Ui.widgetSet(key, valueJson)` → new value JSON: writes `_values[key]`, per-type DOM write (reuse `_updateControlSpec`'s per-type branches — factor the value-write into `_writeControlValue(ctrl, v)` used by both), `_syncPush` — NO handler fire, NO rerun. Unknown key → null + warn.
- `Ui.widgetVisible(key, bool)` (wrap.style.display), `Ui.widgetNode(key, which)` ('wrap'|'input' → the node; used by facades' .element/.input via the element-engine? NO — widget nodes are not in `_els`; return the raw node like `Ui.elNode` does — the facades expose them via the same jsffi handle style as `.el`).
- Facades: `class WidgetHandle` (`_key`); `ui.widget(name)` → handle|None (+ console.warn via bridge). Properties/methods: `.value` (live via `u.value(name)`… NOTE by-key: use `Ui.widgetValueByKey(key)`? simplest: store name AND key; `.value` reads `u.value(self._name)`), `.set(v)`, `.on(event, fn)` (binds on the INPUT node — reuse the elOn machinery? input nodes lack data-ui-el; simplest: `Ui.widgetBind(key, event, handler)` registering into `_bindings` keyed `wk::key::event` matched via the input's existing `data-ui-key` attr — extend the delegate matcher's el-branch to also try `[data-ui-key]`), `.hide()`/`.show()`, `.element`/`.input`.
- Docs line in facade docstrings: deklarer med ui.slider → verdien; håndtak med ui.widget.

Steps: TDD across ui-dom (lookup/set-no-fire/hide/bind) + pytest ×3 (handle API via extended FakeUiJs) → implement → suites → commit `feat(ui): ui.widget("navn") — håndtak med value/set/on/hide uten rerun`.

---

### Task 3: `ui.play` + `ui.kpi`/`ui.markdown`/`ui.image` builders

**Files:** Modify `js/ui.js` (`play` in VALID_TYPES/_BUILDERS + timer), facades ×3 (`play(...)` control + `kpi/markdown/image` Element builders), `webr/ui.R` (`ui_play` + payload-kind spec passthrough), tests ×5 (ui-dom fake timers, pytest ×3, Rscript smoke)

**Interfaces:**
- JS `_buildPlay(key, cellIdx, spec, value)`: slider + play/pause button + readout; `setInterval(tick, Math.max(200, spec.interval||600))`; tick: input disconnected → stop; advance by step; past max → loop?wrap:stop; each tick routes through the SAME change path as user input (store→sync→handler-or-debounced-rerun). stop on: pause click, manual slider 'input', disconnect-in-tick. Sweep/reset must clear timers (`endCellRun`/`resetDocument` — track timers per key and clear on control removal — extend the existing control-removal paths).
- Facade `play(min, max, *, value=None, step=1, interval=600, loop=False, label=None, name=None, rerun='self', on_change=None, placement=None, sync_to=None)` — spec `type:'play'` + interval/loop; callable dispatch like the other controls.
- `ui.kpi(value, delta=None, *, unit=None, fmt=None, ref=None, bra="opp", label=None)` / `ui.markdown(text)` / `ui.image(src, alt=None)` → Elements: build via the element engine a host node and call `Ui.renderPayload({kind}, hostNode)`? Cleanest: new engine call `Ui.elPayload(elId, payloadJson)` rendering the payload INTO an existing element — the facades create a div via elCreate then elPayload, return the Element. matplotlib figures for image: facade converts via the existing `_mpl`-style helper (port dash.py:175's data-URI conversion into the ui facades).
- `webr/ui.R`: `ui_play(...)` (registry spec), and R-side payload emit? R dash cards die in 5b; R's ui system stays control-only + notices — payload builders in R are OUT (document; the R examples rewrite uses plots/tables natively).

Steps: TDD (fake-timer play tests: tick advances + fires change path; pause/manual/disconnect stop; loop wrap; floor 200; sweep clears) + pytest builders → implement → Rscript smoke ui_play spec JSON → suites → browser smoke (one play widget live in pyodide: plays, pauses, survives nothing—rerun ×3 no double-timers) → commit `feat(ui): ui.play med dash-timerhygienen + ui.kpi/markdown/image-byggere`.

---

### Task 4: `cols=`

**Files:** Modify `js/cells.js` (KNOWN_KEYS + validation + docCellNode), `app.css`; Test cells.test + cells-dom

`cols` in KNOWN_KEYS (+ #tag path already generic); validation in parseHeader/scanTagBlock value checks: integer 2..6 else warning + ignored (mirror style/widgets validation). docCellNode: `wrap.classList.add('nb-cols-' + n)`; app.css: `.nb-cols-2 .nb-output-body { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 12px; }` … for 2..6 (direct children flow). Reconcile: cols joins the wrap-attr in-place-staleness family (documented). Tests: attr parse/validation/#tag.cols/preamble-default; docCellNode class. Commit `feat(cells): cols= — flerkolonne-celleinnhold (dash-gridens enkle arvtaker)`.

---

### Task 5: Publish document

**Files:** Modify `index.html` (label/id semantics, notebook support, output-only injection), `js/i18n/en.js`; browser smoke in-task

`publishStandaloneDashboard` → generalized (keep the function, rename user-facing label to «Publiser dokument (HTML)», i18n): works for any brython/micropython document incl. `#%%` notebooks (the autorun boot clicks Kjør — verify the engine-notebook loop path renders the converged document in the published copy); inject `#options.view = output-only` into the published script when the document has no `#options.view` line. Menu stays brython/mpy-gated. Browser smoke: publish a small mpy `#%%`-doc with a widget + kpi → open the downloaded file (file:// or served) → it boots, runs, renders the document output-only with live widget. Commit `feat(publiser): dokument-generalisering — notatbøker + output-only-injeksjon`.

---

### Task 6: 5a exit gate

Browser matrix (all applicable engines; report `.superpowers/sdd/task-5a-6-report.md`): kpi/markdown/image mount + theme switch (figure relayout observer moved — verify dark/light); ui.widget end-to-end (set updates DOM+sync_to WITHOUT firing on_change — verify with a callable attached; hide/show; .on extra listener); ui.play full hygiene live (play/pause/manual-stop/disconnect-via-rerun, loop, rerun ×3 no double-timers); cols= 2-3-column cells; publish flow; regression rows (ui.html example, widgets, param, dash EXAMPLES STILL WORK — dash is not removed yet!, notebook core, both themes). Suites + spec status `**Status 5a:** DELIVERED <date>` + cache bumps (ui.js, cells.js, M2PY_VERSION, sw v26). Commit `feat(ui): absorpsjon 5a verifisert — exit gate`.
