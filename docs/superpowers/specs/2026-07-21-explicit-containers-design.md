# Explicit containers and composable controls (design) — "phase 4"

**Status:** APPROVED 2026-07-21 (design settled with Hans over an extended
discussion 2026-07-20/21; every decision below was explicitly chosen, with
alternatives assessed in-session — see §Rejected alternatives).
Continuation of the interactive-elements line
(`2026-07-20-unified-interactive-elements-design.md`, phases 1–3 all
DELIVERED 2026-07-20; user doc `docs/interactive-elements.html`).

## Motivation

There is a gap between level 2 and level 3 of the interactivity stack:

- **Widgets** (`ui.slider`, …) are effortless but locked to the cell's
  widget strips (top/bottom/left) — they cannot be composed into a
  layout the user builds (a card, a toolbar, a dashboard grid).
- **`ui.html` elements** compose freely but are raw — no value store,
  no label/readout, no change wiring.

Dashboard/report builders need controls AND outputs placed explicitly
in layouts. History note: dash had exactly this (the mosaic/`at=`
named-area layout string). The dash absorption (2026-07-18) deliberately
killed it, replacing it with `cols=` + the power-user pattern
(`#%% html` grid + `.show(target=)`). Three days of use showed the need
did not die with dash — only the implementation. This phase brings the
capability back as a code-level library API rather than a cell-attribute
DSL. `cols=` stays for the simple case.

## Decisions (all settled with Hans)

1. **Freeze the placement model, not the widgets.** The strips remain
   the silent default — `#@param` forms REQUIRE them (no code to place
   them), and the casual notebook case must stay zero-config. But the
   *widget-strip placement model* gets no new features; all new layout
   power goes into containers. PRECISION (important): the freeze covers
   widget placement in strips (`placement=`, `widgets=` stay as-is
   forever). It does NOT cover param forms — they live in the same
   physical strips and may still evolve there (`#@title`/`#@markdown`,
   the planned Colab-parity work, is explicitly allowed; see §Phasing).

2. **Wrappers, not web components.** Containers and composable
   controls are themed wrappers over the element engine (divs + CSS +
   the shared `Ui.makeNode` core from phase 2). Custom elements are
   reconsidered only if a concrete need appears (raw-HTML cells,
   standalone export) — none exists today.

3. **Three container types**, all ordinary `Element` handles
   (nestable, stylable, `.show(target=)` works):
   - `ui.row(...)` / `ui.column(...)` — flex; flex-tuning via kwargs
     (`gap=`, `wrap=`, `justify=`, `align=`), NOT a fourth type.
   - `ui.grid(template, cols=None, rows=None)` — named areas with CSS
     `grid-template-areas` semantics (the mosaic job, familiar and
     1:1 with CSS): `ui.grid("kpi kpi | plot table", cols="1fr 2fr")`
     (`|` separates rows; whitespace separates columns).

4. **`.add(child_or_list, **kwargs)`** on every container (and
   inherited by all Elements where meaningful): appends elements,
   nested containers, or plain VALUES (DataFrames, figures, scalars —
   rendered via the same payload path `on_change` results use).
   Per-child kwargs: `area=` (grid area name), `span=`, `align=`.
   Semantics: `.add` without `area=` appends; `.add(x, area="plot")`
   into an OCCUPIED area REPLACES its content (the W5
   target-registry semantics — this is what makes `on_change`
   handlers that redraw into an area work). API discipline: three
   container types, one `.add`, these three per-child kwargs — and
   stop until something concrete is missing (layout DSLs sprawl;
   see Shiny).

5. **The return rule — one kwarg carries the difference:**
   - `n = ui.slider(0, 100)` → returns the VALUE (pull model,
     unchanged; strip-mounted; rerun-driven). Existing documents are
     untouched.
   - `s = ui.slider(0, 100, into=panel)` → returns the HANDLE
     (today's `WidgetHandle`: `.value` live read, `.set()`, `.on()`,
     `.hide()/.show()`, `.element()`); mounted inside the container.
   `rerun="self"` stays the UNIVERSAL default in both modes (Hans
   2026-07-21, revising an earlier `"none"`-in-container idea): the
   existing rule "a control with an `on_change` callable never
   reruns" already yields event-driven behavior exactly when the
   builder wires a handler, and without one, rerun-rebuild is the
   right beginner default — the layout re-renders with the new value,
   controls keep their values via the stable keying. One rule
   everywhere; no mode-dependent default to memorize.
   Memorable form: *without `into=` you get the value; with `into=`
   you get the control.* Two return types from one function is a
   DELIBERATE choice — see §Rejected alternatives for why the
   alternatives are worse.

6. **Three orthogonal kwargs**, combinable freely, documented as a
   trio: `into=` (where the control LIVES — container handle),
   `sync_to=` (where the value FLOWS — session variable name, live),
   `rerun=` (what RUNS on change — `"self"`/cell id/list/`"none"`).

7. **`sync_to` seeding** — CORRECTED 2026-07-21: planning recon found
   this ALREADY DELIVERED (the 2026-07-16 sync_to phase):
   `_syncPush` fires at registration (js/ui.js:1095, comment "Fyrer
   ved registrering OG ved hver endring") through the `mdUiSyncTo`
   hook, synchronously into the session globals — browser-verified:
   `ui.slider(0, 100, value=40, sync_to="n")` + bare `n + 1` in the
   SAME cell shows 41 on first run. Phase 4a therefore shrinks to:
   pin the registration-time push with a JS test (uncovered today)
   and document the value channel + the self-shadow caveat in
   `docs/interactive-elements.html`.

8. **The self-shadow pattern** `n = ui.slider(sync_to="n")` is not
   forbidden (cannot be) but NEVER documented: a restart re-executes
   the line and `n` becomes a value/element again — the variable's
   type depends on interaction history. Documentation always shows
   the two-name form (`ui.slider(sync_to="n")` bare, or a distinctly
   named handle).

9. **Naming — one slider (alternative 1):** `ui.*` is the curated,
   batteries-included layer (controls, containers, `kpi`/`markdown`/
   `image`); `ui.html.*` remains the full generic ~110-tag raw layer
   (a raw slider is spelled `ui.html.input(type="range")`; there will
   never be a `ui.html.slider` — near-duplicates are the worst user
   trap); `ui.sl.*`/`ui.pico.*`/`ui.<name>.*` remain the imported
   component libraries (`#tag.import`, unchanged). No automatic
   global `sl` injection (users may write `sl = ui.sl` themselves).
   Optional nicety (may be dropped in planning): `ui.button` accepts
   element children (`ui.button(ui.html.b("Run"), " now")`) so rich
   markup no longer needs `ui.html.button`.

## Value channels after this phase (documentation table)

| Channel | Spelling | Suited for |
|---|---|---|
| Pull (return = value) | `n = ui.slider(0, 100)` | notebooks, rerun-driven (unchanged) |
| Session variable (seeded `sync_to`) | `ui.slider(0, 100, sync_to="n")` | live value without rerun, no assignment |
| Handle (`.value`/`.set`/`.on`) | `s = ui.slider(0, 100, into=c)` | containers/apps, event-driven |

## Canonical example

```python
#%% python
import ui

layout = ui.grid("side main | side table", cols="220px 1fr")

def update(_):
    sub = df[df["species"] == a.value]
    layout.add(plot(sub.head(s.value)), area="main")   # replaces area content

panel = ui.column(gap="0.75rem")
s = ui.slider(0, 100, value=30, label="Threshold", into=panel, on_change=update)
a = ui.dropdown(sorted(set(df["species"])), into=panel, on_change=update)

layout.add(panel, area="side")
layout.add(ui.kpi(len(df), label="Rows"), area="main")
layout.add(df.head(10), area="table")
layout
```

## Technical core

The enabler is **mountable widgets**: `_registerInto` (js/ui.js:983)
must accept a mount target — an element id from the `_els` registry —
instead of always resolving a strip. Everything else the controls have
(value store, stable keying across reruns, debounce, `sync_to` push,
handler channel, `_writeControlValue`/`_updateControlSpec`) is reused
UNCHANGED; after phases 2–3 even the rendering (`Ui.makeNode` recipes)
and the facade logic (`shared/ui_core.py`) are already shared.
Containers themselves are thin: element-engine nodes with layout
classes in app.css (light+dark), a `.add` that composes existing
`elAppend`/`elPayload`/target-registry semantics, and a small
grid-template parser (`"a b | c d"` → `grid-template-areas`).

Facade surface: `row`/`column`/`grid` join the curated `ui.*` layer in
`shared/ui_core.py` where pure (template parsing, kwarg assembly), with
dialect bits injected per the phase-3 configure pattern. `into=`
threading: the facade passes the container's element id in the control
spec; JS resolves it against `_els` at register time. Lifecycle: a
control mounted in a container follows the CONTAINER's lifecycle (dies
when the container's cell output is cleared), while keeping its value
in the store under its stable key — exactly like strip controls today.

## Rejected alternatives (assessed in-session, kept for the record)

- **Web components for slider/dropdown**: no consumer today that
  wrappers can't serve; adds shadow-DOM theming and an attribute API
  to keep in sync with Python. Door stays open (phase-2 spec wording).
- **Assignment syntax as placement signal** (`x = ui.slider()` defers,
  bare mounts): collides with the pull model (`n` IS the value — the
  entire example base), requires AST context brython/micropython can't
  provide (text heuristics), and makes one expression's TYPE depend on
  syntactic position (calls inside lists/comprehensions undefined).
  The `into=` kwarg expresses the same intent explicitly.
- **Always-handle return** (`ui.slider()` returns object with
  `.value`): breaks `df.head(n)` everywhere; migration cost of the
  whole document corpus for symmetry's sake.
- **Value-subclass proxies** (int subclass with live `.value`):
  `bool` cannot be subclassed (checkbox/switch fall out),
  `type(x) is int` checks break, MicroPython built-in subclassing is
  shaky. Cute, rejected.
- **Two parallel namespaces** (`ui.widget.slider` vs `ui.html.slider`)
  and **swapped naming** (`ui.slider` = raw element): both force every
  user to learn the widget/element distinction before their first
  line — the distinction this phase abolishes as a user concept; the
  swap additionally renames the most-used API in favor of the
  least-used and ends with two nearly-identical sliders. Rejected.
- **Cell-attribute layout DSL** (reviving mosaic as `#%%`-attrs):
  the 2026-07-18 decision stands — layout is a code-level API;
  `cols=` covers the attribute-level simple case.

## Out of scope

- **Routing CELL output into grid areas** (`#%% python into=layout.main`):
  touches the document model (cell output slots). `.add()` +
  `.show(target=)` cover code-built dashboards; revisit with usage
  experience.
- Colab param parity (`#@title`, `#@markdown`) — separate small phase
  (roadmap), lives entirely in param-forms.js; `display-mode:"form"`
  is a VIEW feature and must be designed with the `#options.view`
  family, not param parsing.
- Automatic global `sl`/`pico` names.
- R/webR: frozen (phase 3); containers and `into=` are python-family
  only, with the standard polite error in R.

## Phasing & testing

- **4a — `sync_to` pin + docs** (small, independent, ships first;
  the seeding itself already exists — see decision 7): a ui-dom test
  pinning the registration-time `_syncPush`, plus the sync_to value
  channel and self-shadow caveat documented in
  `docs/interactive-elements.html`.
- **4b — mountable widgets + containers**: characterization first
  (existing widget suites must pass unchanged — strip behavior is
  frozen), then `_registerInto` mount-target, then the three
  containers + `.add`, then facade surface (`ui_core` + twins +
  drift-tripwire SHARED/MIRRORED list updates), then docs
  (`interactive-elements.html` gains a Containers section) and an
  example document (`examples/python/py_containers.txt` + brython
  twin). Browser sweep: container-mounted controls in all three
  python runtimes, value store surviving rerun, `on_change`/`sync_to`/
  `rerun=` in container mode, both themes.
- Each sub-phase gets its own implementation plan and lands
  independently, same process as phases 1–3.
