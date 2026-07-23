# Altair shim (`altair_core`) — pure-python Vega-Lite for all three python modes (design)

**Status:** APPROVED 2026-07-23 (scope settled with Hans: shared
dialect-neutral core, "core + layer/facet" API surface). First of four
planned shims in this workstream; folium (leaflet), interactive tables
(Tabulator), and a lifelines subset follow as separate spec/plan cycles.

## Motivation

Openstat has pure-python shims (numpy/pandas/matplotlib/plotly express/
seaborn/scipy.stats/sklearn/statsmodels/duckdb) so the brython and
micropython modes feel like real python. Altair is the ideal next shim:
the real library does nothing but build a Vega-Lite JSON dict — all
rendering happens in JS (vega-embed). So the shim is an API-mimicking
dict builder, checked verbatim against real altair's `to_dict()` in
differential tests, and the same file serves brython, micropython AND
CPython (pytest). Pyodide python mode gets the *real* altair rendered
through the same new embed path.

## Architecture

Same pipeline as plotly express, with one new embed type:

    user code → chart object (spec dict) → to_vegalite_json_str()
    → runner _fmt: __micro_transform_start_vegalite__ embed marker
    → buildOutputNodes() in index.html: vegaEmbed(div, spec, themeConfig)

### Files

- **`shared/altair_core.py`** — the entire shim. Dialect-neutral python
  honoring the MicroPython traps documented in
  `micropython/plotly_express_mpy.py`'s header: no `**` inside dict
  LITERALS (fine in calls), no `str.capitalize()`, no `re`, `datetime`
  import guarded with try/except, no walrus, no dataclasses. No
  `browser` import anywhere (pure dict-building) — so the file also
  imports cleanly under CPython for tests.
- **`brython/altair_brython.py`** / **`micropython/altair_mpy.py`** —
  thin wrappers: `from altair_core import *` (+ `__all__` passthrough).
  Same pattern as `ui_brython.py` → `shared/ui_core.py`.
- **`js/brython-engine.js`** and **`js/micropython-engine.js`** — two
  `LIB_REGISTRY` entries each, mirroring the `ui_core` precedent:
  - `altair_core: { aliases: [], deps: [], js: [], path: 'shared/altair_core.py' }`
  - `altair_brython` / `altair_mpy`:
    `{ aliases: ['altair'], deps: ['altair_core'], js: [vega, vega-lite, vega-embed] }`
    JS deps from jsdelivr (vega@5, vega-lite@5, vega-embed@6, pinned
    exact versions at implementation time), `global: 'vegaEmbed'` on the
    last so already-loaded pages skip the fetch. Loaded lazily only when
    a cell imports altair.
- **`brython/brython_runner.py`** and
  **`micropython/micropython_runner.py`** — one new branch in `_fmt`,
  BEFORE the `to_plotly_json_str` branch:
  `hasattr(obj, 'to_vegalite_json_str')` → `vegalite__` embed.
- **`index.html`** —
  1. `buildOutputNodes()`: new `vegalite` embedType case → div +
     `vegaEmbed(div, spec, {actions: false, config: themeConfig})`,
     guarded on `typeof vegaEmbed !== 'undefined'` with the same
     JSON-parse-failure placeholder as the `figure` case.
  2. A `mdRenderVegaFigure(div, spec)`-style helper mirroring
     `mdRenderPlotlyFigure`: theme config from CSS variables at render
     time (transparent `background`, `--text` for label/title color,
     `--border` for grid/domain/tick color, DejaVu Sans font, default
     width/height comparable to plotly's 480×300 unless the spec sets
     its own). Charts thereby follow light/dark theme with no theme
     data baked into the spec.
  3. Pyodide python-mode display hook: next to the existing real-plotly
     branch (`pio.to_json`, ~line 7451), detect a real altair chart —
     `type(obj).__module__.startswith('altair')` and
     `hasattr(obj, 'to_json')` — and print the same `vegalite__` embed
     with `obj.to_json()`. `import altair as alt` then behaves
     identically in all three python modes. (altair + its deps install
     in pyodide via micropip on demand — same lazy mechanism the mode
     already uses for other real packages.)
  4. The available-library mention lists (~lines 2497/2502) get an
     `altair` entry.

## API surface (v1)

Namespace convention: `import altair as alt`.

- **`alt.Chart(data)`** — data may be a pandas_brython/pandas_mpy
  DataFrame (duck-typed: `to_dict('records')` or column access), a
  dict-of-lists, or a list-of-records. Normalized to inline
  `{"values": [record, ...]}`. NaN/None → `null` (vega-lite handles
  nulls natively; reuse the nan-sentinel duck-typing from the plotly
  shim's `_is_nan`).
- **Marks:** `mark_point, mark_line, mark_bar, mark_area, mark_circle,
  mark_tick, mark_rect, mark_rule, mark_text, mark_boxplot` — kwargs
  become mark-def properties (`mark_line(point=True, strokeDash=[4,2])`
  → `{"type": "line", "point": true, ...}`); no kwargs → plain string
  mark, exactly like real altair.
- **`encode(**channels)`** — values are shorthand strings or channel
  objects. Shorthand grammar (subset of altair's):
  `'kol'`, `'kol:Q|O|N|T'`, `'agg(kol)'`, `'agg(kol):Q'`, `'count()'`.
  Aggregates: count, sum, mean, median, min, max, stdev, variance,
  distinct. Bare `'kol'` type inference mirrors altair: all-numeric
  column → Q, date-like → T, else N.
- **Channel classes:** `X, Y, Color, Size, Tooltip, Opacity, Column,
  Row` — first positional arg is shorthand; keyword options `bin`
  (True or `Bin(maxbins=...)`), `scale=Scale(domain=, range=, type=,
  scheme=, zero=)`, `sort`, `title`, `axis=Axis(...)`/`legend=
  Legend(...)`/`None` to disable, `aggregate`, `timeUnit`, `format`.
  Channel → `{"field": ..., "type": ..., <options>}`. `Tooltip` accepts
  a list in `encode(tooltip=[...])`.
- **Helper classes:** `Scale, Axis, Legend, Bin, SortField` — plain
  kwargs→dict holders (None-stripped via a shared `remove_none`-style
  cleaner, same policy as the plotly shim).
- **`properties(width=, height=, title=)`**, **`.interactive()`** —
  emits `{"params": [{"name": ..., "select": {"type": "interval",
  "encodings": ["x", "y"]}, "bind": "scales"}]}` exactly like real
  altair (name generation deterministic: `param_1`, `param_2`, ... per
  chart, matching altair's counter behavior closely enough for the
  normalized diff tests).
- **Layering:** `chart1 + chart2` → `LayerChart` with `{"layer": [...]}`;
  shared data hoisted to top level when both layers share the same data
  object (matches altair). LayerChart supports `properties()` and
  `.interactive()`.
- **Faceting:** via `Column`/`Row` encodings only (v1) — they emit
  ordinary `column`/`row` encoding channels; vega-lite does the layout.
- **Output methods:** `to_dict()`, `to_json(indent=None)` (user-facing,
  matching altair), `to_vegalite_json_str()` (runner protocol),
  `__repr__` mirroring PlotlyFigure's ("use show() or leave as last
  expression"). Spec includes `"$schema"` (vega-lite v5).
- **Module-level:** `alt.value(v)` (literal channel values),
  `alt.defaults` object with `height`/`width` module defaults applied
  when the spec sets neither (mirrors `pe.defaults`; no `norsk` flag in
  v1 — number localization is a render-side concern and vega-embed
  locale support can be added later app-wide).

Chart methods return `self`-style copies cheaply: v1 mutates and
returns self (like the plotly shim), NOT altair's immutable-copy
semantics. Documented divergence; the diff tests never rely on
chart-reuse-after-modification.

## Out of scope (v1)

Concat (`|`, `&`, `hconcat`, `vconcat`), `facet()` method, selections/
params beyond `.interactive()`, `transform_*`, geo/projections (folium
is the next workstream), condition expressions, themes API, `alt.datum`,
`repeat`. All raise a clear `NotImplementedError` naming the feature
where cheap to detect (unknown `alt.X` attribute access stays a normal
AttributeError).

## Testing

1. **`brython/tests/test_altair_core.py`** — CPython unit tests: spec
   shape per mark, shorthand parsing table, channel options, layering,
   facet channels, data normalization (DataFrame/dict/records), nan →
   null, no-None-noise in spec, defaults, interactive param, error on
   out-of-scope features.
2. **`brython/tests/test_altair_core_diff.py`** — differential vs real
   altair when installed (guarded `HAS_ALTAIR` like `HAS_PX`):
   normalize both sides (drop `$schema`, `config`, `usermeta`; resolve
   altair's named-dataset indirection `data: {name}` + `datasets` back
   to inline values; drop generated param names) then compare WHOLE
   specs with `==`. Cases: each mark, shorthand vs channel-class
   equivalence, bin/scale/sort/title, tooltip list, layering, column/
   row facet, interactive.
3. **Micropython smoke** — extend/mirror `micropython/tests/`
   (`mpy_smoke_plotly.py` pattern): unix-micropython imports
   `altair_mpy`, builds a chart, asserts JSON round-trips.
4. **Browser verification** (claude-in-chrome, both brython and
   micropython modes + pyodide real-altair): chart renders, theme
   colors applied, lazy JS loading fires only on `import altair`,
   diff-test suite green in CI/local pytest.

## Examples & docs

One example file per runtime (`examples/brython/bryNN_altair.txt`,
`examples/micropython/NN_altair.txt`, python-mode equivalent) showing:
scatter with color, bar with `mean()` shorthand, layered line+point,
and a Column facet — on a small Norwegian-flavored dataset consistent
with existing examples.
