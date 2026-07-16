# Notebook widget events (W5) — design

**Status:** approved for implementation (user input rounds 2026-07-16 ×2;
"kjør w5").
**Builds on:** spec 2 (`2026-07-15-notebook-widgets-design.md`, W5 phasing
entry — this doc supersedes its sketch where they differ) and spec 1 Phase C
(brython/micropython notebooks, delivered 2026-07-16).
**Repo:** openstat. Branch: `notebook-widget-events`.

## Summary

Two deliveries:

1. **W5.1 — event-named rerun kwargs (all widget runtimes, cheap):**
   `on_click=` / `on_change=` on `ui.*` controls as canonical names for
   what `rerun=` does today. Pure aliasing.
2. **W5.2 — element-level events with Python callbacks (pyodide, brython,
   micropython):** `ui.on(selector, event, handler, target=None)` binds a
   Python function to an HTML event on ANY DOM element (typically in an
   `#%% html` cell); `ui.run_cell(selector, event, cell_id)` runs a named
   cell instead. The handler's printed output + return value are rendered
   as a typed payload (text → `<pre>`, DataFrame → table, plotly figure →
   rendered chart) into the `target` DOM id, or appended to the
   registering cell's output slot when `target` is omitted.

**Implementation model: mirror dash v2's proven callback machinery.** Dash
already calls Python functions from JS events in all three engines
(pyodide via `create_proxy` + `_proxies`/`_reap`, brython/micropython by
passing the function object directly over the FFI — `pyodide/dash.py:291`,
`brython/dash.py:268`, `micropython/dash.py:491`), captures stdout per
runtime (`sys.stdout` swap; micropython uses the destructive
`window.__mpyCaptureStart()`/`__mpyCaptureEnd()` pair since stdout
reassignment is broken there), classifies results into typed payloads, and
renders them (`js/dash.js` `D.renderPayload`). W5.2 reuses these patterns
— NOT the notebook's embed-marker pipeline (`mdRenderOutput`), which the
earlier W5 sketch suggested; typed payloads are the purpose-built channel
for callback results. R/webR is deferred (worker round-trip; parity rule).

## Decisions (user, 2026-07-16)

- Two distinct function names, no overloaded handler argument: `ui.on`
  (function handler) and `ui.run_cell` (cell name). (Naming delegated,
  decided.)
- pyodide + brython first; micropython rides along because dash proves
  its jsffi function-crossing works (a cheap spike in Task order confirms;
  if it fails, mpy ships `ui.on` as a documented notice per the parity
  rule). R deferred.
- Omitted `target` → registering cell's output slot, append semantics;
  plain script (no notebook) → `#outputArea` append.
- `target="dom-id"` → replace semantics; missing id → fall back to the
  cell slot with a visible notice, never silently dropped.

## Global constraints

- Documents that never call `ui.on`/`ui.run_cell`/the new kwargs are
  byte-identical in behavior (all new code behind explicit calls).
- `htmlTrusted` invariant untouched: rendered payloads come from our own
  formatters (pre via textContent, tables from the facades' own
  `to_html`-style builders — same trust level as dash cards render today,
  figures via Plotly from JSON). No user-supplied HTML string is ever
  injected by this feature.
- ES5 var JS, Norwegian comments, `t()` for user-facing strings; twin/
  triplet parity across facades with documented dialect differences only.
- The dash system itself is not modified (read-only precedent), except
  `js/dash.js`'s renderer if a small export is needed (see Components).

## Components

### 1. W5.1 — kwargs aliases (all facades + R)

In `pyodide/ui.py`, `brython/ui_brython.py`, `micropython/ui_mpy.py`,
`webr/ui.R`: `on_click=` accepted by `button()` and `on_change=` by the
value controls (slider/dropdown/checkbox/switch/number/text), each mapped
to the existing `rerun` spec field before JSON crossing; if both
`rerun=` and the alias are given, the alias wins (documented in the
docstrings — no warning channel in v1). `rerun=` stays. JS side
unchanged (still sees `spec.rerun`).

### 2. W5.2 — `Ui` bindings registry (js/ui.js)

- New registry `_bindings` keyed `cellKey::selector::event` holding
  `{cellIdx, selector, event, kind: 'fn'|'cell', handler?, cellId?,
  target?}`. Registered during a cell run via two new bridge functions:
  `Ui.bindEvent(bindingJson, handler)` (handler = crossed function) and
  `Ui.bindRunCell(bindingJson)`. Outside a run context (plain script):
  `bindEvent` registers with `cellIdx: null` (targets then default to
  `#outputArea`).
- **Delegated listeners:** one document-level listener per event type
  (added lazily on first binding of that type), matching
  `e.target.closest(selector)` against registered bindings — survives
  html-cell re-renders (which replace nodes) without rebinding.
- **Mark-and-sweep per rerun:** integrated with the existing
  `beginCellRun`/`endCellRun` pair exactly like controls — a rerun that no
  longer declares a binding removes it; pyodide handler proxies are
  destroyed on sweep (mirror `_reap`).
- **Dispatch:** on event match, if `kind === 'cell'` →
  `Cells.cellIndexById(cellId)` → `Cells.runCell(idx)` (missing id →
  console.warn + notice in the binding cell's slot). If `kind === 'fn'` →
  guard `window.mdIsScriptRunning()` (drop the event with a console.debug
  — no queuing in v1), call `handler(eventJson)` synchronously (main
  thread, dash precedent) where eventJson =
  `{"type", "value", "checked", "targetId"}` extracted from the DOM
  event; the handler returns a payload JSON string (see 3);
  `Ui.renderEventResult(binding, payloadJson)` renders it (see 4).

### 3. Facade side — `ui.on` / `ui.run_cell` (three Python facades)

- `ui.run_cell(selector, event, cell_id)`: builds the binding spec,
  crosses as JSON to `Ui.bindRunCell`. No function crossing.
- `ui.on(selector, event, handler, target=None)`: wraps `handler` in a
  runner closure and crosses it per runtime exactly as dash does:
  - pyodide: `create_proxy(wrapper)` handed to JS — and **JS owns
    destruction**: everywhere a binding is removed (sweep, replace,
    resetBindings), js/ui.js calls `handler.destroy()` when the method
    exists (PyProxy has it; brython/micropython function objects do not
    → guarded no-op). This removes any need for a dash-`_reap`-style
    Python-side proxy ledger.
  - brython/micropython: pass the wrapper directly.
- **The wrapper** (per facade, dialect-adapted): captures stdout
  (`sys.stdout` swap in pyodide/brython; `__mpyCaptureStart/End` in
  micropython — destructive, exactly one pair per invocation, dash
  precedent `micropython/dash.py:536-575`), calls `handler(event_dict)`
  — the handler contract is ALWAYS one argument (the event dict:
  `{"type", "value", "checked", "targetId"}`); no arity sniffing in v1
  (a fixed contract beats `_func_params`-style guessing, which
  micropython cannot do reliably anyway), then classifies `(return_value, stdout_text)` into a
  payload dict and returns it as a JSON string:
  - plotly figure (`to_plotly_json`/`fig`-duck-typing as in dash) →
    `{kind:'figure', spec:{data,layout}}`
  - DataFrame (facade's own frame type) → `{kind:'table', html:...}`
    using the same table-HTML builder the facade's dash payload uses
  - `None` with stdout → `{kind:'text', text:stdout}`
  - anything else → `{kind:'text', text: str(value)}` (+ stdout
    prepended)
  - exception → `{kind:'error', text: traceback}`
  The classification is a compact per-facade copy (the three dash.py
  files are divergent copies by convention; extracting a shared module
  is the existing builder-dedup backlog item, not this spec).

### 4. Rendering — `Ui.renderEventResult` (js/ui.js)

- Resolve target: binding.target → `document.getElementById`; found →
  clear + render into it (replace). Not found → notice + fall through.
  No target → cell slot (`.nb-output-body` of binding.cellIdx) append;
  `cellIdx null` → `#outputArea` append.
- Render by kind: `text` → `<pre>` via textContent; `error` → `<pre
  class="error">`; `table` → container.innerHTML = payload.html (our own
  builder output, same trust level as dash cards); `figure` → lazy-load
  `js/dash.js` if `window.Dash` is absent (plain `addScript`, it has no
  boot cost) and delegate to `Dash.renderPayload({kind:'figure',...},
  node)` — reusing its Plotly deferral; if dash.js fails to load, render
  a notice.
- Plotly availability: figures require the plotly bundle the engines
  already use; `renderPayload` handles the deferral (dash precedent).

### 5. Session lifecycle

- `Ui.beginCellRun/endCellRun` sweep per cell (2 above).
- Session restart/invalidate (`mdNotebookSession.restart/invalidate` and
  the engines' `notebookSession.reset`): all bindings cleared and pyodide
  proxies destroyed via a new `Ui.resetBindings()` hooked where
  `IpwBridge.reset()` is already called (same lifecycle points, same
  reasoning: handlers from a dead session must never fire).
- Re-entrancy: events during any run are dropped (guard in 2); events
  firing after the run completed work against the live session state
  (dash precedent: persistent handlers).

## Error handling

- Handler exception → error payload → red `<pre>` in the resolved target
  (never swallowed).
- Binding to a selector that matches nothing: allowed (delegation is
  lazy) — documented; a typo just never fires.
- `ui.on`/`ui.run_cell` outside pyodide/brython/micropython (R,
  microdata): the facade doesn't exist there (R gets a documented notice
  in webr/ui.R if called: "ikke støttet ennå").
- Plain-script registrations work (target `#outputArea`) — but note the
  notebook is the primary context; examples show notebook usage.

## Testing

- Node (stub-DOM): binding registry keying, mark-sweep on rerun,
  delegated-listener matching (synthetic events), target resolution
  fallback chain, renderEventResult kinds (text/error/table).
- pytest: the three facades' payload classification (figure/frame/text/
  error) and wrapper stdout capture under CPython (js=None guards as the
  facades already do); kwargs aliases mapped to `rerun` in the spec JSON.
- Browser exit gate (pyodide + brython + micropython): an example
  notebook per… one shared example in python mode + one in brython mode
  covering: html-cell button driving `ui.on` with `target=` (table +
  figure + text results), `ui.run_cell` from an html element, omitted
  target appending to the cell slot, missing-id notice, rerun of the
  binding cell not duplicating handlers, Restart clearing bindings
  (event after restart does nothing), plain scripts unaffected, both
  themes. micropython: same flows on a copy of the brython example (or
  documented notice if the spike fails).

## Out of scope

- R/webR `ui.on` (deferred; documented notice), forklar/skrittvis,
  event queuing during runs, async handlers, `ui.output()` placeholder,
  markdown/image payload kinds (text/table/figure/error only in v1),
  modifying dash.

## Phasing (one plan)

1. W5.1 kwargs aliases (all facades incl. R) + tests.
2. js/ui.js bindings registry + delegation + render + lifecycle + node
   tests.
3. pyodide facade (`ui.on`/`ui.run_cell` + wrapper + proxy lifecycle) +
   index.html ensure-wiring if any + pytest.
4. brython + micropython facades (incl. the mpy spike) + pytest.
5. Examples + docs + exit gate (browser matrix above).
