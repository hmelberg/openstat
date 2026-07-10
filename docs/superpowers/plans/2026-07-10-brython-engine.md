# Brython Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Brython as a lightweight Python engine to openstat (then safestat) so dashboards load in seconds instead of Pyodide's 10–30 s cold boot.

**Architecture:** All new logic lives in new files (`js/brython-engine.js`, `brython/*.py`); each `index.html` gets ~25 lines of hooks at seams the code already marked for Brython. Output reuses the existing stdout embed-marker protocol so `buildOutputNodes()` renders Brython results unchanged. Data comes via the existing runtime-neutral `# load` pipeline, embedded JSON blocks, or (for parquet) the already-present DuckDB-WASM engine.

**Tech Stack:** Brython 3.12.0 (jsdelivr CDN), pure-Python libraries copied from `~/Documents/GitHub/code2web/` (`pandas.py`, `plotly_express.py`, `brython_shared_module.py`), Plotly.js 2.32.0 (already loaded globally), DuckDB-WASM 1.29.0 (already wired).

**Spec:** `docs/superpowers/specs/2026-07-10-brython-engine-design.md`

## Global Constraints

- Module names are EXACTLY `pandas_brython` and `plotly_express_brython`; canonical imports in examples/docs: `import pandas_brython as pd`, `import plotly_express_brython as pe`.
- Brython script-tag ids MUST equal the module names (Brython resolves imports via `<script type="text/python" id="<module>">`).
- CDN: `https://cdn.jsdelivr.net/npm/brython@3.12.0/brython.min.js` and `.../brython_stdlib.js`.
- Embed markers (must match `index.html` `EMBED_START`/`EMBED_END` exactly): start `__micro_transform_start_`, end `__micro_transform_end__`. Figure: `__micro_transform_start_figure__\n<plotly JSON>\n__micro_transform_end__`. Table: same with `tablehtml__` and HTML payload.
- New files only, plus minimal hooks in `index.html` / `sw.js`. No changes to `js/data-loader.js`, `js/data-directives.js`, `buildOutputNodes`, or any existing engine.
- Unimplemented pandas verbs raise `NotImplementedError` naming the escape hatch ("… ikke tilgjengelig i Brython-modus — bytt til Python-modus").
- Openstat first (Tasks 1–8), then port to safestat (Task 9). Commit in the repo you are editing.
- All tests are plain-Python files runnable as `python3 <file>` (assert-based, no pytest dependency).

---

### Task 1: `brython/pandas_brython.py` — copy, rename, gap-stubs

**Files:**
- Create: `brython/pandas_brython.py` (from `/Users/hom/Documents/GitHub/code2web/pandas.py`)
- Test: `brython/tests/test_pandas_brython.py`

**Interfaces:**
- Produces: module `pandas_brython` with `DataFrame`, `Series`, `read_csv(filepath_or_buffer)`, `concat`, and `DataFrame.to_html()` — consumed by Tasks 2, 3.
- Gap verbs (`merge`, `join`, `pivot`, `pivot_table`, `melt`, `crosstab`, `get_dummies`, `rolling`, `resample`, `corr`) raise `NotImplementedError`.

- [ ] **Step 1: Copy the source**

```bash
cd /Users/hom/Documents/GitHub/openstat
mkdir -p brython/tests
cp /Users/hom/Documents/GitHub/code2web/pandas.py brython/pandas_brython.py
```

- [ ] **Step 2: Find and neutralize cross-module/browser references**

```bash
grep -n "plotly_express\|import browser\|from browser\|__pyapp_assets\|_app_file\|import pandas" brython/pandas_brython.py
```

For each hit: (a) `import plotly_express` blocks — change the module name to `plotly_express_brython` and make sure the import is inside `try/except` (it already prints "failed to import plotly_express" under CPython, so it is guarded — just rename); (b) `browser` / `window.__pyapp_assets` references appear only inside `read_csv`'s asset branch — wrap that branch in `try/except ImportError` so the module imports cleanly under CPython (keep the plain-path and StringIO branches untouched).

- [ ] **Step 3: Write the failing test**

Create `brython/tests/test_pandas_brython.py`:

```python
import sys, os, io
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pandas_brython as pd

def test_import_and_basic_frame():
    df = pd.DataFrame({'a': [1, 2, 3], 'b': ['x', 'y', 'x']})
    assert len(df) == 3
    assert list(df['a']) == [1, 2, 3]

def test_read_csv_stringio():
    df = pd.read_csv(io.StringIO("a,b\n1,x\n2,y\n"))
    assert len(df) == 2

def test_groupby_and_to_html():
    df = pd.DataFrame({'g': ['a', 'a', 'b'], 'v': [1, 2, 3]})
    counts = df.groupby('g').size()
    html = df.to_html()
    assert '<table' in html

def test_gap_verbs_raise_clear_error():
    df = pd.DataFrame({'a': [1]})
    for verb in ['merge', 'join', 'pivot', 'pivot_table', 'melt', 'rolling', 'resample', 'corr']:
        try:
            getattr(df, verb)()
            raise AssertionError(verb + ' should raise NotImplementedError')
        except NotImplementedError as e:
            assert 'Brython' in str(e), verb + ': message must name Brython mode'

def test_module_gap_verbs_raise():
    for verb in ['merge', 'crosstab', 'get_dummies', 'pivot_table', 'melt']:
        try:
            getattr(pd, verb)()
            raise AssertionError('pd.' + verb + ' should raise NotImplementedError')
        except NotImplementedError as e:
            assert 'Brython' in str(e)

if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
```

- [ ] **Step 4: Run test to verify it fails**

Run: `python3 brython/tests/test_pandas_brython.py`
Expected: FAIL — the gap-verb tests fail because `merge` etc. raise `AttributeError` (or don't exist), not `NotImplementedError`. The basic-frame tests should already PASS (if they don't, fix the Step 2 guards first).

- [ ] **Step 5: Add the gap stubs**

At the END of `brython/pandas_brython.py` add:

```python
# ── Brython-mode gaps ─────────────────────────────────────────────────────
# These pandas verbs are intentionally not implemented in the lightweight
# engine. They raise a clear error naming the escape hatch instead of an
# AttributeError, per the design spec (2026-07-10-brython-engine-design.md).
def _brython_gap(name):
    def _raise(self=None, *args, **kwargs):
        raise NotImplementedError(
            name + " er ikke tilgjengelig i Brython-modus — bytt til Python-modus (Pyodide) for full pandas.")
    _raise.__name__ = name
    return _raise

for _name in ['merge', 'join', 'pivot', 'pivot_table', 'melt', 'rolling', 'resample', 'corr']:
    if not hasattr(DataFrame, _name):
        setattr(DataFrame, _name, _brython_gap(_name))

for _name in ['merge', 'crosstab', 'get_dummies', 'pivot_table', 'melt']:
    if _name not in globals():
        globals()[_name] = _brython_gap(_name)
```

NOTE: `DataFrame.groupby(...)` dispatches aggregations through `GroupBy.__getattr__` — do not touch it. The `if not hasattr` guards keep this future-proof if a verb is later implemented upstream.

- [ ] **Step 6: Run test to verify it passes**

Run: `python3 brython/tests/test_pandas_brython.py`
Expected: `PASS` for all five tests.

- [ ] **Step 7: Commit**

```bash
git add brython/pandas_brython.py brython/tests/test_pandas_brython.py
git commit -m "feat(brython): add pandas_brython pure-Python dataframe library"
```

---

### Task 2: `brython/plotly_express_brython.py` — copy, guard, JSON API

**Files:**
- Create: `brython/plotly_express_brython.py` (from `/Users/hom/Documents/GitHub/code2web/plotly_express.py`)
- Test: `brython/tests/test_plotly_express_brython.py`

**Interfaces:**
- Consumes: `pandas_brython.DataFrame` (Task 1).
- Produces: chart functions (`scatter`, `line`, `bar`, `histogram`, `box`, `pie`, …) returning a figure object with method `to_plotly_json_str() -> str` (JSON with keys `data` and `layout`). Task 3's runner duck-types on `to_plotly_json_str`.

- [ ] **Step 1: Copy the source**

```bash
cp /Users/hom/Documents/GitHub/code2web/plotly_express.py brython/plotly_express_brython.py
```

- [ ] **Step 2: Guard the browser import and remove page-coupled code**

The file starts with `from browser import window, document, html, webcomponent` (line 2). Replace with:

```python
try:
    from browser import window, document, html
except ImportError:          # CPython (tests) — DOM features unavailable
    window = document = html = None
```

Then:

```bash
grep -n "webcomponent\|PlotlyFigureComponent\|def plotly_figure\|plotlyplot:" brython/plotly_express_brython.py
```

- Delete the `PlotlyFigureComponent` class and any `webcomponent.define(...)` registration (openstat's runner owns rendering; the web component is code2web-specific).
- Delete or leave-but-never-call the `plotly_figure()` factory if it references the deleted component (delete is cleaner).
- `plotlyplot:` occurs at ~line 227 (`PlotlyFigure.__str__`) and ~line 3273 (a module-level helper). Handle in Step 4.
- Also run `grep -n "import pandas" brython/plotly_express_brython.py` — rename any internal `pandas` import to `pandas_brython` (guarded imports keep working).

- [ ] **Step 3: Write the failing test**

Create `brython/tests/test_plotly_express_brython.py`:

```python
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import pandas_brython as pd
import plotly_express_brython as pe

DF = pd.DataFrame({'x': [1, 2, 3, 4], 'y': [10, 20, 15, 30], 'g': ['a', 'a', 'b', 'b']})

def test_scatter_returns_json_figure():
    fig = pe.scatter(DF, x='x', y='y', color='g', title='t')
    s = fig.to_plotly_json_str()
    spec = json.loads(s)
    assert 'data' in spec and 'layout' in spec
    assert len(spec['data']) >= 1

def test_no_plotlyplot_prefix_anywhere():
    fig = pe.bar(DF, x='g', y='y')
    assert not fig.to_plotly_json_str().startswith('plotlyplot:')
    assert not str(fig).startswith('plotlyplot:')

def test_chart_families():
    for fn, kw in [(pe.line, dict(x='x', y='y')), (pe.histogram, dict(x='y')),
                   (pe.box, dict(x='g', y='y')), (pe.pie, dict(names='g', values='y'))]:
        spec = json.loads(fn(DF, **kw).to_plotly_json_str())
        assert 'data' in spec, fn.__name__

if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
```

- [ ] **Step 4: Run test to verify it fails, then implement `to_plotly_json_str`**

Run: `python3 brython/tests/test_plotly_express_brython.py`
Expected: FAIL with `AttributeError: ... to_plotly_json_str`.

In the `PlotlyFigure` class (the ~line 227 site shows how the JSON dict is assembled — reuse exactly that logic and its `json_safe()` sanitizer):

```python
    def to_plotly_json_str(self):
        """Full figure spec as a JSON string (data/layout/config) for plotly.js."""
        return json.dumps(json_safe(self._build_plot_data()))
```

Concretely: extract whatever expression `__str__` currently serializes ("plotlyplot:" + json.dumps(json_safe(X))) into a helper `_build_plot_data(self)` returning `X`, call it from `to_plotly_json_str`, and change `__str__` to return `"<PlotlyFigure: use show() or leave as last expression>"`. Apply the same treatment to the ~line 3273 module-level helper (return plain JSON, no prefix). After this, `grep -c "plotlyplot:" brython/plotly_express_brython.py` MUST print `0`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `python3 brython/tests/test_plotly_express_brython.py`
Expected: `PASS` ×3. Also re-run Task 1 tests (`python3 brython/tests/test_pandas_brython.py`) — still PASS.

- [ ] **Step 6: Commit**

```bash
git add brython/plotly_express_brython.py brython/tests/test_plotly_express_brython.py
git commit -m "feat(brython): add plotly_express_brython emitting plotly.js JSON"
```

---

### Task 3: `brython/brython_runner.py` — persistent runner with embed markers

**Files:**
- Create: `brython/brython_runner.py` (pattern from `/Users/hom/Documents/GitHub/code2web/brython_shared_module.py` — read it first)
- Test: `brython/tests/test_brython_runner.py`

**Interfaces:**
- Consumes: `pandas_brython` (Task 1), `plotly_express_brython` (Task 2) — imported lazily inside functions, never at module top (they may not be registered yet when the runner compiles).
- Produces (called from JS via the module object `runPythonSource` returns):
  - `_execute_code(code: str) -> str` — runs code in persistent globals, returns marker-formatted output text.
  - `_get_last_error() -> str` — traceback of the last run ('' if none).
  - `_bind_datasets(spec_json: str) -> str` — binds datasets into the shared globals; returns '' or an error message.
  - Injects `show(*objs)` into user globals.

- [ ] **Step 1: Write the failing test**

Create `brython/tests/test_brython_runner.py`:

```python
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import brython_runner as br

ES = '__micro_transform_start_'
EE = '__micro_transform_end__'

def test_stdout_and_last_expression():
    out = br._execute_code('print("hei")\n1 + 1')
    assert 'hei' in out and '2' in out
    assert br._get_last_error() == ''

def test_state_persists_between_runs():
    br._execute_code('xx = 41')
    out = br._execute_code('xx + 1')
    assert '42' in out

def test_figure_embed_marker():
    br._execute_code('import pandas_brython as pd\nimport plotly_express_brython as pe\n'
                     'df = pd.DataFrame({"x":[1,2],"y":[3,4]})')
    out = br._execute_code('pe.scatter(df, x="x", y="y")')
    assert (ES + 'figure__') in out and EE in out
    payload = out.split(ES + 'figure__')[1].split(EE)[0].strip()
    assert 'data' in json.loads(payload)

def test_dataframe_tablehtml_marker():
    out = br._execute_code('df')
    assert (ES + 'tablehtml__') in out and '<table' in out

def test_show_multiple():
    out = br._execute_code('show(df, "tekst")')
    assert (ES + 'tablehtml__') in out and 'tekst' in out

def test_error_returns_traceback():
    out = br._execute_code('1/0')
    err = br._get_last_error()
    assert 'ZeroDivisionError' in err

def test_bind_datasets_csv_and_columns():
    spec = {'iris': {'kind': 'csv', 'payload': 'a,b\n1,x\n2,y\n'},
            'tall': {'kind': 'columns', 'payload': {'v': [1, 2, 3]}}}
    msg = br._bind_datasets(json.dumps(spec))
    assert msg == ''
    out = br._execute_code('str(len(iris)) + "," + str(len(tall))')
    assert '2,3' in out

if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 brython/tests/test_brython_runner.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'brython_runner'`.

- [ ] **Step 3: Implement the runner**

Create `brython/brython_runner.py`:

```python
# Persistent Brython execution environment for openstat/safestat.
# Pattern from code2web's brython_shared_module.py; output uses the app's
# stdout embed-marker protocol so buildOutputNodes() renders it unchanged.
import sys, json, traceback
from io import StringIO

_EMBED_S = '__micro_transform_start_'
_EMBED_E = '__micro_transform_end__'

_shared_vars = {}
_last_error = ''

def _fmt(obj):
    """Format one object as output text (embed markers for figures/frames)."""
    if obj is None:
        return ''
    if hasattr(obj, 'to_plotly_json_str'):
        return _EMBED_S + 'figure__' + '\n' + obj.to_plotly_json_str() + '\n' + _EMBED_E
    if hasattr(obj, 'to_html'):
        html = obj.to_html()
        if '<table class=' not in html:
            html = html.replace('<table', '<table class="output-table"', 1)
        return _EMBED_S + 'tablehtml__' + '\n' + html + '\n' + _EMBED_E
    if isinstance(obj, str):
        return obj
    return repr(obj)

def _show(*objs):
    """User-facing show(): print each object in its rendered form."""
    for o in objs:
        print(_fmt(o))

_shared_vars['show'] = _show

def _execute_code(code):
    """Run code in the persistent globals; return output text ('' on error)."""
    global _last_error
    _last_error = ''
    buf = StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        lines = code.rstrip().split(chr(10))
        last = lines[-1].strip() if lines else ''
        result = None
        # Try exec-all-but-last + eval-last so the final expression displays
        # (REPL semantics). Fall back to plain exec for statements.
        if last and not last.startswith('#'):
            try:
                body = compile(chr(10).join(lines[:-1]) or 'pass', '<brython>', 'exec')
                tail = compile(last, '<brython>', 'eval')
                exec(body, _shared_vars)
                result = eval(tail, _shared_vars)
            except SyntaxError:
                exec(compile(code, '<brython>', 'exec'), _shared_vars)
        else:
            exec(compile(code, '<brython>', 'exec'), _shared_vars)
        out = buf.getvalue()
        shown = _fmt(result)
        if shown:
            out = out + ('' if not out or out.endswith(chr(10)) else chr(10)) + shown
        return out
    except Exception:
        _last_error = traceback.format_exc()
        return buf.getvalue()
    finally:
        sys.stdout = old

def _get_last_error():
    return _last_error

def _bind_datasets(spec_json):
    """Bind datasets from JS into user globals. spec: {name: {kind, payload}}.
    kind 'csv' → payload is CSV text; kind 'columns' → payload is {col: [values]}."""
    try:
        import pandas_brython as _pd
        spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
        for name, d in spec.items():
            if d['kind'] == 'csv':
                _shared_vars[name] = _pd.read_csv(StringIO(d['payload']))
            else:
                _shared_vars[name] = _pd.DataFrame(d['payload'])
        return ''
    except Exception:
        return traceback.format_exc()
```

NOTE the multi-line-last-expression subtlety: compiling the last *line* as `eval` fails with `SyntaxError` when it is the tail of a multi-line call — the fallback then execs the whole block, so nothing breaks; the figure just isn't auto-shown. `show(...)` is the documented way to display from inside multi-line constructs (same trade-off as code2web).

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 brython/tests/test_brython_runner.py`
Expected: `PASS` ×7.

- [ ] **Step 5: Commit**

```bash
git add brython/brython_runner.py brython/tests/test_brython_runner.py
git commit -m "feat(brython): add persistent runner with embed-marker output"
```

---

### Task 4: `js/brython-engine.js` — loader, module registration, run API

**Files:**
- Create: `js/brython-engine.js`

**Interfaces:**
- Consumes: `brython/*.py` (Tasks 1–3) fetched relative to the page; `window.__brythonParquetColumns(bytes) -> Promise<{col: [values]}>` (Task 5 hook); document nodes `<script type="application/json" id="brythondata_<name>">`.
- Produces: `window.BrythonEngine = { load(): Promise, run(script, opts): Promise<{text, error}> }` where `opts = { loads: [{alias, format, bytes}] }` (the `resolveAndFetchLoads` result). Consumed by Task 5's `modeRegistry` entry and Task 6's dashboard ctx.

- [ ] **Step 1: Read the reference implementation**

Read `/Users/hom/Documents/GitHub/code2web/web2.html` — the `ensureBrythonLoaded()` function (~line 2905: script injection + `brython()` init) and the module-registration block (~line 13523: fetched `.py` sources injected as `<script type="text/python" id="<module>">` so Brython's import system resolves them). Mirror that mechanism exactly; it is proven.

- [ ] **Step 2: Implement the engine**

Create `js/brython-engine.js` (ES5-style like the other `js/` modules, IIFE, no imports):

```js
// js/brython-engine.js — lightweight Python engine (Brython) for openstat/safestat.
// Design: docs/superpowers/specs/2026-07-10-brython-engine-design.md
// Loads Brython 3.12 from CDN, registers pandas_brython/plotly_express_brython
// as text/python script tags (id MUST equal module name — that is how Brython
// resolves imports), compiles brython_runner.py once, and exposes run().
// Output is embed-marker text; index.html renders it via buildOutputNodes().
(function () {
  'use strict';
  var BRYTHON_CORE = 'https://cdn.jsdelivr.net/npm/brython@3.12.0/brython.min.js';
  var BRYTHON_STDLIB = 'https://cdn.jsdelivr.net/npm/brython@3.12.0/brython_stdlib.js';
  var PY_LIBS = ['pandas_brython', 'plotly_express_brython'];

  var __enginePromise = null;

  function addScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Kunne ikke laste ' + src)); };
      document.head.appendChild(s);
    });
  }

  function addPyModule(name, source) {
    if (document.getElementById(name)) return;
    var s = document.createElement('script');
    s.type = 'text/python';
    s.id = name;                       // id == module name (Brython import contract)
    s.textContent = source;
    document.head.appendChild(s);
  }

  function fetchText(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error('Kunne ikke hente ' + path + ' (' + r.status + ')');
      return r.text();
    });
  }

  function load() {
    if (__enginePromise) return __enginePromise;
    __enginePromise = (async function () {
      await addScript(BRYTHON_CORE);
      await addScript(BRYTHON_STDLIB);
      var sources = await Promise.all(
        PY_LIBS.concat(['brython_runner']).map(function (m) { return fetchText('brython/' + m + '.py'); }));
      PY_LIBS.forEach(function (m, i) { addPyModule(m, sources[i]); });
      window.brython({ debug: 0, ids: [] });   // init WITHOUT auto-running page scripts
      var mod = window.__BRYTHON__.runPythonSource(sources[PY_LIBS.length], 'brython_runner');
      return mod;
    })().catch(function (e) { __enginePromise = null; throw e; });
    return __enginePromise;
  }

  // Convert resolveAndFetchLoads results + embedded blocks to the runner's
  // {name: {kind, payload}} spec. CSV/JSON parse in Python; parquet converts
  // via the DuckDB-WASM helper exported by index.html (lazy — only if used).
  async function buildDatasetSpec(loads) {
    var spec = {};
    var i, l;
    for (i = 0; i < (loads || []).length; i++) {
      l = loads[i];
      if (!l.bytes) continue;
      if (l.format === 'csv') {
        spec[l.alias] = { kind: 'csv', payload: new TextDecoder().decode(l.bytes) };
      } else if (l.format === 'json') {
        spec[l.alias] = { kind: 'columns', payload: JSON.parse(new TextDecoder().decode(l.bytes)) };
      } else if (l.format === 'parquet') {
        if (typeof window.__brythonParquetColumns !== 'function') {
          throw new Error('parquet-kilden «' + l.alias + '» støttes ikke: DuckDB-hjelperen mangler');
        }
        spec[l.alias] = { kind: 'columns', payload: await window.__brythonParquetColumns(l.bytes) };
      } else {
        throw new Error('formatet «' + l.format + '» (' + l.alias + ') støttes ikke i Brython-modus — bruk python/r');
      }
    }
    // Embedded data blocks (published dashboards): checked after # load so an
    // explicit load wins over a baked-in copy with the same name.
    var nodes = document.querySelectorAll('script[type="application/json"][id^="brythondata_"]');
    for (i = 0; i < nodes.length; i++) {
      var name = nodes[i].id.slice('brythondata_'.length);
      if (!spec[name]) spec[name] = { kind: 'columns', payload: JSON.parse(nodes[i].textContent) };
    }
    return spec;
  }

  async function run(script, opts) {
    var mod = await load();
    var spec = await buildDatasetSpec(opts && opts.loads);
    if (Object.keys(spec).length) {
      var bindErr = mod._bind_datasets(JSON.stringify(spec));
      if (bindErr) return { text: '', error: String(bindErr) };
    }
    var text = mod._execute_code(script);
    var err = mod._get_last_error();
    return { text: String(text == null ? '' : text), error: err ? String(err) : null };
  }

  window.BrythonEngine = { load: load, run: run };
})();
```

- [ ] **Step 3: Syntax-check**

Run: `node --check js/brython-engine.js`
Expected: no output (exit 0).

CAVEAT for the implementer: `window.brython({ids: []})` and `__BRYTHON__.runPythonSource(src, name)` must match what code2web actually calls (Step 1). If code2web passes different arguments (e.g. `runPythonSource(src)` single-arg or `brython(1)`), copy code2web's exact invocation — its pattern is the one proven to work with script-tag module resolution. Behavior is verified end-to-end in Task 8.

- [ ] **Step 4: Commit**

```bash
git add js/brython-engine.js
git commit -m "feat(brython): add engine loader/runner bridge (js/brython-engine.js)"
```

---

### Task 5: `index.html` hooks — mode, registry, loader wiring, parquet helper

**Files:**
- Modify: `index.html` (six small hooks; anchors given as search strings — line numbers drift)

**Interfaces:**
- Consumes: `window.BrythonEngine` (Task 4), `window.DataLoader.resolveAndFetchLoads` (existing), `renderOutput` / `outputArea` / `setStatus` / `t` (existing, in-scope at the modeRegistry definition).
- Produces: `window.__brythonParquetColumns(bytes)` (consumed by Task 4); mode `brython` runnable from the UI.

- [ ] **Step 1: Script include**

Find `<script src="https://cdn.plot.ly/plotly-2.32.0.min.js"` (~line 675). Immediately after the block of local `js/` includes that follows it (search `js/data-loader.js`), add:

```html
  <script src="js/brython-engine.js"></script>
```

- [ ] **Step 2: Mode button**

Find `<button type="button" data-mode="duckdb">DuckDB</button>` (~line 374). Add after it:

```html
          <button type="button" data-mode="brython">Brython</button>
```

Also extend the dropdown's `title` attribute two lines above (`Velg modus (Microdata, Python, R, Statx, Jamovi, Jamovi light, DuckDB)`) to end `…, DuckDB, Brython)`.

- [ ] **Step 3: modeRegistry entry + RUNTIME_FOR_MODE row**

In `const modeRegistry = {` (~line 3284), after the `duckdb:` entry, add:

```js
      brython: { id: 'brython', label: 'Brython', hlConfig: PY_HL_CFG, handleTab: handlePythonTab,
        translate: { showsButton: false },
        onActivate: function () { if (window.BrythonEngine) window.BrythonEngine.load().catch(function () {}); },
        runSelf: async function (script, ctx) {
          setStatus(ctx.rightStatus, t('Laster Brython…'));
          var _dl = await window.DataLoader.resolveAndFetchLoads(script,
            { anthropicKey: getAnthropicKey(), promptKey: mdPromptKey });
          setStatus(ctx.rightStatus, t('Kjører…'));
          var res = await window.BrythonEngine.run(script, { loads: _dl.loads });
          var _omEl = document.querySelector('input[name="outputMode"]:checked');
          renderOutput(res.text || '', !_omEl || _omEl.value === 'html',
            (typeof suppressEmbedded !== 'undefined' && suppressEmbedded) ? !!suppressEmbedded.checked : false);
          if (res.error) {
            var _pre = document.createElement('pre');
            _pre.className = 'error';
            _pre.textContent = res.error;
            outputArea.appendChild(_pre);
          }
          setStatus(ctx.rightStatus, res.error ? t('Feil') : t('Ferdig'));
        } },
```

In `var RUNTIME_FOR_MODE = {` (~line 3359) add `brython: 'brython'` to the object (before `r: 'webr'`).

- [ ] **Step 4: Eager-load branch + state maps**

Find the eager-load `if (runtimeForMode(activeEditorMode) === 'webr') {` (~line 8395, below the comment mentioning "senere brython → egen gren her"). Change to:

```js
    if (runtimeForMode(activeEditorMode) === 'webr') {
      loadWebR().then(function () {
        if (webRReady) runtimeReadyBootstrap(null);
      });
    } else if (runtimeForMode(activeEditorMode) === 'brython') {
      window.BrythonEngine.load().then(function () {
        runtimeReadyBootstrap(null);
      }).catch(function (e) {
        setStatus(leftStatus, 'Load failed: ' + (e && e.message ? e.message : String(e)), true);
      });
    } else {
      loadPyodideAndM2py()
      ...
```

(keep the existing pyodide else-branch untouched).

In `const editorContent = { microdata: '', …, duckdb: '' }` (~line 3766) add `brython: ''`; in `const editorBP = { … }` on the next line add `brython: new Set()`.

- [ ] **Step 5: Startup example**

Find `const STARTUP_EXAMPLES = { python: _STARTUP_PY, r: _STARTUP_R, microdata: _PLACEHOLDER_MICRODATA };` (~line 3703). Above it, add (reusing the existing `_DATA_RAW` constant used by `_STARTUP_PY`):

```js
    const _STARTUP_BRYTHON = [
      '# OpenStat — Brython: lettvekts-Python som laster på et par sekunder.',
      '# Bra for dashboards. Full pandas/statistikk: bytt til Python-modus.',
      '# load ' + _DATA_RAW + 'iris.csv as iris',
      'import pandas_brython as pd',
      'import plotly_express_brython as pe',
      '',
      'show(iris.head())',
      'pe.scatter(iris, x="sepal_length", y="sepal_width", color="species",',
      '           title="Iris — begerbladlengde mot -bredde")',
    ].join('\n');
```

and extend the map: `{ python: _STARTUP_PY, r: _STARTUP_R, microdata: _PLACEHOLDER_MICRODATA, brython: _STARTUP_BRYTHON }`.

- [ ] **Step 6: Parquet helper**

Directly after `window.runStaticQuery = async function (sql) {…};` (~line 2912), add:

```js
    // Brython-modus: konverter vilkårlige parquet-bytes til kolonne-arrays via
    // DuckDB-WASM (lastes lat — kun når en brython-kjøring faktisk laster parquet).
    window.__brythonParquetColumns = async function (bytes) {
      const db = await __ensureDuckDB();
      await db.registerFileBuffer('_brython_tmp.parquet', bytes);
      const conn = await db.connect();
      try { return __arrowToColumns(await conn.query("SELECT * FROM read_parquet('_brython_tmp.parquet')")); }
      finally { await conn.close(); try { await db.dropFile('_brython_tmp.parquet'); } catch (e) {} }
    };
```

- [ ] **Step 7: Sanity check**

Run: `node -e "const s=require('fs').readFileSync('index.html','utf8'); ['data-mode=\"brython\"','brython: \\'brython\\'','__brythonParquetColumns','_STARTUP_BRYTHON','js/brython-engine.js'].forEach(x=>{if(!s.includes(x)) throw new Error('missing: '+x)}); console.log('hooks OK')"`
Expected: `hooks OK`

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat(brython): wire Brython mode into editor (registry, loader, example)"
```

---

### Task 6: Dashboard integration

**Files:**
- Modify: `index.html` (two spots in the dashboard machinery)

**Interfaces:**
- Consumes: `window.BrythonEngine.run` (Task 4).
- Produces: `#options.view=dashboard` scripts run in Brython mode; chunks execute via the engine and render through the existing `renderInto`.

- [ ] **Step 1: Extend the dashboard gate**

Find `if (window.Dashboard && (activeEditorMode === 'python' || activeEditorMode === 'r')) {` (~line 8504). Add `|| activeEditorMode === 'brython'` to the condition.

- [ ] **Step 2: Extend buildDashboardCtx**

In `function buildDashboardCtx() {` (~line 8420):

Change `var mode = (activeEditorMode === 'r') ? 'r' : 'python';` to:

```js
      var mode = (activeEditorMode === 'r') ? 'r'
        : (activeEditorMode === 'brython') ? 'brython' : 'python';
```

After `async function runR(code) {…}` add:

```js
      async function runBry(code) {
        try {
          var res = await window.BrythonEngine.run(code, {});
          // kind 'py' med ren tekst — renderInto ruter den til buildOutputNodes,
          // som forstår Brython-runnerens embed-markører direkte.
          return { kind: 'py', text: res.text || '', error: res.error || null };
        } catch (e) {
          return { kind: 'py', text: '', error: (e && e.message) || String(e) };
        }
      }
```

Change the return line to:

```js
      return { mode: mode, run: (mode === 'r') ? runR : (mode === 'brython') ? runBry : runPy,
               renderOutput: renderInto, t: t };
```

NOTE: the dashboard setup zone (where `# load` directives live) runs through the mode's `runSelf` (Task 5), which resolves loads and binds datasets into the persistent runner globals — so chunks executed later via `runBry` see the loaded frames. No load-handling is needed in `runBry` itself.

- [ ] **Step 3: Sanity check + commit**

Run: `node -e "const s=require('fs').readFileSync('index.html','utf8'); if(!s.includes('runBry')||!s.includes(\"activeEditorMode === 'brython'\")) throw new Error('dashboard hooks missing'); console.log('OK')"`
Expected: `OK`

```bash
git add index.html
git commit -m "feat(brython): dashboard view support for brython mode"
```

---

### Task 7: Service worker caching

**Files:**
- Modify: `sw.js`

- [ ] **Step 1: Add Brython assets**

`cdn.jsdelivr.net` is already in `CDN_HOSTS` (line ~7) — no host change needed. In `PRECACHE_URLS` (line ~22) add:

```js
  'https://cdn.jsdelivr.net/npm/brython@3.12.0/brython.min.js',
  'https://cdn.jsdelivr.net/npm/brython@3.12.0/brython_stdlib.js',
```

In `LOCAL_SWR_SUFFIXES` (line ~14) add:

```js
  '/brython/pandas_brython.py',
  '/brython/plotly_express_brython.py',
  '/brython/brython_runner.py'
```

- [ ] **Step 2: Bump the cache version**

Per the file-top comment: change `const CACHE = 'm2py-v7';` to `'m2py-v8'`.

- [ ] **Step 3: Commit**

```bash
git add sw.js
git commit -m "feat(brython): precache Brython runtime and libs in service worker"
```

---

### Task 8: End-to-end browser verification (openstat)

**Files:** none (verification only; fix regressions found, in the task that owns them)

- [ ] **Step 1: Serve locally**

```bash
cd /Users/hom/Documents/GitHub/openstat && python3 -m http.server 8801
```

- [ ] **Step 2: Verify in browser** (use available browser tools, e.g. Playwright/Chrome DevTools MCP; otherwise report the checklist for Hans to click through)

Open `http://localhost:8801/`, then:

1. Switch mode dropdown to **Brython** → network shows `brython.min.js` (~3 MB total, NOT pyodide ~20 MB); run buttons go idle.
2. The starter example auto-runs (it auto-runs when unchanged): output shows an iris table AND a Plotly scatter colored by species. Console has no errors.
3. Run `1/0` → red `pre.error` with a `ZeroDivisionError` traceback.
4. Run `import pandas_brython as pd\npd.DataFrame({"a":[1]}).merge(None)` → clear NotImplementedError message naming Python-modus.
5. State: run `x = 5`, then run `x * 2` → `10`.
6. Dashboard: prepend `#options.view=dashboard` to a script with a `#input`-separated chunk producing `pe.bar(...)` → dashboard skeleton renders with the chart. (Check `js/dashboard.js` docs/examples for the exact chunk syntax before writing this script.)
7. Switch to Python mode and run its starter → Pyodide path unaffected.

- [ ] **Step 3: Fix → re-verify → commit any fixes**

Each fix goes in a commit referencing the broken step, e.g. `fix(brython): <what> (e2e step N)`.

---

### Task 9: Port to safestat

**Files:**
- Create: `../safestat/brython/` (all files), `../safestat/js/brython-engine.js` (copies)
- Modify: `../safestat/index.html`, `../safestat/sw.js`

Safestat is the same codebase with extra security layers; its anchors sit at different line numbers (modeRegistry ~3817, RUNTIME_FOR_MODE ~3898) — ALWAYS locate by search string, never by line number. Safestat also has an extra `safestat` mode in the dropdown — leave it untouched.

- [ ] **Step 1: Copy the new files**

```bash
cd /Users/hom/Documents/GitHub/safestat
cp -R ../openstat/brython ./brython
cp ../openstat/js/brython-engine.js js/brython-engine.js
```

- [ ] **Step 2: Run the Python tests in safestat**

Run: `for f in brython/tests/test_*.py; do python3 "$f" || exit 1; done`
Expected: all PASS.

- [ ] **Step 3: Apply the same index.html hooks**

Repeat Task 5 Steps 1–6 and Task 6 Steps 1–2 in `safestat/index.html`, locating every anchor with the same search strings (`data-mode="duckdb"`, `const modeRegistry`, `RUNTIME_FOR_MODE`, `runtimeForMode(activeEditorMode) === 'webr'`, `const editorContent`, `const STARTUP_EXAMPLES`, `window.runStaticQuery`, `buildDashboardCtx`, the dashboard gate). The hook code is IDENTICAL to openstat's — copy each block verbatim from `../openstat/index.html` (search for `brython` there). If an anchor differs materially in safestat (e.g. the `safestat` mode entry sits where you'd insert), place the brython entry immediately after the `duckdb` entry regardless.

- [ ] **Step 4: Apply the sw.js changes**

Repeat Task 7 in `safestat/sw.js` (same additions; bump ITS cache version string by one — check its current value first, it may differ from openstat's).

- [ ] **Step 5: Verify parity + e2e**

```bash
diff ../openstat/js/brython-engine.js js/brython-engine.js && diff -r ../openstat/brython ./brython && echo "parity OK"
```
Expected: `parity OK`.

Then repeat Task 8's checklist against `python3 -m http.server 8802` in safestat (at minimum steps 1, 2, 3 and 7).

- [ ] **Step 6: Commit (in safestat)**

```bash
git add brython js/brython-engine.js index.html sw.js
git commit -m "feat(brython): port Brython lightweight engine from openstat"
```

---

## Self-review notes (spec coverage)

- Spec §Architecture (new files + hooks): Tasks 1–5. §Output protocol: Task 3 (+Task 5 renderOutput). §Data paths 1/2/3 (embedded, # load csv/json, parquet-via-DuckDB): Task 4 + Task 5 Step 6. §Error handling (tracebacks + gap verbs): Tasks 1, 3, 5. §Dashboards (primary use case): Task 6. §SW caching: Task 7. §Testing/smoke: Tasks 1–3 (unit) + 8 (e2e). §Rollout openstat→safestat: Task 9. Publishing-side embedded-data baking: explicitly a spec follow-up, not planned here.
