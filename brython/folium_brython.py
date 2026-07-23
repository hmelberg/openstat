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
