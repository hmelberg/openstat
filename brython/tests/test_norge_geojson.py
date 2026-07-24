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


def _first_rings(d):
    for f in d['features']:
        g = f['geometry']
        if g['type'] == 'Polygon':
            yield g['coordinates'][0]
        elif g['type'] == 'MultiPolygon':
            for poly in g['coordinates']:
                yield poly[0]


def test_winding_d3_kompatibel():
    # ytterringer MED klokka (negativ shoelace) — ellers rendrer plotly.js'
    # d3-geo dem invertert (browser-funn 2026-07-24)
    for name in ('kommuner_2024.geojson', 'fylker_2024.geojson'):
        d, _ = _load(name)
        for ring in _first_rings(d):
            a = 0.0
            for i in range(len(ring) - 1):
                a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
            assert a <= 0, name + ': ytterring mot klokka funnet'


def test_fylker():
    d, size = _load('fylker_2024.geojson')
    assert size < 500_000, 'fylker_2024.geojson for stor: %d' % size
    feats = d['features']
    assert len(feats) == 15, len(feats)
    assert all(len(f['properties']['nummer']) == 2 for f in feats)


if __name__ == '__main__':
    for _name, _fn in sorted(globals().items()):
        if _name.startswith('test_'):
            _fn(); print('PASS', _name)
