#   python3 brython/tests/test_tabulator_runner.py
import sys, os, json, io
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'micropython'))
import tabulator_core as tab
import pandas_brython as bpd
import brython_runner
import micropython_runner


def _capture_show(runner, *a, **kw):
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        runner._shared_vars['show'](*a, **kw)
    finally:
        sys.stdout = old
    return buf.getvalue()


def test_fmt_table_object():
    t = tab.table({'v': [1, 2]})
    out = brython_runner._fmt(t)
    assert out.startswith('__micro_transform_start_tabulator__')
    out2 = micropython_runner._fmt(t)
    assert out2.startswith('__micro_transform_start_tabulator__')


def test_show_df_defaults_to_tabulator():
    df = bpd.DataFrame({'aar': [2020, 2021], 'antall': [1, 2]})
    for runner in (brython_runner, micropython_runner):
        out = _capture_show(runner, df)
        assert 'tabulator__' in out, out[:120]
        assert 'tablehtml__' not in out


def test_show_df_format_html_is_old_path():
    df = bpd.DataFrame({'aar': [2020], 'antall': [1]})
    for runner in (brython_runner, micropython_runner):
        out = _capture_show(runner, df, format='html')
        assert 'tablehtml__' in out and 'tabulator__' not in out


def test_show_unknown_format_raises():
    df = bpd.DataFrame({'v': [1]})
    try:
        _capture_show(brython_runner, df, format='pdf')
        assert False
    except ValueError as e:
        assert 'tabulator' in str(e)


def test_show_opts_forwarded():
    df = bpd.DataFrame({'v': [1]})
    out = _capture_show(brython_runner, df, filters=True, title='T')
    payload = out.split('tabulator__\n', 1)[1].rsplit('\n__micro_transform_end__', 1)[0]
    spec = json.loads(payload)
    assert spec['title'] == 'T' and spec['columns'][0]['headerFilter'] == 'input'


def test_show_nontable_objects_unchanged():
    class FakeVega:
        def to_vegalite_json_str(self):
            return '{}'
    out = _capture_show(brython_runner, FakeVega())
    assert 'vegalite__' in out
    out2 = _capture_show(brython_runner, 'hei')
    assert out2.strip() == 'hei'


def test_spec_parity_with_core():
    df = bpd.DataFrame({'aar': [2020, 2021], 'navn': ['a', 'b'],
                        'v': [1.5, None]})
    want = tab.table(df, filters=True, pagination=10, title='X').to_dict()
    for runner in (brython_runner, micropython_runner):
        got = runner._df_tabulator_spec(df, {'filters': True,
                                             'pagination': 10, 'title': 'X'})
        assert got == want, (runner.__name__, got, want)


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE TABULATOR-RUNNER-TESTER GRØNNE')
