# Notebook widgets — design (spec 2 of 3)

**Status:** approved direction, pending user review of this document
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
- **v1 scope:** stock controls, `observe`, `interact`, display in slots.
  **Deferred:** `Output` widget (`with out:` capture), `jslink`,
  third-party widgets (enable embed-amd CDN loading "best effort", no
  promises), widget state in share links (renders as dead snapshot).
- **Version discipline:** pin ipywidgets 8.1.x ↔ html-manager 1.0.14 (the
  8.1.x counterpart); mismatches are the ecosystem's top failure mode.
  Colab compatibility is source-level (Colab runs ipywidgets 7.7.1, but the
  slider/dropdown/interact API is essentially unchanged, and html-manager
  ≥1.0.12 handles both model formats).
- **Isolation guarantee:** no shared code with track 1; brython/micropython/
  R/microdata are untouched; if the bridge breaks, `ui` is unaffected.

## Track 3 — `#@param` forms (bonus, all runtimes)

Colab's comment syntax, parsed per the open reverse-engineered grammar
(`ipyform` as reference): `x = 3 #@param {type:"slider", min:0, max:10}`,
dropdown-from-list, boolean, string, date; `#@title`, `{run:"auto"}`.
Rendering reuses track 1's controls; a change rewrites the assignment's
value **in the canonical text** (fits the text-canonical philosophy — the
form IS the code) and reruns the cell when `run:"auto"`. Works in every
runtime because it never touches the runtime: it edits text and reruns.

## Phasing

- **W1 — `ui` core (pyodide):** protocol + renderer + python facade +
  rerun semantics + tests; ship.
- **W2 — `ui` everywhere:** brython + micropython facades (same module),
  R facade; notice for microdata.
- **W3 — ipywidgets bridge v1** (per track 2 scope).
- **W4 — `#@param` forms.**

Each phase gets its own implementation plan; W1 must not start before
phase B1's session machinery is merged (done — merged to main 2026-07-14).

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
