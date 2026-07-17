# `ui.html` element builders, library imports, widget callbacks (design)

New phase in the unified-document-model line (between phase 4 and the
dash absorption — approved ordering: this phase FIRST, dash absorption
builds on it). All decisions resolved with Hans 2026-07-17 (three
discussion rounds in-session). Prior art: the code2web repo's `ui.py`
(mined 2026-07-17 — its factory/namespace patterns adopted, its known
warts explicitly fixed; see §2).

## Summary

Four capabilities, python modes first (pyodide/brython/micropython —
all main-thread, DOM bridge available). R/webR deferred (worker, no DOM
bridge; polite notice; future path = the registry/declare-channel).

1. **`ui.html.*` element builders**: `x = ui.html.div("Some text",
   id="hi")` creates a REAL DOM node via the python↔JS bridge. ~110
   standard tags via a generic factory (code2web's tag-string+factory
   pattern, but namespaced under `ui.html` — no globals injection, so
   `input`/`object` never collide with python builtins).
2. **Mounting**: elements are displayable values — the existing
   last-bare-expression display policy mounts them into the cell's
   slot (decision: option (c); no line-sniffing (a) — rejected as
   text-level magic). `.show(target=None)` is the explicit form:
   no-arg = append to the running cell's slot now; `target="dom-id"` =
   replace-into-target with the W5 target-registry semantics
   (replace + sweep on rerun).
3. **Widget callbacks + value getter**: `on_change=`/`on_click=` on
   widgets additionally accept a python **callable** (today: cell
   names only); `ui.value("name")` reads a control's current value
   from the store without running anything.
4. **Library imports**: repeatable `#tag.import` in the preamble —
   `#tag.import = shoelace` / `= pico` (curated shortcuts → `ui.sl.*`
   / `ui.pico.*`) and the general form
   `#tag.import = <url> as <navn>` where **navn doubles as the
   custom-element prefix**: `ui.acme.button()` → `<acme-button>`.
   `.css` URLs load as stylesheets (no namespace).

## Global constraints

- **The pull model and all existing widget behavior unchanged**;
  `on_change="cellnavn"` (alias for rerun) keeps working exactly as
  today — the callable form is additive.
- **Facade twins**: pyodide/brython/micropython mirror byte-for-byte
  except documented dialect differences (js bridge access:
  `import js` / `from browser import window,document` / jsffi).
- **Trust model unchanged**: builders/imports execute only when code
  runs (Kjør / cell run) — the same gate as widgets/dash. The static
  `htmlTrusted` gate for `#%% html` cells is untouched. Shared-link
  autorun keeps its existing gate; `#tag.import` loading happens at
  run time behind it.
- **mdRunNotebookCell contract untouched.** Hybrid segment machinery
  untouched. ES5 var-style JS, Norwegian comments, `t()` + en.js.
- R mode: `ui.html`/imports → polite notice (`ui_html`-calls in webR
  raise a clear "ikke støttet i R ennå" error string), never a crash.

## 1. The builder (`ui.html`)

- **Namespace object** `ui.html` with `__getattr__` → generic factory
  for any tag in the standard list (space-delimited constant, ~110
  tags, adopted from code2web ui.py:4481); unknown attribute → clear
  AttributeError listing the tag list source.
- **Children**: positional varargs — strings become text nodes,
  elements append, lists flatten one level, `None` skipped. `.add(*
  children)` appends later. No context-manager form (YAGNI).
- **Returns the live element handle** (a python wrapper holding the JS
  node): methods `.add`, `.clear`, `.on(event, handler)` (python
  callable — routes through the same callback plumbing as §3),
  `.set_style(**styles)`, `.add_class`/`.remove_class`, `.show(
  target=None)`, plus `.el` (the raw JS node) as the escape hatch.

### The unified kwargs standard (fixes code2web's warts)

One handler for ALL elements (standard + custom), based on code2web's
*custom-component* path (its stronger one), generalized:

- `cls=` **and** `class_=` → `class` (both accepted; code2web only had
  `cls`).
- `style=` accepts a **string or a dict** (dict keys snake_case →
  camelCase) — construction and `.set_style` finally agree.
- `data_x=1` → `data-x="1"`; `aria_label=` → `aria-label=` (underscore
  → hyphen for `data_`/`aria_` prefixes).
- `attrs={"any-name": "v"}` escape hatch for arbitrary attribute
  names.
- `on_click=fn` etc. → event listener when the value is callable
  (routed via §3's register); a **string** value is NOT executed
  (code2web exec'd strings — dropped, warn instead).
- Booleans → attribute presence/absence.
- Everything else: DOM **property when it exists, else
  `setAttribute`**; dict/list values JSON-encoded via setAttribute
  (the web-component convention).
- Failures warn loudly (`console.warn` via the bridge) — never the
  silent try/except code2web had.

## 2. Mounting

- **Default (option c)**: the element handle is displayable — the
  engines' display pipeline (the `_fmt`/`mdRenderOutput` path W5
  established, extended with an element branch) appends the node into
  the running cell's `.nb-output-body` when the handle is the cell's
  last bare expression. Plain scripts: `#outputArea` (the doc-level
  sink, phase 3 precedent). Nothing auto-mounts without being written
  as an expression — no underscore rule needed.
- **Explicit**: `.show()` appends to the running cell's slot
  immediately (multiple mounts per cell, mid-cell mounts).
  `.show(target="dom-id")` mounts into the target with **replace**
  semantics through the same registry `ui.on`'s `target=` uses (W5) —
  re-running the declaring cell replaces, sweep on document reset.
- **Lifecycle**: slot-mounted elements live in the slot and are
  cleared by the normal slot-clearing on rerun (same as any output).
  Target-mounted elements follow the W5 target-registry lifecycle.
- Rejected: mounting every `ui.`-prefixed line (fragile line-level
  sniffing; widgets already self-mount) — decision logged 2026-07-17.

## 3. Widget callables + `ui.value`

- `on_change=`/`on_click=` on all value controls/buttons accept a
  **callable** in addition to today's cell-name strings. Dispatch rule
  in the facades: callable → callback register; string → rerun alias
  (unchanged). Handler signature for widgets: `handler(value)` (the
  new value; simpler than a DOM event — `ui.on` keeps its
  `handler(event)` for element-level work).
- Mechanism: reuse W5's per-cell callback register and bracket
  machinery (only names cross the bridge). Widgets get a stable DOM
  identity (`data-ui-key` = the existing controlKey) so js/ui.js can
  fire the registered callable on change, AFTER the value-store write
  and any `sync_to` push, INSTEAD OF a rerun (a control with a
  callable does not also rerun; documented).
- Return-value rendering: same as `ui.on` handlers (W5 pipeline:
  rendered into the declaring cell's slot / `target=`).
- **`ui.value(name)`**: returns the current stored value of the
  control named `name` anywhere in the document (names should be
  unique; duplicates → console.warn + most recently registered wins);
  `None` when unknown. Synchronous (main-thread store read). All
  three python facades; R gets `ui_value(name)` reading the injected
  `.ui_values` (best-effort, documented as per-run snapshot).

## 4. `#tag.import`

- **Syntax**: `#tag.import = <spec>` where `<spec>` is either a
  registry key (`shoelace`, `pico`) or `<url> as <navn>`
  (`#tag.import = https://cdn.example.com/acme.js as acme`). A bare
  `.css` URL (no `as`) loads as a stylesheet.
- **Repeatable**: the scanner's `entries` array (which keeps every
  occurrence — the last-wins `tags` map is bypassed for this key)
  yields all imports. Document-scope: consumed from the PREAMBLE
  block only; `#tag.import` in a cell block → warning, ignored.
- **Loading**: at run time (Kjør / first cell run), before user code:
  JS loaded as `<script type="module">` (component libraries are
  modules today; a classic-script fallback flag is out of scope),
  CSS as `<link rel="stylesheet">`; both idempotent per URL, failures
  → status warning, run continues. Curated entries live in a small
  registry (LIB_REGISTRY-style) with pinned CDN URLs + their CSS.
- **Namespaces**: `ui.<navn>.*` via a dynamic prefix factory —
  `ui.acme.split_panel()` → `<acme-split-panel>` (snake→kebab), built
  by the SAME factory/kwargs standard as `ui.html`. Curated:
  `shoelace` → `ui.sl.*` (plus code2web's `accepts` child-whitelist
  validation for known components); `pico` → `ui.pico.*` (CSS-class
  mapping onto plain elements — inherently curated, not generic).
  Namespaces exist lazily: accessing `ui.<navn>` for an un-imported
  navn raises a clear error naming the `#tag.import` line to add.

## Error handling

- Builder misuse (unknown tag, bad kwargs value): loud, specific
  python exceptions/warnings — never silent.
- `.show(target=...)` with a missing target: the W5 fallback
  (declaring cell's slot + varsel).
- Import failures (404, CSP): status warning with the URL; the run
  continues; `ui.<navn>` then raises the clear not-loaded error.
- Callable handler raising: rendered as the error payload in the
  slot (W5 error-payload path).

## Testing

- **pytest (facade suites, FakeUiJs/Fake-document pattern)**: kwargs
  matrix (cls/class_/style-str/style-dict/data_/aria_/attrs/bool/
  property-vs-attribute/JSON), children flattening, tag factory,
  namespace prefix mapping incl. snake→kebab, on_change-callable vs
  string dispatch, ui.value semantics, twins in sync (mirrored suites,
  the established convention).
- **node (js side)**: callback firing on control change (callable
  registered → fired with value, no rerun), data-ui-key identity,
  import loader idempotence (stub), target-mount reuse of the W5
  registry.
- **Exit gate (browser, all three python engines)**: build a small
  page (`ui.html.div` + nested elements + styles + data-attrs);
  last-expression mount + .show(target=) into an html cell; shoelace
  via `#tag.import = shoelace` (`ui.sl.button` renders and fires an
  on_click callable); pico shortcut; a generic URL import (`as x`);
  widget `on_change=callable` updates DOM without rerun; `ui.value`
  read from a handler; rerun lifecycle (no duplicate mounts); shared
  link (gate intact); plain script variant; both themes; R mode →
  polite notices, no crash.

## Out of scope (documented)

- R/webR builders (worker — needs the declare-channel; later).
- Classic (non-module) script imports; SRI for arbitrary URLs
  (curated entries may pin).
- Context-manager (`with`) building; HTML-string parsing input.
- Server-side/publish snapshotting of built DOM (phase 5's publish
  work will address baking).

## Phasing

Single plan, expected 6 tasks: (1) js/ui.js — element/callback
plumbing (data-ui-key, callable register + change dispatch, mount
branch in the render pipeline, target-registry reuse, import loader);
(2) pyodide facade — `ui.html` builder + kwargs standard + `ui.value`
+ callable dispatch + pytest; (3) brython/micropython twins + pytest;
(4) `#tag.import` consumption (preamble scan, registry, curated
shoelace/pico incl. `accepts` + pico class map, lazy namespaces);
(5) R-mode notices + ui_value snapshot; (6) examples + browser exit
gate.
