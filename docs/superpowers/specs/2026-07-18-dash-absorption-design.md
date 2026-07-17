# Dash absorption and removal + `ui.widget` (design)

Phase 5 — the FINAL phase of the unified document model
(`2026-07-16-unified-document-model-notes.md` §5, decision 8; user
waiver: backwards compatibility is explicitly NOT a constraint — dash
is unused, examples are rewritten; only the FUNCTIONALITY must
survive). Plus `ui.widget("navn")` (approved by Hans 2026-07-18 in the
widgets-vs-elements discussion). Builds ON the ui.html phase
(2026-07-17-ui-html-design.md).

## Summary

Two plans:

- **Plan 5a — absorption**: everything dash can do that `ui` cannot
  ships in the `ui` system: `ui.kpi` (+ markdown/image payload kinds in
  the shared render vocabulary; the figure/theme renderer internals
  move INTO ui.js), `ui.play` (dash's timer-hygiene pattern), the
  `cols=` cell attribute (multi-column cell output), the
  «publish document» generalization, and `ui.widget("navn")` handles.
- **Plan 5b — rewrite + removal**: the 13 dash example documents are
  rewritten as cell/widget/ui.html documents; then the four adapters
  (`pyodide/dash.py`, `brython/dash.py`, `micropython/dash.py`,
  `webr/dash.R`), `js/dash.js`, `js/dash-webr.js`, `css/dash.css`, and
  every dash coupling in index.html/engines/tests are removed. Removal
  is LAST, after the exit gate proves the rewritten examples.

## Global constraints

- **Functionality survives, API does not**: every capability in the
  dash examples must be expressible (and demonstrated) in the
  cell/`ui` system before dash is deleted.
- **ui/notebook behavior unchanged for existing documents** (the ui.html
  phase's contracts hold: pull model, data-ui-shown two-half lifecycle,
  generation sweep, run-gated imports).
- Facade twins byte-mirror (documented dialects). R: `ui_play` and the
  payload kinds work via the registry channel; `ui.widget` handles are
  python-only (R gets the polite-notice pattern — live handles cannot
  cross the worker boundary).
- ES5/Norwegian/`t()`+en.js; index.html inline changes browser-smoked
  in the same task; rerun ×3 is a standard smoke row.
- Suites at plan start: node 633/637 + 4 known ENOENT; pytest 1506 + 1
  known collection error.

## 1. `ui.widget("navn")` (plan 5a)

Handle for an already-declared control; the value-returning builder
calls stay THE primary API (unchanged).

- Lookup by name: the `Ui.value` suffix-match rule (last-registered
  wins + console.warn on duplicates); unknown name → `None` +
  console.warn (tolerant, mirrors `ui.value`).
- `WidgetHandle` API: `.value` (property — live read, = `ui.value`);
  `.set(v)` (writes the value store + the control's DOM (per-type,
  reusing the `_updateControlSpec` per-type write logic) + `sync_to`
  push; does NOT fire `on_change`/rerun — programmatic set is not a
  user gesture, and handlers calling `.set` must not loop; documented);
  `.on(event, fn)` (extra listeners on the control's input, the
  ui.html callback plumbing); `.hide()`/`.show()` (toggles the
  `.ui-widget` wrap's display); `.element` (the wrap), `.input` (the
  raw input node). JS side: `Ui.widgetLookup(name)` → key,
  `Ui.widgetSet(key, valueJson)`, `Ui.widgetVisible(key, bool)`,
  `Ui.widgetNode(key, which)`.
- All three python facades (twins). Docs one-liner: «ui.slider(...)
  deklarerer og gir verdien; ui.widget("navn") gir håndtaket».

## 2. Payload vocabulary + `ui.kpi` (plan 5a)

- The shared render vocabulary (today text/error/table/figure in
  `Ui.renderEventResult`) gains **`kpi`** (dash's `number`: value,
  `unit=`, `fmt=`, `ref=`+`bra=` → delta with direction), **`markdown`**
  and **`image`** (data-URI/URL/matplotlib-figure). The rendering
  branches, `formatNumber`/`computeDelta`, `mdToHtml`, `themeColor` and
  the theme observer MOVE from dash.js into ui.js in 5a (dash.js
  delegates to the moved code until 5b deletes it — one implementation,
  no fork).
- **`ui.kpi(value, delta=None, *, unit=None, fmt=None, ref=None,
  bra="opp", label=None)`** → an Element (built on the element engine
  with the kpi card styling) — mounts like any ui.html element
  (last-expression / `.show(target=)`). `delta=` is the direct form;
  `ref=` computes delta vs a reference (dash's rule). CSS moves from
  css/dash.css to the ui/app styles.
- `ui.markdown(text)` and `ui.image(src_or_figure, alt=None)`
  convenience builders (thin wrappers producing the same Elements the
  payload kinds render — one rendering path).

## 3. `ui.play` (plan 5a)

A real value control joining the builders in all four facades:
`ui.play(min, max, *, value=None, step=1, interval=600, loop=False,
label=None, name=None, rerun='self', on_change=None, placement=None,
sync_to=None)`. JS builder = slider + play/pause button + interval
timer with dash's documented hygiene (timer cleared on pause, on
manual slider input, and — checked in the tick itself — when the input
is disconnected; interval floored at 200ms; loop wraps else stops).
Each tick behaves exactly like a user change (store write → sync_to →
handler-or-rerun, debounced rerun coalesces). R: `ui_play` via the
registry channel.

## 4. `cols=` (plan 5a)

Cell attribute (`#%%` line and `#tag.cols =`), integer 2-6: the cell's
`.nb-output-body` becomes `display:grid; grid-template-columns:
repeat(N, minmax(0,1fr))` so multiple mounted payloads/elements/outputs
flow into columns — the simple replacement for dash's mosaic. Validation:
non-integer/out-of-range → warning + ignored. The power-user pattern
(`#%% html` grid + `.show(target=)`) covers everything mosaic did.
`KNOWN_KEYS` gains `cols`; docCellNode applies the class/style;
reconciliation handles cols changes (attr change → structure-equal but
wrap-attr… NOTE: wrap-attrs are a known in-place staleness (4a Minor) —
cols joins style/hide-output in that family; acceptable, full render
applies it).

## 5. Publish document (plan 5a)

«Publiser dashboard (HTML)» → **«Publiser dokument (HTML)»**: same
mechanism (script + baked `# load` data + autorun boot), still
brython/micropython-only (the light engines; pyodide/R stay out — the
runtimes are too heavy/worker-bound; documented), but now works for any
document INCLUDING `#%%` notebooks (the autorun Kjør renders the
converged document). The published HTML gets `#options.view =
output-only` injected (unless the document sets a view) so it opens as
a report. Menu label + i18n updated.

## 6. Rewrite inventory (plan 5b)

The 13 dash documents (12 examples + the loose `ex_dashboard_jobb.r`)
are rewritten as `#%%`-documents using `ui.*`/`ui.html`/`ui.kpi`/
`ui.play`/`cols=` with equivalent functionality; `examples/_unlinked/
ex_dashboard_iris.txt` and the loose root file are deleted (unlinked).
Manifest regenerated. Each rewrite is browser-verified in its engine.

## 7. Removal (plan 5b, LAST)

After the rewritten examples pass the exit gate:

- Delete: `pyodide/dash.py`, `brython/dash.py`, `micropython/dash.py`,
  `webr/dash.R`, `js/dash.js`, `js/dash-webr.js`, `css/dash.css` (+
  index.html link), the LIB_REGISTRY dash entries (both engines),
  `__ensurePyDash` + the pyodide preRun dash gate, every DashWebR call
  site (ensureDefs/reset/mount/invalidateDefs), the dash script tags,
  `Dash.sweepDisconnected` calls (mdClearOutputAreaUnlessDoc sites,
  runCell), the `.dash` half of the two-half markers (data-ui-shown
  remains the single preserved-content contract), the dash tests
  (tests/js/dash.test.js, dash-webr.test.js, tests/test_pyodide_dash.py,
  micropython/tests/test_dash_mpy.py + smoke), and the `_reap`
  proxy-hygiene coupling (pyodide) — verify ui's own sweep/destroy
  covers the proxies ui creates; dash's die with it.
- Prerequisite (done in 5a): the figure/theme/format internals live in
  ui.js; grep-verify zero `Dash.`/`window.Dash` references remain
  outside deleted files before deleting.
- ui.js's `_loadDash`/`_renderFigure` indirection collapses into the
  moved implementation.
- Full regression matrix re-run after removal (the 5b exit gate),
  including the ui.html example, widgets/param/notebook core flows,
  publish, and every rewritten example.

## Error handling

- `ui.widget` on unknown name → None + warn; `.set` with an
  out-of-range/incoercible value → per-type clamp/warn (the
  `_updateControlSpec` rules).
- `ui.play` timer can never leak (the three-way hygiene rule) — pinned
  by tests.
- `cols=` invalid → warning + single column.
- Publish on an unsupported mode keeps the existing disabled/hidden
  menu behavior.

## Testing

- node: widget-handle lookup/set/hide/on; play timer hygiene (fake
  timers/stub: tick → store write, pause/manual/disconnect stops);
  payload branches (kpi format/delta, markdown, image) in ui.js;
  cols validation + docCellNode class; publish autorun injection
  (string-level).
- pytest ×3 facades: ui.widget API, ui.kpi/markdown/image/play spec
  shapes, twins in sync. R: Rscript smoke for ui_play + payload kinds.
- Exit gates: 5a — browser matrix for each new capability in all
  applicable engines (incl. rerun ×3 and play-timer disconnect);
  5b — every rewritten example end-to-end + the full post-removal
  regression matrix.

## Out of scope

- Pyodide/R publish (documented limitation).
- Mosaic/`at=` named-area layout (cols= + html-grid replace it).
- K2 URL-state encode/decode (dash-only feature, dies with dash —
  no example uses it).
- R `ui.widget` handles (worker boundary).
