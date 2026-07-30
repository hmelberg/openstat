#   python3 -m pytest brython/tests/test_pretty_defaults.py -q
import sys, os, io, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'micropython'))
import pandas_brython as bpd
import brython_runner
import micropython_runner

import pytest

RUNNERS = [brython_runner, micropython_runner]


@pytest.fixture(autouse=True)
def _restore_state():
    saved = []
    for r in RUNNERS:
        saved.append((r, dict(r._shared_vars['show'].defaults), r._pretty[0]))
    yield
    for r, defaults, pretty in saved:
        r._shared_vars['show'].defaults.clear()
        r._shared_vars['show'].defaults.update(defaults)
        r._pretty[0] = pretty


def _df():
    return bpd.DataFrame({'aar': [2020, 2021], 'antall': [1, 2]})


def _capture_show(runner, *a, **kw):
    buf = io.StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        runner._shared_vars['show'](*a, **kw)
    finally:
        sys.stdout = old
    return buf.getvalue()


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_df_default_is_tablehtml(runner):
    out = runner._fmt(_df())
    assert 'tablehtml__' in out and 'tabulator__' not in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_df_defaults_tabulator(runner):
    runner._shared_vars['show'].defaults['dataframe'] = 'tabulator'
    out = runner._fmt(_df())
    assert 'tabulator__' in out and 'tablehtml__' not in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_df_defaults_text(runner):
    runner._shared_vars['show'].defaults['dataframe'] = 'text'
    out = runner._fmt(_df())
    assert 'tablehtml__' not in out and 'tabulator__' not in out
    assert 'aar' in out   # str(df) — shimens __str__


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_df_pretty_off_is_tablehtml_even_with_defaults(runner):
    # pretty av = dagens oppførsel: naken df -> statisk tablehtml, registry hoppes over
    runner._shared_vars['show'].defaults['dataframe'] = 'tabulator'
    runner._set_pretty(False)
    out = runner._fmt(_df())
    assert 'tablehtml__' in out and 'tabulator__' not in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_fmt_defaults_unknown_falls_back_to_html(runner):
    runner._shared_vars['show'].defaults['dataframe'] = 'excel'
    out = runner._fmt(_df())
    assert 'tablehtml__' in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_show_default_follows_defaults_html(runner):
    out = _capture_show(runner, _df())
    assert 'tablehtml__' in out and 'tabulator__' not in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_show_pretty_off_defaults_to_tabulator(runner):
    # dagens kontrakt (spec 2026-07-24) beholdes når pretty er av
    runner._set_pretty(False)
    out = _capture_show(runner, _df())
    assert 'tabulator__' in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_show_format_text(runner):
    out = _capture_show(runner, _df(), format='text')
    assert 'tablehtml__' not in out and 'tabulator__' not in out and 'aar' in out


@pytest.mark.parametrize('runner', RUNNERS)
def test_show_unknown_format_raises(runner):
    with pytest.raises(ValueError) as e:
        _capture_show(runner, _df(), format='pdf')
    assert 'tabulator' in str(e.value)


@pytest.mark.parametrize('runner', RUNNERS)
def test_set_pretty_roundtrip(runner):
    assert runner._pretty[0] is True
    runner._set_pretty(False)
    assert runner._pretty[0] is False
    runner._set_pretty(True)
    assert runner._pretty[0] is True


@pytest.mark.parametrize('runner', RUNNERS)
def test_non_df_to_html_objects_always_html(runner):
    # statsmodels-summary o.l.: to_html uten .columns -> alltid html-embed,
    # registry gjelder kun df-aktige (har .columns)
    class Summarylike:
        def to_html(self):
            return '<table><tr><td>s</td></tr></table>'
    runner._shared_vars['show'].defaults['dataframe'] = 'text'
    out = runner._fmt(Summarylike())
    assert 'tablehtml__' in out
