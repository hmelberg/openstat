# Unified interactive elements: display policy v2 + one engine under `ui.*` (design)

**Status:** APPROVED 2026-07-20 (discussion with Hans 2026-07-19/20).
Three-phase plan. Follows the unified-document-model line
(`2026-07-15-notebook-widgets-design.md`,
`2026-07-17-ui-html-design.md`).

## Motivation

Today there are three user-facing ways to make interactive elements —
`#@param` forms, `ui.*` controls, `ui.html` builders (plus the isolated
ipywidgets bridge). That layering is a FEATURE (three levels of
abstraction for three audiences). The problem is that the
*implementations* are parallel:

- `js/ui.js` has a dedicated control-builder path
  (`_buildSlider`/`_buildDropdown`/… , js/ui.js:561–743) SEPARATE from
  the element engine (`elCreate`/`elSetProps`/… , js/ui.js:1933+).
- Four mirrored language facades (`pyodide/ui.py` 1380 lines,
  `brython/ui_brython.py` 1305, `micropython/ui_mpy.py` 1401,
  `webr/ui.R` 332) each duplicate spec-building, kwargs
  normalization and value coercion — a real 4× maintenance
  multiplier.
- Display is inconsistent: notebook cells show only the LAST bare
  expression; whole-script "Kjør" echoes every top-level expression.

**Decision (Hans 2026-07-20):** keep all three entry points as
user-facing layers; collapse them onto ONE engine (the `ui.html`
element engine). Cross-runtime parity is explicitly deprioritized:
pyodide is the reference implementation; brython/micropython ride
along cheaply; R is frozen at today's widget behavior.

## Summary

1. **Phase 1 — Display policy v2** ("a value on its own line shows
   itself, everywhere"): notebook cells show ALL bare expressions,
   not just the last. Suppression: `None` (already), bare names with
   `_` prefix, trailing `;` as the general mute, and no scalar echo
   from bare `ui.*` control calls.
2. **Phase 2 — Re-platform controls**: `ui.slider`/`ui.dropdown`/…
   keep their exact API and semantics but are rebuilt as thin
   recipes over the element engine. The parallel `_build*` render
   path in js/ui.js is deleted. `#@param` inherits the new builders
   for free (it reuses Track-1 renderers).
3. **Phase 3 — Slim the facades**: move spec-building/normalization
   JS-side so each facade becomes a dumb pipe (~100–150 lines).
   `webr/ui.R` is frozen as documented legacy.

## Global constraints

- **No user-facing API removal.** `n = ui.slider(10, 200)` keeps
  working byte-for-byte; `#@param` untouched at syntax level;
  ipywidgets bridge (`js/ipywidgets-bridge.js`) untouched.
- **Pull model unchanged**: control calls synchronously return the
  current stored value; value changes rerun `rerun=`/`on_change=`
  targets via the existing `_wireChange`/`_syncPush`/`_rerunFor`
  wiring (js/ui.js:546/507/466).
- **Stable keying preserved**: `(cellIdx, name|declaration-order)`
  keys with `data-ui-key`; reruns update in place, never duplicate.
- **Trust model unchanged**: everything renders only on Kjør/cell
  run; the static `htmlTrusted` gate for `#%% html` cells untouched.
- **mdRunNotebookCell contract untouched.** ES5 var-style JS,
  Norwegian comments, `t()` + en.js.
- **Web components are not an aim in this round.** Polished
  components come from `#tag.import` (shoelace/pico). Building our
  own custom elements stays open as a future option — and may be
  used within this plan if a concrete case turns up where a custom
  element is the natural fit (e.g. a control wrapper that needs
  encapsulated markup/styling) — but no phase depends on it.

## Phase 1 — Display policy v2

### Rule

In notebook cells AND whole-script runs, every top-level bare
expression displays via `_show_one`, EXCEPT:

1. Value is `None` → suppressed (existing behavior, kept).
2. The expression is a bare `ast.Name` whose id starts with `_` →
   suppressed. Rationale: loop temps and "private" intermediates.
   Only bare names — `_df.describe()` still displays (it's a call,
   author asked for it).
3. The statement's source line ends with `;` → suppressed. General
   escape hatch (IPython/MATLAB convention), works for any
   expression, and is the documented answer when `_`-prefix
   collides with a name someone wants shown.
4. The expression is a bare `ui.*` CONTROL call (slider, dropdown,
   checkbox, switch, number, text, button, run_button, play) →
   control renders as today (registration side effect), but the
   returned scalar is NOT echoed. Without this, a bare
   `ui.slider(0, 100)` line would print `55` under the slider.
   Detection is AST-side (a return-value marker is impossible —
   controls return plain scalars): a bare `Expr` whose call func is
   `Attribute(value=Name('ui'), attr=<control name>)`. An aliased
   module (`import ui as u`) is not detected; the `;` mute is the
   documented workaround for that corner. `ui.html.*` calls are NOT in the list — elements
   keep displaying themselves (duck-typed `_openstat_el_id` in
   `_show_one`, index.html:7457).

### Where

- **pyodide** (reference): `_exec_pyodide_block`
  (index.html:7511). The `only_last` flag becomes a display-policy
  object; notebook cells and script segments use the same "all bare
  expressions" policy. The per-segment flag wiring around
  index.html:9969 simplifies accordingly.
- **brython/micropython**: their runners use statement-aware TEXT
  heuristics (no `ast` available — brython_runner.py:69,
  micropython_runner.py:85) that detect only the TRAILING
  expression. Accepted divergence for now: these runtimes keep
  trailing-expression display, but apply rules 2–4 to that trailing
  expression. Upgrading them to all-expression display is a
  possible later step, not part of this plan.
- **R/webR**: untouched (R's own visibility rules apply).

### Docs

The one-sentence mental model goes in the user docs: *"Et navn eller
uttrykk alene på en linje vises. Demp med `_`-prefiks eller `;`."*

## Phase 2 — Re-platform controls onto the element engine

### What changes

Each control builder (`_buildSlider` … `_buildButton`,
js/ui.js:561–743, dispatch table :743) is reimplemented as a recipe
that composes the element engine: `elCreate('input', …)` /
`elSetProps` / label + wrapper markup, then hands the node to the
EXISTING register/refresh core (`_registerInto`, js/ui.js:983).
After parity is proven, the old `_build*` functions are deleted.

What explicitly does NOT change:

- `registerControl` contract (spec JSON in → current value out).
- Value store (`Ui._values`), `Ui.valuesForCell`, `resetDocument`.
- Keying/update-in-place, ~150 ms slider debounce, play-timer
  semantics, placement strips (top/bottom/left, cell `widgets=`
  attr), `sync_to` push.
- `#@param`: `js/param-forms.js` keeps calling the same builder
  entry points; it gets the new rendering with zero syntax changes.
  Its test suite doubles as an acceptance gate.

### Method: characterization first

Before touching builders, capture current behavior as tests (extend
existing widget suites): per control — initial render, value
round-trip, rerun-updates-in-place (no duplicate nodes), debounce,
`rerun=`/`on_change=` targeting, placement, `#@param` write-back.
These tests must pass unchanged after the swap. This phase carries
the regression risk of the whole plan; the tests are the contract.

### Why bother (payoff)

- One rendering path: styling fixes, a11y, and future component
  work land once.
- Controls become styleable/composable like any element (same CSS
  surface as `ui.html`).
- Opens the later option of letting `#tag.import`-ed component
  libraries back `ui.*` controls (e.g. a Shoelace slider) without
  API change. NOT in scope now — the option is the point.

## Phase 3 — Slim the facades

### What changes

Move all per-control logic that is duplicated 4× python-side into
`js/ui.js`:

- Spec building + defaults (min/max/step/label/name/rerun/…).
- Kwargs normalization for elements (`_normalize_kwargs`,
  pyodide/ui.py:680: `cls`→`class`, style dict + snake→camel,
  `data_`/`aria_`, booleans, attrs escape hatch).
- Value coercion/validation.

A facade then does exactly: serialize the call (name + positional +
kwargs as JSON) → `window.Ui.callControl(...)` /
`window.Ui.callElement(...)` → unwrap the return. Target size
~100–150 lines per facade; the `Element` wrapper class keeps its
python ergonomics (`.add`, `.on`, `.show`, …) but each method is a
one-line bridge call.

- **pyodide/ui.py** is rewritten first and is the reference.
- **brython/micropython** facades follow the same shape; their only
  legitimate differences are the js-bridge dialect (`import js` vs
  `from browser import window` vs jsffi). Drift becomes structurally
  impossible because there is no logic left to drift.
- **webr/ui.R**: FROZEN. Keeps today's widget behavior against the
  stable `registerControl`/`registerFromRegistry` contract. Header
  comment + user docs mark it legacy ("fryst 2026-07-20; ui.html og
  nye kontroller kommer ikke til R uten ny beslutning"). Revisit
  only on user demand.

### Error handling

JS-side validation errors return a structured
`{error: "..."}`; facades raise it as a normal python exception with
the original call site in the message. No silent fallbacks (matches
the `ui.html` "warn loudly" decision).

## Phasing & dependencies

1. **Phase 1** is independent and ships first (smallest, immediate
   UX win, makes the "elements self-display" story uniform before
   more people write `ui.html` code).
2. **Phase 2** depends on nothing in phase 1; ships behind its
   characterization suite.
3. **Phase 3** depends on phase 2 (the JS engine must own rendering
   before it can own spec-building).

Each phase gets its own implementation plan
(docs/superpowers/plans/) and lands independently.

## Testing

- Phase 1: pytest cases over `_exec_pyodide_block` covering the four
  suppression rules × notebook/script; brython/mpy trailing-expr
  rule tests in their suites.
- Phase 2: characterization suite (above) + existing
  `FakeUiJs`-based facade suites + `js/param-forms` suite unchanged.
- Phase 3: facade suites shrink to bridge-contract tests; a shared
  JSON fixture of call→spec pairs is asserted identically from
  pyodide and brython/mpy to prove the pipes are equivalent.

## Non-goals

- Removing or deprecating the `ui.*` API, `#@param`, or ipywidgets.
- Web components as a goal in themselves. Not ruled out — a phase
  MAY reach for a custom element where it is clearly the best fit,
  and the re-platformed engine deliberately keeps that door open
  (custom-element factories already exist via `#tag.import`) — but
  this round succeeds without any.
- `ui.html` support in R.
- All-expression display in brython/micropython (trailing-expr
  divergence accepted and documented).
- Reactive dependency graph / auto-rerun on variable change (pull
  model stays).
