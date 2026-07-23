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
