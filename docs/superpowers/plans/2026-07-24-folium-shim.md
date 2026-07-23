# Folium Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pure-python folium API subset (`shared/folium_core.py`) that emits a small JSON layer-spec rendered by Leaflet, with built-in lazy-loaded Norwegian kommune/fylke geometry for choropleths, working in brython and micropython (pyodide renders real folium via the html embed).

**Architecture:** Exact altair-shim pattern: one dialect-neutral core in `shared/`, thin facades with explicit rebinds, a new `leafletmap__` embed type in both runners' `_fmt`, and a `mdRenderLeafletMap` helper in index.html translating the JSON spec into Leaflet calls. All choropleth color/bin logic runs in python (testable without a browser); JS only styles features and draws a legend.

**Tech Stack:** Python (CPython 3.13 tests, Brython 3.12, unix/wasm MicroPython), Leaflet 1.9.4 (pinned jsdelivr, verified 200), geodata from robhop/fylker-og-kommuner (Kartverket-derived, CC BY 4.0; 357 kommuner / 15 fylker 2024, properties kommunenummer/fylkesnummer — verified 2026-07-24; raw copies already in scratchpad).

**Spec:** `docs/superpowers/specs/2026-07-24-folium-shim-design.md` — read first.

## Global Constraints

- `shared/folium_core.py` dialect-neutral: NO `**` in dict LITERALS, no `str.capitalize`/`re`/`setdefault`/`partition`/`zfill`, guarded `datetime` (unused here — skip), no browser/js imports. Trap list: `micropython/plotly_express_mpy.py` header.
- Facades use `import folium_core as _core` + explicit rebinds — NEVER `from ... import *` (empty through the mpy `_Mod` proxy).
- Leaflet pins: `https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js` (global `L`) and `.../dist/leaflet.css` — both verified 200.
- Geometry files: `static_data/kommuner_2024.geojson` (<2 MB) and `static_data/fylker_2024.geojson` (<500 kB), properties normalized to `nummer` (string, zero-padded) + `navn`, Kartverket CC BY 4.4 attribution in file header key and map attribution.
- Bump `window.M2PY_VERSION` (index.html ~line 619) in the final index.html task — stale-cache trap from the altair cycle.
- Norwegian comments; commit per task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Norwegian geometry — build script + static_data files + sanity test

**Files:**
- Create: `tools/build_norge_geojson.py`
- Create: `static_data/kommuner_2024.geojson`, `static_data/fylker_2024.geojson` (generated, committed)
- Create: `brython/tests/test_norge_geojson.py`

**Interfaces:**
- Produces: the two static_data files with `FeatureCollection` + top-level `"attribution"` key; each feature has `properties: {"nummer": "0301", "navn": "Oslo"}`. Task 5's JS fetches them by exact filename.

- [ ] **Step 1: Write the sanity test**

Create `brython/tests/test_norge_geojson.py`:

```python
# Sanity-test for de genererte norgeskart-filene (kjøres etter
# tools/build_norge_geojson.py):
#   python3 brython/tests/test_norge_geojson.py
import json, os

BASE = os.path.join(os.path.dirname(__file__), '..', '..', 'static_data')


def _load(name):
    p = os.path.join(BASE, name)
    assert os.path.exists(p), name + ' mangler — kjør tools/build_norge_geojson.py'
    with open(p) as f:
        return json.load(f), os.path.getsize(p)


def test_kommuner():
    d, size = _load('kommuner_2024.geojson')
    assert size < 2_000_000, 'kommuner_2024.geojson for stor: %d' % size
    assert 'Kartverket' in d.get('attribution', '')
    feats = d['features']
    assert len(feats) == 357, len(feats)
    nummer = {f['properties']['nummer'] for f in feats}
    assert '0301' in nummer and all(len(n) == 4 for n in nummer)
    assert all('navn' in f['properties'] for f in feats)


def test_fylker():
    d, size = _load('fylker_2024.geojson')
    assert size < 500_000, 'fylker_2024.geojson for stor: %d' % size
    feats = d['features']
    assert len(feats) == 15, len(feats)
    assert all(len(f['properties']['nummer']) == 2 for f in feats)


if __name__ == '__main__':
    test_kommuner(); print('PASS test_kommuner')
    test_fylker(); print('PASS test_fylker')
```

- [ ] **Step 2: Run to verify it fails** — `python3 brython/tests/test_norge_geojson.py` → AssertionError "mangler".

- [ ] **Step 3: Write the build script**

Create `tools/build_norge_geojson.py`:

```python
"""Bygg static_data/{kommuner,fylker}_2024.geojson fra
robhop/fylker-og-kommuner (Kartverket-avledet, CC BY 4.0).

Kjøres manuelt fra repo-roten når grensene skal oppdateres:
    python3 tools/build_norge_geojson.py
Forenkler med Douglas-Peucker + koordinatavrunding til målstørrelsene
(kommuner < 2 MB, fylker < 500 kB) og normaliserer egenskapene til
{nummer, navn}."""
import json
import urllib.request
import os

SRC = {
    'kommuner': ('https://raw.githubusercontent.com/robhop/'
                 'fylker-og-kommuner/main/Kommuner-M.geojson',
                 'kommunenummer', 'kommunenavn', 4, 0.0015),
    'fylker':   ('https://raw.githubusercontent.com/robhop/'
                 'fylker-og-kommuner/main/Fylker-M.geojson',
                 'fylkesnummer', 'fylkesnavn', 2, 0.004),
}
ATTRIB = ('Grenser: Kartverket (CC BY 4.0) via '
          'github.com/robhop/fylker-og-kommuner')
OUT = os.path.join(os.path.dirname(__file__), '..', 'static_data')


def dp(points, tol):
    """Iterativ Douglas-Peucker (rekursjonstrygg) på [[lon, lat], ...]."""
    n = len(points)
    if n < 3:
        return points
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
        maxd, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm
            if d > maxd:
                maxd, idx = d, i
        if maxd > tol:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(ring, tol):
    out = dp(ring, tol)
    out = [[round(x, 4), round(y, 4)] for x, y in out]
    if len(out) >= 4:
        if out[0] != out[-1]:
            out.append(list(out[0]))
        return out
    return None


def simplify_geom(geom, tol):
    t = geom['type']
    if t == 'Polygon':
        rings = [r for r in (simplify_ring(r, tol) for r in geom['coordinates']) if r]
        return {'type': 'Polygon', 'coordinates': rings} if rings else None
    if t == 'MultiPolygon':
        polys = []
        for poly in geom['coordinates']:
            rings = [r for r in (simplify_ring(r, tol) for r in poly) if r]
            if rings:
                polys.append(rings)
        return {'type': 'MultiPolygon', 'coordinates': polys} if polys else None
    return geom


def build(kind):
    url, numkey, navnkey, width, tol = SRC[kind]
    with urllib.request.urlopen(url) as r:
        src = json.load(r)
    feats = []
    for f in src['features']:
        g = simplify_geom(f['geometry'], tol)
        if g is None:
            # aldri mist en kommune pga forenkling — behold uforenklet
            g = f['geometry']
        p = f['properties']
        nummer = str(p[numkey])
        while len(nummer) < width:
            nummer = '0' + nummer
        feats.append({'type': 'Feature',
                      'properties': {'nummer': nummer, 'navn': p[navnkey]},
                      'geometry': g})
    out = {'type': 'FeatureCollection', 'attribution': ATTRIB,
           'features': feats}
    path = os.path.join(OUT, '%s_2024.geojson' % kind)
    with open(path, 'w') as fh:
        json.dump(out, fh, separators=(',', ':'), ensure_ascii=False)
    print(kind, len(feats), 'features,', os.path.getsize(path), 'bytes')


if __name__ == '__main__':
    build('kommuner')
    build('fylker')
```

- [ ] **Step 4: Run it and the sanity test**

```bash
python3 tools/build_norge_geojson.py
python3 brython/tests/test_norge_geojson.py
```

Expected: both files written, both tests PASS. If a size assertion fails, increase the tolerance (5th tuple element in `SRC`) for that layer by ~50% and rerun until under target — visual quality is re-checked in the browser task.

- [ ] **Step 5: Commit**

```bash
git add tools/build_norge_geojson.py static_data/kommuner_2024.geojson \
    static_data/fylker_2024.geojson brython/tests/test_norge_geojson.py
git commit -m "feat(folium): norsk kommune-/fylkesgeometri 2024 + byggescript"
```

---

### Task 2: `shared/folium_core.py` del 1 — helpers, Map, basislag

**Files:**
- Create: `shared/folium_core.py`
- Create: `brython/tests/test_folium_core.py`

**Interfaces:**
- Produces: `TILES` (dict name→{url, attribution}), `_zpad(s, n)`, `_interp_palette(name, n) -> [hex]*n`, `_linear_bins(vmin, vmax, n) -> [n+1 kanter]`, `_is_nan(v)`, `class Map` (`add_child`, `to_dict`, `to_leaflet_json_str`, `show`, `__repr__`), layer classes `Marker, CircleMarker, Circle, PolyLine, Polygon` each with `add_to(m)` and `_layer_dict() -> dict`.

- [ ] **Step 1: Write failing tests** — create `brython/tests/test_folium_core.py`:

```python
# Enhetstester for shared/folium_core.py — kjøres under CPython:
#   python3 brython/tests/test_folium_core.py
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import folium_core as fol


def test_map_defaults_and_spec():
    m = fol.Map()
    spec = m.to_dict()
    assert spec == {'center': None, 'zoom': None,
                    'tiles': 'OpenStreetMap', 'layers': []}
    m2 = fol.Map(location=[59.91, 10.75], zoom_start=10,
                 tiles='CartoDB positron', width=600, height=400)
    s2 = m2.to_dict()
    assert s2['center'] == [59.91, 10.75] and s2['zoom'] == 10
    assert s2['tiles'] == 'CartoDB positron'
    assert s2['width'] == 600 and s2['height'] == 400


def test_unknown_tiles_raises():
    try:
        fol.Map(tiles='Stamen Toner')
        assert False, 'skulle kastet'
    except ValueError as e:
        assert 'OpenStreetMap' in str(e)


def test_marker_add_to_and_add_child():
    m1 = fol.Map()
    fol.Marker([60.0, 11.0], popup='Hei', tooltip='Tips').add_to(m1)
    m2 = fol.Map()
    m2.add_child(fol.Marker([60.0, 11.0], popup='Hei', tooltip='Tips'))
    assert m1.to_dict() == m2.to_dict()
    ld = m1.to_dict()['layers'][0]
    assert ld == {'type': 'marker', 'location': [60.0, 11.0],
                  'popup': 'Hei', 'tooltip': 'Tips'}


def test_circle_marker_and_circle():
    ld = (fol.CircleMarker([60, 11], radius=8, color='#ff0000',
                           fill=True, fill_color='#00ff00',
                           fill_opacity=0.5, weight=2)._layer_dict())
    assert ld['type'] == 'circle_marker' and ld['radius'] == 8
    assert ld['color'] == '#ff0000' and ld['fill'] is True
    ld2 = fol.Circle([60, 11], radius=5000)._layer_dict()
    assert ld2['type'] == 'circle' and ld2['radius'] == 5000
    # None-opsjoner skal IKKE med i spec-en
    assert 'color' not in fol.CircleMarker([60, 11])._layer_dict()


def test_polyline_and_polygon():
    pts = [[60, 10], [61, 11], [62, 10]]
    ld = fol.PolyLine(pts, color='blue', weight=4)._layer_dict()
    assert ld == {'type': 'polyline', 'locations': pts,
                  'color': 'blue', 'weight': 4}
    lp = fol.Polygon(pts, fill_color='#aaa')._layer_dict()
    assert lp['type'] == 'polygon' and lp['fill_color'] == '#aaa'


def test_zpad_and_bins():
    assert fol._zpad(301, 4) == '0301'
    assert fol._zpad('03', 2) == '03'
    edges = fol._linear_bins(0.0, 10.0, 4)
    assert edges == [0.0, 2.5, 5.0, 7.5, 10.0]


def test_palette_interpolation():
    c3 = fol._interp_palette('YlOrRd', 3)
    assert len(c3) == 3
    assert c3[0].lower() == '#ffffcc' and c3[-1].lower() == '#800026'
    c9 = fol._interp_palette('Blues', 9)
    assert len(c9) == 9 and c9[0].lower() == '#f7fbff'
    try:
        fol._interp_palette('Viridis', 5)
        assert False
    except ValueError as e:
        assert 'YlOrRd' in str(e)


def test_runner_protocol():
    m = fol.Map()
    fol.Marker([60, 11]).add_to(m)
    s = m.to_leaflet_json_str()
    assert json.loads(s)['layers'][0]['type'] == 'marker'
    assert 'FoliumMap' in repr(m)


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE FOLIUM-CORE-TESTER GRØNNE')
```

- [ ] **Step 2: Run to verify failure** — `python3 brython/tests/test_folium_core.py` → ModuleNotFoundError.

- [ ] **Step 3: Implement** — create `shared/folium_core.py`:

```python
"""folium_core — delt Leaflet-kart-bygger (folium-API-subset) for
brython/micropython/CPython (spec 2026-07-24-folium-shim-design.md).
Samme dialektregler som altair_core.py (se dens filhode +
micropython/plotly_express_mpy.py-fellelisten). Python-siden bygger en
liten deklarativ spec ({center, zoom, tiles, layers}); JS-siden
(mdRenderLeafletMap i index.html) oversetter til Leaflet-kall. ALL
choropleth-farge-/bin-logikk ligger HER (testbar uten browser)."""

import json

TILES = {
    'OpenStreetMap': {
        'url': 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        'attribution': '&copy; OpenStreetMap contributors'},
    'CartoDB positron': {
        'url': 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
        'attribution': '&copy; OpenStreetMap contributors &copy; CARTO'},
}

# 9-klasse ColorBrewer-ankre; n-klasse-skalaer interpoleres lineært
# mellom ankrene (samme idé som branca.LinearColormap i ekte folium).
PALETTES = {
    'YlOrRd': ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c',
               '#fc4e2a', '#e31a1c', '#bd0026', '#800026'],
    'YlGnBu': ['#ffffd9', '#edf8b1', '#c7e9b4', '#7fcdbb', '#41b6c4',
               '#1d91c0', '#225ea8', '#253494', '#081d58'],
    'Blues':  ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6',
               '#4292c6', '#2171b5', '#08519c', '#08306b'],
    'Greens': ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476',
               '#41ab5d', '#238b45', '#006d2c', '#00441b'],
    'Reds':   ['#fff5f0', '#fee0d2', '#fcbba1', '#fc9272', '#fb6a4a',
               '#ef3b2c', '#cb181d', '#a50f15', '#67000d'],
    'Purples': ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8',
                '#807dba', '#6a51a3', '#54278f', '#3f007d'],
}


def _is_nan(v):
    if v is None:
        return True
    if type(v).__name__ == 'NaN':
        return True
    return isinstance(v, float) and v != v


def _zpad(s, n):
    """Zero-padding uten str.zfill (MicroPython-byggavhengig)."""
    s = str(s)
    while len(s) < n:
        s = '0' + s
    return s


def _hex_to_rgb(h):
    h = h.lstrip('#')
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _rgb_to_hex(rgb):
    return '#%02x%02x%02x' % rgb


def _interp_palette(name, n):
    """n farger jevnt fordelt langs palettens ankerpunkter."""
    if name not in PALETTES:
        raise ValueError('Ukjent palett: ' + str(name) + ' (tilgjengelig: '
                         + ', '.join(sorted(PALETTES.keys())) + ')')
    anchors = [_hex_to_rgb(c) for c in PALETTES[name]]
    if n <= 1:
        return [_rgb_to_hex(anchors[-1])]
    out = []
    m = len(anchors) - 1
    for i in range(n):
        pos = i * m / (n - 1)
        lo = int(pos)
        if lo >= m:
            out.append(_rgb_to_hex(anchors[m]))
            continue
        frac = pos - lo
        a, b = anchors[lo], anchors[lo + 1]
        rgb = (int(round(a[0] + (b[0] - a[0]) * frac)),
               int(round(a[1] + (b[1] - a[1]) * frac)),
               int(round(a[2] + (b[2] - a[2]) * frac)))
        out.append(_rgb_to_hex(rgb))
    return out


def _linear_bins(vmin, vmax, n):
    if vmax <= vmin:
        vmax = vmin + 1.0
    step = (vmax - vmin) / n
    return [vmin + step * i for i in range(n)] + [vmax]


def _clean(d):
    """Fjern None-verdier (grunn — lagdicts er flate)."""
    out = {}
    for k in d:
        if d[k] is not None:
            out[k] = d[k]
    return out


class _Layer:
    """Basisklasse: folium-mønsteret obj.add_to(m)."""

    def add_to(self, m):
        m.add_child(self)
        return self


class Map:
    def __init__(self, location=None, zoom_start=None,
                 tiles='OpenStreetMap', width=None, height=None):
        if tiles not in TILES:
            raise ValueError('Ukjente tiles: ' + str(tiles)
                             + ' (tilgjengelig: '
                             + ', '.join(sorted(TILES.keys())) + ')')
        self._center = list(location) if location is not None else None
        self._zoom = zoom_start
        self._tiles = tiles
        self._width = width
        self._height = height
        self._layers = []

    def add_child(self, child):
        self._layers.append(child._layer_dict())
        return self

    def to_dict(self):
        spec = {'center': self._center, 'zoom': self._zoom,
                'tiles': self._tiles, 'layers': list(self._layers)}
        if self._width is not None:
            spec['width'] = self._width
        if self._height is not None:
            spec['height'] = self._height
        return spec

    def to_leaflet_json_str(self):
        """Runner-protokollen (_fmt): hele spec-en som JSON-streng."""
        return json.dumps(self.to_dict())

    def show(self):
        return str(self)

    def __str__(self):
        return '<FoliumMap: use show() or leave as last expression>'

    def __repr__(self):
        return str(self)

    def _repr_html_(self):
        return str(self)


class Marker(_Layer):
    def __init__(self, location, popup=None, tooltip=None):
        self._d = _clean({'type': 'marker', 'location': list(location),
                          'popup': popup, 'tooltip': tooltip})

    def _layer_dict(self):
        return dict(self._d)


class CircleMarker(_Layer):
    _TYPE = 'circle_marker'

    def __init__(self, location, radius=10, color=None, fill=None,
                 fill_color=None, fill_opacity=None, weight=None,
                 opacity=None, popup=None, tooltip=None):
        self._d = _clean({'type': self._TYPE, 'location': list(location),
                          'radius': radius, 'color': color, 'fill': fill,
                          'fill_color': fill_color,
                          'fill_opacity': fill_opacity, 'weight': weight,
                          'opacity': opacity, 'popup': popup,
                          'tooltip': tooltip})

    def _layer_dict(self):
        return dict(self._d)


class Circle(CircleMarker):
    # radius i METER (Leaflet L.circle) — CircleMarker er piksler
    _TYPE = 'circle'


class PolyLine(_Layer):
    _TYPE = 'polyline'

    def __init__(self, locations, color=None, weight=None, opacity=None,
                 popup=None, tooltip=None):
        self._d = _clean({'type': self._TYPE,
                          'locations': [list(p) for p in locations],
                          'color': color, 'weight': weight,
                          'opacity': opacity, 'popup': popup,
                          'tooltip': tooltip})

    def _layer_dict(self):
        return dict(self._d)


class Polygon(PolyLine):
    _TYPE = 'polygon'

    def __init__(self, locations, color=None, weight=None, opacity=None,
                 fill=None, fill_color=None, fill_opacity=None,
                 popup=None, tooltip=None):
        PolyLine.__init__(self, locations, color=color, weight=weight,
                          opacity=opacity, popup=popup, tooltip=tooltip)
        extra = _clean({'fill': fill, 'fill_color': fill_color,
                        'fill_opacity': fill_opacity})
        for k in extra:
            self._d[k] = extra[k]
```

- [ ] **Step 4: Run** — `python3 brython/tests/test_folium_core.py` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/folium_core.py brython/tests/test_folium_core.py
git commit -m "feat(folium): folium_core del 1 — Map, basislag, paletter/bins"
```

---

### Task 3: `folium_core` del 2 — GeoJson, FeatureGroup, LayerControl, Choropleth + paritetstest

**Files:**
- Modify: `shared/folium_core.py` (append)
- Modify: `brython/tests/test_folium_core.py` (append)

**Interfaces:**
- Consumes: `_Layer`, `_clean`, `_zpad`, `_interp_palette`, `_linear_bins`, `_is_nan`, `Map.add_child`.
- Produces: `GeoJson(data, name=None, style=None, tooltip_fields=None)`, `FeatureGroup(name=None)` (own `add_child`), `LayerControl()`, `Choropleth(geo_data, data=None, columns=None, key_on='nummer', fill_color='YlOrRd', bins=6, nan_fill_color='#d9d9d9', fill_opacity=0.7, line_opacity=0.4, legend_name=None, name=None)`. Layer-dict shapes exactly as in the spec's JSON format (Task 5's JS consumes them).

- [ ] **Step 1: Append failing tests** (before `__main__`):

```python
def test_geojson_dict_and_url():
    gj = {"type": "FeatureCollection", "features": []}
    ld = fol.GeoJson(gj, name='Lag', style={'color': '#333'},
                     tooltip_fields=['navn'])._layer_dict()
    assert ld['type'] == 'geojson' and ld['data'] == gj
    assert ld['style'] == {'color': '#333'}
    assert ld['tooltip_fields'] == ['navn'] and ld['name'] == 'Lag'
    lu = fol.GeoJson('https://example.com/x.geojson')._layer_dict()
    assert lu['url'] == 'https://example.com/x.geojson' and 'data' not in lu


def test_geojson_callable_style_raises():
    try:
        fol.GeoJson({}, style=lambda f: {})
        assert False
    except TypeError as e:
        assert 'style' in str(e)


def test_feature_group_and_layer_control():
    fg = fol.FeatureGroup(name='Punkter')
    fol.Marker([60, 11]).add_to(fg)
    fg.add_child(fol.Marker([61, 11]))
    ld = fg._layer_dict()
    assert ld['type'] == 'feature_group' and ld['name'] == 'Punkter'
    assert len(ld['layers']) == 2
    assert fol.LayerControl()._layer_dict() == {'type': 'layer_control'}


def test_choropleth_norge_kommuner():
    data = {301: 10.0, '1103': 20.0, '5001': 30.0}
    ld = fol.Choropleth('norge:kommuner', data=data, bins=3,
                        legend_name='Rate')._layer_dict()
    assert ld['type'] == 'choropleth' and ld['geo'] == 'norge:kommuner'
    assert ld['key_on'] == 'nummer'
    # 301 -> "0301" (zero-padding for norge:kommuner)
    assert set(ld['colors'].keys()) == {'0301', '1103', '5001'}
    # lav verdi -> lys, høy -> mørk (YlOrRd 3 bins)
    assert ld['colors']['0301'] != ld['colors']['5001']
    lg = ld['legend']
    assert lg['title'] == 'Rate' and len(lg['colors']) == 3
    assert len(lg['bins']) == 4 and lg['bins'][0] == 10.0 and lg['bins'][-1] == 30.0
    assert ld['nan_fill_color'] == '#d9d9d9'


def test_choropleth_dataframe_and_columns():
    import pandas_brython as bpd
    df = bpd.DataFrame({'fylke': ['03', '11', '50'], 'verdi': [1.0, 2.0, 3.0]})
    ld = fol.Choropleth('norge:fylker', data=df, columns=['fylke', 'verdi'],
                        fill_color='Blues', bins=2)._layer_dict()
    assert set(ld['colors'].keys()) == {'03', '11', '50'}
    assert len(ld['legend']['colors']) == 2


def test_choropleth_explicit_bins_and_nan():
    data = {'0301': 5.0, '1103': None, '5001': 95.0}
    ld = fol.Choropleth('norge:kommuner', data=data,
                        bins=[0, 10, 100])._layer_dict()
    # None-verdi utelates fra colors (JS bruker nan_fill_color)
    assert '1103' not in ld['colors']
    assert ld['legend']['bins'] == [0, 10, 100]
    assert ld['colors']['0301'] != ld['colors']['5001']


def test_choropleth_geojson_dict_and_bad_geo():
    gj = {"type": "FeatureCollection", "features": []}
    ld = fol.Choropleth(gj, data={'a': 1.0}, key_on='id')._layer_dict()
    assert ld['data'] == gj and ld['key_on'] == 'id'
    assert list(ld['colors'].keys()) == ['a']   # ingen padding utenfor norge:*
    try:
        fol.Choropleth(42)
        assert False
    except ValueError:
        pass


def test_folium_api_parity():
    """Våre parameternavn skal være en DELMENGDE av ekte foliums
    (folium emitter HTML — spec-diff som altair er umulig)."""
    try:
        import folium as rf
        import inspect
    except ImportError:
        return
    pairs = [(fol.Map, rf.Map), (fol.Marker, rf.Marker),
             (fol.CircleMarker, rf.CircleMarker), (fol.PolyLine, rf.PolyLine),
             (fol.Choropleth, rf.Choropleth)]
    for mine, real in pairs:
        my = set(inspect.signature(mine.__init__).parameters) - {'self'}
        theirs = set(inspect.signature(real.__init__).parameters)
        # ekte folium tar **kwargs mange steder — da er alt gyldig
        if any(p.kind == inspect.Parameter.VAR_KEYWORD
               for p in inspect.signature(real.__init__).parameters.values()):
            continue
        extra = my - theirs
        assert not extra, '%s: parametre utenfor folium: %s' % (mine.__name__, extra)
```

- [ ] **Step 2: Run to verify failure**, then **Step 3: install real folium and implement** — `python3 -m pip install --user --quiet folium`, then append to `shared/folium_core.py`:

```python
class GeoJson(_Layer):
    def __init__(self, data, name=None, style=None, tooltip_fields=None):
        if callable(style):
            raise TypeError('style som funksjon er utenfor v1 — bruk en '
                            'stil-dict ({"color": ..., "weight": ...})')
        d = {'type': 'geojson', 'name': name, 'style': style,
             'tooltip_fields': tooltip_fields}
        if isinstance(data, str):
            d['url'] = data
        elif isinstance(data, dict):
            d['data'] = data
        else:
            raise ValueError('GeoJson: forventer dict eller url-streng')
        self._d = _clean(d)

    def _layer_dict(self):
        return dict(self._d)


class FeatureGroup(_Layer):
    def __init__(self, name=None):
        self._name = name
        self._children = []

    def add_child(self, child):
        self._children.append(child._layer_dict())
        return self

    def _layer_dict(self):
        return _clean({'type': 'feature_group', 'name': self._name,
                       'layers': list(self._children)})


class LayerControl(_Layer):
    def _layer_dict(self):
        return {'type': 'layer_control'}


def _data_to_pairs(data, columns):
    """Choropleth-data -> [(nøkkel, verdi)]: dict {kode: verdi} eller
    DataFrame + columns=[nøkkelkolonne, verdikolonne] (duck-typet som
    altair_core._records_from_data)."""
    if hasattr(data, 'columns') and hasattr(data, 'to_dict'):
        if not columns or len(columns) != 2:
            raise ValueError('Choropleth med DataFrame krever '
                             "columns=['nøkkelkolonne', 'verdikolonne']")
        cols = data.to_dict()
        keys = list(cols[columns[0]])
        vals = list(cols[columns[1]])
        return list(zip(keys, vals))
    if isinstance(data, dict):
        return [(k, data[k]) for k in data]
    raise ValueError('Choropleth: data må være dict {kode: verdi} '
                     'eller DataFrame med columns=[...]')


class Choropleth(_Layer):
    def __init__(self, geo_data, data=None, columns=None, key_on='nummer',
                 fill_color='YlOrRd', bins=6, nan_fill_color='#d9d9d9',
                 fill_opacity=0.7, line_opacity=0.4, legend_name=None,
                 name=None):
        d = {'type': 'choropleth', 'key_on': key_on,
             'nan_fill_color': nan_fill_color, 'fill_opacity': fill_opacity,
             'line_opacity': line_opacity, 'name': name}
        pad = 0
        if geo_data == 'norge:kommuner':
            d['geo'] = geo_data
            pad = 4
        elif geo_data == 'norge:fylker':
            d['geo'] = geo_data
            pad = 2
        elif isinstance(geo_data, str) and (
                geo_data.startswith('http://')
                or geo_data.startswith('https://')):
            d['url'] = geo_data
        elif isinstance(geo_data, dict):
            d['data'] = geo_data
        else:
            raise ValueError("Choropleth: geo_data må være 'norge:kommuner',"
                             " 'norge:fylker', en url eller en geojson-dict")
        pairs = _data_to_pairs(data, columns) if data is not None else []
        clean_pairs = []
        for k, v in pairs:
            if _is_nan(v):
                continue
            key = _zpad(k, pad) if pad else str(k)
            clean_pairs.append((key, float(v)))
        if clean_pairs:
            vals = [v for _, v in clean_pairs]
            if isinstance(bins, (list, tuple)):
                edges = [float(b) for b in bins]
                nb = len(edges) - 1
            else:
                nb = int(bins)
                edges = _linear_bins(min(vals), max(vals), nb)
            colors = _interp_palette(fill_color, nb)
            code_colors = {}
            for key, v in clean_pairs:
                idx = nb - 1
                for i in range(nb):
                    if v <= edges[i + 1]:
                        idx = i
                        break
                code_colors[key] = colors[idx]
            d['colors'] = code_colors
            d['legend'] = _clean({'title': legend_name, 'bins': edges,
                                  'colors': colors})
        else:
            d['colors'] = {}
        self._d = _clean(d)

    def _layer_dict(self):
        return dict(self._d)
```

- [ ] **Step 4: Run** — `python3 brython/tests/test_folium_core.py` → all PASS (incl. parity against pip-installed folium).

- [ ] **Step 5: Commit**

```bash
git add shared/folium_core.py brython/tests/test_folium_core.py
git commit -m "feat(folium): folium_core del 2 — GeoJson, Choropleth, paritetstest"
```

---

### Task 4: Runtime-kobling — fasader, registries, `_fmt`, CSS-link, mpy-røyk

**Files:**
- Create: `brython/folium_brython.py`, `micropython/folium_mpy.py`, `micropython/tests/mpy_smoke_folium.py`, `brython/tests/test_folium_runner_fmt.py`
- Modify: `js/brython-engine.js` (LIB_REGISTRY etter altair-oppføringene), `js/micropython-engine.js` (samme), `brython/brython_runner.py` (`_fmt`, FØR vegalite-grenen), `micropython/micropython_runner.py` (samme), `index.html` (statisk leaflet-CSS-link ved Tabulator-linken ~590)

**Interfaces:**
- Consumes: `to_leaflet_json_str()` fra Task 2.
- Produces: importnavn `folium` i begge shim-modusene; embed-typen `leafletmap` (payload = spec-JSON) som Task 5 rendrer.

- [ ] **Step 1: Runner-test** — create `brython/tests/test_folium_runner_fmt.py`:

```python
#   python3 brython/tests/test_folium_runner_fmt.py
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import folium_core as fol
import brython_runner


def test_fmt_emits_leafletmap_embed():
    m = fol.Map()
    fol.Marker([60, 11]).add_to(m)
    out = brython_runner._fmt(m)
    assert out.startswith('__micro_transform_start_leafletmap__')
    assert '"marker"' in out


def test_vegalite_and_plotly_unaffected():
    class FakeVega:
        def to_vegalite_json_str(self):
            return '{}'
    assert 'vegalite__' in brython_runner._fmt(FakeVega())


if __name__ == '__main__':
    test_fmt_emits_leafletmap_embed(); print('PASS test_fmt_emits_leafletmap_embed')
    test_vegalite_and_plotly_unaffected(); print('PASS test_vegalite_and_plotly_unaffected')
```

Run → FAIL. Then add to BOTH runners, directly BEFORE the `to_vegalite_json_str` branch:

```python
    if hasattr(obj, 'to_leaflet_json_str'):
        # folium-shimet (spec 2026-07-24): Leaflet-rendring i JS
        return _EMBED_S + 'leafletmap__' + '\n' + obj.to_leaflet_json_str() + '\n' + _EMBED_E
```

Run → PASS.

- [ ] **Step 2: Fasader** — `brython/folium_brython.py`:

```python
# Tynn fasade over shared/folium_core.py — eksplisitte rebind-er (ALDRI
# stjerneimport: tom gjennom micropython-runnerens _Mod-proxy, se
# altair-fasadene). Samme liste som micropython/folium_mpy.py.
import folium_core as _core

TILES = _core.TILES
PALETTES = _core.PALETTES
Map = _core.Map
Marker = _core.Marker
CircleMarker = _core.CircleMarker
Circle = _core.Circle
PolyLine = _core.PolyLine
Polygon = _core.Polygon
GeoJson = _core.GeoJson
FeatureGroup = _core.FeatureGroup
LayerControl = _core.LayerControl
Choropleth = _core.Choropleth
```

`micropython/folium_mpy.py`: identisk innhold, filhodet peker på brython-fila.

- [ ] **Step 3: Registries** — i `js/brython-engine.js` etter `altair_core`-oppføringen:

```js
    // folium (spec 2026-07-24): samme mønster som altair — delt kjerne i
    // shared/, Leaflet lastes lazy ved `import folium` (CSS-en er statisk
    // i index.html-head, Tabulator-presedensen).
    folium_brython:         { aliases: ['folium'], deps: ['folium_core'],
                              js: [
      { url: 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.min.js', global: 'L' }
                              ] },
    folium_core:            { aliases: [], deps: [], js: [],
                              path: 'shared/folium_core.py' }
```

Samme i `js/micropython-engine.js` med nøkkel `folium_mpy`. Kjør `node --check` på begge.

- [ ] **Step 4: Leaflet-CSS** — i `index.html`, rett etter Tabulator-CSS-linken (~linje 590):

```html
  <link href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css" rel="stylesheet">
```

- [ ] **Step 5: MPy-røyk** — create `micropython/tests/mpy_smoke_folium.py`:

```python
# micropython micropython/tests/mpy_smoke_folium.py   (fra repo-roten)
import sys, json
sys.path.insert(0, 'shared')
sys.path.insert(0, 'micropython')
import folium_mpy as fol

m = fol.Map(location=[59.91, 10.75], zoom_start=10)
fol.Marker([59.91, 10.75], popup='Oslo').add_to(m)
fol.Choropleth('norge:kommuner', data={'0301': 1.0, '5001': 2.0},
               bins=2, legend_name='Test').add_to(m)
spec = json.loads(m.to_leaflet_json_str())
assert spec['zoom'] == 10 and len(spec['layers']) == 2
assert spec['layers'][1]['colors']['0301'] != spec['layers'][1]['colors']['5001']
print('MPY-FOLIUM-RØYK OK')
```

Run: `micropython micropython/tests/mpy_smoke_folium.py` → `MPY-FOLIUM-RØYK OK`. Dialektfeil fikses i KJERNEN (CPython-testene skal forbli grønne).

- [ ] **Step 6: Alle tester + commit**

```bash
python3 brython/tests/test_folium_core.py && \
python3 brython/tests/test_folium_runner_fmt.py && \
python3 brython/tests/test_altair_runner_fmt.py && \
micropython micropython/tests/mpy_smoke_folium.py && \
node --check js/brython-engine.js && node --check js/micropython-engine.js
git add -A && git commit -m "feat(folium): runtime-kobling — fasader, registry, leafletmap-embed"
```

---

### Task 5: index.html — mdRenderLeafletMap, embed-case, pyodide, legend-CSS

**Files:**
- Modify: `index.html` — (1) `mdRenderLeafletMap` + geo-cache-hjelpere etter `mdRenderVegaFigure`; (2) `leafletmap`-case i `buildOutputNodes()` FØR `vegalite`-casen; (3) pyodide `_show_one`: folium-gren FØR altair-grenen; (4) `PYTHON_DS_IMPORTS`: + `'folium'`; (5) `M2PY_VERSION` → ny verdi (dagens dato-suffiks); (6) legend-CSS i `app.css`

- [ ] **Step 1: Renderer** — etter `mdRenderVegaFigure`s lukkeklamme:

```js
    var __norgeGeoCache = {};
    function __norgeGeoFetch(kind) {
      // 'norge:kommuner' | 'norge:fylker' -> memoisert fetch av static_data
      if (!__norgeGeoCache[kind]) {
        var f = kind === 'norge:fylker' ? 'fylker_2024.geojson' : 'kommuner_2024.geojson';
        __norgeGeoCache[kind] = fetch('static_data/' + f + '?v=' + (window.M2PY_VERSION || '1'))
          .then(function (r) {
            if (!r.ok) throw new Error('Kunne ikke hente ' + f + ' (' + r.status + ')');
            return r.json();
          });
      }
      return __norgeGeoCache[kind];
    }

    var LEAFLET_TILES = {
      'OpenStreetMap': { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
                         attribution: '&copy; OpenStreetMap contributors' },
      'CartoDB positron': { url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
                            attribution: '&copy; OpenStreetMap contributors &copy; CARTO' }
    };

    function __leafletLegend(map, legend) {
      var ctl = L.control({ position: 'bottomright' });
      ctl.onAdd = function () {
        var d = L.DomUtil.create('div', 'leafletmap-legend');
        var html = legend.title ? '<b>' + legend.title + '</b><br>' : '';
        function fmt(x) { return Math.round(x * 100) / 100; }
        for (var i = 0; i < legend.colors.length; i++) {
          html += '<i style="background:' + legend.colors[i] + '"></i>'
                + fmt(legend.bins[i]) + '&ndash;' + fmt(legend.bins[i + 1]) + '<br>';
        }
        d.innerHTML = html;
        return d;
      };
      ctl.addTo(map);
    }

    function mdRenderLeafletMap(div, spec) {
      if (typeof L === 'undefined') return;
      div.className = 'leafletmap-container';
      div.style.width = (spec.width || 520) + 'px';
      div.style.height = (spec.height || 360) + 'px';
      var tiles = LEAFLET_TILES[spec.tiles] || LEAFLET_TILES['OpenStreetMap'];
      var map = L.map(div);
      L.tileLayer(tiles.url, { attribution: tiles.attribution }).addTo(map);
      var fitables = [];   // lag med getBounds() for auto-fit
      var overlays = {};   // navngitte lag for LayerControl
      var wantsControl = false;
      var pending = [];

      function styleFromDict(s) {
        return s || {};
      }

      function bindPopupTooltip(layer, ld) {
        if (ld.popup) layer.bindPopup(String(ld.popup));
        if (ld.tooltip) layer.bindTooltip(String(ld.tooltip));
        return layer;
      }

      function makeGeoJsonLayer(gj, ld) {
        var opts = { style: function () { return styleFromDict(ld.style); } };
        if (ld.tooltip_fields && ld.tooltip_fields.length) {
          opts.onEachFeature = function (feat, lyr) {
            var parts = [];
            for (var i = 0; i < ld.tooltip_fields.length; i++) {
              var k = ld.tooltip_fields[i];
              if (feat.properties && feat.properties[k] !== undefined) {
                parts.push(k + ': ' + feat.properties[k]);
              }
            }
            if (parts.length) lyr.bindTooltip(parts.join('<br>'));
          };
        }
        return L.geoJSON(gj, opts);
      }

      function makeChoroplethLayer(gj, ld) {
        var layer = L.geoJSON(gj, {
          style: function (feat) {
            var key = feat.properties ? feat.properties[ld.key_on] : undefined;
            var color = (ld.colors && ld.colors[key]) || ld.nan_fill_color || '#d9d9d9';
            return { fillColor: color, fillOpacity: ld.fill_opacity || 0.7,
                     color: '#666', weight: 1, opacity: ld.line_opacity || 0.4 };
          },
          onEachFeature: function (feat, lyr) {
            var p = feat.properties || {};
            var key = p[ld.key_on];
            var navn = p.navn || key;
            lyr.bindTooltip(String(navn));
          }
        });
        if (ld.legend) __leafletLegend(map, ld.legend);
        if (gj.attribution) map.attributionControl.addAttribution(gj.attribution);
        return layer;
      }

      function buildLayer(ld) {
        // returnerer L-lag ELLER Promise<L-lag> (geojson/choropleth m/fetch)
        switch (ld.type) {
          case 'marker':
            return bindPopupTooltip(L.marker(ld.location), ld);
          case 'circle_marker':
            return bindPopupTooltip(L.circleMarker(ld.location, ld), ld);
          case 'circle':
            return bindPopupTooltip(L.circle(ld.location, ld), ld);
          case 'polyline':
            return bindPopupTooltip(L.polyline(ld.locations, ld), ld);
          case 'polygon':
            return bindPopupTooltip(L.polygon(ld.locations, ld), ld);
          case 'geojson':
          case 'choropleth': {
            var src = ld.geo ? __norgeGeoFetch(ld.geo)
              : ld.url ? fetch(ld.url).then(function (r) {
                  if (!r.ok) throw new Error('geojson ' + r.status);
                  return r.json();
                })
              : Promise.resolve(ld.data || {});
            return src.then(function (gj) {
              return ld.type === 'choropleth'
                ? makeChoroplethLayer(gj, ld)
                : makeGeoJsonLayer(gj, ld);
            });
          }
          case 'feature_group': {
            var fg = L.featureGroup();
            (ld.layers || []).forEach(function (sub) {
              var subl = buildLayer(sub);
              if (subl && typeof subl.then === 'function') {
                pending.push(subl.then(function (l) { fg.addLayer(l); }));
              } else if (subl) {
                fg.addLayer(subl);
              }
            });
            if (ld.name) overlays[ld.name] = fg;
            return fg;
          }
          case 'layer_control':
            wantsControl = true;
            return null;
          default:
            return null;
        }
      }

      (spec.layers || []).forEach(function (ld) {
        var l = buildLayer(ld);
        if (l && typeof l.then === 'function') {
          pending.push(l.then(function (layer) {
            layer.addTo(map);
            fitables.push(layer);
            if (ld.name && ld.type !== 'feature_group') overlays[ld.name] = layer;
          }).catch(function (e) {
            console.warn('leafletmap-lag feilet:', e && e.message);
          }));
        } else if (l) {
          l.addTo(map);
          fitables.push(l);
          if (ld.name && ld.type !== 'feature_group') overlays[ld.name] = l;
        }
      });

      Promise.all(pending).then(function () {
        setTimeout(function () {
          map.invalidateSize();
          if (spec.center) {
            map.setView(spec.center, spec.zoom || 6);
          } else {
            var b = null;
            fitables.forEach(function (l) {
              try {
                var lb = l.getBounds ? l.getBounds() : null;
                if (lb && lb.isValid()) b = b ? b.extend(lb) : lb;
              } catch (e) {}
            });
            if (b) map.fitBounds(b, { padding: [10, 10] });
            else map.setView([64.5, 12.5], 4);   // Norge-utsnitt
          }
          if (wantsControl && Object.keys(overlays).length) {
            L.control.layers(null, overlays).addTo(map);
          }
        }, 0);
      });
    }
```

- [ ] **Step 2: Embed-case** i `buildOutputNodes()`, FØR `vegalite`-casen:

```js
            } else if (p.embedType === 'leafletmap' && p.payload && typeof L !== 'undefined') {
              try {
                const lmSpec = JSON.parse(p.payload);
                const lmDiv = document.createElement('div');
                frag.appendChild(lmDiv);
                mdRenderLeafletMap(lmDiv, lmSpec);
              } catch (e) {
                const pre = document.createElement('pre');
                pre.className = 'embed-placeholder';
                pre.textContent = '[Leaflet-kart – kunne ikke tolke JSON]';
                frag.appendChild(pre);
              }
```

- [ ] **Step 3: Pyodide-gren** i `_show_one`, FØR altair-grenen (ekte folium gir komplett HTML — bruk den eksisterende html-embedden):

```python
    try:
        _fmod = getattr(type(obj), "__module__", "") or ""
        if _fmod.split(".")[0] == "folium" and hasattr(obj, "get_root"):
            # ekte folium i pyodide -> html-embed (komplett iframe-HTML)
            print(_EMBED_S + "html__" + chr(10) + obj._repr_html_() + chr(10) + _EMBED_E)
            return
    except Exception:
        pass
```

- [ ] **Step 4: Småting** — `PYTHON_DS_IMPORTS` (+ `'folium'` etter `'altair'`); `M2PY_VERSION` bumpes; legend-CSS i `app.css`:

```css
/* folium-shimets choropleth-legend (mdRenderLeafletMap) */
.leafletmap-legend {
  background: var(--bg-code, #fff);
  color: var(--text, #1a1b26);
  border: 1px solid var(--border, #e4e2dd);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  line-height: 1.5;
}
.leafletmap-legend i {
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-right: 5px;
  vertical-align: -1px;
}
.leafletmap-container { margin: 6px 0; }
```

- [ ] **Step 5: Kjør alle python-tester på nytt + commit**

```bash
git add index.html app.css
git commit -m "feat(folium): leafletmap-rendring, norsk geo-fetch, pyodide-gren"
```

---

### Task 6: Eksempler + manifest

**Files:**
- Create: `examples/brython/bry28_folium.txt`, `examples/micropython/08_folium.txt`, `examples/python/py08_folium.txt`
- Modify (generert): `examples/manifest.json`

- [ ] **Step 1:** `examples/brython/bry28_folium.txt`:

```
# label: folium — kart og choropleth
# Folium (Leaflet) i brython-modus: markører + norsk kommune-choropleth.
import folium

m = folium.Map()

folium.Marker([59.9139, 10.7522], popup="Oslo", tooltip="Hovedstaden").add_to(m)
folium.CircleMarker([60.3913, 5.3221], radius=10, color="#c0392b",
                    fill=True, tooltip="Bergen").add_to(m)

folium.Choropleth(
    "norge:fylker",
    data={"03": 12.5, "11": 9.8, "15": 7.1, "18": 8.4, "31": 10.2,
          "32": 9.1, "33": 8.8, "34": 7.9, "39": 9.5, "40": 8.2,
          "42": 9.9, "46": 8.6, "50": 9.3, "55": 6.8, "56": 7.4},
    legend_name="Rate per 1000",
    fill_color="YlGnBu",
    bins=5,
).add_to(m)

m
```

- [ ] **Step 2:** `examples/micropython/08_folium.txt` — samme innhold, header «MicroPython-modus». `examples/python/py08_folium.txt` — ekte folium: samme markørdel, men choropleth-delen byttes med en `folium.GeoJson`-kommentar (ekte folium har ikke `norge:*`-nøklene):

```
# label: folium — kart
# Ekte folium i python-modus (pyodide): rendres som HTML-iframe.
import folium

m = folium.Map(location=[65.0, 13.0], zoom_start=4)
folium.Marker([59.9139, 10.7522], popup="Oslo", tooltip="Hovedstaden").add_to(m)
folium.CircleMarker([60.3913, 5.3221], radius=10, color="#c0392b",
                    fill=True, tooltip="Bergen").add_to(m)
m
```

- [ ] **Step 3:** `python3 examples/generate_manifest.py`; commit `examples/`.

---

### Task 7: Browser-verifisering (alle tre moduser) + full test-rerun

Same procedure som altair-Task 8 (serveren på port 8123 server repoet — sjekk `lsof -nP -i :8123` og cwd før gjenbruk):

- [ ] Brython-modus: kjør bry28-eksemplet — markører + fylkes-choropleth med legend rendres; `typeof L` er `undefined` FØR kjøring (lazy); ingen konsollfeil; skjermbilde.
- [ ] MicroPython-modus: 08-eksemplet; skjermbilde.
- [ ] Pyodide python-modus: py08-eksemplet — ekte folium via html-embed (micropip-installasjon kan feile på requests-avhengigheten; i så fall: dokumentér, verifiser at grenen er no-op og annen output fortsatt virker).
- [ ] Temasjekk: mørkt tema — legend følger CSS-variablene.
- [ ] Full suite:

```bash
python3 brython/tests/test_folium_core.py && \
python3 brython/tests/test_folium_runner_fmt.py && \
python3 brython/tests/test_norge_geojson.py && \
python3 brython/tests/test_altair_core.py && \
python3 brython/tests/test_altair_core_diff.py && \
python3 brython/tests/test_altair_runner_fmt.py && \
micropython micropython/tests/mpy_smoke_folium.py && \
micropython micropython/tests/mpy_smoke_altair.py && \
python3 micropython/tests/test_micropython_runner.py && \
node --check js/brython-engine.js && node --check js/micropython-engine.js
```

- [ ] Commit fikser; deretter superpowers:finishing-a-development-branch.

## Self-review notes

- Spec-dekning: geometri (T1), API + choropleth-logikk (T2–T3), paritetstest (T3), wiring + CSS (T4), renderer/pyodide/imports/M2PY (T5), eksempler (T6), browser (T7). Alle spec-krav har task.
- Type-konsistens: `to_leaflet_json_str` (runner ↔ kjerne), lagdict-nøkler i T2/T3 matcher renderer-switchen i T5 (`marker`, `circle_marker`, `circle`, `polyline`, `polygon`, `geojson`, `choropleth`, `feature_group`, `layer_control`), `nummer`-egenskapen i T1 matcher `key_on`-defaulten i T3.
- Kjente åpne punkter delegert med fallback: DP-toleransejustering (T1 step 4), micropip/folium-requests (T7).
