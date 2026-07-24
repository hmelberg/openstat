# px.choropleth-opprydding i plotly-shimene (design)

**Status:** APPROVED 2026-07-24 (Hans: «rydd. forbedre og teste» —
omfanget fra samtalen: landnivå-varianten skal virke ordentlig; norsk
kommune-geometri holdes UTENFOR — det er folium-shimets jobb).

## Nåsituasjon

`choropleth()` finnes i begge plotly-shimene (brython:1290, mpy:1318)
men er et tidlig utkast: aldri browser-verifisert, ingen eksempler,
hardkodet `title='Choropleth Map'` og `width=800, height=600` (resten
av shimet lar CSS style), alltid-på `projection='mercator'` og
`showland`, kartesiske `xaxis_title/yaxis_title/xaxis_range/yaxis_range`
-argumenter som ikke finnes for geo-plott, `labels` misbrukt som
trace-navn, og ingen hover_name-støtte.

**Fasit-probe (ekte px, 2026-07-24):** signaturen HAR lat/lon (beholdes);
trace = {type: choropleth, locations, z, locationmode, hovertext ved
hover_name}; geo-layout inneholder KUN satte nøkler (scope når angitt,
ingen projection/showland som default); farge går via coloraxis med
Plasma-stops (plotly.js har IKKE 'Plasma' som navngitt skala — vi
beholder trace-nivå `colorscale` med navngitte skalaer og 'Viridis' som
default; dokumentert avvik).

## Endringer (identisk i begge shimene; mpy-porten følger dialektfellene)

Ny signatur — delmengde av ekte px + husets config/static:

```python
def choropleth(data=None, lat=None, lon=None, locations=None,
               locationmode='country names', geojson=None,
               featureidkey='id', color=None, hover_name=None,
               labels=None, title=None,
               color_continuous_scale='Viridis', range_color=None,
               projection=None, scope=None, center=None, fitbounds=None,
               basemap_visible=True, width=None, height=None,
               config=None, static=None):
```

- **Fjernet:** xaxis_title/yaxis_title/xaxis_range/yaxis_range (fantes
  aldri i px for geo; død kode ut).
- **Defaults:** title None (ingen påtvunget «Choropleth Map»); width/
  height None og IKKE i layout (CSS-styring som resten av shimet;
  argumentene aksepteres for px-paritet).
- **Geo-layout kun med satte nøkler:** `scope` når angitt, `projection`
  {'type': ...} når angitt, `center`/`fitbounds` når angitt,
  `basemap_visible=False` → `geo['visible'] = False` (px-semantikken;
  showland-mappingen ut).
- **hover_name:** kolonneoppslag → `hovertext` + hovertemplate
  `'<b>%{hovertext}</b><br>%{z}<extra></extra>'` (husets
  _hover_fields-stil).
- **labels:** px-semantikk der den er billig: `labels.get(color, color)`
  → colorbar-tittel (`trace.colorbar.title`); ikke lenger trace-navn.
- **z-verdier nan-trygge:** color-kolonnen vaskes med `_is_nan` → None.

## Testing

1. **Diff-tester** i `brython/tests/test_plotly_express_brython_diff.py`
   (eksisterende fil, samme normaliserte stil): locations/z/locationmode/
   hovertext mot ekte px; geojson+featureidkey-passthrough; at geo-layout
   IKKE inneholder projection/showland uten at de er satt; at layout
   mangler width/height.
2. **mpy-paritet:** `test_plotly_express_mpy.py`-tillegg (kjøres under
   CPython) som sammenligner brython- og mpy-variantens spec for samme
   input (to_plotly_json_str-JSON likhet).
3. **Eksempler:** `examples/brython/bry31_choropleth.txt` +
   `examples/micropython/11_choropleth.txt` (nordiske land, ISO-3,
   scope='europe', hover_name) + manifest.
4. **Browser:** begge modusene — kartet rendres med fargeskala og
   hover; `M2PY_VERSION` bumpes (runtime-fetchede .py-filer endres).

## Utenfor omfang

Norsk kommune-/fylkesgeometri (folium-shimet), scatter_geo,
choropleth_map/mapbox (tile-baserte), facetter/animasjon på choropleth,
coloraxis-migrering.
