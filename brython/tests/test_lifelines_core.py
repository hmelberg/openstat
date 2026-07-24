# Enhetstester for shared/lifelines_core.py — kjøres under CPython:
#   python3 brython/tests/test_lifelines_core.py
import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import lifelines_core as ll

T = [5, 6, 6, 2, 4, 4, 6, 7, 3, 9]
E = [1, 0, 1, 1, 1, 0, 1, 1, 1, 0]


def test_norm_ppf():
    assert abs(ll._norm_ppf(0.975) - 1.959963985) < 1e-6
    assert abs(ll._norm_ppf(0.5)) < 1e-12
    assert abs(ll._norm_ppf(0.025) + 1.959963985) < 1e-6


def test_chi2_sf():
    assert abs(ll._chi2_sf(3.841458820694124, 1) - 0.05) < 1e-9
    assert abs(ll._chi2_sf(5.991464547107979, 2) - 0.05) < 1e-9
    assert ll._chi2_sf(0.0, 1) == 1.0


def test_solve_and_inv():
    A = [[4.0, 1.0], [1.0, 3.0]]
    x = ll._solve([row[:] for row in A], [1.0, 2.0])
    assert abs(x[0] - 1.0 / 11) < 1e-12 and abs(x[1] - 7.0 / 11) < 1e-12
    Ainv = ll._inv(A)
    assert abs(Ainv[0][0] - 3.0 / 11) < 1e-12


def test_survival_table():
    rows = ll._survival_table(T, E)
    assert [r['t'] for r in rows] == [0.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 9.0]
    r6 = rows[5]
    assert (r6['removed'], r6['observed'], r6['censored'], r6['at_risk']) == (3, 2, 1, 5)
    assert rows[0]['entrance'] == 10 and rows[0]['at_risk'] == 10


def test_km_fit_values_and_median():
    kmf = ll.KaplanMeierFitter().fit(T, E)
    assert kmf.timeline == [0.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 9.0]
    want = [1.0, 0.9, 0.8, 0.7, 7.0 / 12, 0.35, 0.175, 0.175]
    got = kmf._sf
    assert all(abs(a - b) < 1e-10 for a, b in zip(got, want)), got
    assert kmf.median_survival_time_ == 6.0
    # alle sensurert -> median inf
    kmf2 = ll.KaplanMeierFitter().fit([1, 2, 3], [0, 0, 0])
    assert kmf2.median_survival_time_ == float('inf')


def test_km_ci_exp_greenwood():
    kmf = ll.KaplanMeierFitter().fit(T, E)
    lo, hi = kmf._ci_lower[1], kmf._ci_upper[1]     # t=2
    assert abs(lo - 0.47300927136205023) < 1e-9, lo
    assert abs(hi - 0.9852813933673431) < 1e-9, hi
    assert kmf._ci_lower[0] == 1.0 and kmf._ci_upper[0] == 1.0


def test_km_frames_without_pd():
    ll.configure(pe=None, pd=None)
    ll._pd = None      # eksplisitt: test dict-fallbacken
    kmf = ll.KaplanMeierFitter().fit(T, E, label='grp')
    sf = kmf.survival_function_
    assert isinstance(sf, dict) and sf['timeline'][1] == 2.0 and abs(sf['grp'][1] - 0.9) < 1e-12
    ci = kmf.confidence_interval_
    assert 'grp_lower_0.95' in ci and 'grp_upper_0.95' in ci
    et = kmf.event_table
    assert et['at_risk'][5] == 5 and et['observed'][5] == 2


def test_km_frames_with_pd():
    import pandas_brython as bpd
    ll.configure(pd=bpd)
    try:
        kmf = ll.KaplanMeierFitter().fit(T, E)
        sf = kmf.survival_function_
        cols = list(sf.columns)
        assert cols[0] == 'timeline' and 'KM_estimate' in cols
    finally:
        ll._pd = None


def test_na_tie_corrected():
    naf = ll.NelsonAalenFitter().fit(T, E)
    got = naf._cumhaz
    assert abs(got[1] - 0.1) < 1e-12
    # tie-korreksjonen: H(6)-H(5) = 1/5 + 1/4 (IKKE 2/5)
    assert abs((got[5] - got[4]) - (1.0 / 5 + 1.0 / 4)) < 1e-12
    assert abs(got[7] - 1.4527777778) < 1e-9
    lo, hi = naf._ci_lower[1], naf._ci_upper[1]
    assert abs(lo - 0.014086349409321772) < 1e-9
    assert abs(hi - 0.7099071384231335) < 1e-9


def test_plot_requires_pe():
    ll._pe = None
    kmf = ll.KaplanMeierFitter().fit(T, E)
    try:
        kmf.plot()
        assert False
    except RuntimeError as e:
        assert 'plotly' in str(e)


def test_plot_builds_plotly_figure():
    import plotly_express_brython as pe
    ll.configure(pe=pe)
    try:
        kmf = ll.KaplanMeierFitter().fit(T, E, label='A')
        fig = kmf.plot_survival_function()
        assert hasattr(fig, 'to_plotly_json_str')
        import json
        spec = json.loads(fig.to_plotly_json_str())
        steps = [t for t in spec['data'] if t.get('line', {}).get('shape') == 'hv' and t.get('name')]
        assert len(steps) == 1 and steps[0]['name'] == 'A'
        bands = [t for t in spec['data'] if t.get('fill') == 'tonexty']
        assert len(bands) == 1
        # overlay: ny kurve på samme figur
        kmf2 = ll.KaplanMeierFitter().fit([1, 2, 3, 4], [1, 1, 0, 1], label='B')
        fig2 = kmf2.plot_survival_function(fig=fig)
        spec2 = json.loads(fig2.to_plotly_json_str())
        steps2 = [t for t in spec2['data'] if t.get('line', {}).get('shape') == 'hv' and t.get('name')]
        assert len(steps2) == 2
        assert steps2[0]['line']['color'] != steps2[1]['line']['color']
    finally:
        ll._pe = None


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE LIFELINES-CORE-TESTER GRØNNE')
