# Tabulator Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tabulator.table(df, ...)` → interactive Tabulator table in all three python modes, plus a generalized `show(df)` that renders DataFrames as interactive tables by default (`format='html'` for the old static path).

**Architecture:** Shared dict-building core + facades (standard workstream pattern), a new `tabulator__` embed rendered by the already-loaded Tabulator 6.3.1, a small duplicated `_df_tabulator_spec` helper in each runner so `show(df)` works without any import (spec-parity with the core is test-enforced), and an `__ensureUi`-style module registration for pyodide.

**Tech Stack:** Python (CPython/Brython/MicroPython), Tabulator 6.3.1 (static in index.html — no lazy JS, no CSS work beyond a title style).

**Spec:** `docs/superpowers/specs/2026-07-24-tabulator-shim-design.md`.

## Global Constraints

- `shared/tabulator_core.py` dialect-neutral (trap list: `micropython/plotly_express_mpy.py` header); no runtime imports, no configure needed.
- Facades: explicit rebinds, never star-import.
- Real pandas `to_dict()` returns `{col: {idx: val}}` (nested dicts) while the pandas shims return `{col: [list]}` — `_records_and_columns` MUST handle both (pyodide runs the core on real pandas).
- `_fmt` branch order (both runners): `_openstat_el_id` → **tabulator** → leafletmap → vegalite → plotly → to_html.
- Runner helper and `tabulator_core.table` must produce IDENTICAL specs for the same input — enforced by `test_spec_parity_with_core`.
- Bump `M2PY_VERSION`, the engine-js `?v=` tags (~line 600) and `app.css?v=` in the final index.html task.
- Norwegian comments; commit per task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `shared/tabulator_core.py`

**Files:**
- Create: `shared/tabulator_core.py`
- Create: `brython/tests/test_tabulator_core.py`

**Interfaces:**
- Produces: `table(data, pagination=None, height=None, filters=False, sortable=True, title=None, options=None) -> Table`, `class Table` (`to_dict()`, `to_tabulator_json_str()`, `show()`, `__repr__`), `_records_and_columns(data) -> (cols, records)`, `_is_nan(v)`. Spec shape: `{'columns': [...], 'data': [...], 'options': {...}, 'title'?}` per the design doc.

- [ ] **Step 1: Write failing tests** — `brython/tests/test_tabulator_core.py`:

```python
# Enhetstester for shared/tabulator_core.py — kjøres under CPython:
#   python3 brython/tests/test_tabulator_core.py
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import tabulator_core as tab


def test_dict_of_lists_basic():
    t = tab.table({'aar': [2020, 2021], 'navn': ['a', 'b']})
    spec = t.to_dict()
    assert [c['field'] for c in spec['columns']] == ['aar', 'navn']
    assert spec['data'] == [{'aar': 2020, 'navn': 'a'}, {'aar': 2021, 'navn': 'b'}]
    aar = spec['columns'][0]
    assert aar['hozAlign'] == 'right' and aar['sorter'] == 'number'
    navn = spec['columns'][1]
    assert 'hozAlign' not in navn and navn['sorter'] == 'string'
    # liten tabell -> ingen paginering
    assert 'pagination' not in spec['options']


def test_list_of_records_and_dataframe_ducktype():
    recs = [{'x': 1, 'y': 'a'}, {'x': 2, 'y': 'b'}]
    t = tab.table(recs)
    assert t.to_dict()['data'] == recs
    import pandas_brython as bpd
    t2 = tab.table(bpd.DataFrame({'x': [1, 2], 'y': ['a', 'b']}))
    assert t2.to_dict()['data'] == recs


def test_real_pandas_nested_to_dict_shape():
    # ekte pandas' to_dict() gir {kol: {idx: verdi}} — kjernen kjører på
    # ekte pandas i pyodide og MÅ håndtere begge formene
    class FakeReal:
        columns = ['x', 'y']
        def to_dict(self):
            return {'x': {0: 1, 1: 2}, 'y': {0: 'a', 1: 'b'}}
    spec = tab.table(FakeReal()).to_dict()
    assert spec['data'] == [{'x': 1, 'y': 'a'}, {'x': 2, 'y': 'b'}]


def test_pagination_auto_threshold():
    big = {'v': list(range(201))}
    spec = tab.table(big).to_dict()
    assert spec['options']['pagination'] == 'local'
    assert spec['options']['paginationSize'] == 20
    small = {'v': list(range(200))}
    assert 'pagination' not in tab.table(small).to_dict()['options']
    explicit = tab.table({'v': [1, 2]}, pagination=50).to_dict()
    assert explicit['options']['paginationSize'] == 50
    off = tab.table(big, pagination=False).to_dict()
    assert 'pagination' not in off['options']


def test_filters_sortable_height_title():
    spec = tab.table({'v': [1]}, filters=True, sortable=False,
                     height=300, title='Tittel').to_dict()
    c = spec['columns'][0]
    assert c['headerFilter'] == 'input' and c['headerSort'] is False
    assert spec['options']['height'] == 300
    assert spec['title'] == 'Tittel'


def test_options_passthrough_wins():
    spec = tab.table({'v': list(range(300))},
                     options={'paginationSize': 5, 'movableColumns': True}).to_dict()
    assert spec['options']['paginationSize'] == 5      # vinner over auto-20
    assert spec['options']['movableColumns'] is True


def test_callable_option_raises():
    try:
        tab.table({'v': [1]}, options={'rowClick': lambda: None})
        assert False
    except TypeError as e:
        assert 'callable' in str(e) or 'funksjon' in str(e)


def test_nan_becomes_none():
    import pandas_brython as bpd
    spec = tab.table(bpd.DataFrame({'v': [1.0, bpd.nan]})).to_dict()
    assert spec['data'][1]['v'] is None
    json.dumps(spec)


def test_runner_protocol_and_repr():
    t = tab.table({'v': [1]})
    assert json.loads(t.to_tabulator_json_str())['data'] == [{'v': 1}]
    assert 'Table' in repr(t)


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE TABULATOR-CORE-TESTER GRØNNE')
```

- [ ] **Step 2: Run to verify failure** — ModuleNotFoundError.

- [ ] **Step 3: Implement** — `shared/tabulator_core.py`:

```python
"""tabulator_core — interaktive tabeller (Tabulator 6.3.1) for
brython/micropython/pyodide/CPython (spec 2026-07-24-tabulator-shim-
design.md). Dialektregler som de andre kjernene. Ren dict-bygging —
Tabulator-JS-en er statisk lastet i index.html, og opsjoner utover de
navngitte går uendret gjennom `options={...}` (Tabulator-dokumentasjonen
er referansen). Vises via show()/siste uttrykk (tabulator__-embedden)."""

import json

_PAGINATION_AUTO_THRESHOLD = 200
_PAGINATION_AUTO_SIZE = 20


def _is_nan(v):
    if v is None:
        return True
    if type(v).__name__ == 'NaN':
        return True
    return isinstance(v, float) and v != v


def _records_and_columns(data):
    """-> (kolonnenavn, liste av rad-dicts). Godtar DataFrame (duck-typet
    .columns + .to_dict() — BÅDE shim-formen {kol: [liste]} og ekte
    pandas' {kol: {idx: verdi}}), dict-av-lister og liste-av-records."""
    if hasattr(data, 'columns') and hasattr(data, 'to_dict'):
        cols = [str(c) for c in list(data.columns)]
        raw = data.to_dict()
        norm = {}
        for c0 in raw:
            v = raw[c0]
            if isinstance(v, dict):
                norm[str(c0)] = list(v.values())
            else:
                norm[str(c0)] = list(v)
        data = norm
        keys = cols
    elif isinstance(data, dict):
        keys = [str(k) for k in data.keys()]
        data = {str(k): list(data[k]) for k in data}
    elif isinstance(data, (list, tuple)):
        recs = []
        keys = []
        for r in data:
            row = {}
            for k in r:
                ks = str(k)
                if ks not in keys:
                    keys.append(ks)
                row[ks] = r[k]
            recs.append(row)
        return keys, recs
    else:
        raise ValueError('table(data): forventer DataFrame, dict av '
                         'lister eller liste av dicts')
    n = 0
    for k in keys:
        n = max(n, len(data.get(k, [])))
    recs = []
    for i in range(n):
        row = {}
        for k in keys:
            seq = data.get(k, [])
            row[k] = seq[i] if i < len(seq) else None
        recs.append(row)
    return keys, recs


def _json_safe_cell(v):
    if _is_nan(v):
        return None
    if isinstance(v, (bool, int, float, str)):
        return v
    return str(v)


def _check_no_callables(obj, path):
    if callable(obj):
        raise TypeError('options-verdien «' + path + '» er en funksjon — '
                        'kun JSON-serialiserbare verdier kan sendes til '
                        'Tabulator (bruk formatter-NAVN som streng, se '
                        'Tabulator-dokumentasjonen)')
    if isinstance(obj, dict):
        for k in obj:
            _check_no_callables(obj[k], path + '.' + str(k))
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            _check_no_callables(v, path + '[' + str(i) + ']')


class Table:
    def __init__(self, data, pagination=None, height=None, filters=False,
                 sortable=True, title=None, options=None):
        keys, recs = _records_and_columns(data)
        recs = [{k: _json_safe_cell(r[k]) for k in r} for r in recs]
        numeric = {}
        for k in keys:
            saw = False
            ok = True
            for r in recs:
                v = r.get(k)
                if v is None:
                    continue
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    ok = False
                    break
                saw = True
            numeric[k] = ok and saw
        colspecs = []
        for k in keys:
            c = {'title': k, 'field': k,
                 'sorter': 'number' if numeric[k] else 'string'}
            if numeric[k]:
                c['hozAlign'] = 'right'
            if filters:
                c['headerFilter'] = 'input'
            if not sortable:
                c['headerSort'] = False
            colspecs.append(c)
        opts = {}
        n = len(recs)
        if pagination is None or pagination is True:
            if n > _PAGINATION_AUTO_THRESHOLD:
                opts['pagination'] = 'local'
                opts['paginationSize'] = _PAGINATION_AUTO_SIZE
        elif pagination is not False:
            opts['pagination'] = 'local'
            opts['paginationSize'] = int(pagination)
        if height is not None:
            opts['height'] = height
        if options:
            _check_no_callables(options, 'options')
            for k in options:
                opts[k] = options[k]
        self._spec = {'columns': colspecs, 'data': recs, 'options': opts}
        if title is not None:
            self._spec['title'] = title

    def to_dict(self):
        return self._spec

    def to_tabulator_json_str(self):
        """Runner-protokollen (_fmt/show): hele spec-en som JSON-streng."""
        return json.dumps(self._spec)

    def show(self):
        return str(self)

    def __str__(self):
        return '<Table: use show() or leave as last expression>'

    def __repr__(self):
        return str(self)

    def _repr_html_(self):
        return str(self)


def table(data, pagination=None, height=None, filters=False,
          sortable=True, title=None, options=None):
    return Table(data, pagination=pagination, height=height,
                 filters=filters, sortable=sortable, title=title,
                 options=options)
```

- [ ] **Step 4: Run** — all PASS. **Step 5: Commit** `feat(tabulator): tabulator_core — spec-bygger`.

---

### Task 2: Runnere — `_fmt`-gren, `_df_tabulator_spec`, generalisert `_show`

**Files:**
- Modify: `brython/brython_runner.py` (`_fmt` ~line 34-area; `_show` line ~130)
- Modify: `micropython/micropython_runner.py` (samme; `_show` line ~150)
- Create: `brython/tests/test_tabulator_runner.py`

**Interfaces:**
- Consumes: `Table.to_tabulator_json_str()`; `tabulator_core.table` (kun i paritetstesten).
- Produces: embed-typen `tabulator` fra både `_fmt` og `show(df)`; `show(*objs, format=None, **opts)`-semantikken fra spec-en.

- [ ] **Step 1: Failing tests** — `brython/tests/test_tabulator_runner.py`:

```python
#   python3 brython/tests/test_tabulator_runner.py
import sys, os, json, io
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'micropython'))
import tabulator_core as tab
import pandas_brython as bpd
import brython_runner
import micropython_runner


def _capture_show(runner, *a, **kw):
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        runner._shared_vars['show'](*a, **kw)
    finally:
        sys.stdout = old
    return buf.getvalue()


def test_fmt_table_object():
    t = tab.table({'v': [1, 2]})
    out = brython_runner._fmt(t)
    assert out.startswith('__micro_transform_start_tabulator__')
    out2 = micropython_runner._fmt(t)
    assert out2.startswith('__micro_transform_start_tabulator__')


def test_show_df_defaults_to_tabulator():
    df = bpd.DataFrame({'aar': [2020, 2021], 'antall': [1, 2]})
    for runner in (brython_runner, micropython_runner):
        out = _capture_show(runner, df)
        assert 'tabulator__' in out, out[:120]
        assert 'tablehtml__' not in out


def test_show_df_format_html_is_old_path():
    df = bpd.DataFrame({'aar': [2020], 'antall': [1]})
    for runner in (brython_runner, micropython_runner):
        out = _capture_show(runner, df, format='html')
        assert 'tablehtml__' in out and 'tabulator__' not in out


def test_show_unknown_format_raises():
    df = bpd.DataFrame({'v': [1]})
    try:
        _capture_show(brython_runner, df, format='pdf')
        assert False
    except ValueError as e:
        assert 'tabulator' in str(e)


def test_show_opts_forwarded():
    df = bpd.DataFrame({'v': [1]})
    out = _capture_show(brython_runner, df, filters=True, title='T')
    payload = out.split('tabulator__\n', 1)[1].rsplit('\n__micro_transform_end__', 1)[0]
    spec = json.loads(payload)
    assert spec['title'] == 'T' and spec['columns'][0]['headerFilter'] == 'input'


def test_show_nontable_objects_unchanged():
    class FakeVega:
        def to_vegalite_json_str(self):
            return '{}'
    out = _capture_show(brython_runner, FakeVega())
    assert 'vegalite__' in out
    out2 = _capture_show(brython_runner, 'hei')
    assert out2.strip() == 'hei'


def test_spec_parity_with_core():
    df = bpd.DataFrame({'aar': [2020, 2021], 'navn': ['a', 'b'],
                        'v': [1.5, None]})
    want = tab.table(df, filters=True, pagination=10, title='X').to_dict()
    for runner in (brython_runner, micropython_runner):
        got = runner._df_tabulator_spec(df, {'filters': True,
                                             'pagination': 10, 'title': 'X'})
        assert got == want, (runner.__name__, got, want)


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE TABULATOR-RUNNER-TESTER GRØNNE')
```

- [ ] **Step 2: Verify fail.** **Step 3: Implement in BOTH runners.**

`_fmt`: insert BEFORE the `to_leaflet_json_str` branch:

```python
    if hasattr(obj, 'to_tabulator_json_str'):
        # tabulator-wrapperen (spec 2026-07-24): interaktiv tabell i JS
        return _EMBED_S + 'tabulator__' + '\n' + obj.to_tabulator_json_str() + '\n' + _EMBED_E
```

New helper directly above `_show` (identical in both runners, only the docstring naming its sibling):

```python
def _df_tabulator_spec(df, opts):
    """DataFrame -> tabulator-embed-spec. BEVISST duplisert fra
    shared/tabulator_core.py (identisk output — håndhevet av
    test_spec_parity_with_core): show(df) skal virke uten at
    tabulator-modulen er importert/registrert i økten."""
    keys = [str(c) for c in list(df.columns)]
    raw = df.to_dict()
    norm = {}
    for c0 in raw:
        v = raw[c0]
        norm[str(c0)] = list(v.values()) if isinstance(v, dict) else list(v)
    n = 0
    for k in keys:
        n = max(n, len(norm.get(k, [])))
    def _cell(v):
        if v is None:
            return None
        if type(v).__name__ == 'NaN':
            return None
        if isinstance(v, float) and v != v:
            return None
        if isinstance(v, (bool, int, float, str)):
            return v
        return str(v)
    recs = []
    for i in range(n):
        row = {}
        for k in keys:
            seq = norm.get(k, [])
            row[k] = _cell(seq[i]) if i < len(seq) else None
        recs.append(row)
    colspecs = []
    for k in keys:
        saw = False
        ok = True
        for r in recs:
            v = r.get(k)
            if v is None:
                continue
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                ok = False
                break
            saw = True
        numeric = ok and saw
        c = {'title': k, 'field': k,
             'sorter': 'number' if numeric else 'string'}
        if numeric:
            c['hozAlign'] = 'right'
        if opts.get('filters'):
            c['headerFilter'] = 'input'
        if opts.get('sortable') is False:
            c['headerSort'] = False
        colspecs.append(c)
    o = {}
    pag = opts.get('pagination')
    if pag is None or pag is True:
        if len(recs) > 200:
            o['pagination'] = 'local'
            o['paginationSize'] = 20
    elif pag is not False:
        o['pagination'] = 'local'
        o['paginationSize'] = int(pag)
    if opts.get('height') is not None:
        o['height'] = opts['height']
    spec = {'columns': colspecs, 'data': recs, 'options': o}
    if opts.get('title') is not None:
        spec['title'] = opts['title']
    return spec
```

`_show` rewrite (both runners — keep the existing docstring notes about the `if shown:` guard):

```python
def _show(*objs, **kwargs):
    """User-facing show(): print each object in its rendered form.
    DataFrames vises som interaktiv Tabulator-tabell som DEFAULT
    (spec 2026-07-24); format='html' gir den gamle statiske tabellen.
    Øvrige kwargs (pagination/height/filters/sortable/title) går til
    tabellbyggingen."""
    fmtv = kwargs.pop('format', None)
    for o in objs:
        if (hasattr(o, 'to_html') and hasattr(o, 'columns')
                and not hasattr(o, 'to_tabulator_json_str')):
            if fmtv is None or fmtv == 'tabulator':
                spec = _df_tabulator_spec(o, kwargs)
                print(_EMBED_S + 'tabulator__' + '\n' + json.dumps(spec)
                      + '\n' + _EMBED_E)
                continue
            if fmtv != 'html':
                raise ValueError("show(format=...): gyldige verdier er "
                                 "'tabulator' og 'html'")
        shown = _fmt(o)
        if shown:
            print(shown)
```

(NB: `format='html'` faller med vilje gjennom til `_fmt(o)` → tablehtml-veien. brython_runner har `import json` på topp allerede; sjekk at micropython_runner også har det — legg til om ikke.)

- [ ] **Step 4: Run** — `python3 brython/tests/test_tabulator_runner.py` all PASS; also rerun `test_altair_runner_fmt.py`, `test_folium_runner_fmt.py`, `test_micropython_runner.py`, `test_lifelines_core.py` (show-endringen må ikke knekke noe).

- [ ] **Step 5: Commit** `feat(tabulator): tabulator-embed i _fmt + generalisert show(df)`.

---

### Task 3: Fasader + registries + mpy-røyk

**Files:**
- Create: `brython/tabulator_brython.py`, `micropython/tabulator_mpy.py`, `micropython/tests/mpy_smoke_tabulator.py`
- Modify: `js/brython-engine.js`, `js/micropython-engine.js` (etter lifelines-oppføringene)

- [ ] **Step 1: Fasade** — `brython/tabulator_brython.py`:

```python
# Tynn fasade over shared/tabulator_core.py — eksplisitte rebind-er
# (aldri stjerneimport, _Mod-fellen). Samme liste som
# micropython/tabulator_mpy.py.
import tabulator_core as _core

Table = _core.Table
table = _core.table
```

`micropython/tabulator_mpy.py`: identisk (filhode peker på brython-fila).

- [ ] **Step 2: Registries** — `js/brython-engine.js` etter `lifelines_core`:

```js
    // tabulator (spec 2026-07-24): interaktive tabeller — ingen js-deps
    // (Tabulator 6.3.1 er statisk lastet i index.html-head).
    tabulator_brython:      { aliases: ['tabulator'], deps: ['tabulator_core'], js: [] },
    tabulator_core:         { aliases: [], deps: [], js: [],
                              path: 'shared/tabulator_core.py' }
```

Samme i `js/micropython-engine.js` med `tabulator_mpy`. `node --check` begge.

- [ ] **Step 3: MPy-røyk** — `micropython/tests/mpy_smoke_tabulator.py`:

```python
# micropython micropython/tests/mpy_smoke_tabulator.py   (fra repo-roten)
import sys, json
sys.path.insert(0, 'shared')
sys.path.insert(0, 'micropython')
import tabulator_mpy as tab

t = tab.table({'aar': [2020, 2021], 'antall': [3, None]},
              filters=True, title='Røyk')
spec = json.loads(t.to_tabulator_json_str())
assert spec['title'] == 'Røyk'
assert spec['data'][1]['antall'] is None
assert spec['columns'][0]['headerFilter'] == 'input'
print('MPY-TABULATOR-RØYK OK')
```

Run → OK. Kjør også `micropython micropython/tests/test_micropython_runner.py`?? — NEI: den testfila kjøres under CPython (`python3`), se altair-syklusens funn.

- [ ] **Step 4: Alle tester + commit** `feat(tabulator): runtime-kobling — fasader, registry`.

---

### Task 4: index.html — embed-case, pyodide, versjonsbumper, CSS

**Files:**
- Modify: `index.html` — (1) `tabulator`-case i `buildOutputNodes()` FØR `leafletmap`-casen; (2) `_show_one`: tabulator-gren FØR folium-grenen; (3) `__ensureTabulatorPy(py)` ved siden av `__ensureUi` (~9244) + preRun-gren etter lifelines-blokken; (4) `PYTHON_DS_IMPORTS` + `'tabulator'`; (5) `M2PY_VERSION` → `2026-07-24e`, engine-js `?v=` → `2026-07-24b`, `app.css?v=` → `2026-07-24b`
- Modify: `app.css` (tittel-stil)

- [ ] **Step 1: Embed-case** (før leafletmap-casen; setTimeout fordi Tabulator måler containeren — fragmentet monteres først ETTER at buildOutputNodes returnerer):

```js
            } else if (p.embedType === 'tabulator' && p.payload && typeof Tabulator !== 'undefined') {
              try {
                const tbSpec = JSON.parse(p.payload);
                const tbWrap = document.createElement('div');
                tbWrap.className = 'tabulator-embed';
                if (tbSpec.title) {
                  const tbTitle = document.createElement('div');
                  tbTitle.className = 'tabulator-embed-title';
                  tbTitle.textContent = tbSpec.title;
                  tbWrap.appendChild(tbTitle);
                }
                const tbDiv = document.createElement('div');
                tbWrap.appendChild(tbDiv);
                frag.appendChild(tbWrap);
                setTimeout(function () {
                  new Tabulator(tbDiv, Object.assign({
                    data: tbSpec.data,
                    columns: tbSpec.columns,
                    layout: 'fitDataTable',
                    placeholder: '(ingen data)'
                  }, tbSpec.options || {}));
                }, 0);
              } catch (e) {
                const pre = document.createElement('pre');
                pre.className = 'embed-placeholder';
                pre.textContent = '[Tabulator-tabell – kunne ikke tolke JSON]';
                frag.appendChild(pre);
              }
```

- [ ] **Step 2: Pyodide `_show_one`-gren** (FØR folium-grenen, samme try/except-struktur):

```python
    try:
        if hasattr(obj, "to_tabulator_json_str"):
            # tabulator-wrapperen (spec 2026-07-24) -> samme embed som
            # brython/micropython-runnerne
            print(_EMBED_S + "tabulator__" + chr(10) + obj.to_tabulator_json_str() + chr(10) + _EMBED_E)
            return
    except Exception:
        pass
```

- [ ] **Step 3: `__ensureTabulatorPy`** (rett etter `__ensureUi`-funksjonen, samme idiom) + preRun-gren:

```js
    var __tabulatorPyP = null;
    function __ensureTabulatorPy(py) {
      // tabulator-modulen i python-modus (spec 2026-07-24): kjernen ER
      // modulen (ingen pyodide-fasade nødvendig — ren dict-bygging).
      if (__tabulatorPyP) return __tabulatorPyP;
      var base = window.location.href.replace(/[^/]+$/, '');
      __tabulatorPyP = fetch(base + 'shared/tabulator_core.py?v=' + (window.M2PY_VERSION || '1'))
        .then(function (r) { if (!r.ok) throw new Error('shared/tabulator_core.py: ' + r.status); return r.text(); })
        .then(function (code) {
          return py.runPythonAsync(
            'import sys, importlib.util\n' +
            'def _reg_tabulator(src):\n' +
            '    spec = importlib.util.spec_from_loader("tabulator", loader=None)\n' +
            '    mod = importlib.util.module_from_spec(spec)\n' +
            '    sys.modules["tabulator"] = mod\n' +
            '    exec(compile(src, "tabulator_core.py", "exec"), mod.__dict__)\n' +
            '_reg_tabulator(' + JSON.stringify(code) + ')');
        })
        .catch(function (e) { __tabulatorPyP = null; throw e; });
      return __tabulatorPyP;
    }
```

preRun (etter lifelines-blokken):

```js
          // tabulator (spec 2026-07-24): registrer shared/tabulator_core.py
          // som modulen `tabulator` (ingen PyPI-pakke å micropip-e).
          if (/^\s*(?:import|from)\s+tabulator\b/m.test(script)) {
            try { await __ensureTabulatorPy(ctx.py); }
            catch (e) { console.warn('tabulator-modul:', e); }
          }
```

- [ ] **Step 4: Småting** — `PYTHON_DS_IMPORTS` + `'tabulator'` (etter `'folium'`); versjonsbumper per Global Constraints; `app.css`:

```css
/* tabulator-wrapperens embed (buildOutputNodes) */
.tabulator-embed { margin: 6px 0; }
.tabulator-embed-title { font-weight: 600; font-size: 13px; margin: 2px 0 6px; color: var(--text); }
```

- [ ] **Step 5: Commit** `feat(tabulator): embed-rendring + pyodide-modul + versjonsbumper`.

---

### Task 5: Eksempler + manifest

- [ ] `examples/brython/bry30_tabulator.txt`:

```
# label: tabulator — interaktive tabeller
# Sorterbare/filtrerbare tabeller (Tabulator) i brython-modus.
import tabulator
import pandas_brython as pd

df = pd.DataFrame({
    "kommune": ["Oslo", "Bergen", "Trondheim", "Stavanger", "Tromsø"],
    "aar": [2024, 2024, 2024, 2024, 2024],
    "antall": [713, 291, 212, 149, 78],
    "rate": [12.5, 9.8, 9.3, 8.6, 6.8],
})

# show(df) gir interaktiv tabell som standard:
show(df, title="Med show()")

# eller eksplisitt med flere valg (alle Tabulator-opsjoner kan sendes
# via options={...} — se tabulator.info for dokumentasjonen):
tabulator.table(df, filters=True, title="Med filter",
                options={"movableColumns": True})
```

- [ ] `examples/micropython/10_tabulator.txt` — samme med `pandas_mpy`. `examples/python/py10_tabulator.txt` — `import pandas as pd` + `tabulator.table(df, ...)` (ekte pandas; `show()` finnes ikke i python-modus — bruk table()).
- [ ] `python3 examples/generate_manifest.py`; commit.

---

### Task 6: Browser-verifisering + full suite + finishing

- [ ] Brython: kjør bry30 — begge tabellene rendres; klikk kolonneheader → sortering; skriv i filterfeltet → filtrering; skjermbilde.
- [ ] Stor tabell: kjør `show(pd.DataFrame({'v': list(range(500))}))` → paginering synlig (20 per side).
- [ ] `show(df, format='html')` → statisk tabell som før.
- [ ] MicroPython: 10-eksemplet; skjermbilde.
- [ ] Pyodide: py10 — `tabulator.table(df)` på ekte pandas rendres.
- [ ] Tema: mørkt tema — Tabulator-CSS-en (tabulator_simple) + tittel følger.
- [ ] Full suite (alle fire shimenes tester + runnere + node --check); commit fikser; superpowers:finishing-a-development-branch.

## Self-review notes

- Spec-dekning: kjerne (T1), runner-show/_fmt + paritet (T2), fasader/registry (T3), embed/pyodide/versjoner (T4), eksempler (T5), browser (T6).
- Konsistens: `to_tabulator_json_str` (kjerne ↔ runnere ↔ _show_one), `_df_tabulator_spec(df, opts)`-navnet i T2-testene og -implementasjonen, spec-nøklene {columns,data,options,title} i T1/T2/T4.
- Kjent risiko med regel: Tabulator på detached element (T4 setTimeout-grepet; browser-tasken verifiserer), `format='html'`-fallthrough til _fmt (testdekket).
