# Notebook widgets — design (spec 2 of 3)

**Status:** all three tracks delivered (W1–W4) — see Phasing below for
per-phase browser-verification evidence. **Placement extension shipped
2026-07-15** (Tasks 1–4: strips-to-output-slot + `widgets=` attr, R Run-All
parity, per-control `placement` keyword, exit-gate cleanup/examples/sweep —
see `.superpowers/sdd/task-place-4-report.md`).
**Date:** 2026-07-15
**Builds on:** spec 1 (`2026-07-13-notebook-cells-design.md`) — the `#%%` cell
format, notebook rendering, and the phase-B1 per-cell run machinery
(`mdRunNotebookCell`, live sessions, per-cell output slots).
**Repo:** openstat leads; safestat port later; no microdata-repo port.

## Summary

Widgets come in **three isolated tracks**, decided after two research rounds
(2026-07-14/15; sources and findings in the conversation ledger):

1. **Track 1 — the common `ui` system (primary):** a small, runtime-agnostic
   control protocol + thin language facades, working in **pyodide, brython,
   micropython and R**. It generalizes dash v2's existing control layer
   (js/dash.js already renders a JSON control spec as native HTML elements
   and syncs values back — and already works from all four runtimes) from
   dashboard cards to notebook cells.
2. **Track 2 — native ipywidgets (pyodide-only opt-in):** a minimal comm
   bridge so real `ipywidgets` (and thereby `anywidget`) run unchanged.
   For users coming from Jupyter/Colab. Loaded lazily, zero footprint when
   unused, zero code shared with track 1.
3. **Track 3 — Colab `#@param` forms (bonus):** comment-syntax forms that
   work in every runtime by construction (set a variable, rerun the cell).

**Design principle: standardize the protocol, not the pixels.** The `ui`
protocol and language APIs are ours; the renderer (native HTML + our CSS) is
a swappable detail behind them.

## Decisions log (research-backed, 2026-07-14/15)

- **Two systems is correct.** ipywidgets can never be the common system
  (traitlets/ipywidgets have no path on brython/micropython; R is out of
  scope by nature). The common system stays primary and documented; the
  ipywidgets bridge is the "expert option".
- **Native ipywidgets is feasible, not a hack:** ipywidgets 8 routes all
  transport through the pluggable `comm` package (subclass `BaseComm`,
  override `publish_msg`); no ipykernel/ZMQ dependency. Precedents:
  JupyterLite's pyodide-kernel and marimo (whose WASM build runs the same
  bridge in-browser, single-process — architecturally identical to us).
  `anywidget` is a plain ipywidgets subclass → rides the bridge for free.
- **No third-party widget/component library for track 1.** The 2026 survey:
  Shoelace **archived 2026-05-14** ("sunset"); Microsoft FAST deprecated;
  Google Material Web in unmaintained "maintenance mode" since 2024;
  Vaadin/SAP UI5 require bundlers (no-build incompatible); Wired/Lion
  dead/white-label. Precedent: Observable Inputs — the closest comparable
  product — wraps native HTML elements with its own small CSS. Native HTML
  2026 covers the control set well (`accent-color`, stylable `<select>` as
  progressive enhancement, `<dialog>`/`<details>` baseline).
- **Pico CSS: inspiration, not dependency.** Even `pico.conditional.min.css`
  applies a global `:root` reset; its `--pico-*` token system would need a
  permanent translation layer against our tokens; upstream shows
  maintainer-absence signals. Instead we **vendor the 2–3 fiddly recipes**
  (cross-browser range styling, switch checkbox, focus states) into our own
  stylesheet with MIT attribution comments.
- The `rerun=`-based custom-`ui` sketch from the original brainstorm is
  superseded by this spec's track 1 (same idea, now grounded in the dash v2
  protocol and B1's per-cell run).

## Track 1 — the common `ui` system

### Protocol

One JSON control spec, shared with dash v2 (extend `js/dash.js`'s existing
`spec.type` vocabulary rather than inventing a parallel one):

```
{ type: 'slider'|'dropdown'|'checkbox'|'switch'|'number'|'text'|'button',
  name, label?, value?, min?, max?, step?, options?, rerun? }
```

- Controls render into the **declaring cell's output slot**, above that
  cell's results (a `.ui-controls` strip).
- Value changes sync the value into the cell's runtime session (same
  cross-boundary JSON mechanism dash v2 uses) and then trigger a rerun per
  `rerun`: `"self"` (default), a cell `id`, a list of ids, or `"none"`.
  Reruns go through the existing `Cells.runCell` / `mdRunNotebookCell`
  machinery — widgets require a notebook and reuse B1's sessions untouched.
- Sliders throttle (~150 ms) before rerunning; buttons rerun on click.

**Per-control placement (placement phase, Task 3, 2026-07-15):** every
control accepts an optional `placement: "top"|"bottom"|"left"` keyword
(`ui.slider(1, 10, placement="left")`, same keyword vocabulary in every
facade including R's `ui_slider(..., placement = "left")`). Precedence:
**control placement > the cell's `widgets=top|bottom|left` attribute >
default `top`** — controls without their own `placement` simply follow the
cell's attribute (or `top` if that is absent too), so existing notebooks are
byte-identical in appearance. A single cell may freely mix all three: e.g. a
slider left at the default top, a dropdown pinned `placement="left"`, and a
button pinned `placement="bottom"` all coexist. Mechanically, `.nb-output`
holds up to three physical anchors per system (`.ui-controls`/`.param-form`
tagged `data-pos="top"`/`"bottom"`, routed by CSS Grid — see `app.css`'s
`.nb-output` rules) plus one **shared** `.nb-strips-left` side column that
both `ui.*` and `#@param` controls stack into when placed left. Changing a
control's placement between runs re-parents it cleanly (old node removed
from its old anchor, fresh/moved node in the new one) without losing its
current value or leaving a stale duplicate behind.

### Language facades (thin, per runtime)

The Python-family facade (one `ui` module served to pyodide, brython and
micropython — mirroring how `dash.py` exists per runtime today):

```python
import ui
n     = ui.slider(10, 200, value=50)          # returns CURRENT value (int)
farge = ui.dropdown(["red", "blue"])          # returns current selection
vis   = ui.checkbox("Vis rutenett", value=True)
ui.button("Oppdater", rerun="plot")           # rerun another cell by id
```

Semantics (marimo-style): the call **registers/refreshes the control** in the
cell's slot and **returns its current value**, so downstream code reads
naturally and a rerun picks up the new value. Identity: controls are keyed by
`(cellIdx, name-or-declaration-order)` so reruns update rather than
duplicate. The API vocabulary deliberately stays close to ipywidgets
*concepts* (value, observe-like `on_change=` later) without claiming
compatibility.

R facade: `ui_slider(...)`, `ui_dropdown(...)` etc. emitting the same JSON
via the existing webR→JS channel (DashWebR precedent).

**Parity is a goal, not a straitjacket** (user decision 2026-07-15): small,
documented differences between the language facades are acceptable where a
runtime makes exact parity hard. Concretely for W2: brython/micropython
MODES have no notebook support (spec 1 §3.3), so their `ui` facades ship as
API-compatible fallbacks (return defaults in scripts; dash v2 remains the
interactive story there) until those runners gain cell support; full cell
widgets land in pyodide (W1, done) and R-mode notebooks (W2).
*Update 2026-07-16:* Phase C (brython/micropython notebook execution, spec
1 §6) is now DONE — widgets and `#@param` came for free as predicted: the
facades and the param parser were already dialect-ready, and both engines
being main-thread means the pyodide pull model applies unchanged. Full
cell-widget parity across pyodide/R/brython/micropython is delivered; see
`2026-07-16-notebook-cells-phase-c-design.md` for the execution seam.

**Track-1 parity note (placement phase, Task 2, fixed 2026-07-15):** R's
"Kjør alle" originally shipped as a documented W2 adaptation — no per-cell
integration, controls never rendered outside per-cell ▶, `.ui_values` wiped
before every run so widgets always showed defaults. Browser diagnosis during
placement Task 2 found this created a real user-facing gap (loading the R
widgets example and pressing "Kjør alle" showed zero controls, matching a
user report) and, separately, an actual regression risk: the R segment-kind
default used by "Kjør alle" (`hasMarkers ? 'microdata' : 'r'`, unchanged
since before the notebook cell model existed) misclassifies a notebook's
implicit preamble as `'microdata'` whenever any other cell has an explicit
marker — true for almost every notebook-format R document — which made
`Cells.alignPlan` unable to align the plan at all. Both are now fixed:
"Kjør alle" injects `Ui.valuesForCell`/reads the registry per r-segment
(same declare-and-inject pattern as per-cell ▶, via a new
`Cells.alignedPlanForKinds` helper that mirrors `beginRun`'s alignment
without touching output sinks — output stays on the trailing/combined slot,
untouched), and the segment-kind default is corrected to the notebook's
docMode whenever `Cells.active() && UI_R_REGEX` (never for ui-free
documents, preserving byte-identical output there). Values now persist
across "Kjør alle" and "Restart & kjør alle" exactly like python's
JS-side store (`Ui._values`, cleared only by `Ui.resetDocument()` on a new
document) — full parity with track 1's pull-model semantics, not just the
declare-and-inject mechanics. forklar's R per-block path is intentionally
untouched (still shows only `ui_*()` defaults) — its block model has no
notebook cell index to inject/read against; wiring that up is noted as a
follow-up, not attempted here (see
`.superpowers/sdd/task-place-2-report.md`).

### Rendering

Native HTML elements + our own CSS on openstat's existing tokens
(`--accent`, `--border`, `--bg-code`, …): `accent-color` for
checkbox/radio/range; vendored Pico-derived rules (MIT, attributed) for
range thumb/track, switch and focus-visible. No shadow DOM, no new
dependency, both themes. Known gaps accepted until needed: searchable
combobox, multi-thumb slider, rich date picker — each can be added
individually behind the protocol later.

### Scope notes

- Widgets are a **notebook feature** (they need per-cell slots + sessions).
  In plain scripts, `ui.*` calls return their default values and render
  nothing (graceful, documented).
- dash v2 keeps its own `d.controls`/card-kwargs API unchanged; the shared
  renderer is refactored, not the dash API.
- Microdata cells: `ui` is not available (replay-through semantics make
  widget reruns pathological); a notice explains.
- **W1 limitation resolved (W2, N1, fixed 2026-07-15):** microdata replay
  now brackets ALL replayed segments — not just the target — with their
  aligned cell idx, so `ui.*` calls in non-target replayed python cells
  consume stored widget values instead of spec defaults.

## Track 2 — ipywidgets bridge (pyodide-only, isolated)

- **Activation:** lazily, when a run's document imports `ipywidgets` —
  micropip-install the pinned wheel set (~10 MB incl. IPython; same UX as R
  package auto-install) and load the pinned
  `@jupyter-widgets/html-manager` bundle (SW-precached like other CDN
  assets). Nothing loads otherwise.
- **Kernel side:** implement `comm.create_comm`/`get_comm_manager` with a
  `BaseComm` subclass whose `publish_msg` calls straight into JS (single
  process — no transport layer). JupyterLite's `pyodide_kernel/comm.py` is
  the reference implementation.
- **Frontend side:** extend `HTMLManager` for live comms (create/route
  `comm_open`/`comm_msg` both ways; render via `display_view(view, el)` into
  the cell's output slot). No official cookbook exists; JupyterLite/Voila
  sources are the references.
- **Display integration:** the exec core's display hook recognizes
  `_repr_mimebundle_` containing
  `application/vnd.jupyter.widget-view+json` and hands the model id to the
  manager instead of printing.
- **v1 scope:** stock controls, `observe`/traitlets sync both ways,
  display in slots (last-expression + widget mimebundle detection).
  **Deferred:** `interact()` — research (2026-07-15) showed it HARD-depends
  on the `Output` widget (`interactive.__init__` unconditionally wraps in
  `with self.out:`), so it ships together with Output-widget support later;
  `Output`/`with out:` capture (needs a display-publisher seam we don't
  have without an IPython shell); `jslink`; third-party widgets (embed-amd
  CDN loading "best effort", no promises); widget state in share links;
  **`FileUpload`** — frontend→kernel binary buffers are dropped in v1
  (`_ipw_dispatch` hardcodes `"buffers": []`), so FileUpload silently
  never delivers its bytes; ships when the buffer path is threaded
  through (likely with `Output`).
  **Accepted v1 limitations (browser-verified 2026-07-15, exit gate):** a
  per-cell rerun of a cell that creates a widget accumulates comms in the
  JS registry (+3 per `IntSlider` rerun, e.g. 15→18→21→24 across three
  reruns) — the DOM stays clean (one view), and "Restart & kjør alle"
  resets the registry fully; not fixed (would require tracking which
  widget instance "belongs" to a cell/slot to close the old one on
  rerun — a real lifecycle decision out of v1 scope). `observe` callbacks
  run outside any captured cell, so `print(...)` inside a callback lands
  in the browser console, not the cell's output — documented in the
  example notebook's intro. Python-side, old `Widget`/comm-manager entries
  survive session restarts in the persistent interpreter (JS reset never
  sends `comm_close` into python) — unreachable from a fresh `_g`,
  memory-only, harmless.
- **Frontend correction (research 2026-07-15):** `HTMLManager`'s
  `_create_comm`/`_get_comm_info` are no-op stubs — live comms require
  subclassing it with a real comm implementation (a hand-rolled
  `IClassicComm`-shaped shim; `ManagerBase.handle_comm_open` does the
  rest). The `jupyterlab_widgets` KernelWidgetManager path (full
  `@jupyterlab/services` kernel shim) is NOT needed.
- **Version discipline:** pin ipywidgets 8.1.x ↔ html-manager 1.0.14 (the
  8.1.x counterpart); mismatches are the ecosystem's top failure mode.
  Colab compatibility is source-level (Colab runs ipywidgets 7.7.1, but the
  slider/dropdown/interact API is essentially unchanged, and html-manager
  ≥1.0.12 handles both model formats).
- **Isolation guarantee:** no shared code with track 1; brython/micropython/
  R/microdata are untouched; if the bridge breaks, `ui` is unaffected.

## Track 3 — `#@param` forms (bonus, all runtimes) — done

Colab's comment syntax, parsed per the open reverse-engineered grammar
(`ipyform` as reference): `x = 3 #@param {type:"slider", min:0, max:10}`,
dropdown-from-list, boolean, string, date; `#@title`, `{run:"auto"}`.
Rendering reuses track 1's controls; a change rewrites the assignment's
value **in the canonical text** (fits the text-canonical philosophy — the
form IS the code) and reruns the cell when `run:"auto"`. Works in every
runtime because it never touches the runtime: it edits text and reruns. Form
interactions clear the cell textarea's browser undo-stack (programmatic
`.value` writes), so the undo control remains independent.

**Per-control placement (placement phase, Task 3, 2026-07-15):** the meta
object accepts the same `placement: "top"|"bottom"|"left"` keyword as
track 1 (`x = 3 #@param {type:"slider", placement:"left"}`), with identical
precedence (control meta > cell `widgets=` attribute > default `top`) and
the identical physical anchors (per-position `.param-form`/`.ui-controls`,
shared `.nb-strips-left` column) — see track 1's protocol section above for
the full mechanics, which are system-agnostic. An unrecognized `placement`
value warns and is ignored (the line falls back to the cell's default),
matching the grammar's existing "unknown key → warn, don't fail the line"
convention. Changing `placement` on a line is treated as a structural
change (like changing its `type`): the form rebuilds so the control lands
cleanly in its new anchor, reading its current value fresh from the
(already up to date) source text — no value loss, no duplicate node.

## Phasing

- **W1 — `ui` core (pyodide):** protocol + renderer + python facade +
  rerun semantics + tests; ship. **Done 2026-07-15** — browser-verified
  end-to-end (slider/dropdown/button, per-cell + Run All, DOM-identity
  preserved across reruns, zero-ui sweep, plain-script fallback, example
  notebook); see `.superpowers/sdd/task-w1-5-report.md`.
- **W2 — `ui` everywhere:** brython + micropython facades (same module),
  R facade; notice for microdata. **Done 2026-07-15** — browser-verified
  end-to-end (R declare-and-inject model: per-cell slider/dropdown/button,
  Run All defaults-only with no stale values, controls survive as strips
  from earlier per-cell runs; R example notebook). brython/micropython
  facades confirmed as documented API-compatible fallbacks (defaults, no
  render — real cell support pending those runners' notebook support, see
  Scope notes above); see `.superpowers/sdd/task-w2-5-report.md`.
  **Superseded (placement phase, Task 2, 2026-07-15):** "Run All
  defaults-only" is no longer the contract — R "Kjør alle" now renders
  controls per r-segment and uses stored values exactly like python's Run
  All, closing the gap where a user loading the R widgets example and
  pressing "Kjør alle" saw no controls at all. See the track-1 parity note
  above and `.superpowers/sdd/task-place-2-report.md`.
- **W3 — ipywidgets bridge v1** (per track 2 scope). **Done 2026-07-15** —
  browser-verified end-to-end (widget render + live `observe`-driven
  updates with no cell rerun, kernel-sync both ways, buffer-and-replay
  for the one-cell create-mutate-display idiom, clean "Restart & kjør
  alle" rebuilds with stable registry counts, isolation from W1/W2 `ui`
  across document switches, zero-footprint for plain scripts/non-ipywidgets
  notebooks, pinned bundle URLs, both-themes render); v1-scope exactly as
  documented above (stock controls + observe/traitlets sync + display in
  slots; `interact()`/`Output` deferred); see
  `.superpowers/sdd/task-w3-5-report.md`.
- **W4 — `#@param` forms.** **Done 2026-07-15** — browser-verified
  end-to-end (example notebook `examples/python/py_param_forms.txt`:
  slider/dropdown/boolean/allow-input-string/date forms render; a
  `run:"auto"` slider rewrites the source line AND reruns the cell live;
  a non-`run:"auto"` dropdown rewrites the text and stale-tints until a
  manual ▶; the same document round-trips through a share-link with
  forms rebuilding from the canonical text; an r-mode cell
  (`x <- 3 #@param {type:"slider", ..., run:"auto"}`) works end-to-end
  in a genuine R-mode document; a plain (non-notebook) script containing
  `#@param` runs completely inert/unchanged; a coexistence cell with both
  `ui.slider` and `#@param` renders both strips with `.param-form` always
  first; both themes screenshot-checked); see
  `.superpowers/sdd/task-w4-3-report.md`. This was the last W-phase —
  **track 3 (Colab `#@param` forms) is now delivered**, alongside tracks
  1 and 2 above: all three widget tracks in this spec are complete.

Each phase gets its own implementation plan; W1 must not start before
phase B1's session machinery is merged (done — merged to main 2026-07-14).

- **W5 — DONE 2026-07-16: widget events
  (`on_click`/`on_change`), two-step delivery.**
  Delivered per the dedicated W5 spec
  [`2026-07-16-notebook-widget-events.md`](2026-07-16-notebook-widget-events.md)
  (dash-callback precedence, `ui.on`/`ui.run_cell`, typed payloads). One
  supersession from the planning notes below: the return-value rendering
  does **not** route through `window.mdRenderOutput`; the facades classify
  the handler's `(return, stdout)` into **typed payloads**
  (`text`/`error`/`table`/`figure`) that `Ui.renderEventResult` draws
  directly — same type→view mapping, but no embed-marker round-trip.
  Examples: `examples/{python/py_widget_events,brython/bry25_widget_events,micropython/06_widget_events}.txt`.
  The original two-step plan is retained below for provenance.
  - **Step 1 — cell-name targets (all widget runtimes, cheap):**
    `on_click="cellname"` / `on_change="cellname"` (string or list) as
    the canonical names for what `rerun=` does today — same JS path,
    same debounce, same serialized run queue. `rerun=` stays as an
    alias for backward compatibility with shipped examples. `on_change`
    applies to value controls, `on_click` to buttons. Output goes to
    the target cell's own slot, exactly as rerun does — no redirection
    for the cell-name variant.
  - **Step 2 — function callbacks (pyodide first, own mini-spec/plan):**
    `on_click=my_function` introduces push into the pull model. Design
    decisions already taken in discussion (2026-07-16):
    - Functions cannot cross the bridge — a per-cell callback registry
      on the Python side (`ui._callbacks["cellKey::name"]`); only the
      name crosses; JS dispatches `ui._dispatch(name, event_payload)`.
    - **Output targeting:** optional `target="dom-id"` names the DOM
      element (typically a `<div id=…>` in an `#%% html` cell) that
      receives the function's rendered return value — replace
      semantics by default. Omitted `target` → the widget cell's own
      output slot. Missing/misspelled id → fall back to the widget
      cell's slot with a visible notice, never silently dropped.
      Rendering uses the ordinary output builders (DataFrame → table,
      figure → chart, string → escaped text), so the `htmlTrusted`
      invariant is untouched.
    - Lifecycle note: editing the html cell re-renders it and clears
      the target div's injected content — accepted, documented. A
      `ui.output("name")` placeholder widget is the future-proof
      alternative if raw ids prove fragile; not in v1.
    - Parity: pyodide first. brython/micropython get it with spec 1
      Phase C (main-thread closures make it trivial there). R/webR is
      feasible via the declare-then-inject channel (inject fresh
      values, then call the named function in the worker) but ships
      later under the parity-is-a-goal rule.
    - Open at planning time: re-entrancy (event firing during a run),
      error surfacing, and forklar/skrittvis semantics for callbacks.
  - **User input 2026-07-16 (second round) — incorporated decisions:**
    - **Start with pyodide + brython** (both have native DOM event
      binding on the main thread: Brython's `elt.bind(...)`, pyodide's
      FFI `addEventListener` + `create_proxy`); micropython follows
      (same main-thread model), R last. Note Phase C is delivered, so
      brython/micropython notebooks are real targets now.
    - **A second, element-level API layer** alongside the `on_click=`
      kwargs on `ui.*` controls: wrap native event binding so ANY DOM
      element (typically one in an `#%% html` cell) can drive Python.
      Two distinct names instead of one overloaded handler argument
      (user delegated naming; decided):
      `ui.on(selector, event, handler, target=None)` binds a Python
      function to an HTML event ("click", "change", "input", …);
      `ui.run_cell(selector, event, cell_id)` is the cell variant —
      separate name, no function/string overloading.
    - **Return-value rendering reuses the existing output pipeline** —
      this dissolves the type-conversion question (plot → base64 vs
      plotly-JSON, dataframe → table, text → `<pre>`): the runner's
      existing formatting (`_fmt`/show → embed-marker text) +
      `window.mdRenderOutput(text, targetEl)` already implement
      exactly that mapping for cell output today (plotly embed
      markers rendered as charts, frames as tables, text as pre).
      Callbacks format their return value through the same machinery
      and route it to the target node — no new per-type converters.
    - **Omitted `target` default:** the registering cell's own output
      slot with append semantics (keeps results next to their
      context); in a plain script (no notebook) the fallback is
      `#outputArea` (append at the end of the visible output — the
      user's "end of screen" suggestion, applied where no cell slot
      exists).

## Testing

Pure-half tests for the control-spec builder and `#@param` parser (node);
stub-DOM tests for control registration/update identity and rerun wiring;
browser verification per runtime per phase; the ipywidgets bridge gets a
dedicated browser suite (slider→observe→output round-trip, interact,
version-pin smoke).

## Risks

- Live-HTMLManager extension has no official cookbook (JupyterLite source is
  the map) — the single biggest unknown, isolated to W3.
- html-manager is low-churn (last touched 2025-04); pinning mitigates; the
  marimo/anywidget direction is the long-term fallback.
- Two systems to document — mitigated by positioning (`ui` is the default
  story; ipywidgets is "for Jupyter/Colab users").
- Widget reruns amplify any B1 session bugs; W1 inherits B1's test suite as
  its regression floor.
