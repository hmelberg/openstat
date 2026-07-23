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
