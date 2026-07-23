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
        sig = inspect.signature(real.__init__)
        # ekte folium tar **kwargs mange steder — da er alt gyldig
        if any(p.kind == inspect.Parameter.VAR_KEYWORD
               for p in sig.parameters.values()):
            continue
        my = set(inspect.signature(mine.__init__).parameters) - {'self'}
        theirs = set(sig.parameters)
        extra = my - theirs
        assert not extra, '%s: parametre utenfor folium: %s' % (mine.__name__, extra)


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE FOLIUM-CORE-TESTER GRØNNE')
