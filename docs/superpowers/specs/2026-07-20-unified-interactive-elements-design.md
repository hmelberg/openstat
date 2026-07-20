# Unified interactive elements: display policy v2 + one engine under `ui.*` (design)

**Status:** APPROVED 2026-07-20 (discussion with Hans 2026-07-19/20);
Phase 1 DELIVERED 2026-07-20 (plan 2026-07-20-display-policy-v2.md);
Phase 2 DELIVERED 2026-07-20 (plan 2026-07-20-shared-node-core.md).
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
3. The expression is immediately followed by `;` → suppressed
   (so `a; b` mutes `a` and shows `b`; `df.head(); # kommentar` is
   muted; `df.head() # note;` is shown — implemented via the
   expression's `end_col_offset`, not line-level text). General
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
  (index.html:7511). The `only_last` boolean is kept as-is (YAGNI —
  no policy object needed): the "all"-policy is simply `only_last=False`
  plus the suppression rules, which apply in both modes; notebook cells
  and script segments now both default to it. The per-segment flag
  wiring around index.html:9969 simplifies accordingly.
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

### Corrected premise (Hans 2026-07-20, scope decision)

Code inspection during phase-2 planning found the original premise
wrong: `js/param-forms.js` does NOT call `js/ui.js`'s builders — it
has its OWN `_BUILDERS` (param-forms.js:605, deliberately duplicated
in W4, documented at :461-464 as the deferred "B2 dedup"). So there
are THREE DOM-construction paths (ui.js builders, param-forms
builders, element engine), and nothing inherits "for free".
Decision: phase 2 unifies the CONSTRUCTION of both builder sets onto
one shared core; each system's WIRING (ui.js: value store + rerun;
param-forms: source-text write-back) is the essence of its feature
and stays untouched.

### What changes

A shared construction core `Ui.makeNode(tag, opts)` is extracted
from the element engine (`elCreate` minus JSON parsing and `_els`
registration — same `_applyElProps` props/attrs/style semantics,
real object in, raw node out, no lifecycle). `Ui.elCreate` becomes
makeNode + registry. Both builder sets then compose it:

- `js/ui.js` `_buildSlider` … `_buildButton` (:561–743): `_el` and
  every direct `document.createElement` + property-assignment idiom
  is replaced by `Ui.makeNode` recipes; the returned
  `{wrap, input, labelEl, readout}` contract, `_wireChange`, play
  timers, and `_registerInto` (:983) are untouched.
- `js/param-forms.js` `_build*` (:505–603): same treatment via the
  now-shared `Ui.makeNode` (load order index.html:583–584 already
  puts ui.js first; the `_commit` write-back wiring untouched).

The builders survive as thin recipes; what is deleted is their
private DOM idioms — after this phase, every element the app
constructs for controls, forms, and `ui.html` flows through ONE
props-application path.

What explicitly does NOT change:

- `registerControl` contract (spec JSON in → current value out).
- Value store (`Ui._values`), `Ui.valuesForCell`, `resetDocument`.
- Keying/update-in-place, ~150 ms slider debounce, play-timer
  semantics, placement strips (top/bottom/left, cell `widgets=`
  attr), `sync_to` push.
- `#@param`: syntax, parsing, write-back and run:auto semantics
  untouched — only its builders' node construction moves to
  `Ui.makeNode`. Its test suite doubles as an acceptance gate.

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

### Corrected premise and revised strategy (Hans 2026-07-20)

Function-level analysis during phase-3 planning invalidated two
assumptions in the original text above the fold: (a) the facades'
per-control functions are ALREADY thin — js/ui.js's `normalizeSpec`
owns defaults/validation since W1, so there is no fat per-control
logic to move; (b) the heavy shared functions the twins' docstrings
call "mirrored byte for byte" are in fact dialect-ENTANGLED
(`_normalize_kwargs` 0.69 similarity, `_make_event_wrapper` 0.16,
`_register` 0.58, `Element` 0.87 — ffi differences run through the
bodies, not just the imports). Only ~260 code lines are provably
identical across all three, ~220 more near-identical.

Decision (two rounds with Hans 2026-07-20): drop the
JS-migration/`callControl` design. Instead: **incremental shared
Python core + drift tripwire**:

- **`shared/ui_core.py`** — ONE file holding the provably-identical
  set: tag/accepts tables (`HTML_TAGS`, `_SL_ACCEPTS`, `PICO_*`),
  pure helpers (`_snake_to_camel`, `_json_safe`, `_spec`), and the
  identical API functions (`kpi`, `markdown`, `play`, `run_button`,
  `run_cell`, `widget`, `_tag_builder`, `_append_children`, …).
  Dialect symbols the moved functions need (`_register`,
  `_register_value`, window access, …) are INJECTED by each facade
  via `ui_core.configure(...)` — the core never imports
  `js`/`browser`/jsffi itself.
- **Loading**: brython/micropython engines' existing lib registries
  gain an optional per-entry `path` field so `ui_core` can resolve
  to `shared/ui_core.py` and be declared as `deps` of the ui entry;
  pyodide's `__ensureUi` fetches the core file alongside ui.py.
- **Dialect-entangled functions stay per-facade** (`_normalize_kwargs`,
  `Element`, event wrappers, `_register`, `value`, `image`, `lib`,
  namespaces) — extracting them means refactoring the ffi out of
  their bodies, which is the risk this decision declines.
- **Twin-drift tripwire**: a pytest that ast-extracts the still-
  mirrored functions from the three facades and fails when a
  one-sided edit lowers their normalized similarity below recorded
  floors (synchronized edits keep similarity high and pass). Public
  API name parity across the three is asserted exactly.
- **webr/ui.R**: FROZEN. Keeps today's widget behavior against the
  stable `registerControl`/`registerFromRegistry` contract. Header
  comment + user docs mark it legacy ("fryst 2026-07-20; ui.html og
  nye kontroller kommer ikke til R uten ny beslutning"). Revisit
  only on user demand.

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
- Phase 3 (revised): existing facade suites stay the behavioral
  contract and must pass unchanged after the core extraction; the
  new twin-drift tripwire test guards the functions that remain
  mirrored per-facade.

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
