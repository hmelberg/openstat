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
