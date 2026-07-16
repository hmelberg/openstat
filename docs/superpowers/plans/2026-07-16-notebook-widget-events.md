# Notebook Widget Events (W5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `on_click`/`on_change` kwargs on `ui.*` controls (all runtimes), plus element-level events — `ui.on(selector, event, handler, target=None)` and `ui.run_cell(selector, event, cell_id)` — with typed-payload rendering, in pyodide, brython and micropython.

**Architecture:** Spec: `docs/superpowers/specs/2026-07-16-notebook-widget-events-design.md`. W5.1 is facade-side aliasing onto the existing `rerun` spec field. W5.2 mirrors dash v2's proven callback machinery: function crossing per runtime (pyodide `create_proxy`, brython/mpy direct), delegated document-level listeners in js/ui.js keyed by (cellKey, selector, event) with mark-sweep per rerun, per-facade payload classification (figure/table/text/error), rendering in `Ui.renderEventResult` with `js/dash.js` lazy-loaded for figures. JS owns pyodide-proxy destruction via guarded `handler.destroy()`.

**Tech Stack:** ES5-style JS (js/ui.js), the three Python facades (CPython-testable), webr/ui.R (W5.1 only), node:test stub-DOM, pytest.

## Global Constraints

- Documents that never call the new APIs behave byte-identically (all new code behind explicit calls).
- `htmlTrusted` untouched: payload rendering injects only our own formatter output (pre via textContent, table HTML from the facades' builders, figures via Plotly JSON) — never user-supplied HTML strings.
- Handler contract: ALWAYS one argument (event dict `{"type","value","checked","targetId"}` as parsed JSON). No arity sniffing.
- Alias precedence: `on_click`/`on_change` win over `rerun=` when both given; documented in docstrings, no warning channel.
- Twin/triplet parity across facades with documented dialect differences only (mpy: `from js import window`, `__mpyCaptureStart/End` stdout capture, no `sys.stdout` swap).
- dash system read-only (precedent, not modified): `pyodide/dash.py`, `brython/dash.py`, `micropython/dash.py`, `js/dash.js`.
- ES5 var JS, Norwegian comments, `t()` for user-facing strings.
- Branch: `notebook-widget-events` off main.
- Baselines: node `node --test tests/js/*.test.js` = 475 tests / 471 pass / 4 pre-existing ENOENT; pytest `python3 -m pytest tests/ brython/tests/ micropython/tests/ --ignore=tests/test_equivalence.py -q` = 1191 pass.

---

### Task 1: W5.1 — `on_click`/`on_change` aliases (four facades)

**Files:**
- Modify: `pyodide/ui.py` (functions at lines 112-178), `brython/ui_brython.py`, `micropython/ui_mpy.py`, `webr/ui.R` (same functions in each)
- Test: `tests/test_ui_module.py`, `brython/tests/test_ui_brython.py`, `micropython/tests/test_ui_mpy.py` (webr/ui.R has no unit harness — verified at the Task 5 exit gate)

**Interfaces:**
- Produces: `button(label, *, rerun='self', on_click=None, …)` and `slider/dropdown/checkbox/switch/number/text(…, rerun='self', on_change=None, …)` where a non-None alias replaces `rerun` before `_spec()` builds the JSON. JS side unchanged (`spec.rerun`).

- [ ] **Step 1: Write failing tests (all three Python facades)**

Each facade's test file already builds specs through a stubbed/absent `window` — find how existing tests inspect the spec JSON (there are tests asserting `rerun`/`placement` pass-through; mirror the nearest one's mechanics). Add per facade (adapt module alias):

```python
def test_on_click_alias_wins_over_rerun():
    # button: on_click er kanonisk alias for rerun (W5.1); aliaset vinner.
    spec = <how the file captures the spec for ui.button("Kjør", rerun="a", on_click="plot")>
    assert spec["rerun"] == "plot"

def test_on_change_alias_on_slider():
    spec = <captured for ui.slider(1, 10, on_change="plot")>
    assert spec["rerun"] == "plot"

def test_no_alias_keeps_rerun_default():
    spec = <captured for ui.slider(1, 10)>
    assert spec.get("rerun") == "self"
```

If the existing tests have no spec-capture mechanism (they may only test fallback returns), add a tiny capture stub following the file's conventions (e.g. monkeypatching the module's `_register` to record its argument and return None).

- [ ] **Step 2: Run to verify failure** — `python3 -m pytest tests/test_ui_module.py brython/tests/test_ui_brython.py micropython/tests/test_ui_mpy.py -q` → new tests FAIL (unexpected keyword argument).

- [ ] **Step 3: Implement in the three Python facades**

Pattern (identical in all three; shown for `pyodide/ui.py`):

```python
def _alias_rerun(rerun, alias):
    """W5.1 (spec 2026-07-16-notebook-widget-events): on_click=/on_change=
    er kanoniske aliaser for rerun= - aliaset vinner når begge er satt
    (dokumentert kontrakt, ingen advarselskanal i v1)."""
    return alias if alias is not None else rerun
```

Then per function: `def button(label, *, rerun='self', on_click=None, name=None, placement=None):` with first body line `rerun = _alias_rerun(rerun, on_click)`; value controls get `on_change=None` + `rerun = _alias_rerun(rerun, on_change)`. Update each docstring's one-liner to mention the alias.

`webr/ui.R`: same change R-style — add `on_click = NULL` to `ui_button` and `on_change = NULL` to the value controls, with `if (!is.null(on_click)) rerun <- on_click` (resp. on_change) before the spec list is built; comment in Norwegian.

- [ ] **Step 4: Run to verify pass** — same pytest command; all pass (baseline + new).

- [ ] **Step 5: Commit**

```bash
git add pyodide/ui.py brython/ui_brython.py micropython/ui_mpy.py webr/ui.R tests/test_ui_module.py brython/tests/test_ui_brython.py micropython/tests/test_ui_mpy.py
git commit -m "feat(W5.1): on_click/on_change som kanoniske aliaser for rerun i alle fire ui-fasadene

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: js/ui.js — bindings registry, delegation, rendering, lifecycle (TDD)

**Files:**
- Modify: `js/ui.js` (new section after the controls machinery, before the `Ui.beginCellRun`/`endCellRun` pair ~line 858; small additions inside `endCellRun` and a new `Ui.resetBindings`)
- Test: `tests/js/ui-dom.test.js` (stub-DOM — follow its existing setup helpers)

**Interfaces:**
- Consumes: existing `_cellKeyAt(cellIdx)` (js/ui.js:629), the `mdUiRunCtx()` run-context read used by `registerControl` (read that function first — bindings resolve cellIdx the same way), `window.Cells.cellIndexById`/`runCell`, `window.mdIsScriptRunning`, `t()` is NOT available in ui.js (check — if not, use plain Norwegian strings consistent with the file).
- Produces (Tasks 3-4 call these):
  - `Ui.bindEvent(bindingJson, handler)` — bindingJson = `{"selector","event","target"?}`; handler = crossed function (called with ONE JSON-string argument, returns a payload JSON string). Returns `true` if registered, `null` outside any usable context.
  - `Ui.bindRunCell(bindingJson)` — bindingJson = `{"selector","event","cellId"}`.
  - `Ui.renderEventResult(binding, payloadJson)` — payload = `{"kind":"text"|"error"|"table"|"figure", ...}`.
  - `Ui.resetBindings()` — clears all bindings, guarded `handler.destroy()`.

- [ ] **Step 1: Write failing stub-DOM tests**

Append to `tests/js/ui-dom.test.js` (reuse its DOM/window stubs and any run-context helper its registerControl tests use):

```js
test('W5.2: bindEvent registrerer og sveipes ved rerun uten re-deklarasjon', function () {
  // aktiv kjørekontekst for celle 0 (samme oppsett som registerControl-testene)
  Ui.beginCellRun(0);
  var ok = Ui.bindEvent(JSON.stringify({ selector: '#knapp', event: 'click' }), function () { return '{"kind":"text","text":"hei"}'; });
  Ui.endCellRun(0);
  assert.equal(ok, true);
  // rerun som IKKE re-deklarerer bindingen -> sveipes
  Ui.beginCellRun(0);
  Ui.endCellRun(0);
  // dispatch mot sveipet binding skal ikke skje (verifiser via registrylengde-accessor eller dispatch-effekt)
});

test('W5.2: destroy kalles på handler med destroy-metode ved sveip', function () {
  var destroyed = false;
  var h = function () { return '{"kind":"text","text":""}'; };
  h.destroy = function () { destroyed = true; };
  Ui.beginCellRun(0);
  Ui.bindEvent(JSON.stringify({ selector: '#x', event: 'click' }), h);
  Ui.endCellRun(0);
  Ui.beginCellRun(0);
  Ui.endCellRun(0);   // sveip
  assert.equal(destroyed, true);
});

test('W5.2: renderEventResult — text/error/table-kinds og target-fallback', function () {
  // target-id finnes -> replace inn i den; mangler -> fallback til celle-slot med notis;
  // text -> <pre> via textContent; error -> pre.error; table -> innerHTML fra payload.html
});

test('W5.2: bindRunCell dispatcher til Cells.runCell via cellIndexById', function () {
  // stub window.Cells {cellIndexById, runCell} og syntetiser event-dispatch
});
```

Flesh these out against the file's actual stub conventions — the assertions above are the contract; the setup mechanics must match the file. Expose a minimal test-only accessor if needed (`Ui._bindingCount()` — follow the file's existing pattern for test hooks if one exists; otherwise assert through observable behavior).

- [ ] **Step 2: Run to verify failure** — `node --test tests/js/ui-dom.test.js` → new tests fail (`Ui.bindEvent is not a function`).

- [ ] **Step 3: Implement**

New section in js/ui.js (Norwegian comments; adapt the run-context resolution to exactly what `registerControl` does — read it first):

```js
  // ── W5.2: element-events (spec 2026-07-16-notebook-widget-events) ────
  // Delegerte dokument-lyttere + bindingsregister. En binding deklareres
  // under en cellekjøring (ui.on/ui.run_cell i fasadene) og lever til
  // cellen re-kjøres uten å re-deklarere den (mark-og-sveip, samme par
  // som kontrollene), eller til Ui.resetBindings() (sesjonsrestart).
  // JS EIER handler-livssyklusen: pyodide-proxier har .destroy() — kalles
  // guarded overalt der en binding fjernes (brython/mpy-funksjoner har
  // ingen destroy → no-op).
  var _bindings = {};      // "cellKey::selector::event" -> binding
  var _delegated = {};     // eventType -> true når dokument-lytteren er satt

  function _destroyHandler(b) {
    if (b && b.handler && typeof b.handler.destroy === 'function') {
      try { b.handler.destroy(); } catch (e) {}
    }
  }

  function _installDelegate(eventType) {
    if (_delegated[eventType] || typeof document === 'undefined') return;
    _delegated[eventType] = true;
    document.addEventListener(eventType, function (e) {
      for (var key in _bindings) {
        var b = _bindings[key];
        if (b.event !== eventType) continue;
        var hit = (e.target && e.target.closest) ? e.target.closest(b.selector) : null;
        if (hit) _dispatchBinding(b, e, hit);
      }
    });
  }

  function _dispatchBinding(b, e, hit) {
    if (b.kind === 'cell') {
      if (!global.Cells || typeof global.Cells.cellIndexById !== 'function') return;
      var idx = global.Cells.cellIndexById(b.cellId);
      if (idx === -1) { console.warn('ui.run_cell: fant ikke celle-id', b.cellId); return; }
      global.Cells.runCell(idx);
      return;
    }
    // kind === 'fn': dropp events midt i en kjøring (v1 — ingen kø)
    if (global.mdIsScriptRunning && global.mdIsScriptRunning()) {
      console.debug('ui.on: event droppet (kjøring pågår)');
      return;
    }
    var evt = { type: e.type, value: (hit && hit.value !== undefined) ? hit.value : null,
                checked: (hit && hit.checked !== undefined) ? !!hit.checked : null,
                targetId: hit && hit.id ? hit.id : null };
    var payloadJson;
    try { payloadJson = b.handler(JSON.stringify(evt)); }
    catch (err) {
      payloadJson = JSON.stringify({ kind: 'error', text: String((err && err.message) || err) });
    }
    Ui.renderEventResult(b, payloadJson);
  }
```

Registration (resolve run context the way `registerControl` does; store `cellIdx` possibly null for plain scripts, `cellKey` via `_cellKeyAt` or a `'doc'` sentinel when null; mark for sweep with the same mechanism `endCellRun` uses for controls):

```js
  Ui.bindEvent = function (bindingJson, handler) { /* parse, resolve ctx, replace-with-destroy, register, _installDelegate, mark seen */ };
  Ui.bindRunCell = function (bindingJson) { /* samme uten handler; kind:'cell' */ };
```

Rendering:

```js
  Ui.renderEventResult = function (b, payloadJson) {
    var p;
    try { p = JSON.parse(payloadJson || '{}'); } catch (e) { p = { kind: 'error', text: 'ui.on: ugyldig payload' }; }
    var node = null, replace = false;
    if (b.target) {
      node = document.getElementById(b.target);
      if (node) { replace = true; }
      else { /* notis i celle-slot + fall gjennom til slot-append */ }
    }
    if (!node) node = _slotFor(b);   // celle-slot (.nb-output-body for b.cellIdx) eller #outputArea
    if (!node) return;
    if (replace) node.innerHTML = '';
    if (p.kind === 'text' || p.kind === 'error') {
      var pre = document.createElement('pre');
      if (p.kind === 'error') pre.className = 'error';
      pre.textContent = p.text || '';
      node.appendChild(pre);
    } else if (p.kind === 'table') {
      var div = document.createElement('div');
      div.innerHTML = p.html || '';     // vår egen to_html-bygger, samme tillitsnivå som dash-kort
      node.appendChild(div);
    } else if (p.kind === 'figure') {
      _renderFigure(p, node);           // lazy-load js/dash.js -> Dash.renderPayload({kind:'figure',...})
    }
  };
```

`_slotFor(b)`: `b.cellIdx != null` → `Cells.cellElementAt(b.cellIdx)`'s `.nb-output-body` (query within), else `document.getElementById('outputArea')`. `_renderFigure`: if `window.Dash && Dash.renderPayload` render directly; else inject `<script src="js/dash.js">` once (memoized promise, mirror the engines' `addScript` idiom) then render; on load failure append a text notice.

Sweep integration: in `endCellRun`'s existing stale-sweep loop add the parallel `_bindings` sweep (same cellIdx match, same seen-marking scheme as controls — read how `_controls` marking works and mirror it); `Ui.resetBindings = function () { for (var k in _bindings) _destroyHandler(_bindings[k]); _bindings = {}; };`.

- [ ] **Step 4: Run tests** — `node --test tests/js/ui-dom.test.js` all pass; full suite `node --test tests/js/*.test.js` → baseline + new, still 4 pre-existing failures.

- [ ] **Step 5: Hook `Ui.resetBindings` into the session lifecycle**

In `index.html`, next to every existing `IpwBridge.reset()` call in `mdNotebookSession.restart()` and `.invalidate()` (~9195/9245 — anchor on the IpwBridge lines), add:

```js
        if (window.Ui && window.Ui.resetBindings) window.Ui.resetBindings();
```

with a one-line Norwegian comment (`// W5.2: element-event-bindinger er økt-scoped akkurat som ipywidgets-comms`).

- [ ] **Step 6: Commit**

```bash
git add js/ui.js tests/js/ui-dom.test.js index.html
git commit -m "feat(W5.2): bindingsregister med delegerte lyttere, payload-rendering og livssyklus i js/ui.js

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: pyodide facade — `ui.on` / `ui.run_cell` + payload classification (TDD)

**Files:**
- Modify: `pyodide/ui.py`
- Test: `tests/test_ui_module.py`

**Interfaces:**
- Consumes: Task 2's `Ui.bindEvent`/`Ui.bindRunCell` contracts (handler receives ONE JSON-string arg, returns payload JSON string).
- Produces: `ui.on(selector, event, handler, *, target=None)` and `ui.run_cell(selector, event, cell_id)`; module-private `_event_payload(res, out_text)` classification reused verbatim (dialect-adapted) by Task 4.

- [ ] **Step 1: Write failing tests**

```python
def test_event_payload_text_from_return():
    p = ui._event_payload(42, "")
    assert p == {"kind": "text", "text": "42"}

def test_event_payload_stdout_prepended():
    p = ui._event_payload("res", "logget\n")
    assert p["kind"] == "text" and "logget" in p["text"] and "res" in p["text"]

def test_event_payload_none_with_stdout():
    assert ui._event_payload(None, "bare print\n") == {"kind": "text", "text": "bare print"}

def test_event_payload_none_silent():
    assert ui._event_payload(None, "") is None   # ingenting å rendre

def test_event_payload_figure_ducktype():
    class Fig:
        def to_plotly_json(self):
            return {"data": [{"y": [1]}], "layout": {"title": "x"}}
    p = ui._event_payload(Fig(), "")
    assert p["kind"] == "figure" and p["spec"]["layout"]["title"] == "x"

def test_event_payload_dataframe_ducktype():
    class DF:
        columns = ["a"]
        def to_html(self, **kw):
            return "<table><tr><td>1</td></tr></table>"
    p = ui._event_payload(DF(), "")
    assert p["kind"] == "table" and p["html"].startswith("<table")

def test_wrapper_catches_exception():
    def boom(evt):
        raise ValueError("au")
    w = ui._make_event_wrapper(boom)
    out = json.loads(w('{"type":"click"}'))
    assert out["kind"] == "error" and "au" in out["text"]

def test_wrapper_passes_event_dict():
    seen = {}
    def h(evt):
        seen.update(evt)
        return "ok"
    w = ui._make_event_wrapper(h)
    out = json.loads(w('{"type":"click","value":"7"}'))
    assert seen["value"] == "7" and out["kind"] == "text"

def test_on_and_run_cell_return_none_without_browser():
    # CPython: window is None -> begge er no-op uten å kaste
    assert ui.on("#x", "click", lambda e: None) is None
    assert ui.run_cell("#x", "click", "plot") is None
```

- [ ] **Step 2: Run to verify failure** — `python3 -m pytest tests/test_ui_module.py -q`.

- [ ] **Step 3: Implement in `pyodide/ui.py`**

Read `pyodide/dash.py`'s `_run` (L366-389) and figure/table classification first — `_event_payload` mirrors its duck-typing decisions (to_plotly_json for figures; DataFrame detection via the same attributes dash uses; adapt, don't import dash):

```python
def _event_payload(res, out_text):
    """Klassifiser (returverdi, stdout) -> payload-dict for
    Ui.renderEventResult (W5.2). Speiler dash.py sin kort-klassifisering
    (figur-ducktyping via to_plotly_json, frame via to_html/columns),
    men som egen kompakt kopi - fasadene er divergente kopier per
    konvensjon (builder-dedup er et eksisterende backlog-punkt)."""
    out_text = (out_text or "").rstrip("\n")
    if res is not None and hasattr(res, "to_plotly_json"):
        pj = res.to_plotly_json()
        return {"kind": "figure", "spec": {"data": pj.get("data"), "layout": pj.get("layout")}}
    if res is not None and hasattr(res, "to_html") and hasattr(res, "columns"):
        return {"kind": "table", "html": res.to_html(border=0)}
    if res is None:
        return {"kind": "text", "text": out_text} if out_text else None
    text = str(res)
    if out_text:
        text = out_text + "\n" + text
    return {"kind": "text", "text": text}


def _make_event_wrapper(handler):
    """Wrapperen JS faktisk kaller: JSON-event inn, payload-JSON ut.
    Fanger stdout (sys.stdout-bytte, dash-presedens) og ALLE unntak ->
    {"kind":"error"}. Kontrakt: handler tar ALLTID ett argument
    (event-dicten) - ingen aritetssniffing (spec-avgjørelse)."""
    def _wrapper(event_json):
        import io, sys, traceback
        buf = io.StringIO()
        old = sys.stdout
        sys.stdout = buf
        try:
            evt = json.loads(event_json) if event_json else {}
            res = handler(evt)
            p = _event_payload(res, buf.getvalue())
            return json.dumps(p) if p is not None else '{}'   # tom payload -> JS no-op
        except BaseException:
            return json.dumps({"kind": "error", "text": traceback.format_exc()})
        finally:
            sys.stdout = old
    return _wrapper


def on(selector, event, handler, *, target=None):
    """Bind en python-funksjon til en HTML-event på et vilkårlig
    DOM-element (typisk i en #%% html-celle). handler(evt) kalles med
    event-dicten; returverdien rendres (tekst -> <pre>, DataFrame ->
    tabell, plotly-figur -> graf) i target-id-en, eller appendes i
    cellens output-slot når target utelates. Utenfor nettleser: no-op."""
    u = _ui()
    if u is None:
        return None
    binding = {"selector": str(selector), "event": str(event)}
    if target is not None:
        binding["target"] = str(target)
    try:
        from pyodide.ffi import create_proxy
    except ImportError:
        def create_proxy(f):
            return f
    u.bindEvent(json.dumps(binding), create_proxy(_make_event_wrapper(handler)))
    return None


def run_cell(selector, event, cell_id):
    """Kjør en navngitt celle (id= i #%%-headeren) når HTML-eventen
    fyrer - cellevarianten av on() (eget navn, ingen overloading)."""
    u = _ui()
    if u is None:
        return None
    u.bindRunCell(json.dumps({"selector": str(selector), "event": str(event), "cellId": str(cell_id)}))
    return None
```

NOTE: `_ui()` returning non-None but `bindEvent` absent (stale ui.js) — follow the file's existing defensive convention if it has one; otherwise let the AttributeError surface (loud beats silent).

- [ ] **Step 4: Run tests** — `python3 -m pytest tests/test_ui_module.py -q` all pass.

- [ ] **Step 5: Commit**

```bash
git add pyodide/ui.py tests/test_ui_module.py
git commit -m "feat(W5.2): ui.on/ui.run_cell + payload-klassifisering i pyodide-fasaden

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: brython + micropython facades (TDD, twin)

**Files:**
- Modify: `brython/ui_brython.py`, `micropython/ui_mpy.py`
- Test: `brython/tests/test_ui_brython.py`, `micropython/tests/test_ui_mpy.py`

**Interfaces:**
- Consumes: Task 3's `_event_payload`/`_make_event_wrapper`/`on`/`run_cell` shapes; Task 2's JS contracts.
- Produces: the same public API in both facades.

- [ ] **Step 1: Port the Task 3 tests** to both facade test files (same assertions, each file's import alias/conventions; drop the `create_proxy` aspect — not applicable).

- [ ] **Step 2: Verify failure** — `python3 -m pytest brython/tests/test_ui_brython.py micropython/tests/test_ui_mpy.py -q`.

- [ ] **Step 3: Implement — brython**

Identical to Task 3's code with two dialect changes: no `create_proxy` (pass `_make_event_wrapper(handler)` directly — Brython functions are JS-callable, dash precedent `brython/dash.py:268`), and the header-comment style of that file.

- [ ] **Step 4: Implement — micropython**

Same, with the mpy dialect differences (mirror `micropython/dash.py`'s documented traps):
- No `sys.stdout` swap — the wrapper uses the capture pair, destructively, exactly once per invocation:

```python
def _make_event_wrapper(handler):
    def _wrapper(event_json):
        window.__mpyCaptureStart()
        try:
            try:
                evt = json.loads(event_json) if event_json else {}
                res = handler(evt)
            finally:
                out_text = window.__mpyCaptureEnd()
            p = _event_payload(res, out_text)
            return json.dumps(p) if p is not None else '{}'   # tom payload -> JS no-op
        except BaseException as e:
            return json.dumps({"kind": "error", "text": _format_exc(e)})
    return _wrapper
```

(`_format_exc` — reuse/mirror whatever exception-formatting helper `micropython/dash.py` or the runner uses under mpy; under CPython pytest it must still produce a non-empty string. Read those files first.)
- CPython-test guard: the capture pair lives on `window`, which is None under pytest — the wrapper must fall back to a plain StringIO-swap under CPython (guard on `window is None`; document that real-mpy uses the capture pair). Structure it so the pytest tests exercise the classification and error paths meaningfully.
- Direct function pass to `u.bindEvent` (jsffi, dash precedent `micropython/dash.py:491`).

- [ ] **Step 5: Run tests** — facade pytest all green; full pytest sweep `python3 -m pytest tests/ brython/tests/ micropython/tests/ --ignore=tests/test_equivalence.py -q` → 1191 + new.

- [ ] **Step 6: Commit**

```bash
git add brython/ui_brython.py micropython/ui_mpy.py brython/tests/test_ui_brython.py micropython/tests/test_ui_mpy.py
git commit -m "feat(W5.2): ui.on/ui.run_cell i brython- og micropython-fasadene (tvilling, mpy-capture-dialekt)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Examples, docs, exit gate

**Files:**
- Create: `examples/python/py_widget_events.txt`, `examples/brython/bry25_widget_events.txt`, `examples/micropython/06_widget_events.txt`
- Modify: `examples/manifest.json` (regenerate), `docs/superpowers/specs/2026-07-15-notebook-widgets-design.md` (W5 phasing entry → DONE + pointer + supersession note re mdRenderOutput→typed payloads), `sw.js` (CACHE v17→v18), `index.html` (`?v=` bump on js/ui.js — check whether its script tag has one; add/update to 2026-07-16b)

**Interfaces:** consumes everything above.

- [ ] **Step 1: Create the python-mode example**

`examples/python/py_widget_events.txt` — structure (verify every cell runs in browser and adapt wording freely):

```
# label: Widget-events — ui.on og ui.run_cell
#options.mode = python
#options.title = "Widget-events (ui.on / ui.run_cell)"
#options.description = "HTML-events på vilkårlige DOM-elementer: python-callbacks med target-rendering, og celle-kjøring fra HTML-knapper"
# load https://raw.githubusercontent.com/hmelberg/openstat/main/data/iris.csv as iris

#%% md
# Events på HTML-elementer

`ui.on(selector, event, funksjon, target=…)` binder en python-funksjon til
en HTML-event; returverdien rendres i `target`-elementet (tekst → pre,
DataFrame → tabell, plotly-figur → graf). `ui.run_cell(selector, event,
celle_id)` kjører en navngitt celle i stedet.

#%% html
<button id="beregnBtn">Beregn snitt</button>
<button id="plotBtn">Tegn plott på nytt</button>
<div id="resultat"></div>

#%% python
import ui

def beregn(evt):
    return iris.groupby("species")["sepal_length"].mean().to_frame()

ui.on("#beregnBtn", "click", beregn, target="resultat")
ui.run_cell("#plotBtn", "click", "plot")

#%% python id=plot
import plotly.express as px
px.scatter(iris, x="sepal_length", y="petal_length", color="species")
```

- [ ] **Step 2: Create the brython and micropython twins** — same document with mode/title/dialect substitutions (`import pandas_brython as pd`-style imports only where needed; `groupby(...).mean()` support differs per engine — verify in browser and simplify the callback to what the engine's pandas actually supports, e.g. `iris.head(5)` as the table result if groupby is unsupported; keep one text-returning handler too).

- [ ] **Step 3: Regenerate manifest + docs + cache**

`python3 examples/generate_manifest.py`; `python3 -m pytest tests/test_examples_manifest.py tests/test_manifest_integration.py -q`; W5 phasing entry in spec 2 → `**DONE 2026-07-16**` + pointer to the W5 spec + one line noting the typed-payload supersession; sw.js CACHE → `m2py-v18`; js/ui.js script tag `?v=2026-07-16b`.

- [ ] **Step 4: Exit gate — browser sweep (Playwright), three modes**

Serve fresh port. Matrix per mode (python, brython, micropython):
1. Load the example → Kjør alle → html-cell buttons render, plot renders.
2. Click «Beregn snitt» → table appears in `#resultat` (replace on repeat clicks, no stacking).
3. Click «Tegn plott på nytt» → the plot cell reruns (spinner/output refresh).
4. A handler returning text (add temporarily or include in example) → `<pre>` in target; a handler that raises → red pre with traceback in target.
5. Omitted target: temporary `ui.on` without target → output appends in the binding cell's slot.
6. Missing id: `target="finnesIkke"` → notice + fallback to cell slot, nothing silently dropped.
7. Rerun the binding cell twice → clicking still fires exactly ONE handler (no duplicates); then remove the `ui.on` line and rerun → clicking does nothing (sweep).
8. Restart & kjør alle → old bindings gone until re-declared by the run; after the run, buttons work again.
9. W5.1: change a `rerun=` in an existing widgets example to `on_click=`/`on_change=` (temporarily) → identical behavior. R: same check in the R widgets example (`on_change=` on `ui_slider`).
10. Plain script (no `#%%`) with `ui.on` → no crash, no render (returns None path); regression: py_widgets_ui and bry24 examples still fully work; both themes screenshot-checked on the target-rendered table.

- [ ] **Step 5: Full suites** — node `475+new/…/4`, pytest sweep green.

- [ ] **Step 6: Commit + ledger**

```bash
git add examples/ docs/superpowers/specs/2026-07-15-notebook-widgets-design.md sw.js index.html
git commit -m "docs+eksempler(W5): widget-events-eksempler i tre moduser, spec-status, cache-bump

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Append the W5 completion lines to `.superpowers/sdd/progress.md`.
