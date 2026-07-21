# Phase 4b: Mountable Widgets + Containers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 4b of `docs/superpowers/specs/2026-07-21-explicit-containers-design.md`: controls become mountable into containers (`into=` kwarg → control lives inside an element, call returns the `WidgetHandle`), and three container types (`ui.row`, `ui.column`, `ui.grid`) with an extended `.add(child, area=, span=, align=)` land in the curated `ui.*` layer.

**Architecture:** Everything reuses delivered machinery. JS side: `_registerInto` (js/ui.js:975–1097) gains a mount-target branch — when `spec.into` names an element id from the `_els` registry, the control's wrap mounts there instead of the strip; value store, stable keying, debounce, sync_to, handler channel, `_updateControlSpec` are untouched. `registerControl`'s return is EXTENDED (only when `spec.into` is present — backward compatible) to include `key` and the control's `name` so the facade can build a `WidgetHandle`; a tiny `Ui.widgetValue(key)` getter gives nameless handles a live `.value`. Facade side: the mirrored control functions get an `into=None` passthrough + handle-return (synchronized 3× edit, guarded by the drift tripwire); `play` lives in `shared/ui_core.py` (single edit). Containers are pure sugar in `ui_core`: `ui.grid` parses its template python-side and pre-creates one child div per named area (`gridArea` style) via the existing element engine — `.add(x, area="plot")` clears + renders into that child (replace semantics for free), `.add` without `area` appends. CSS: three layout classes in app.css.

**Tech Stack:** ES5 JS + Norwegian comments (js/ui.js, app.css); Python (MicroPython-safe) in shared/ui_core.py + three facades; node --test + pytest.

## Global Constraints

- **Strip behavior byte-frozen**: every existing widget/param test must pass unchanged. A control WITHOUT `into=` behaves exactly as today, including its return value (the pull model).
- `into=` and `placement=` are mutually exclusive: both given → `console.warn` + `into` wins. A control switching strip↔container (or container→other container) between runs takes the existing placement-change path (old wrap removed, fresh build in the new host, `_values[key]` PRESERVED).
- On EVERY registration with `into=`, the wrap is (re)appended to the resolved host (appendChild moves the node — this is what re-parents surviving nodes into a freshly rebuilt container on rerun). Unknown/missing `into`-id → `console.warn` + fallback to the strip (a control must never be lost).
- `registerControl`'s return contract for into-less specs is UNCHANGED (a bare JSON value). The extended `{"__into": true, "value": ..., "key": ..., "name": ...}` shape appears ONLY when `spec.into` was present.
- Facade edits to the mirrored control functions (slider, dropdown, checkbox, switch, number, text, button) are applied IDENTICALLY in all three facades; the drift tripwire's floors are recalibrated in the same commit if needed (synchronized edits keep similarity high — floors should barely move; document any adjustment).
- `shared/ui_core.py` stays dialect-free (configure-injection for anything new it needs). ES5/Norwegian comments in JS. index.html is NOT edited (bump `?v=` for js/ui.js and app.css at the final task instead — both change here).
- R: frozen — `into=`/containers do not reach `webr/ui.R`.
- Commit after every task, Norwegian messages.

## File map

- `js/ui.js` — `_registerInto` mount branch (~:975–1097), `Ui.widgetValue` (next to `Ui.widgetSet`), spec normalization accepts `into` (find `normalizeSpec`/validation and add `into` as a pass-through string field)
- `app.css` — `.os-row`, `.os-col`, `.os-grid` layout classes (follow the file's var()-based theming conventions)
- `shared/ui_core.py` — `row`/`column`/`grid` + template parser + `play` gains `into=`; `Element.add` extended (`area=`, `span=`, `align=`, value-payload children)
- `pyodide/ui.py`, `brython/ui_brython.py`, `micropython/ui_mpy.py` — `into=` on the seven mirrored controls, handle-return, `WidgetHandle.value` key-fallback
- Tests: `tests/js/ui-dom.test.js`, `tests/test_ui_module.py`, `brython/tests/test_ui_brython.py`, `micropython/tests/test_ui_mpy.py`, `tests/test_ui_core_drift.py` (floors), plus a new pure-python test section for the grid parser
- Docs/examples (Task 4): `docs/interactive-elements.html`, `examples/python/py_containers.txt`, `examples/brython/bry26_containers.txt`, `docs/ROADMAP.md`

---

### Task 1: JS — mount-target in `_registerInto`, extended return, `Ui.widgetValue`

**Files:**
- Modify: `js/ui.js`
- Test: `tests/js/ui-dom.test.js`

**Interfaces:**
- Produces (Task 2 consumes): `spec.into` (string el-id) honored by `registerControl`; return JSON becomes `{"__into": true, "value": <v>, "key": "<controlKey>", "name": <spec.name or null>}` when `spec.into` present; `Ui.widgetValue(keyJson…)` — takes the raw key string, returns `JSON.stringify(_values[key])` or `null` for unknown keys.

- [ ] **Step 1: Failing tests first (append to `tests/js/ui-dom.test.js`; harness idioms from the existing register-tests, element creation via `Ui.elCreate` as in the elCreate tests)**

Test list (write them all; assertions are the contract):
1. `into: kontroll monteres i element, IKKE i stripa` — `const host = Ui.elCreate('div');` then register a slider with `into: host`; assert the wrap is a child of `Ui.elNode(host)`, the strip has no children, and the parsed return equals `{ __into: true, value: 40, key: <truthy>, name: 'x' }`.
2. `into: re-registrering flytter SAMME node inn i NY container` — register into host A, keep a reference to the wrap node, register same spec into a fresh host B; assert SAME wrap object, now child of B, old value preserved.
3. `into: verdilager overlever rerun-syklus` — register into host with value 40, simulate change to 70 (input event idiom from :351), `endCellRun`/`beginCellRun` cycle as neighbouring tests do, re-register → returned value 70.
4. `into + placement: warn, into vinner` — spy on console.warn as the file's other warn-tests do; register with both; wrap lands in the host.
5. `into: ukjent el-id → warn + fallback til stripa` — register with `into: 'el9999'`; wrap in strip; return is the PLAIN value (no `__into` wrapper — fallback means no handle contract).
6. `widgetValue: live verdi per nøkkel, null for ukjent` — after test 3's flow, `Ui.widgetValue(key)` returns `'70'`; unknown key → null.
7. `uten into: retur og oppførsel BYTE-uendret` — register a plain slider; assert the return is the bare value JSON (no object wrapper).

- [ ] **Step 2: Run — new tests fail, all existing pass**

Run: `node --test tests/js/ui-dom.test.js`

- [ ] **Step 3: Implement in `js/ui.js`**

(a) Spec validation: find where spec fields are normalized/validated (search `normalizeSpec` / the validation starting ~:136) and accept `into` as an optional string, passed through untouched.

(b) In `_registerInto`: after `var pos = _effectivePlacement(spec, cellEl);` resolve the host —

```js
      // fase 4b (spec 2026-07-21): into= — monter kontrollen i et element
      // fra _els-registeret i stedet for stripa. Ukjent id → warn +
      // stripe-fallback (en kontroll skal aldri forsvinne). into vinner
      // over placement (gjensidig utelukkende, warn ved begge).
      var intoNode = null;
      if (spec.into) {
        if (spec.placement) console.warn('Ui: into= og placement= er gjensidig utelukkende — into vinner');
        var intoEntry = _els[spec.into];
        intoNode = intoEntry ? intoEntry.node : null;
        if (!intoNode) console.warn('Ui: ukjent into-mål ' + spec.into + ' — faller tilbake til stripa');
      }
      var strip = intoNode || _ensureStrip(cellEl, cellIdx, pos);
```

(c) Host-switch detection joins the placement-change rule: store the mount identity on the control (`intoId: spec.into || null` in the `_controls[key]` records) and extend the `placementChanged` condition to also trigger when `existing.intoId !== (spec.into || null)`.

(d) Re-parent on every into-registration: in the `existing` branch (after `_updateControlSpec`), when `intoNode` is set, `intoNode.appendChild(existing.wrap)`.

(e) Extended return at BOTH return sites (`button` and the main one): when `intoNode` (i.e. the mount actually happened — NOT on fallback), return `{ value: …, key: key, __into: true, name: spec.name || null }` — then find `Ui.registerControl` (the JSON boundary, ~:1099) and make it serialize the object form when `__into` is present, the bare value otherwise (read how it serializes today and extend minimally).

(f) `Ui.widgetValue` next to `Ui.widgetSet`:

```js
    /**
     * Ui.widgetValue(key) → JSON-streng med kontrollens LAGREDE verdi,
     * eller null for ukjent nøkkel — nøkkel-varianten av Ui.value(navn)
     * (fase 4b: håndtak for NAVNLØSE into-kontroller trenger live .value).
     */
    Ui.widgetValue = function (key) {
      if (!_values.hasOwnProperty(key)) return null;
      try { return JSON.stringify(_values[key]); } catch (e) { return null; }
    };
```

- [ ] **Step 4: Full JS suite**

Run: `node --test tests/js/*.test.js`
Expected: all pass (existing counts + 7)

- [ ] **Step 5: Commit**

```bash
git add js/ui.js tests/js/ui-dom.test.js
git commit -m "feat(ui): into= — kontroller kan monteres i elementer (fase 4b); utvidet registerControl-retur + Ui.widgetValue for nøkkelbaserte håndtak"
```

---

### Task 2: Facades — `into=` passthrough + handle return (3× synchronized) 

**Files:**
- Modify: `pyodide/ui.py`, `brython/ui_brython.py`, `micropython/ui_mpy.py`, `shared/ui_core.py` (`play` + a shared `_handle_from_into` helper), `tests/test_ui_core_drift.py` (floor recalibration if needed)
- Test: `tests/test_ui_module.py`, `brython/tests/test_ui_brython.py`, `micropython/tests/test_ui_mpy.py`

**Interfaces:**
- Consumes: Task 1's extended return + `Ui.widgetValue`.
- Produces: every value control + `button` accepts `into=` (an `Element`/container handle); with `into=` the call returns a `WidgetHandle`; `WidgetHandle.value` works without a name (key fallback).

- [ ] **Step 1: Failing facade tests first (mirrored in all three suites, adapted to each file's `FakeUiJs`/loader idiom)**

The FakeUiJs stubs must learn the extended contract: when the registered spec JSON contains `"into"`, `registerControl` returns the object form (`{"__into": true, "value": …, "key": "k1", "name": null}`) — extend each stub minimally, mirroring its existing `next_result` mechanics. Tests per suite:
1. `into=Element` → spec JSON contains `into: "<el-id>"`; call returns a `WidgetHandle` (not the value); `handle.value` hits `widgetValue` with the returned key (record the call in the stub).
2. Without `into=` → returns the plain value (unchanged pull model; reuse an existing test's shape to prove no regression in the same run).
3. `into=` + `placement=` both given → facade passes both through (the WARN lives JS-side; facade must not pre-empt it).
4. Plain-script fallback (no run context: `registerControl` → None) with `into=` → returns a `WidgetHandle` whose `.value` is the spec default (no crash) — DESIGN NOTE: in the no-context fallback there is no key; construct the handle with `key=None` and make `.value` fall back to the remembered default. Pin that.

- [ ] **Step 2: Implement**

(a) `shared/ui_core.py`: a small pure helper used by all facades (injected deps only):

```python
def _handle_from_into(res, name, default):
    """fase 4b: bygg WidgetHandle-retur for into=-kall. res er dict-formen
    fra registerControl ({'__into':..., 'value':..., 'key':..., 'name':...})
    eller None (ingen kjørekontekst). default huskes for no-context-.value."""
    if isinstance(res, dict) and res.get("__into"):
        return _widget_handle_cls(res.get("name"), res.get("key"))
    h = _widget_handle_cls(name, None)
    h._fallback_value = default
    return h
```

(b) Each facade's `WidgetHandle` gains the key-fallback in `.value` (mirrored 3×): if `self._name` is None → if `self._key` is None return `getattr(self, '_fallback_value', None)`; else `Ui.widgetValue(self._key)` (JSON-decoded, same JsNull discipline as `_register`).

(c) Each mirrored control function (slider, dropdown, checkbox, switch, number, text, button) gains `into=None`: when set, extract the el-id (`into._openstat_el_id` — raise a clear TypeError if absent: "into= tar en ui.html-/container-Element"), pass `into=<el-id>` into `_spec(...)`, and route the result through `_register_value`-as-today but return `_core._handle_from_into(raw_result, name, default)` instead of the value. IMPORTANT: `_register`/`_register_value` currently `json.loads` the bare value — the object form arrives as a dict; thread it through without coercion (read each facade's `_register_value` first; keep the change minimal and identical 3×). `play` (in core) gets the same treatment once.

(d) Recalibrate `MIRRORED_FLOORS` in `tests/test_ui_core_drift.py` ONLY if the synchronized edits moved a pairwise ratio below its floor (they should not — verify and report the measured ratios).

- [ ] **Step 3: Run everything**

Run: `python -m pytest tests/ brython/tests/ micropython/tests/ -q` and `node --test tests/js/*.test.js`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add shared/ui_core.py pyodide/ui.py brython/ui_brython.py micropython/ui_mpy.py tests/
git commit -m "feat(fasader): into= på kontrollene — håndtak-retur (uten into: verdien, uendret); WidgetHandle med nøkkel-fallback for navnløse kontroller"
```

---

### Task 3: Containers — `ui.row`/`ui.column`/`ui.grid` + extended `Element.add`

**Files:**
- Modify: `shared/ui_core.py` (containers + grid parser + `Element.add`-extension glue), the three facades (bind the new names; `Element.add` body is facade-side — extend mirrored 3×), `app.css`
- Test: `tests/test_ui_module.py` (+ mirrored), plus pure parser tests in a new section of `tests/test_ui_module.py` or a small `tests/test_ui_containers.py`

**Interfaces:**
- Consumes: element engine (`elCreate`/`elAppend`/`elClear`/`elPayload`) as already wrapped by the facades; Task 2's `into=`.
- Produces: `ui.row(**kw)`, `ui.column(**kw)`, `ui.grid(template, cols=None, rows=None, **kw)` returning Elements; `.add(child_or_list, area=None, span=None, align=None)`; grid template parser `_parse_grid_template("a a | b c") -> {"areas": '"a a" "b c"', "names": ["a","b","c"]}`.

- [ ] **Step 1: Failing tests first**

1. Parser (pure, core-level): `"kpi kpi | plot table"` → CSS `grid-template-areas` string `'"kpi kpi" "plot table"'` and unique names `["kpi","plot","table"]`; ragged rows (different column counts) → ValueError with a readable message; single row without `|` works.
2. `ui.grid` creates the container div with class `os-grid` and one child div PER unique area with `style.gridArea` set (assert via the FakeUiJs `el_calls` recording, same idiom as existing `ui.html` tests).
3. `.add(x, area="plot")` → `elClear` on the area child, then render into it (element child → `elAppend`; VALUE child → `elPayload` with the same payload classification `on_change` results use — reuse `_payload_element`/the injected payload path). Second `.add` to same area replaces (another `elClear` first).
4. `.add` without `area` on row/column appends a new child (no clear). `.add([a, b])` adds each. `span=2` → child style `gridColumn: "span 2"`; `align="center"` → `alignSelf`.
5. Controls compose: `ui.slider(0, 100, into=filters)` where `filters = ui.row()` — the spec's `into` equals the row's el-id (facade-level test).
6. `ui.grid` with `cols="1fr 2fr"` sets `gridTemplateColumns`.

- [ ] **Step 2: Implement**

- Parser + `row`/`column`/`grid` in `shared/ui_core.py` (pure: they assemble props dicts and call the injected element-creation path the same way `_tag_builder` does — read `_tag_builder`'s shape first and follow it; grid pre-creates area children and stores `{area: child_element}` on the returned Element as `_areas`).
- `Element.add` extension mirrored 3× in the facades (it is facade-side, dialectal): new keyword args with today's positional-children behavior unchanged; `area=` requires `_areas` (clear + render into child; TypeError with readable message on a non-grid); values (non-Element, non-str) go through the payload path.
- `app.css`: 
```css
/* fase 4b (spec 2026-07-21): containere — os-row/os-col/os-grid */
.os-row { display: flex; flex-direction: row; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
.os-col { display: flex; flex-direction: column; gap: 0.75rem; }
.os-grid { display: grid; gap: 0.75rem; }
```
(kwargs like `gap=`/`justify=` override via inline style from the facade — no more CSS than this.)
- Bind `row`/`column`/`grid` in all three facades' rebind blocks; add to the drift test's SHARED list.

- [ ] **Step 3: Run everything + commit**

Run: `python -m pytest tests/ brython/tests/ micropython/tests/ -q` and `node --test tests/js/*.test.js`

```bash
git add shared/ui_core.py pyodide/ui.py brython/ui_brython.py micropython/ui_mpy.py app.css tests/
git commit -m "feat(containere): ui.row/ui.column/ui.grid + utvidet Element.add (area/span/align, verdi-payloads, replace-inn-i-område) — fase 4b"
```

---

### Task 4: Docs + examples

**Files:**
- Modify: `docs/interactive-elements.html` (new "Containers" section after Level 3: the three types, `.add` semantics incl. area-replace, `into=` + the return rule table from the spec §Value channels, the `rerun`/`on_change` interplay), `docs/ROADMAP.md` (nothing to tick — but add a line under the interactive-elements section noting fase 4a/4b delivered)
- Create: `examples/python/py_containers.txt` (a small dashboard: `ui.grid("side main | side table", cols="220px 1fr")`, a `ui.column` of two controls with `into=` + `on_change` redraw into `area="main"`, a table in `area="table"`; English, `# label: Containers — explicit layout`), `examples/brython/bry26_containers.txt` (twin, brython imports)
- Regenerate: `examples/manifest.json` (`python examples/generate_manifest.py`)

Steps: write both examples (runnable — model data on the iris examples), the docs section (match existing tone/markup), regenerate manifest, run `python -m pytest tests/test_examples_manifest.py -q`, commit.

```bash
git add docs/ examples/
git commit -m "docs(fase4b): containere i brukeroversikten + to eksempler (python/brython) + manifest"
```

---

### Task 5: Full suites + browser sweep + delivery

- [ ] **Step 1:** `python -m pytest tests/ brython/tests/ micropython/tests/ -q` and `node --test tests/js/*.test.js` — all green.
- [ ] **Step 2:** Bump `?v=` in index.html for `js/ui.js` and `app.css` (both changed; follow the repo convention — this is the ONLY index.html edit, outside all template literals).
- [ ] **Step 3:** Browser sweep (serve root, cache-busted; pyodide boot ~30–60 s; run twice if the first run is empty — known boot race):
  - (a) `examples/python/py_containers.txt`: grid renders with named areas; controls sit inside the side column (NOT the strip); dragging the slider redraws `area="main"` via `on_change` (replace, not append); the table stays.
  - (b) Handle semantics: `s.value` reflects the drag; a rerun of the cell rebuilds the layout and the controls keep their values (same-node or same-value — assert value).
  - (c) `sync_to` + `into=` together: session variable updates live.
  - (d) Strip regression: a plain `n = ui.slider(0,100)` document behaves exactly as before (value return, strip mount, rerun).
  - (e) brython twin example works (proves core/facade parity live).
  - (f) `#@param` example unaffected. (g) Both themes screenshot of the container example.
- [ ] **Step 4:** Append to the phase-4 spec's Status line: `Phase 4a+4b DELIVERED <dato> (plans 2026-07-21-sync-to-pin-docs.md, 2026-07-21-containers.md)`; ledger updated.

```bash
git add docs/superpowers/specs/2026-07-21-explicit-containers-design.md index.html
git commit -m "docs(spec): fase 4 levert — into=/håndtak + containere verifisert i browser (pyodide+brython), striper regresjonsfrie"
```
