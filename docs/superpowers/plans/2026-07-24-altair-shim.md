# Altair Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure-python altair API subset (`shared/altair_core.py`) that emits Vega-Lite specs rendered by vega-embed, working identically in brython, micropython and (via real altair) pyodide python mode.

**Architecture:** One dialect-neutral spec-builder file shared by both shim runtimes (ui_core precedent), thin per-runtime wrapper modules, a new `vegalite__` embed type in both runners' `_fmt`, and a vega-embed render path in index.html with app-theme config injected at render time. Fidelity is enforced by differential tests against real altair 6.2.2 (installed locally).

**Tech Stack:** Python (CPython 3.13 for tests, Brython 3.12, unix/wasm MicroPython), vega + vega-lite + vega-embed (pinned CDN), pytest-style plain test files run with `python3`.

**Spec:** `docs/superpowers/specs/2026-07-23-altair-shim-design.md` — read it before starting.

## Global Constraints

- `shared/altair_core.py` must be dialect-neutral: NO `**` inside dict LITERALS (fine in function calls), NO `str.capitalize()`, NO `re`, NO `setdefault` (Brython AST-guard quirk, see plotly shim line ~196), `datetime` import guarded with try/except, no `browser`/`js` imports anywhere. (Trap list: header of `micropython/plotly_express_mpy.py`.)
- Avoid `str.partition`/`rpartition` (MicroPython build-dependent) — use `find`/`rfind` slicing.
- Emitted `$schema` is `https://vega.github.io/schema/vega-lite/v5.json`; `mark` is always the dict form `{"type": ...}` (altair 5+/6 parity).
- Diff tests compare WHOLE normalized specs against real altair (`python3 -c "import altair"` → 6.2.2 available locally); normalization drops `$schema`/`config`/`usermeta`, resolves named-dataset indirection, renames params to `param`.
- All comments in new code follow the repo's Norwegian comment style; only comment non-obvious constraints.
- Commit after every task (at minimum).

---

### Task 1: `shared/altair_core.py` — data normalization, shorthand parser, helper + channel classes

**Files:**
- Create: `shared/altair_core.py`
- Create: `brython/tests/test_altair_core.py`

**Interfaces:**
- Produces: `_records_from_data(data) -> list[dict]`, `_parse_shorthand(sh, records) -> dict`, `_infer_type(field, records) -> str`, `_json_safe(obj)`, `_is_nan(v)`, sentinel `Undefined`, classes `Scale/Axis/Legend/Bin/SortField` (kwargs→dict holders with `_to_channel_dict()`), channel classes `X/Y/Color/Size/Opacity/Tooltip/Column/Row` (all subclass `Channel`, expose `_channel_dict(records) -> dict`), `value(v) -> {'value': v}`, constant `VEGALITE_SCHEMA`.
- Consumes: nothing (first task).

- [ ] **Step 1: Write the failing tests**

Create `brython/tests/test_altair_core.py`:

```python
# Enhetstester for shared/altair_core.py — kjøres under CPython:
#   python3 brython/tests/test_altair_core.py
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import altair_core as alt


def test_records_from_dict_of_lists():
    recs = alt._records_from_data({"a": [1, 2], "b": ["x", "y"]})
    assert recs == [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]


def test_records_from_list_of_dicts():
    src = [{"a": 1}, {"a": 2}]
    recs = alt._records_from_data(src)
    assert recs == src and recs is not src


def test_records_from_dataframe_ducktype():
    import pandas_brython as bpd
    recs = alt._records_from_data(bpd.DataFrame({"a": [1, 2], "b": ["x", "y"]}))
    assert recs == [{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]


def test_shorthand_plain_field_infers_type():
    recs = [{"n": 1, "s": "a", "m": None}]
    assert alt._parse_shorthand("n", recs) == {"field": "n", "type": "quantitative"}
    assert alt._parse_shorthand("s", recs) == {"field": "s", "type": "nominal"}
    # bare None-verdier -> nominal (samme fallback som altair for object-kolonner)
    assert alt._parse_shorthand("m", recs)["type"] == "nominal"


def test_shorthand_explicit_typecodes():
    for code, full in [("Q", "quantitative"), ("O", "ordinal"),
                       ("N", "nominal"), ("T", "temporal")]:
        assert alt._parse_shorthand("kol:" + code, []) == {"field": "kol", "type": full}


def test_shorthand_aggregates():
    assert alt._parse_shorthand("mean(v)", [{"v": 1}]) == {
        "aggregate": "mean", "field": "v", "type": "quantitative"}
    assert alt._parse_shorthand("count()", []) == {
        "aggregate": "count", "type": "quantitative"}
    assert alt._parse_shorthand("median(v):O", [])["type"] == "ordinal"


def test_shorthand_unknown_aggregate_raises():
    try:
        alt._parse_shorthand("foo(v)", [])
        assert False, "skulle kastet"
    except ValueError as e:
        assert "foo" in str(e)


def test_infer_bool_is_nominal():
    assert alt._infer_type("b", [{"b": True}]) == "nominal"


def test_channel_class_options():
    ch = alt.X("region:N", sort="-y", title="Region")._channel_dict([])
    assert ch == {"field": "region", "type": "nominal", "sort": "-y", "title": "Region"}


def test_channel_axis_none_disables():
    ch = alt.Y("v:Q", axis=None)._channel_dict([])
    assert ch["axis"] is None


def test_channel_scale_and_bin():
    ch = alt.Y("v:Q", scale=alt.Scale(zero=False))._channel_dict([])
    assert ch["scale"] == {"zero": False}
    b = alt.X("v:Q", bin=alt.Bin(maxbins=10))._channel_dict([])
    assert b["bin"] == {"maxbins": 10}
    b2 = alt.X("v:Q", bin=True)._channel_dict([])
    assert b2["bin"] is True


def test_channel_field_kwarg_infers():
    ch = alt.Color(field="g")._channel_dict([{"g": "a"}])
    assert ch == {"field": "g", "type": "nominal"}


def test_json_safe_nan_and_tuple():
    import pandas_brython as bpd
    assert alt._json_safe({"a": (1, bpd.nan)}) == {"a": [1, None]}
    assert alt._json_safe(float("nan")) is None


def test_value_helper():
    assert alt.value("red") == {"value": "red"}


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE ALTAIR-CORE-TESTER (task 1) GRØNNE')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/hom/Documents/GitHub/openstat && python3 brython/tests/test_altair_core.py`
Expected: `ModuleNotFoundError: No module named 'altair_core'`

- [ ] **Step 3: Implement**

Create `shared/altair_core.py`:

```python
"""altair_core — delt Vega-Lite-spec-bygger (altair-API-subset) for
brython/micropython/CPython (spec 2026-07-23-altair-shim-design.md).
Samme rolle som plotly_express_*, men ÉN delt fil (ui_core-presedensen):
KUN dialektfri kode — ingen browser/js-import, ingen `**` i dict-
LITERALER, ingen str.capitalize()/re/setdefault/partition, datetime
guardet (fellelisten: micropython/plotly_express_mpy.py-filhodet).
Spec-paritet verifiseres mot ekte altair (6.2.2) i
brython/tests/test_altair_core_diff.py."""

import json

try:
    import datetime as _datetime
except ImportError:          # unix-micropython mangler datetime helt
    _datetime = None

VEGALITE_SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json'


class _UndefinedType:
    """Skiller 'ikke oppgitt' fra None — None er MENINGSBÆRENDE i altair
    (axis=None -> "axis": null -> aksen skjules)."""
    def __repr__(self):
        return 'Undefined'


Undefined = _UndefinedType()


def _is_nan(v):
    """True for None, float-nan og pandas-shimenes NaN-sentinel
    (duck-typet på klassenavn — samme grep som plotly-shimet)."""
    if v is None:
        return True
    if type(v).__name__ == 'NaN':
        return True
    return isinstance(v, float) and v != v


def _json_safe(obj):
    """Rekursivt JSON-trygt: nan->None (vega-lite håndterer null),
    tupler->lister, datetime->isoformat, ukjente objekter->str."""
    if _is_nan(obj):
        return None
    if isinstance(obj, dict):
        out = {}
        for k in obj:
            out[str(k)] = _json_safe(obj[k])
        return out
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if _datetime is not None and isinstance(obj, (_datetime.datetime, _datetime.date)):
        return obj.isoformat()
    if isinstance(obj, (bool, int, float, str)):
        return obj
    return str(obj)


def _records_from_data(data):
    """Chart-data -> liste av rad-dicts (vega-lite 'values'-form).
    Godtar DataFrame (duck-typet: .columns + .to_dict() -> {kol: sekvens},
    slik pandas_brython/pandas_mpy sin to_dict() faktisk oppfører seg),
    dict-av-lister og liste-av-dicts."""
    if data is None:
        return []
    if isinstance(data, (list, tuple)):
        return [dict(r) for r in data]
    if hasattr(data, 'columns') and hasattr(data, 'to_dict'):
        data = data.to_dict()
    if isinstance(data, dict):
        if not data:
            return []
        cols = list(data.keys())
        first = data[cols[0]]
        if not isinstance(first, (list, tuple)):
            raise ValueError('Chart(data): dict-input må være {kolonne: liste}')
        out = []
        for i in range(len(first)):
            row = {}
            for c in cols:
                row[c] = data[c][i]
            out.append(row)
        return out
    raise ValueError('Chart(data): forventer DataFrame, dict av lister '
                     'eller liste av dicts, fikk ' + type(data).__name__)


_TYPECODES = {'Q': 'quantitative', 'O': 'ordinal', 'N': 'nominal', 'T': 'temporal'}
_AGGREGATES = ('count', 'sum', 'mean', 'median', 'min', 'max',
               'stdev', 'variance', 'distinct')


def _infer_type(field, records):
    """altair-lik typeinferens for bar 'kol'-shorthand: numerisk -> Q,
    datetime -> T, ellers N (bool er N — bool er subklasse av int, sjekkes
    derfor FØR tallgrenen)."""
    saw_num = False
    for r in records:
        v = r.get(field) if isinstance(r, dict) else None
        if _is_nan(v):
            continue
        if isinstance(v, bool):
            return 'nominal'
        if isinstance(v, (int, float)):
            saw_num = True
            continue
        if _datetime is not None and isinstance(v, (_datetime.datetime, _datetime.date)):
            return 'temporal'
        return 'nominal'
    if saw_num:
        return 'quantitative'
    return 'nominal'


def _parse_shorthand(sh, records):
    """'kol' | 'kol:Q' | 'agg(kol)' | 'agg(kol):T' | 'count()' -> kanal-dict.
    rfind-basert (ikke rpartition — MicroPython-byggavhengig)."""
    s = str(sh)
    typ = None
    i = s.rfind(':')
    if i >= 0 and s[i + 1:] in _TYPECODES:
        typ = _TYPECODES[s[i + 1:]]
        s = s[:i]
    out = {}
    if s.endswith(')'):
        j = s.find('(')
        if j > 0:
            agg = s[:j]
            fld = s[j + 1:-1]
            if agg not in _AGGREGATES:
                raise ValueError('Ukjent aggregat: ' + agg)
            out['aggregate'] = agg
            if fld:
                out['field'] = fld
            out['type'] = typ if typ is not None else 'quantitative'
            return out
    out['field'] = s
    out['type'] = typ if typ is not None else _infer_type(s, records)
    return out


class _Options:
    """Generisk kwargs->dict-holder for Scale/Axis/Legend/Bin/SortField.
    None-verdier beholdes IKKE (None brukes aldri meningsbærende inni
    disse under-objektene i v1)."""
    def __init__(self, **kwargs):
        self._kw = {}
        for k in kwargs:
            if kwargs[k] is not None:
                self._kw[k] = kwargs[k]

    def _to_channel_dict(self):
        return dict(self._kw)


class Scale(_Options):
    pass


class Axis(_Options):
    pass


class Legend(_Options):
    pass


class Bin(_Options):
    pass


class SortField(_Options):
    pass


class Channel:
    """Felles kanalklasse (X/Y/Color/... er navnesubklasser). Kanalnøkkelen
    bestemmes av encode()-kwargen, ikke av klassen — som i altair-praksis."""
    def __init__(self, shorthand=Undefined, type=Undefined, aggregate=Undefined,
                 field=Undefined, bin=Undefined, scale=Undefined, sort=Undefined,
                 title=Undefined, axis=Undefined, legend=Undefined,
                 timeUnit=Undefined, format=Undefined):
        self._shorthand = shorthand
        self._opts = {}
        if type is not Undefined:
            self._opts['type'] = type
        if aggregate is not Undefined:
            self._opts['aggregate'] = aggregate
        if field is not Undefined:
            self._opts['field'] = field
        if bin is not Undefined:
            self._opts['bin'] = bin
        if scale is not Undefined:
            self._opts['scale'] = scale
        if sort is not Undefined:
            self._opts['sort'] = sort
        if title is not Undefined:
            self._opts['title'] = title
        if axis is not Undefined:
            self._opts['axis'] = axis
        if legend is not Undefined:
            self._opts['legend'] = legend
        if timeUnit is not Undefined:
            self._opts['timeUnit'] = timeUnit
        if format is not Undefined:
            self._opts['format'] = format

    def _channel_dict(self, records):
        out = {}
        if self._shorthand is not Undefined and self._shorthand is not None:
            out = _parse_shorthand(self._shorthand, records)
        for k in self._opts:
            v = self._opts[k]
            if hasattr(v, '_to_channel_dict'):
                v = v._to_channel_dict()
            out[k] = v
        # field= som kwarg (uten shorthand): infer type som altair
        if 'field' in out and 'type' not in out and out.get('aggregate') != 'count':
            out['type'] = _infer_type(out['field'], records)
        return out


class X(Channel):
    pass


class Y(Channel):
    pass


class Color(Channel):
    pass


class Size(Channel):
    pass


class Opacity(Channel):
    pass


class Tooltip(Channel):
    pass


class Column(Channel):
    pass


class Row(Channel):
    pass


def value(v):
    """alt.value: literal kanalverdi (encode(color=alt.value('red')))."""
    return {'value': v}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 brython/tests/test_altair_core.py`
Expected: all `PASS` lines + `ALLE ALTAIR-CORE-TESTER (task 1) GRØNNE`

- [ ] **Step 5: Commit**

```bash
git add shared/altair_core.py brython/tests/test_altair_core.py
git commit -m "feat(altair): altair_core del 1 — data, shorthand, kanalklasser"
```

---

### Task 2: `Chart` — marks, encode, properties, interactive, to_dict/to_json, out-of-scope stubs

**Files:**
- Modify: `shared/altair_core.py` (append)
- Modify: `brython/tests/test_altair_core.py` (append tests)

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `class _TopLevel` (shared by Chart/LayerChart: `properties(width, height, title)`, `interactive()`, `to_dict()`, `to_json(indent=None)`, `to_vegalite_json_str()`, `show()`, `__repr__`), `class Chart(_TopLevel)` with `mark_point/line/bar/area/circle/tick/rect/rule/text/boxplot(**kw)`, `encode(**channels)`, `__add__` (raises until Task 3 replaces the body — implement it fully here returning `LayerChart` is NOT possible yet; instead define `__add__` in Task 3), `defaults` module object (`_Defaults` with `height=None`, `width=None`), module-level `NotImplementedError` stubs `hconcat/vconcat/selection_point/selection_interval/condition`.

- [ ] **Step 1: Append failing tests to `brython/tests/test_altair_core.py`** (before the `__main__` block)

```python
def test_chart_minimal_spec():
    spec = alt.Chart({"a": [1, 2]}).mark_point().encode(x="a:Q").to_dict()
    assert spec["$schema"] == alt.VEGALITE_SCHEMA
    assert spec["mark"] == {"type": "point"}
    assert spec["data"] == {"values": [{"a": 1}, {"a": 2}]}
    assert spec["encoding"] == {"x": {"field": "a", "type": "quantitative"}}


def test_all_marks():
    c = alt.Chart({"a": [1]})
    for m in ("point", "line", "bar", "area", "circle", "tick",
              "rect", "rule", "text", "boxplot"):
        spec = getattr(c, "mark_" + m)().to_dict()
        assert spec["mark"] == {"type": m}, m


def test_mark_kwargs():
    spec = alt.Chart({"a": [1]}).mark_line(point=True, strokeDash=[4, 2]).to_dict()
    assert spec["mark"] == {"type": "line", "point": True, "strokeDash": [4, 2]}


def test_encode_channel_objects_and_lists():
    spec = (alt.Chart({"g": ["a"], "v": [1]}).mark_bar()
            .encode(x=alt.X("g:N", sort="-y"),
                    y="mean(v):Q",
                    tooltip=["g:N", alt.Tooltip("v:Q", format=".1f")]).to_dict())
    assert spec["encoding"]["x"] == {"field": "g", "type": "nominal", "sort": "-y"}
    assert spec["encoding"]["y"] == {"aggregate": "mean", "field": "v",
                                     "type": "quantitative"}
    assert spec["encoding"]["tooltip"] == [
        {"field": "g", "type": "nominal"},
        {"field": "v", "type": "quantitative", "format": ".1f"}]


def test_encode_unknown_channel_raises():
    try:
        alt.Chart({"a": [1]}).mark_point().encode(theta="a:Q")
        assert False, "skulle kastet"
    except NotImplementedError as e:
        assert "theta" in str(e)


def test_properties_and_defaults():
    spec = (alt.Chart({"a": [1]}).mark_point()
            .properties(width=400, height=250, title="Tittel").to_dict())
    assert spec["width"] == 400 and spec["height"] == 250 and spec["title"] == "Tittel"
    alt.defaults.height = 300
    try:
        spec2 = alt.Chart({"a": [1]}).mark_point().to_dict()
        assert spec2["height"] == 300 and "width" not in spec2
    finally:
        alt.defaults.height = None


def test_interactive_param():
    spec = alt.Chart({"a": [1]}).mark_point().encode(x="a:Q").interactive().to_dict()
    assert len(spec["params"]) == 1
    p = spec["params"][0]
    assert p["name"].startswith("param_")
    assert p["select"] == {"type": "interval", "encodings": ["x", "y"]}
    assert p["bind"] == "scales"


def test_facet_channels():
    spec = (alt.Chart({"a": [1], "g": ["x"]}).mark_point()
            .encode(x="a:Q", column="g:N", row="g:N").to_dict())
    assert spec["encoding"]["column"] == {"field": "g", "type": "nominal"}
    assert spec["encoding"]["row"] == {"field": "g", "type": "nominal"}


def test_nan_becomes_null_in_values():
    import pandas_brython as bpd
    df = bpd.DataFrame({"x": [1, 2], "y": [1.0, bpd.nan]})
    spec = alt.Chart(df).mark_point().encode(x="x:Q", y="y:Q").to_dict()
    assert spec["data"]["values"][1]["y"] is None
    json.dumps(spec)   # må ikke kaste


def test_runner_protocol_and_repr():
    c = alt.Chart({"a": [1]}).mark_point()
    s = c.to_vegalite_json_str()
    assert json.loads(s)["mark"] == {"type": "point"}
    assert "AltairChart" in repr(c)
    assert c.to_json(indent=2).startswith("{")


def test_out_of_scope_raises():
    c = alt.Chart({"a": [1]}).mark_point()
    for attempt in (lambda: c | c, lambda: c & c, lambda: c.facet("a"),
                    lambda: c.transform_filter("x"),
                    lambda: c.transform_calculate(y="x"),
                    lambda: alt.hconcat(c, c), lambda: alt.vconcat(c, c),
                    lambda: alt.selection_point(), lambda: alt.selection_interval(),
                    lambda: alt.condition(None, None, None)):
        try:
            attempt()
            assert False, "skulle kastet NotImplementedError"
        except NotImplementedError:
            pass
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `python3 brython/tests/test_altair_core.py`
Expected: `AttributeError: module 'altair_core' has no attribute 'Chart'` (first new test)

- [ ] **Step 3: Append implementation to `shared/altair_core.py`**

```python
_CHANNEL_NAMES = ('x', 'y', 'color', 'size', 'opacity', 'tooltip',
                  'column', 'row', 'text')

_param_counter = [0]


class _Defaults:
    """Modulvide størrelsesdefaults (speiler pe.defaults). None = ikke satt
    — da bestemmer spec/vega-lite selv (render-siden i index.html legger på
    en visningsdefault for ikke-fasetterte spec-er)."""
    def __init__(self):
        self.height = None
        self.width = None


defaults = _Defaults()


def _one_channel(val, records):
    if hasattr(val, '_channel_dict'):
        return val._channel_dict(records)
    if isinstance(val, str):
        return _parse_shorthand(val, records)
    if isinstance(val, dict):
        return dict(val)
    raise ValueError('encode(): ugyldig kanalverdi: ' + repr(val))


class _TopLevel:
    """Delte toppnivå-metoder for Chart og LayerChart."""

    def properties(self, width=None, height=None, title=None):
        if width is not None:
            self._props['width'] = width
        if height is not None:
            self._props['height'] = height
        if title is not None:
            self._props['title'] = title
        return self

    def interactive(self):
        # altair bruker hashede param-navn; teller er deterministisk nok
        # (diff-testene normaliserer navnet uansett)
        _param_counter[0] = _param_counter[0] + 1
        self._params.append({'name': 'param_' + str(_param_counter[0]),
                             'select': {'type': 'interval',
                                        'encodings': ['x', 'y']},
                             'bind': 'scales'})
        return self

    def to_dict(self):
        return self._to_dict(True)

    def to_json(self, indent=None):
        # indent-guard: MicroPython-json støtter ikke alltid indent-kwarg
        if indent is None:
            return json.dumps(self.to_dict())
        return json.dumps(self.to_dict(), indent=indent)

    def to_vegalite_json_str(self):
        """Runner-protokollen (_fmt): hele spec-en som JSON-streng."""
        return json.dumps(self.to_dict())

    def show(self):
        return str(self)

    def __str__(self):
        return '<AltairChart: use show() or leave as last expression>'

    def __repr__(self):
        return str(self)

    def _repr_html_(self):
        return str(self)

    def _apply_top(self, spec):
        """Props + params + modul-defaults inn i en toppnivå-spec."""
        for k in self._props:
            spec[k] = self._props[k]
        if 'width' not in spec and defaults.width is not None:
            spec['width'] = defaults.width
        if 'height' not in spec and defaults.height is not None:
            spec['height'] = defaults.height
        if self._params:
            spec['params'] = [dict(p) for p in self._params]
        return spec

    # ---- utenfor v1-omfanget (spec §Out of scope) ----------------------
    def __or__(self, other):
        raise NotImplementedError('hconcat (|) er utenfor v1 — spec '
                                  '2026-07-23-altair-shim-design.md')

    def __and__(self, other):
        raise NotImplementedError('vconcat (&) er utenfor v1')

    def facet(self, *a, **kw):
        raise NotImplementedError('facet() er utenfor v1 — bruk column=/'
                                  'row=-kanalene i encode()')

    def transform_filter(self, *a, **kw):
        raise NotImplementedError('transform_filter er utenfor v1')

    def transform_calculate(self, *a, **kw):
        raise NotImplementedError('transform_calculate er utenfor v1')


class Chart(_TopLevel):
    def __init__(self, data=None):
        self._records = _records_from_data(data)
        self._mark = None
        self._encoding = {}
        self._props = {}
        self._params = []

    def _set_mark(self, mtype, kw):
        m = {'type': mtype}
        for k in kw:
            if kw[k] is not None:
                m[k] = kw[k]
        self._mark = m
        return self

    def mark_point(self, **kw):
        return self._set_mark('point', kw)

    def mark_line(self, **kw):
        return self._set_mark('line', kw)

    def mark_bar(self, **kw):
        return self._set_mark('bar', kw)

    def mark_area(self, **kw):
        return self._set_mark('area', kw)

    def mark_circle(self, **kw):
        return self._set_mark('circle', kw)

    def mark_tick(self, **kw):
        return self._set_mark('tick', kw)

    def mark_rect(self, **kw):
        return self._set_mark('rect', kw)

    def mark_rule(self, **kw):
        return self._set_mark('rule', kw)

    def mark_text(self, **kw):
        return self._set_mark('text', kw)

    def mark_boxplot(self, **kw):
        return self._set_mark('boxplot', kw)

    def encode(self, **channels):
        for name in channels:
            if name not in _CHANNEL_NAMES:
                raise NotImplementedError(
                    'encode(' + name + '=...) er utenfor v1-omfanget '
                    '(kanaler: ' + ', '.join(_CHANNEL_NAMES) + ')')
        for name in channels:
            self._encoding[name] = channels[name]
        return self

    def _to_dict(self, top):
        spec = {}
        if top:
            spec['$schema'] = VEGALITE_SCHEMA
        spec['data'] = {'values': _json_safe(self._records)}
        if self._mark is not None:
            spec['mark'] = dict(self._mark)
        if self._encoding:
            enc = {}
            for name in self._encoding:
                val = self._encoding[name]
                if isinstance(val, (list, tuple)):
                    enc[name] = [_one_channel(v, self._records) for v in val]
                else:
                    enc[name] = _one_channel(val, self._records)
            spec['encoding'] = enc
        if top:
            return self._apply_top(spec)
        # lag-kontekst (LayerChart): props/params på under-charten følger
        # med, men modul-defaults gjør det IKKE (gjelder kun toppnivå)
        for k in self._props:
            spec[k] = self._props[k]
        if self._params:
            spec['params'] = [dict(p) for p in self._params]
        return spec


def hconcat(*charts):
    raise NotImplementedError('hconcat er utenfor v1')


def vconcat(*charts):
    raise NotImplementedError('vconcat er utenfor v1')


def selection_point(*a, **kw):
    raise NotImplementedError('selection_point er utenfor v1 — '
                              '.interactive() dekker zoom/pan')


def selection_interval(*a, **kw):
    raise NotImplementedError('selection_interval er utenfor v1')


def condition(*a, **kw):
    raise NotImplementedError('alt.condition er utenfor v1')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 brython/tests/test_altair_core.py`
Expected: all `PASS` (Task 1 + Task 2 tests)

- [ ] **Step 5: Commit**

```bash
git add shared/altair_core.py brython/tests/test_altair_core.py
git commit -m "feat(altair): altair_core del 2 — Chart, marks, encode, interactive"
```

---

### Task 3: `LayerChart` (`chart1 + chart2`)

**Files:**
- Modify: `shared/altair_core.py` (append + add `Chart.__add__`)
- Modify: `brython/tests/test_altair_core.py` (append tests)

**Interfaces:**
- Consumes: `_TopLevel`, `Chart._to_dict(top)`, `_json_safe`.
- Produces: `class LayerChart(_TopLevel)` with `_charts` list; `Chart.__add__/LayerChart.__add__` returning flattened `LayerChart`.

- [ ] **Step 1: Append failing tests**

```python
def test_layer_shared_data_hoisted():
    df = {"x": [1, 2], "y": [3, 4]}
    # NB: mark_* muterer og returnerer self (dokumentert v1-avvik fra
    # altairs immutabilitet) — bruk derfor to SEPARATE Chart-objekter:
    a = alt.Chart(df).mark_line().encode(x="x:Q", y="y:Q")
    b = alt.Chart(df).mark_point().encode(x="x:Q", y="y:Q")
    spec = (a + b).to_dict()
    assert spec["data"] == {"values": [{"x": 1, "y": 3}, {"x": 2, "y": 4}]}
    assert [sorted(l.keys()) for l in spec["layer"]] == [
        ["encoding", "mark"], ["encoding", "mark"]]
    assert spec["layer"][0]["mark"] == {"type": "line"}
    assert spec["layer"][1]["mark"] == {"type": "point"}


def test_layer_flattens_and_props():
    a = alt.Chart({"x": [1]}).mark_line().encode(x="x:Q")
    b = alt.Chart({"x": [1]}).mark_point().encode(x="x:Q")
    c = alt.Chart({"x": [1]}).mark_rule().encode(x="x:Q")
    spec = ((a + b) + c).properties(title="Lagdelt").to_dict()
    assert len(spec["layer"]) == 3
    assert spec["title"] == "Lagdelt"
    assert spec["$schema"] == alt.VEGALITE_SCHEMA


def test_layer_differing_data_stays_per_layer():
    a = alt.Chart({"x": [1]}).mark_line().encode(x="x:Q")
    b = alt.Chart({"x": [9]}).mark_point().encode(x="x:Q")
    spec = (a + b).to_dict()
    assert "data" not in spec
    assert spec["layer"][0]["data"] == {"values": [{"x": 1}]}
    assert spec["layer"][1]["data"] == {"values": [{"x": 9}]}


def test_layer_interactive_on_top():
    a = alt.Chart({"x": [1]}).mark_line().encode(x="x:Q")
    b = alt.Chart({"x": [1]}).mark_point().encode(x="x:Q")
    spec = (a + b).interactive().to_dict()
    assert spec["params"][0]["bind"] == "scales"
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 brython/tests/test_altair_core.py`
Expected: `TypeError: unsupported operand type(s) for +` (or NotImplementedError-free failure on first layer test)

- [ ] **Step 3: Implement** — append to `shared/altair_core.py`, and add `__add__` to BOTH `Chart` and `LayerChart`:

```python
class LayerChart(_TopLevel):
    """chart1 + chart2 -> {"layer": [...]} (flatet: (a+b)+c gir tre lag).
    Delte data (samme records-innhold) heises til toppnivå — som altair."""
    def __init__(self, charts):
        self._charts = []
        for c in charts:
            if isinstance(c, LayerChart):
                for cc in c._charts:
                    self._charts.append(cc)
            else:
                self._charts.append(c)
        self._props = {}
        self._params = []

    def __add__(self, other):
        return LayerChart([self, other])

    def _to_dict(self, top):
        spec = {}
        if top:
            spec['$schema'] = VEGALITE_SCHEMA
        shared = len(self._charts) > 0
        base = self._charts[0]._records if shared else None
        for c in self._charts:
            if not (c._records is base or c._records == base):
                shared = False
                break
        if shared:
            spec['data'] = {'values': _json_safe(base)}
        layers = []
        for c in self._charts:
            sub = c._to_dict(False)
            if shared and 'data' in sub:
                del sub['data']
            layers.append(sub)
        spec['layer'] = layers
        if top:
            return self._apply_top(spec)
        for k in self._props:
            spec[k] = self._props[k]
        if self._params:
            spec['params'] = [dict(p) for p in self._params]
        return spec
```

And inside `class Chart`, add the method:

```python
    def __add__(self, other):
        return LayerChart([self, other])
```

(`Chart.__add__` references `LayerChart`, defined later in the file — fine at call time.)

- [ ] **Step 4: Run tests**

Run: `python3 brython/tests/test_altair_core.py`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add shared/altair_core.py brython/tests/test_altair_core.py
git commit -m "feat(altair): altair_core del 3 — LayerChart (+)"
```

---

### Task 4: Differential tests against real altair

**Files:**
- Create: `brython/tests/test_altair_core_diff.py`

**Interfaces:**
- Consumes: full `altair_core` API; real `altair` 6.2.2 + real `pandas` (installed via `python3 -m pip install --user altair pandas`; guard with `HAS_ALTAIR`).

- [ ] **Step 1: Write the diff tests**

Create `brython/tests/test_altair_core_diff.py`:

```python
# Differensialtester for altair_core: fasit er EKTE altair (6.2.2) sin
# to_dict(). Hele spec-er sammenlignes etter normalisering (drop
# $schema/config/usermeta, resolér named-dataset-indireksjon, normaliser
# param-navn). Kjøres under CPython:
#   python3 brython/tests/test_altair_core_diff.py
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import altair_core as malt
import pandas_brython as bpd

try:
    import altair as ralt
    import pandas as rpd
    HAS_ALTAIR = True
except ImportError:
    HAS_ALTAIR = False

D = {"aar": [2020, 2021, 2022, 2020, 2021, 2022],
     "antall": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
     "region": ["A", "A", "A", "B", "B", "B"]}


def norm(spec):
    spec = json.loads(json.dumps(spec, default=str))
    spec.pop('$schema', None)
    spec.pop('config', None)
    spec.pop('usermeta', None)
    ds = spec.pop('datasets', None)

    def walk(node):
        if isinstance(node, dict):
            d = node.get('data')
            if isinstance(d, dict) and 'name' in d and ds and d['name'] in ds:
                node['data'] = {'values': ds[d['name']]}
            for p in node.get('params') or []:
                if isinstance(p, dict) and 'name' in p:
                    p['name'] = 'param'
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(spec)
    return spec


def pair(build_mine, build_real):
    mine = norm(build_mine(malt, bpd.DataFrame(D)).to_dict())
    real = norm(build_real(ralt, rpd.DataFrame(D)).to_dict())
    assert mine == real, '\nMIN:  %s\nEKTE: %s' % (
        json.dumps(mine, sort_keys=True), json.dumps(real, sort_keys=True))


def test_marks_match():
    if not HAS_ALTAIR:
        return
    for m in ("point", "line", "bar", "area", "circle", "tick",
              "rect", "rule", "boxplot"):
        pair(lambda a, df, m=m: getattr(a.Chart(df), "mark_" + m)()
             .encode(x="aar:O", y="antall:Q"),
             lambda a, df, m=m: getattr(a.Chart(df), "mark_" + m)()
             .encode(x="aar:O", y="antall:Q"))


def test_shorthand_and_channel_equivalence():
    if not HAS_ALTAIR:
        return
    pair(lambda a, df: a.Chart(df).mark_point().encode(
            x="aar", y="mean(antall)", color="region"),
         lambda a, df: a.Chart(df).mark_point().encode(
            x="aar", y="mean(antall)", color="region"))
    pair(lambda a, df: a.Chart(df).mark_bar().encode(
            x=a.X("region:N", sort="-y", title="Region"),
            y=a.Y("antall:Q", scale=a.Scale(zero=False), axis=None)),
         lambda a, df: a.Chart(df).mark_bar().encode(
            x=a.X("region:N", sort="-y", title="Region"),
            y=a.Y("antall:Q", scale=a.Scale(zero=False), axis=None)))


def test_bin_count_tooltip():
    if not HAS_ALTAIR:
        return
    pair(lambda a, df: a.Chart(df).mark_bar().encode(
            x=a.X("antall:Q", bin=True), y="count()"),
         lambda a, df: a.Chart(df).mark_bar().encode(
            x=a.X("antall:Q", bin=True), y="count()"))
    pair(lambda a, df: a.Chart(df).mark_point().encode(
            x="aar:Q", y="antall:Q",
            tooltip=[a.Tooltip("antall:Q", format=".1f"), "region:N"]),
         lambda a, df: a.Chart(df).mark_point().encode(
            x="aar:Q", y="antall:Q",
            tooltip=[a.Tooltip("antall:Q", format=".1f"), "region:N"]))


def test_properties_and_interactive():
    if not HAS_ALTAIR:
        return
    pair(lambda a, df: a.Chart(df).mark_point().encode(x="aar:Q")
         .properties(width=400, height=250, title="Tittel"),
         lambda a, df: a.Chart(df).mark_point().encode(x="aar:Q")
         .properties(width=400, height=250, title="Tittel"))
    pair(lambda a, df: a.Chart(df).mark_point()
         .encode(x="aar:Q", y="antall:Q").interactive(),
         lambda a, df: a.Chart(df).mark_point()
         .encode(x="aar:Q", y="antall:Q").interactive())


def test_layer_matches():
    if not HAS_ALTAIR:
        return
    def build(a, df):
        return (a.Chart(df).mark_line().encode(x="aar:O", y="antall:Q")
                + a.Chart(df).mark_point().encode(x="aar:O", y="antall:Q"))
    pair(build, build)


def test_column_facet_matches():
    if not HAS_ALTAIR:
        return
    pair(lambda a, df: a.Chart(df).mark_point().encode(
            x="aar:O", y="antall:Q", column="region:N"),
         lambda a, df: a.Chart(df).mark_point().encode(
            x="aar:O", y="antall:Q", column="region:N"))


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE ALTAIR-DIFF-TESTER GRØNNE' + ('' if HAS_ALTAIR else ' (uten altair-fasit)'))
```

- [ ] **Step 2: Run**

Run: `python3 brython/tests/test_altair_core_diff.py`
Expected: all PASS with the real-altair oracle active (altair 6.2.2 is installed). If a comparison fails, the assert prints both normalized specs — fix `altair_core` (NOT the normalization) unless the difference is one of the documented normalization concerns ($schema/config/param names/dataset indirection). Likely first-run issues: int vs float in records from pandas (real pandas serializes `2020` as int — pandas_brython must too), key presence differences in channel dicts.

- [ ] **Step 3: Also re-run unit tests**

Run: `python3 brython/tests/test_altair_core.py`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add brython/tests/test_altair_core_diff.py shared/altair_core.py
git commit -m "test(altair): differensialtester mot ekte altair 6.2.2"
```

---

### Task 5: Runtime wiring — wrappers, engine registries, runner `_fmt`, micropython smoke

**Files:**
- Create: `brython/altair_brython.py`
- Create: `micropython/altair_mpy.py`
- Create: `micropython/tests/mpy_smoke_altair.py`
- Modify: `js/brython-engine.js` (LIB_REGISTRY, after the `ui_core` entry ~line 79)
- Modify: `js/micropython-engine.js` (LIB_REGISTRY, after its `ui_core` entry ~line 38)
- Modify: `brython/brython_runner.py:34` (`_fmt`)
- Modify: `micropython/micropython_runner.py:51` (`_fmt`)
- Test: `brython/tests/test_altair_runner_fmt.py` (create)

**Interfaces:**
- Consumes: `to_vegalite_json_str()` from Task 2.
- Produces: importable module name `altair` in both shim modes; embed type string `vegalite` (marker payload = full spec JSON) consumed by Task 6.

- [ ] **Step 1: Write failing runner test**

Create `brython/tests/test_altair_runner_fmt.py`:

```python
# _fmt-protokollen: et altair-chart skal bli en vegalite__-embed.
#   python3 brython/tests/test_altair_runner_fmt.py
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import altair_core as alt
import brython_runner


def test_fmt_emits_vegalite_embed():
    chart = alt.Chart({"a": [1]}).mark_point().encode(x="a:Q")
    out = brython_runner._fmt(chart)
    assert out.startswith('__micro_transform_start_vegalite__')
    assert '"mark": {"type": "point"}' in out or '"mark":{"type":"point"}' in out
    assert out.rstrip().endswith('__micro_transform_end__')


def test_fmt_plotly_still_works():
    class Fake:
        def to_plotly_json_str(self):
            return '{}'
    assert 'figure__' in brython_runner._fmt(Fake())


if __name__ == '__main__':
    test_fmt_emits_vegalite_embed(); print('PASS test_fmt_emits_vegalite_embed')
    test_fmt_plotly_still_works(); print('PASS test_fmt_plotly_still_works')
```

Run: `python3 brython/tests/test_altair_runner_fmt.py`
Expected: FAIL (assertion — `_fmt` has no vegalite branch yet)

- [ ] **Step 2: Add the `_fmt` branch in BOTH runners**

In `brython/brython_runner.py`, directly BEFORE the `to_plotly_json_str` branch (line ~34):

```python
    if hasattr(obj, 'to_vegalite_json_str'):
        # altair-shimet (spec 2026-07-23): vega-embed-rendring i JS
        return _EMBED_S + 'vegalite__' + '\n' + obj.to_vegalite_json_str() + '\n' + _EMBED_E
```

In `micropython/micropython_runner.py`, same insertion directly before its `to_plotly_json_str` branch (line ~51).

Run: `python3 brython/tests/test_altair_runner_fmt.py`
Expected: PASS both

- [ ] **Step 3: Create the wrapper modules**

`brython/altair_brython.py`:

```python
# Tynn fasade over shared/altair_core.py (ui_core-presedensen): HELE
# API-et ligger i den dialektfrie kjernen. Registrert i js/brython-engine
# med alias 'altair'; deps sørger for at altair_core ligger i sys.modules
# før denne linjen kjører.
from altair_core import *          # noqa: F401,F403
```

`micropython/altair_mpy.py`:

```python
# Tynn fasade over shared/altair_core.py — se brython/altair_brython.py.
from altair_core import *          # noqa: F401,F403
```

Verify import * exposes the API (CPython):

Run: `python3 -c "import sys; sys.path[:0]=['shared','brython']; import altair_brython as a; a.Chart({'x':[1]}).mark_point().encode(x='x:Q').to_dict(); print('WRAPPER OK')"` (from repo root)
Expected: `WRAPPER OK`

- [ ] **Step 4: Registry entries — verify JS dep loading is SEQUENTIAL first**

Read `js/brython-engine.js` `ensureLibs`/`loadJsDep` (~lines 114–160): confirm the `js:` array for an entry is loaded in order (awaited one by one), since vega → vega-lite → vega-embed is a hard order. If loading is parallel (`Promise.all`), change it to sequential for-await — safe for all existing entries (they have 0 or 1 js deps).

Then verify the CDN pins exist (HTTP 200):

```bash
for u in "https://cdn.jsdelivr.net/npm/vega@5.30.0/build/vega.min.js" \
         "https://cdn.jsdelivr.net/npm/vega-lite@5.21.0/build/vega-lite.min.js" \
         "https://cdn.jsdelivr.net/npm/vega-embed@6.26.0/build/vega-embed.min.js"; do
  curl -s -o /dev/null -w "%{http_code} $u\n" "$u"; done
```

Expected: three `200` lines. If any 404s, list available versions with `curl -s https://data.jsdelivr.com/v1/package/npm/<pkg>` and pin the nearest stable 5.x/5.x/6.x.

Add to `js/brython-engine.js` LIB_REGISTRY (after the `ui_core` entry):

```js
    // altair (spec 2026-07-23): delt dialektfri kjerne i shared/ — samme
    // path-overstyring som ui_core. Vega-stakken lastes lazy ved
    // `import altair`; rekkefølgen er bindende (vega -> vega-lite ->
    // vega-embed), lasteren går sekvensielt gjennom js-listen.
    altair_brython:         { aliases: ['altair'], deps: ['altair_core'],
                              js: [
      { url: 'https://cdn.jsdelivr.net/npm/vega@5.30.0/build/vega.min.js', global: 'vega' },
      { url: 'https://cdn.jsdelivr.net/npm/vega-lite@5.21.0/build/vega-lite.min.js', global: 'vegaLite' },
      { url: 'https://cdn.jsdelivr.net/npm/vega-embed@6.26.0/build/vega-embed.min.js', global: 'vegaEmbed' }
                              ] },
    altair_core:            { aliases: [], deps: [], js: [],
                              path: 'shared/altair_core.py' },
```

Add to `js/micropython-engine.js` LIB_REGISTRY the same two entries with the mpy name:

```js
    altair_mpy:         { aliases: ['altair'], deps: ['altair_core'],
                          js: [
      { url: 'https://cdn.jsdelivr.net/npm/vega@5.30.0/build/vega.min.js', global: 'vega' },
      { url: 'https://cdn.jsdelivr.net/npm/vega-lite@5.21.0/build/vega-lite.min.js', global: 'vegaLite' },
      { url: 'https://cdn.jsdelivr.net/npm/vega-embed@6.26.0/build/vega-embed.min.js', global: 'vegaEmbed' }
                          ] },
    altair_core:        { aliases: [], deps: [], js: [],
                          path: 'shared/altair_core.py' },
```

(If `altair_core` already exists in a registry from a merge, keep one entry. Note: BOTH registries fetch `shared/altair_core.py` via their `path` override — check how the micropython registry's ui_core entry is keyed and mirror it exactly, including any comment conventions.)

- [ ] **Step 5: MicroPython smoke test**

First read `micropython/tests/mpy_smoke_plotly.py` to mirror its path-setup convention exactly. Then create `micropython/tests/mpy_smoke_altair.py`:

```python
# Røyktest under unix-micropython:
#   micropython micropython/tests/mpy_smoke_altair.py   (fra repo-roten)
import sys
sys.path.insert(0, 'shared')
sys.path.insert(0, 'micropython')
import json
import altair_mpy as alt

chart = (alt.Chart({"x": [1, 2, 3], "g": ["a", "b", "a"]})
         .mark_bar()
         .encode(x="g:N", y="mean(x):Q", tooltip=["g:N", "x:Q"])
         .properties(width=300, title="Røyk")
         .interactive())
spec = json.loads(chart.to_vegalite_json_str())
assert spec["mark"] == {"type": "bar"}, spec
assert spec["encoding"]["y"]["aggregate"] == "mean"
assert spec["title"] == "Røyk"
layered = (alt.Chart({"x": [1]}).mark_line().encode(x="x:Q")
           + alt.Chart({"x": [1]}).mark_point().encode(x="x:Q"))
assert "layer" in layered.to_dict()
print("MPY-ALTAIR-RØYK OK")
```

Run: `cd /Users/hom/Documents/GitHub/openstat && micropython micropython/tests/mpy_smoke_altair.py`
Expected: `MPY-ALTAIR-RØYK OK`. Any SyntaxError/AttributeError here is a dialect trap in `altair_core.py` — fix the CORE (keeping CPython tests green), don't fork the file.

- [ ] **Step 6: Run all python tests, commit**

```bash
python3 brython/tests/test_altair_core.py && \
python3 brython/tests/test_altair_core_diff.py && \
python3 brython/tests/test_altair_runner_fmt.py && \
micropython micropython/tests/mpy_smoke_altair.py
git add brython/altair_brython.py micropython/altair_mpy.py \
    micropython/tests/mpy_smoke_altair.py brython/tests/test_altair_runner_fmt.py \
    js/brython-engine.js js/micropython-engine.js \
    brython/brython_runner.py micropython/micropython_runner.py
git commit -m "feat(altair): runtime-kobling — fasader, registry, vegalite-embed i _fmt"
```

---

### Task 6: Render path in index.html (+ pyodide real-altair)

**Files:**
- Modify: `index.html` — four places:
  1. `mdRenderVegaFigure` helper next to `mdRenderPlotlyFigure` (~line 6225)
  2. new `vegalite` case in `buildOutputNodes()` (insert before the `p.embedType === 'figure'` branch, ~line 6375)
  3. pyodide python-mode display hook: new branch next to the real-plotly branch (~line 7448 — Read the surrounding function first and mirror its structure exactly)
  4. `PYTHON_DS_IMPORTS` list (~line 2501): add `'altair'`

**Interfaces:**
- Consumes: `vegalite` embed payload (full Vega-Lite spec JSON) from Task 5; `window.vegaEmbed` loaded lazily by the registries.
- Produces: rendered charts in all three python modes.

- [ ] **Step 1: Add `mdRenderVegaFigure`** (immediately after `mdRenderPlotlyFigure`'s closing brace):

```js
    function mdRenderVegaFigure(div, spec) {
      if (typeof vegaEmbed === 'undefined') return;
      div.className = 'vegalite-container';
      var styles = getComputedStyle(document.body);
      var textColor = (styles.getPropertyValue('--text') || '#1a1b26').trim();
      var borderColor = (styles.getPropertyValue('--border') || '#e4e2dd').trim();
      var fontStack = 'DejaVu Sans, Arial, sans-serif';
      // Tema-config ved RENDER-tid (ikke bakt inn i spec-en) — samme
      // policy som mdRenderPlotlyFigure: transparent bakgrunn + app-farger
      // i begge temaer.
      var themeConfig = {
        background: null,
        view: { stroke: borderColor },
        axis: { labelColor: textColor, titleColor: textColor,
                gridColor: borderColor, domainColor: borderColor,
                tickColor: borderColor, labelFont: fontStack, titleFont: fontStack },
        legend: { labelColor: textColor, titleColor: textColor,
                  labelFont: fontStack, titleFont: fontStack },
        title: { color: textColor, font: fontStack },
        text: { color: textColor }
      };
      // Visningsdefaults à la plotly-stien (480x300-følelse) — kun når
      // spec-en ikke selv setter størrelse, og aldri for fasetterte spec-er
      // (column/row styrer egen panelstørrelse i vega-lite).
      var enc = spec.encoding || {};
      var faceted = !!(enc.column || enc.row || spec.facet);
      if (!faceted && spec.width === undefined) spec.width = 440;
      if (!faceted && spec.height === undefined) spec.height = 260;
      vegaEmbed(div, spec, { actions: false, config: themeConfig })
        .catch(function () {});
    }
```

- [ ] **Step 2: Add the `vegalite` embed case in `buildOutputNodes()`** — insert this `else if` between the end of the `tablehtml` block and the `p.embedType === 'figure'` branch:

```js
            } else if (p.embedType === 'vegalite' && p.payload && typeof vegaEmbed !== 'undefined') {
              try {
                const vlSpec = JSON.parse(p.payload);
                const vlDiv = document.createElement('div');
                frag.appendChild(vlDiv);
                mdRenderVegaFigure(vlDiv, vlSpec);
              } catch (e) {
                const pre = document.createElement('pre');
                pre.className = 'embed-placeholder';
                pre.textContent = '[Vega-Lite figure – could not parse JSON]';
                frag.appendChild(pre);
              }
```

- [ ] **Step 3: Pyodide real-altair branch.** Read the display-hook python block around line 7430–7460 (the one containing `pio.to_json(obj)`). Insert BEFORE the plotly branch, at the same indent level, mirroring its structure:

```python
        _omod = getattr(type(obj), "__module__", "") or ""
        if _omod.split(".")[0] == "altair" and hasattr(obj, "to_json"):
            # ekte altair i pyodide-modus -> samme vegalite__-embed som
            # brython/micropython-shimene (spec 2026-07-23)
            print(_EMBED_S + "vegalite__" + chr(10) + obj.to_json() + chr(10) + _EMBED_E)
            <samme "ferdig håndtert"-mekanisme som plotly-grenen — return/flagg, kopier grenen over>
```

Adapt the last line to whatever the surrounding hook actually does after printing (early return, `continue`, or flag) — copy the plotly branch's control flow exactly.

- [ ] **Step 4: Add `'altair'` to `PYTHON_DS_IMPORTS`** (~line 2501), after the `'seaborn'` entry:

```js
      'pandas','numpy','matplotlib','matplotlib.pyplot','seaborn','altair',
```

- [ ] **Step 5: Syntax check + commit**

Run: `node --check js/brython-engine.js && node --check js/micropython-engine.js` (index.html's inline JS can't be node-checked — rely on the browser task). Re-run all Task 5 python tests.

```bash
git add index.html
git commit -m "feat(altair): vegalite-embed-rendring + pyodide ekte-altair-gren"
```

---

### Task 7: Examples + manifest

**Files:**
- Create: `examples/brython/bry27_altair.txt`
- Create: `examples/micropython/07_altair.txt`
- Create: one file in `examples/python/` (check the dir's naming convention first with `ls examples/python/` and use the next free number)
- Modify (generated): `examples/manifest.json`

- [ ] **Step 1: Create `examples/brython/bry27_altair.txt`**

```
# label: altair — deklarative diagram
# Altair (Vega-Lite) i brython-modus: bygg spec-en deklarativt,
# vega-embed rendrer.
import altair as alt
import pandas_brython as pd

df = pd.DataFrame({
    "aar": [2020, 2021, 2022, 2020, 2021, 2022],
    "antall": [12, 15, 19, 8, 11, 9],
    "region": ["Øst", "Øst", "Øst", "Vest", "Vest", "Vest"],
})

# Lagdelt linje + punkt, med gjennomsnitt per år og region
linjer = alt.Chart(df).mark_line().encode(
    x="aar:O",
    y="mean(antall):Q",
    color="region:N",
)
punkter = alt.Chart(df).mark_point().encode(
    x="aar:O",
    y="mean(antall):Q",
    color="region:N",
    tooltip=["aar:O", "antall:Q", "region:N"],
)
(linjer + punkter).properties(title="Antall per region").interactive()
```

- [ ] **Step 2: Create `examples/micropython/07_altair.txt`** — same content, but `import pandas_mpy as pd` and header `# Altair (Vega-Lite) i MicroPython-modus`.

- [ ] **Step 3: Python-mode example** — `ls examples/python/`, create the next-numbered file with the same chart built on REAL imports (`import altair as alt`, `import pandas as pd`), label `# label: altair — deklarative diagram`.

- [ ] **Step 4: Regenerate manifest, commit**

```bash
python3 examples/generate_manifest.py
git add examples/
git commit -m "docs(altair): eksempler for brython/micropython/python + manifest"
```

---

### Task 8: Browser verification (all three modes)

**Files:** none (verification only; fix regressions found)

- [ ] **Step 1: Serve the app**

```bash
cd /Users/hom/Documents/GitHub/openstat && python3 -m http.server 8123
```

(background; or the repo's usual serve flow if one exists — check README.md first)

- [ ] **Step 2: Brython mode** — with claude-in-chrome: open `http://localhost:8123/index.html`, switch to brython mode, load/paste the `bry27_altair.txt` example, run it. Verify: chart renders (layered line+point, two colors, tooltip on hover), no console errors, and that the vega scripts were NOT loaded before the `import altair` cell ran (lazy check: `typeof vegaEmbed` in console before/after). Screenshot.

- [ ] **Step 3: MicroPython mode** — same with `07_altair.txt`. Screenshot.

- [ ] **Step 4: Pyodide python mode** — run the python example (real altair via micropip; first run may download packages). Verify same chart renders through the `vegalite__` embed. If micropip cannot install altair (dependency issue), document it and verify the branch is a no-op that doesn't break other output (charts fall back to repr text).

- [ ] **Step 5: Theme check** — toggle light/dark; re-run one cell; verify axis/label colors follow the theme and background stays transparent.

- [ ] **Step 6: Full test suite re-run + final commit of any fixes**

```bash
python3 brython/tests/test_altair_core.py && \
python3 brython/tests/test_altair_core_diff.py && \
python3 brython/tests/test_altair_runner_fmt.py && \
micropython micropython/tests/mpy_smoke_altair.py && \
python3 brython/tests/test_plotly_express_brython.py
git add -A && git commit -m "fix(altair): browser-verifisering — justeringer" || true
```

(also re-run the existing plotly tests to prove `_fmt` ordering broke nothing)

---

## Self-review notes

- Spec coverage: files/registry (T5), API surface (T1–T3), rendering+theme+pyodide (T6), tests incl. diff oracle (T1–T5), examples+lists (T6 step 4, T7), browser verification (T8). Mutating-not-immutable divergence is asserted implicitly in `test_layer_shared_data_hoisted`'s comment.
- The `interactive()` param-name determinism, `mark` dict form, dataset-indirection normalization all verified against a live altair 6.2.2 probe on 2026-07-24.
- Type consistency: `to_vegalite_json_str` (runner protocol), `_channel_dict(records)`, `_to_channel_dict()`, `_to_dict(top)` used consistently across tasks.
