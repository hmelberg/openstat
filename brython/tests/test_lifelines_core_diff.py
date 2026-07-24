# Differensialtester mot ekte lifelines (0.30.3):
#   python3 brython/tests/test_lifelines_core_diff.py
import sys, os, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'shared'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import lifelines_core as mll

try:
    import lifelines as rll
    from lifelines.statistics import (logrank_test as r_logrank,
                                      multivariate_logrank_test as r_mv)
    import pandas as rpd
    HAS_LL = True
except ImportError:
    HAS_LL = False

D1 = ([5, 6, 6, 2, 4, 4, 6, 7, 3, 9], [1, 0, 1, 1, 1, 0, 1, 1, 1, 0])
D2 = ([3, 3, 3, 5, 5, 7, 7, 7, 7, 10, 10, 12, 2, 2, 8],
      [1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1])
D3T = [(i * 7) % 19 + 1 for i in range(40)]
D3E = [1 if (i * 5) % 7 != 0 else 0 for i in range(40)]
ALDER = [40 + (i * 13) % 30 for i in range(40)]
BEH = [i % 2 for i in range(40)]


def close(a, b, tol):
    return abs(a - b) < tol


def test_km_exact_all_datasets():
    if not HAS_LL:
        return
    for T, E in (D1, D2, (D3T, D3E)):
        mine = mll.KaplanMeierFitter().fit(T, E)
        real = rll.KaplanMeierFitter().fit(T, E)
        assert mine.timeline == list(real.survival_function_.index)
        rv = list(real.survival_function_['KM_estimate'])
        assert all(close(a, b, 1e-12) for a, b in zip(mine._sf, rv)), (T, mine._sf, rv)
        rlo = list(real.confidence_interval_.iloc[:, 0])
        rhi = list(real.confidence_interval_.iloc[:, 1])
        assert all(close(a, b, 1e-6) for a, b in zip(mine._ci_lower, rlo))
        assert all(close(a, b, 1e-6) for a, b in zip(mine._ci_upper, rhi))
        rmed = real.median_survival_time_
        if math.isinf(rmed):
            assert math.isinf(mine.median_survival_time_)
        else:
            assert close(mine.median_survival_time_, rmed, 1e-9)
        ret = real.event_table
        mrows = mine._rows
        assert [r['at_risk'] for r in mrows] == list(ret['at_risk'])
        assert [r['observed'] for r in mrows] == list(ret['observed'])
        assert [r['censored'] for r in mrows] == list(ret['censored'])


def test_na_exact_all_datasets():
    if not HAS_LL:
        return
    for T, E in (D1, D2, (D3T, D3E)):
        mine = mll.NelsonAalenFitter().fit(T, E)
        real = rll.NelsonAalenFitter().fit(T, E)
        rv = list(real.cumulative_hazard_.iloc[:, 0])
        assert all(close(a, b, 1e-10) for a, b in zip(mine._cumhaz, rv)), (T, mine._cumhaz, rv)
        rlo = list(real.confidence_interval_.iloc[:, 0])
        rhi = list(real.confidence_interval_.iloc[:, 1])
        assert all(close(a, b, 1e-6) for a, b in zip(mine._ci_lower, rlo)), (mine._ci_lower, rlo)
        assert all(close(a, b, 1e-6) for a, b in zip(mine._ci_upper, rhi))


def test_logrank_all_pairs():
    if not HAS_LL:
        return
    pairs = [(D1, D2), (D1, (D3T, D3E)), (D2, (D3T, D3E))]
    for (Ta, Ea), (Tb, Eb) in pairs:
        m = mll.logrank_test(Ta, Tb, Ea, Eb)
        r = r_logrank(Ta, Tb, Ea, Eb)
        assert close(m.test_statistic, r.test_statistic, 1e-8)
        assert close(m.p_value, r.p_value, 1e-8)


def test_multivariate_logrank_three_groups():
    if not HAS_LL:
        return
    T = list(D1[0]) + list(D2[0]) + D3T
    E = list(D1[1]) + list(D2[1]) + D3E
    G = ['a'] * len(D1[0]) + ['b'] * len(D2[0]) + ['c'] * len(D3T)
    m = mll.multivariate_logrank_test(T, G, E)
    r = r_mv(T, G, E)
    assert close(m.test_statistic, r.test_statistic, 1e-8)
    assert close(m.p_value, r.p_value, 1e-8)


def test_cox_d3():
    if not HAS_LL:
        return
    mine = mll.CoxPHFitter().fit({'T': D3T, 'E': D3E, 'alder': ALDER, 'beh': BEH},
                                 'T', 'E')
    real = rll.CoxPHFitter().fit(
        rpd.DataFrame({'T': D3T, 'E': D3E, 'alder': ALDER, 'beh': BEH}), 'T', 'E')
    for c in ('alder', 'beh'):
        assert close(mine.params_[c], real.params_[c], 1e-4), (c, mine.params_[c], real.params_[c])
        assert close(mine.standard_errors_[c], real.standard_errors_[c], 1e-4)
        assert close(mine._pvals[c], float(real.summary.loc[c, 'p']), 1e-4)
    assert close(mine.log_likelihood_, real.log_likelihood_, 1e-4)
    assert close(mine.concordance_index_, real.concordance_index_, 1e-6)


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE LIFELINES-DIFF-TESTER GRØNNE' + ('' if HAS_LL else ' (uten fasit)'))
