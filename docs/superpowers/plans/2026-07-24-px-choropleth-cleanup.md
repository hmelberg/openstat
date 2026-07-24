# px.choropleth-opprydding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gjøre `pe.choropleth()` px-tro og browser-verifisert i begge plotly-shimene (landnivå; norsk geometri er folium-shimets ansvar).

**Architecture:** Én funksjonsomskriving per shim (divergent-kopi-arkitekturen — porten til mpy følger dialektfellene), diff-tester mot ekte px i den eksisterende diff-fila, kryssruntime-paritetstest, eksempler, browser.

**Tech Stack:** Eksisterende plotly-shim-infrastruktur; ingen nye embeds/JS.

**Spec:** `docs/superpowers/specs/2026-07-24-px-choropleth-cleanup-design.md` — signaturen og semantikken der er bindende.

## Global Constraints

- mpy-porten: fellelisten i `plotly_express_mpy.py`-filhodet (ingen `**` i dict-literaler mm.).
- `M2PY_VERSION` bumpes (runtime-fetchede .py-filer endres).
- Norsk kommentarstil; commit per task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Diff-tester + brython-omskriving

**Files:** Modify `brython/plotly_express_brython.py` (choropleth, linje ~1290) og `brython/tests/test_plotly_express_brython_diff.py` (append).

- [ ] **Step 1: Failing tests** — append til diff-fila (før `__main__`):

```python
def test_choropleth_matches_px():
    if not HAS_PX:
        return
    d = {"land": ["NOR", "SWE", "DNK"], "verdi": [3.1, 2.5, 2.9]}
    mine = spec_of(pe.choropleth(bpd.DataFrame(d), locations="land",
                                 locationmode="ISO-3", color="verdi",
                                 scope="europe", hover_name="land"))
    ref = px.choropleth(rpd.DataFrame(d), locations="land",
                        locationmode="ISO-3", color="verdi",
                        scope="europe", hover_name="land")
    t, rt = mine["data"][0], ref.data[0]
    assert t["locations"] == list(rt.locations)
    assert t["z"] == [float(v) for v in rt.z]
    assert t["locationmode"] == rt.locationmode
    assert t["hovertext"] == list(rt.hovertext)
    assert mine["layout"]["geo"]["scope"] == "europe"
    # ryddet: ingen påtvungne nøkler (spec 2026-07-24)
    assert "projection" not in mine["layout"]["geo"]
    assert "showland" not in mine["layout"]["geo"]
    assert "width" not in mine["layout"] and "height" not in mine["layout"]
    assert "title" not in mine["layout"]


def test_choropleth_geojson_passthrough():
    gj = {"type": "FeatureCollection", "features": []}
    spec = spec_of(pe.choropleth(bpd.DataFrame({"k": ["a"], "v": [1.0]}),
                                 locations="k", geojson=gj,
                                 featureidkey="properties.nummer", color="v"))
    t = spec["data"][0]
    assert t["geojson"] == gj and t["featureidkey"] == "properties.nummer"
    assert "locationmode" not in t


def test_choropleth_nan_and_colorbar_label():
    df = bpd.DataFrame({"k": ["a", "b"], "v": [1.0, bpd.nan]})
    spec = spec_of(pe.choropleth(df, locations="k", color="v",
                                 labels={"v": "Rate"}))
    t = spec["data"][0]
    assert t["z"][1] is None
    assert t["colorbar"]["title"] == "Rate"
    # basemap_visible=False -> geo.visible False (px-semantikken)
    s2 = spec_of(pe.choropleth(df, locations="k", color="v",
                               basemap_visible=False))
    assert s2["layout"]["geo"]["visible"] is False
```

- [ ] **Step 2: Kjør → FAIL.**

- [ ] **Step 3: Erstatt hele choropleth-funksjonen** i `brython/plotly_express_brython.py` med:

```python
def choropleth(data=None, lat=None, lon=None, locations=None,
               locationmode='country names', geojson=None,
               featureidkey='id', color=None, hover_name=None,
               labels=None, title=None,
               color_continuous_scale='Viridis', range_color=None,
               projection=None, scope=None, center=None, fitbounds=None,
               basemap_visible=True, width=None, height=None,
               config=None, static=None):
    """px.choropleth-subset (ryddet 2026-07-24, spec
    2026-07-24-px-choropleth-cleanup-design.md): landnivåkart via
    plotly.js' innebygde geometri (locationmode) eller medbrakt
    geojson=/featureidkey=. Norske kommune-/fylkeskart: bruk
    folium-shimet (innebygd geometri, lazy-lastet). Avvik fra px:
    colorscale er trace-nivå med plotly.js' NAVNGITTE skalaer
    ('Viridis' default — plotly.js mangler px' 'Plasma');
    locationmode-default er 'country names' (bakoverkompatibelt).
    width/height aksepteres for px-paritet, men CSS styrer størrelsen
    (som resten av shimet)."""
    data = ensure_data_dict(data)
    locations_data = list(data.get(locations, [])) if locations else None
    lat_data = list(data.get(lat, [])) if lat else None
    lon_data = list(data.get(lon, [])) if lon else None
    color_data = list(data.get(color, [])) if color else None
    if color_data:
        color_data = [None if _is_nan(v) else v for v in color_data]
    trace = {
        'type': 'choropleth',
        'locations': locations_data,
        'lat': lat_data,
        'lon': lon_data,
        # geojson-modus: locationmode utelates (plotly.js bruker
        # featureidkey-oppslaget i stedet)
        'locationmode': None if geojson else locationmode,
        'geojson': geojson,
        'featureidkey': featureidkey if geojson else None,
        'z': color_data,
        'colorscale': color_continuous_scale,
        'zmin': range_color[0] if range_color else None,
        'zmax': range_color[1] if range_color else None,
    }
    if hover_name:
        hn = list(data.get(hover_name, []))
        if hn:
            trace['hovertext'] = hn
            trace['hovertemplate'] = '<b>%{hovertext}</b><br>%{z}<extra></extra>'
    if color is not None:
        cb = labels.get(color, color) if isinstance(labels, dict) else color
        trace['colorbar'] = {'title': str(cb)}
    trace = remove_none(trace)
    geo = {}
    if scope:
        geo['scope'] = scope
    if projection:
        geo['projection'] = {'type': projection}
    if center:
        geo['center'] = center
    if fitbounds:
        geo['fitbounds'] = fitbounds
    if not basemap_visible:
        geo['visible'] = False
    layout = {}
    if title:
        layout['title'] = title
    if geo:
        layout['geo'] = geo
    clean_config = remove_none(config or {})
    if resolve_static(static):
        clean_config['staticPlot'] = True
    plot_data = {'type': 'plotly', 'data': [trace], 'layout': layout,
                 'config': clean_config}
    return PlotlyFigure(plot_data)
```

NB: `z` med None-innslag skal OVERLEVE remove_none (den renser kun
dict-nøkler, ikke listeelementer) — nan-testen håndhever det.

- [ ] **Step 4: Kjør hele diff-fila → alle PASS.** **Step 5: Commit.**

---

### Task 2: mpy-port + kryssruntime-paritet

**Files:** Modify `micropython/plotly_express_mpy.py` (choropleth ~1318); append paritetstest i `brython/tests/test_plotly_express_brython_diff.py`.

- [ ] **Step 1: Paritetstest (failing):**

```python
def test_choropleth_brython_mpy_parity():
    import os as _os, sys as _sys
    _sys.path.insert(0, _os.path.join(_os.path.dirname(__file__), '..', '..', 'micropython'))
    import plotly_express_mpy as pemp
    d = {"land": ["NOR", "SWE"], "verdi": [1.0, 2.0]}
    a = spec_of(pe.choropleth(d, locations="land", color="verdi",
                              hover_name="land", scope="europe",
                              labels={"verdi": "Rate"}))
    b = json.loads(pemp.choropleth(d, locations="land", color="verdi",
                                   hover_name="land", scope="europe",
                                   labels={"verdi": "Rate"}).to_plotly_json_str())
    assert a["data"] == b["data"] and a["layout"] == b["layout"]
```

- [ ] **Step 2: Port** — samme funksjonskropp inn i mpy-fila (dialektsjekk: kroppen bruker ingen `**`-literaler/f-strings/re — porterbar som den er; `_is_nan` finnes i mpy-fila fra før — verifiser med grep, ellers samme duck-type-hjelper som brython-fila).

- [ ] **Step 3:** `python3 brython/tests/test_plotly_express_brython_diff.py` + `python3 micropython/tests/test_plotly_express_mpy.py` + `micropython micropython/tests/mpy_smoke_plotly.py` → alle grønne. **Commit.**

---

### Task 3: Eksempler + manifest + versjonsbump

- [ ] `examples/brython/bry31_choropleth.txt`:

```
# label: plotly — choropleth (landnivå)
# Verdenskart/landnivå med plotly express. For norske kommune-/
# fylkeskart: bruk folium-shimet (innebygd geometri).
import pandas_brython as pd
import plotly_express_brython as pe

df = pd.DataFrame({
    "land": ["NOR", "SWE", "DNK", "FIN", "ISL"],
    "navn": ["Norge", "Sverige", "Danmark", "Finland", "Island"],
    "rate": [3.1, 2.5, 2.9, 3.4, 2.2],
})

pe.choropleth(df, locations="land", locationmode="ISO-3",
              color="rate", hover_name="navn", scope="europe",
              labels={"rate": "Rate per 1000"},
              title="Nordiske land")
```

- [ ] `examples/micropython/11_choropleth.txt` — samme med `pandas_mpy`/`plotly_express_mpy`.
- [ ] `python3 examples/generate_manifest.py`; `M2PY_VERSION` → `2026-07-24f`. **Commit.**

---

### Task 3b: `geojson='norge:kommuner'` (spec-tillegget)

**Files:** Modify begge shimenes `choropleth` (norge-grenen + `_zpad`-hjelper), `index.html` (`mdRenderPlotlyFigure` async norge-oppløsning + attribusjon), append tester i diff-fila.

- [ ] **Step 1: Failing tests** (append i diff-fila):

```python
def test_choropleth_norge_marker():
    df = bpd.DataFrame({"kommnr": [301, 1103], "rate": [1.0, 2.0]})
    spec = spec_of(pe.choropleth(df, geojson="norge:kommuner",
                                 locations="kommnr", color="rate"))
    t = spec["data"][0]
    assert t["geojson"] == "norge:kommuner"          # markør urørt til JS
    assert t["locations"] == ["0301", "1103"]        # zero-paddet
    assert t["featureidkey"] == "properties.nummer"  # geometrifilens nøkkel
    assert spec["layout"]["geo"]["fitbounds"] == "locations"
    # fylker: 2-sifret padding; eksplisitt featureidkey vinner
    s2 = spec_of(pe.choropleth(bpd.DataFrame({"f": [3], "v": [1.0]}),
                               geojson="norge:fylker", locations="f",
                               color="v", featureidkey="properties.navn"))
    assert s2["data"][0]["locations"] == ["03"]
    assert s2["data"][0]["featureidkey"] == "properties.navn"
```

- [ ] **Step 2: Python-implementasjon** (begge shimene) — i choropleth, etter locations_data-byggingen:

```python
    # norge-geometri (spec-tillegget 2026-07-24): gjenbruk folium-shimets
    # geojson-filer — JS-siden (mdRenderPlotlyFigure) løser markørstrengen
    # via samme memoiserte fetch. Padding/nøkkel/fitbounds som folium.
    _norge = geojson if geojson in ('norge:kommuner', 'norge:fylker') else None
    if _norge and locations_data:
        _pad = 4 if _norge == 'norge:kommuner' else 2
        locations_data = [_zpad(v, _pad) for v in locations_data]
    if _norge and featureidkey == 'id':
        featureidkey = 'properties.nummer'
    if _norge and fitbounds is None:
        fitbounds = 'locations'
```

med modul-hjelperen (begge filene, uten zfill):

```python
def _zpad(s, n):
    s = str(s)
    while len(s) < n:
        s = '0' + s
    return s
```

- [ ] **Step 3: JS** — `mdRenderPlotlyFigure`: FØR `Plotly.newPlot(...)`-linja, erstatt kallet med:

```js
      var norgeKinds = [];
      data.forEach(function (tr) {
        if (tr && (tr.geojson === 'norge:kommuner' || tr.geojson === 'norge:fylker')
            && norgeKinds.indexOf(tr.geojson) === -1) norgeKinds.push(tr.geojson);
      });
      function doPlot() {
        Plotly.newPlot(div, data, layout, { responsive: true, autosizable: true, staticPlot: staticPlot }).catch(function(){});
      }
      if (norgeKinds.length) {
        Promise.all(norgeKinds.map(__norgeGeoFetch)).then(function (geos) {
          data.forEach(function (tr) {
            var i = tr ? norgeKinds.indexOf(tr.geojson) : -1;
            if (i !== -1) tr.geojson = geos[i];
          });
          // CC BY 4.0-attribusjon når norsk geometri brukes
          layout.annotations = (layout.annotations || []).concat([{
            text: 'Grenser: Kartverket (CC BY 4.0)', showarrow: false,
            xref: 'paper', yref: 'paper', x: 1, y: 0, xanchor: 'right',
            yanchor: 'top', font: { size: 9, color: textColor }
          }]);
          doPlot();
        }).catch(function (e) { console.warn('norge-geojson (plotly):', e); doPlot(); });
      } else {
        doPlot();
      }
```

(`__norgeGeoFetch` er funksjonsdeklarasjon i samme scope — hoistet, delt cache med folium.)

- [ ] **Step 4:** Kjør diff-fila + paritetstesten (utvid paritetstesten med et norge-kall); `M2PY_VERSION` → `2026-07-24g`. Legg en norge-kommune-figur til i bry31/11-eksemplene. **Commit.**

---

### Task 4: Browser-verifisering + finishing

- [ ] Brython + MicroPython: bry31/11-eksemplet — Europa-kart med fem fargede land, colorbar med «Rate per 1000», hover viser landnavn; skjermbilde.
- [ ] Full plotly-suite + øvrige shim-suiter; commit fikser; superpowers:finishing-a-development-branch.

## Self-review

Spec-dekning: signatur/defaults/geo-nøkler/hover/labels/nan (T1), mpy + paritet (T2), eksempler/bump (T3), browser (T4). Konsistens: samme funksjonskropp begge steder, testnavn matcher.
