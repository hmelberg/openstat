# Folium-shim (`folium_core`) — pure-python Leaflet-kart for alle tre python-modusene (design)

**Status:** APPROVED 2026-07-24 (omfang avklart med Hans: kjerne +
Choropleth, innebygd lazy-lastet norsk kommune-/fylkesgeometri). Andre
leveranse i shim-workstreamen (altair levert 2026-07-24; gjenstår:
interaktive tabeller/Tabulator, lifelines-subset).

## Motivasjon

Kart — særlig kommune-/fylkes-choroplether — er den viktigste
visualiseringen plotly/altair-shimene ikke dekker godt for en norsk
statistikk-app. Folium er (som plotly express) et "python-API →
JS-rendring"-bibliotek: python-siden bygger bare konfigurasjon, Leaflet
tegner. Shimet følger altair-mønsteret: én dialektnøytral kjerne i
`shared/`, tynne fasader, ny embed-type, lazy JS. Én forskjell: det
finnes ingen ferdig deklarativ spec-renderer for Leaflet (à la
vega-embed), så vi definerer et lite JSON-lagformat selv og holder
JS-siden tynn.

## Arkitektur

    brukerkode → Map-objekt (spec-dict) → to_leaflet_json_str()
    → runner _fmt: __micro_transform_start_leafletmap__-embed
    → buildOutputNodes() → mdRenderLeafletMap(div, spec) → Leaflet (L.*)

### Filer

- **`shared/folium_core.py`** — hele shimet. Samme dialektregler som
  `altair_core.py` (filhodet der + `plotly_express_mpy.py`-fellelisten):
  ingen `**` i dict-literaler, ingen str.capitalize/re/setdefault/
  partition, guardet datetime, ingen browser/js-import.
- **`brython/folium_brython.py`** / **`micropython/folium_mpy.py`** —
  fasader med EKSPLISITTE rebind-er (`import folium_core as _core`;
  stjerneimport er tom gjennom micropython-runnerens `_Mod`-proxy —
  browser-funn 2026-07-24, se altair-fasadene).
- **`js/brython-engine.js`** / **`js/micropython-engine.js`** — to
  registry-oppføringer hver: `folium_core` (path-overstyring
  `shared/folium_core.py`) og `folium_brython`/`folium_mpy` med
  `aliases: ['folium']`, `deps: ['folium_core']`,
  `js: [leaflet@1.9.4 (global 'L')]` fra jsdelivr (pinnet; verifiser 200
  ved implementering).
- **`index.html`** —
  1. Statisk `<link>` for leaflet@1.9.4-CSS i head (samme presedens som
     Tabulator-CSS-en på ~linje 590; ~14 kB, cachebar).
  2. `mdRenderLeafletMap(div, spec)` ved siden av mdRenderVegaFigure.
  3. Ny `leafletmap`-case i `buildOutputNodes()` (før vegalite-casen),
     guardet på `typeof L !== 'undefined'`, med parse-feil-placeholder.
  4. Pyodide python-modus: `_show_one`-gren FØR altair-grenen som fanger
     ekte folium (`type(obj).__module__` starter med 'folium' og
     `hasattr(obj, 'get_root')`) og skriver en **`html__`-embed** med
     `obj._repr_html_()` (ekte folium genererer komplett
     iframe-innkapslet HTML — den eksisterende html-embed-stien rendrer
     den; leafletmap-embedden brukes IKKE for ekte folium).
  5. `PYTHON_DS_IMPORTS`: legg til `'folium'`.
  6. `M2PY_VERSION` bumpes ved leveranse.
- **`brython/brython_runner.py`** / **`micropython/micropython_runner.py`**
  — ny `_fmt`-gren FØR vegalite-grenen:
  `hasattr(obj, 'to_leaflet_json_str')` → `leafletmap__`-embed.
- **`static_data/kommuner_2024.geojson`** og
  **`static_data/fylker_2024.geojson`** — forenklet norsk geometri
  (2024-grenser). Mål: kommuner < ~1,5 MB, fylker < ~150 kB. Kilde:
  Kartverket (CC BY 4.0) — attribusjon i filenes `attribution`-felt/
  filhode OG i kartets Leaflet-attribution når lagene brukes.
  Nedlastings-/forenklingsscript sjekkes inn som
  `tools/build_norge_geojson.py` (kjøres manuelt; geojson-filene
  committes). Egenskapsnavn i filene normaliseres til `nummer` (4-sifret
  kommunenr / 2-sifret fylkesnr, streng) og `navn`.

## Spec-format (JSON, python → JS)

```json
{
  "center": [59.91, 10.75] | null,
  "zoom": 5 | null,
  "tiles": "OpenStreetMap" | "CartoDB positron",
  "layers": [
    {"type": "marker", "location": [lat, lon], "popup": "tekst", "tooltip": "tekst"},
    {"type": "circle_marker", "location": [...], "radius": 8, "color": "#3388ff",
     "fill": true, "fill_color": "#3388ff", "fill_opacity": 0.2, "weight": 3,
     "popup": ..., "tooltip": ...},
    {"type": "circle", ... samme + "radius" i meter},
    {"type": "polyline", "locations": [[lat, lon], ...], "color": ..., "weight": ...},
    {"type": "polygon", "locations": [...], ... + fill-opsjoner},
    {"type": "geojson", "data": {...} | null, "url": "..." | null,
     "name": ..., "style": {objekt, ikke callable}, "tooltip_fields": [...]},
    {"type": "choropleth", "geo": "norge:kommuner" | "norge:fylker" | null,
     "url": ... | null, "data": {geojson-dict} | null,
     "key_on": "nummer", "colors": {"0301": "#bd0026", ...},
     "nan_fill_color": "#d9d9d9", "fill_opacity": 0.7, "line_opacity": 0.4,
     "legend": {"title": ..., "bins": [kanter], "colors": [farger]},
     "name": ...},
    {"type": "feature_group", "name": ..., "layers": [underlag]},
    {"type": "layer_control"}
  ]
}
```

- `center`/`zoom` null → JS auto-fitter til lagenes samlede bounds
  (`map.fitBounds`); helt tomt kart → Norge-utsnitt (default center
  [64.5, 12.5], zoom 4).
- `"norge:kommuner"`/`"norge:fylker"` løses i JS som lazy `fetch` av
  static_data-filene (med `M2PY_VERSION`-cachebuster), memoisert per
  sideinnlasting. Kartverket-attribusjon legges til kartet.

## API-flate (v1) — speiler folium

- **`Map(location=None, zoom_start=None, tiles='OpenStreetMap', width=None, height=None)`**
  — `.add_child(obj)` og `obj.add_to(m)` (begge veier, som folium);
  `to_dict()`/`to_leaflet_json_str()`; `__repr__` som altair-shimet.
  Godkjente tiles i v1: `'OpenStreetMap'` og `'CartoDB positron'`
  (andre verdier → ValueError med liste). Høyde/bredde: render-default
  ~500×340 i JS (som plotly/vega-stiene), overstyrbar per kart.
- **`Marker(location, popup=None, tooltip=None)`**,
  **`CircleMarker(location, radius=10, color=None, fill=None,
  fill_color=None, fill_opacity=None, weight=None, popup=, tooltip=)`**,
  **`Circle(...)`** (radius i meter), **`PolyLine(locations, color=,
  weight=, opacity=)`**, **`Polygon(locations, ... + fill-opsjoner)`**.
  Popup/tooltip er tekst i v1 (HTML-objekter er utenfor omfang).
- **`GeoJson(data, name=None, style=None, tooltip_fields=None)`** —
  `data` er dict ELLER url-streng; `style` er en dict med
  Leaflet-stilnøkler (callables utenfor v1 → TypeError med forklaring).
- **`Choropleth(geo_data, data=None, columns=None, key_on='nummer',
  fill_color='YlOrRd', bins=6, nan_fill_color='#d9d9d9',
  fill_opacity=0.7, line_opacity=0.4, legend_name=None, name=None)`** —
  `geo_data`: `'norge:kommuner'`, `'norge:fylker'`, url eller
  geojson-dict. `data` + `columns=[nøkkelkolonne, verdikolonne]` som
  folium (DataFrame duck-typet som altair-shimet, eller dict
  {kode: verdi}). Nøkler normaliseres: tall → zero-paddet streng
  (4 siffer kommune, 2 siffer fylke når geo er norge:*; ellers str()).
  **All farge-/bin-logikk kjører i python**: bins (lineære kanter over
  min–maks; eller eksplisitt liste), innebygde brewer-paletter
  (YlOrRd, YlGnBu, Blues, Greens, Reds, Purples — 3–9 klasser,
  hardkodede hexverdier), per-kode-farge og legend-data i spec-en.
  Manglende koder → nan_fill_color.
- **`FeatureGroup(name)`** (med `.add_child`), **`LayerControl()`**.
- **Utenfor v1** (klare NotImplementedError der det er billig):
  MarkerCluster/plugins, style_function-callables, TopoJSON,
  Popup/IFrame-objekter, andre tiles, `save()`, jinja-ting.

## Testing

1. **`brython/tests/test_folium_core.py`** — CPython-enhetstester:
   spec-form per lagtype, add_to/add_child-ekvivalens, auto-fit-signal
   (center null), kodenormalisering (301→"0301", "03"-fylke),
   bin-kanter/palettoppslag/per-kode-farger, nan-farge, tiles-validering,
   utenfor-omfang-feil.
2. **API-paritetstest** i samme fil, guardet på ekte folium
   (pip --user): `inspect.signature`-sjekk på at våre parameternavn er
   en DELMENGDE av ekte foliums for Map/Marker/CircleMarker/PolyLine/
   GeoJson/Choropleth (folium emitter HTML — byte-diff som altair er
   umulig; pariteten håndheves på API-nivå + browser).
3. **Micropython-røyk** — `micropython/tests/mpy_smoke_folium.py`.
4. **Geometri-sanity** — test (guardet på at filene finnes) som leser
   static_data-geojsonene: featureantall (357 kommuner, 15 fylker),
   `nummer`/`navn`-egenskaper, filstørrelsesgrenser.
5. **Browser-verifisering** (alle tre moduser + tema): markører,
   choropleth med legend over norske kommuner, lazy leaflet-lasting,
   pyodide ekte-folium via html-embed.

## Eksempler & docs

`examples/brython/bry28_folium.txt`, `examples/micropython/08_folium.txt`,
`examples/python/py08_folium.txt` (ekte folium): markørkart +
kommune-choropleth på mock-tall; manifest regenereres.
