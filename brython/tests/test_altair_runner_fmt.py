# _fmt-protokollen: et altair-chart skal bli en vegalite__-embed.
#   python3 brython/tests/test_altair_runner_fmt.py
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import altair_core as alt
import brython_runner


def test_fmt_emits_vegalite_embed():
    chart = alt.Chart({"a": [1]}).mark_point().encode(x="a:Q")
    out = brython_runner._fmt(chart)
    assert out.startswith('__micro_transform_start_vegalite__')
    assert '"mark": {"type": "point"}' in out or '"mark":{"type":"point"}' in out
    assert out.rstrip().endswith('__micro_transform_end__')


def test_fmt_plotly_still_works():
    class Fake:
        def to_plotly_json_str(self):
            return '{}'
    assert 'figure__' in brython_runner._fmt(Fake())


if __name__ == '__main__':
    test_fmt_emits_vegalite_embed(); print('PASS test_fmt_emits_vegalite_embed')
    test_fmt_plotly_still_works(); print('PASS test_fmt_plotly_still_works')
