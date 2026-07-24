# Lifelines Shim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pure-python survival analysis (`shared/lifelines_core.py`) — KaplanMeierFitter, NelsonAalenFitter, logrank tests, CoxPHFitter (Efron) — for brython/micropython, with plots reusing the plotly shim and tables the pandas shim via `configure()` injection.

**Architecture:** One dialect-neutral core; facades inject runtime plotly/pandas shims (`configure(pe=, pd=)`, ui_core precedent) and rebind names explicitly. No new embed type, no JS, no index.html changes. Fidelity enforced differentially against real lifelines 0.30.3 (pip-installed locally).

**Tech Stack:** Python only. Numerics implemented in-core: Acklam inverse normal, regularized incomplete gamma (chi² sf), Gauss elimination, Efron Newton–Raphson.

**Spec:** `docs/superpowers/specs/2026-07-24-lifelines-shim-design.md`.

**Ground truth probed 2026-07-24 (lifelines 0.30.3)** on T=[5,6,6,2,4,4,6,7,3,9], E=[1,0,1,1,1,0,1,1,1,0]:
- SF index [0,2,3,4,5,6,7,9]; values [1, .9, .8, .7, .5833333333, .35, .175, .175]; CI cols `KM_estimate_lower_0.95`; CI(t=2) = [0.47300927136205023, 0.9852813933673431]; median 6.0.
- event_table rows (removed, observed, censored, entrance, at_risk): t0=(0,0,0,10,10), t2=(1,1,0,0,10), t3=(1,1,0,0,9), t4=(2,1,1,0,8), t5=(1,1,0,0,6), t6=(3,2,1,0,5), t7=(1,1,0,0,2), t9=(1,0,1,0,1).
- **NA uses tie-corrected increments**: H(6)−H(5) = 1/5+1/4 = 0.45 (NOT 2/5); H = [0, .1, .2111111111, .3361111111, .5027777778, .9527777778, 1.4527777778, 1.4527777778]. NA CI(t=2) = [0.014086349409321772, 0.7099071384231335] ⇒ variance increment 1/n² per event-slot (Σ_j 1/(n−j)² form; verify against tied dataset in diff test — if the tied case mismatches, switch variance increments to d/n² and rerun).
- logrank vs T2=[1,4,4,5,8,9], E2=[1,1,0,1,1,1]: statistic 0.02639709685012403, p 0.8709343067602499 (identical for 2-group multivariate).
- Cox on the combined 16-row dataset with alder/gruppe (see Task 4): params {alder: −0.038762591012489175, gruppe: −0.9536282188095797}, se {alder: 0.06316212139335002, gruppe: 1.0009401196742758}, ll −21.72683500060126, concordance 0.7553191489361702.

## Global Constraints

- `shared/lifelines_core.py` dialect-neutral (trap list: `micropython/plotly_express_mpy.py` header): no `**` in dict literals, no capitalize/re/setdefault/partition/zfill, guarded imports of `math.lgamma`/`math.erfc` behavior differences, no runtime-module imports — `configure(pe=None, pd=None)` injection only.
- Facades: explicit rebinds, never star-import (`_Mod`-proxy trap).
- Real lifelines is the oracle; where an exact-match rule is ambiguous (NA variance, concordance ties) the plan states the adjustment rule inline — fix the CORE to match the oracle, never loosen a tolerance beyond what the task states.
- Norwegian comments; commit per task; `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Numerics + survival table + KaplanMeierFitter + NelsonAalenFitter

**Files:**
- Create: `shared/lifelines_core.py`
- Create: `brython/tests/test_lifelines_core.py`

**Interfaces:**
- Produces: `configure(pe=None, pd=None)`, `_norm_ppf(p)`, `_chi2_sf(x, df)`, `_as_list(x)`, `_survival_table(durations, events) -> list[dict]` (keys t/removed/observed/censored/entrance/at_risk), `_solve(A, b)`, `_inv(A)`, `class KaplanMeierFitter` (fit, survival_function_, confidence_interval_, median_survival_time_, event_table, timeline, plot, plot_survival_function), `class NelsonAalenFitter` (fit, cumulative_hazard_, confidence_interval_, plot). Frames: pandas-shim DataFrame with `timeline` as FIRST column (pandas-shim has no index support — documented divergence), or plain dict when `pd` is unconfigured.

- [ ] **Step 1: Write failing tests** — create `brython/tests/test_lifelines_core.py`:

```python
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
    want = [0.0, 0.1, 0.1 + 1.0 / 9, None, None, None, None, None]
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
        steps = [t for t in spec['data'] if t.get('line', {}).get('shape') == 'hv']
        assert len(steps) == 1 and steps[0]['name'] == 'A'
        bands = [t for t in spec['data'] if t.get('fill') == 'tonexty']
        assert len(bands) == 1
        # overlay: ny kurve på samme figur
        kmf2 = ll.KaplanMeierFitter().fit([1, 2, 3, 4], [1, 1, 0, 1], label='B')
        fig2 = kmf2.plot_survival_function(fig=fig)
        spec2 = json.loads(fig2.to_plotly_json_str())
        steps2 = [t for t in spec2['data'] if t.get('line', {}).get('shape') == 'hv']
        assert len(steps2) == 2
        assert steps2[0]['line']['color'] != steps2[1]['line']['color']
    finally:
        ll._pe = None


if __name__ == '__main__':
    for name, fn in sorted(globals().items()):
        if name.startswith('test_'):
            fn(); print('PASS', name)
    print('ALLE LIFELINES-CORE-TESTER GRØNNE')
```

- [ ] **Step 2: Run to verify failure** — `python3 brython/tests/test_lifelines_core.py` → ModuleNotFoundError.

- [ ] **Step 3: Implement** — create `shared/lifelines_core.py`:

```python
"""lifelines_core — ren-python overlevelsesanalyse (lifelines-API-subset)
for brython/micropython/CPython (spec 2026-07-24-lifelines-shim-design.md).
Dialektregler som altair_core/folium_core. INGEN runtime-imports her:
plotly-/pandas-shimene injiseres av fasadene via configure(pe=, pd=) —
ui_core-presedensen (sen binding). Fasit: ekte lifelines 0.30.3
(brython/tests/test_lifelines_core_diff.py).
Kjent avvik fra lifelines: shim-DataFrames har 'timeline' som FØRSTE
KOLONNE i stedet for som indeks (pandas-shimet mangler ekte indeks)."""

import math

_pe = None
_pd = None


def configure(pe=None, pd=None):
    """Fasadene kaller denne ved import (plotly-/pandas-shim-injeksjon)."""
    global _pe, _pd
    if pe is not None:
        _pe = pe
    if pd is not None:
        _pd = pd


def _as_list(x):
    if isinstance(x, (list, tuple)):
        return list(x)
    v = getattr(x, 'values', None)
    if v is not None and not callable(v):
        return list(v)
    return list(x)


# ---- numerikk -----------------------------------------------------------

def _norm_ppf(p):
    """Acklams inverse normal-CDF (maks relativ feil ~1.15e-9)."""
    if p <= 0.0 or p >= 1.0:
        raise ValueError('p må ligge i (0, 1)')
    a = (-3.969683028665376e+01, 2.209460984245205e+02,
         -2.759285104469687e+02, 1.383577518672690e+02,
         -3.066479806614716e+01, 2.506628277459239e+00)
    b = (-5.447609879822406e+01, 1.615858368580409e+02,
         -1.556989798598866e+02, 6.680131188771972e+01,
         -1.328068155288572e+01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01,
         -2.400758277161838e+00, -2.549732539343734e+00,
         4.374664141464968e+00, 2.938163982698783e+00)
    d = (7.784695709041462e-03, 3.224671290700398e-01,
         2.445134137142996e+00, 3.754408661907416e+00)
    plow = 0.02425
    if p < plow:
        q = math.sqrt(-2.0 * math.log(p))
        return ((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
                / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0))
    if p > 1.0 - plow:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        return -((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
                 / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0))
    q = p - 0.5
    r = q * q
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
            / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0))


_LANCZOS = (676.5203681218851, -1259.1392167224028, 771.32342877765313,
            -176.61502916214059, 12.507343278686905, -0.13857109526572012,
            9.9843695780195716e-6, 1.5056327351493116e-7)


def _lgamma(x):
    try:
        return math.lgamma(x)
    except AttributeError:
        # Lanczos-fallback (g=7) — MicroPython-bygg uten lgamma
        if x < 0.5:
            return (math.log(math.pi / math.sin(math.pi * x)) - _lgamma(1.0 - x))
        x -= 1.0
        s = 0.99999999999980993
        for i in range(8):
            s += _LANCZOS[i] / (x + i + 1)
        t = x + 7.5
        return 0.5 * math.log(2 * math.pi) + (x + 0.5) * math.log(t) - t + math.log(s)


def _chi2_sf(x, df):
    """P(X > x) for chi² med df frihetsgrader — regularisert øvre
    ufullstendig gamma Q(df/2, x/2): serie for små x, Lentz-kjedebrøk
    ellers (Numerical Recipes gser/gcf)."""
    if x <= 0.0:
        return 1.0
    a = df / 2.0
    xx = x / 2.0
    if xx < a + 1.0:
        # serien gir P; returner 1-P
        ap = a
        s = 1.0 / a
        delta = s
        for _ in range(500):
            ap += 1.0
            delta *= xx / ap
            s += delta
            if abs(delta) < abs(s) * 1e-15:
                break
        p = s * math.exp(-xx + a * math.log(xx) - _lgamma(a))
        return max(0.0, min(1.0, 1.0 - p))
    # kjedebrøk for Q
    tiny = 1e-300
    b = xx + 1.0 - a
    c = 1.0 / tiny
    d = 1.0 / b
    h = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2.0
        d = an * d + b
        if abs(d) < tiny:
            d = tiny
        c = b + an / c
        if abs(c) < tiny:
            c = tiny
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < 1e-15:
            break
    q = math.exp(-xx + a * math.log(xx) - _lgamma(a)) * h
    return max(0.0, min(1.0, q))


def _solve(A, b):
    """Gauss-eliminasjon med partiell pivotering. Muterer kopier."""
    n = len(b)
    M = [list(A[i]) + [b[i]] for i in range(n)]
    for col in range(n):
        piv = col
        for r in range(col + 1, n):
            if abs(M[r][col]) > abs(M[piv][col]):
                piv = r
        if abs(M[piv][col]) < 1e-300:
            raise ValueError('Singulær matrise')
        M[col], M[piv] = M[piv], M[col]
        pv = M[col][col]
        for r in range(col + 1, n):
            f = M[r][col] / pv
            if f != 0.0:
                for k in range(col, n + 1):
                    M[r][k] -= f * M[col][k]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = M[r][n]
        for k in range(r + 1, n):
            s -= M[r][k] * x[k]
        x[r] = s / M[r][r]
    return x


def _inv(A):
    n = len(A)
    cols = []
    for j in range(n):
        e = [1.0 if i == j else 0.0 for i in range(n)]
        cols.append(_solve(A, e))
    # kolonnene tilbake til radform
    return [[cols[j][i] for j in range(n)] for i in range(n)]


# ---- felles tabell ------------------------------------------------------

def _survival_table(durations, events):
    """Rader per unikt tidspunkt (med t=0-entrance-raden, som lifelines):
    {'t','removed','observed','censored','entrance','at_risk'}."""
    T = [float(t) for t in _as_list(durations)]
    if events is None:
        E = [1] * len(T)
    else:
        E = [1 if e else 0 for e in _as_list(events)]
    if len(T) != len(E):
        raise ValueError('durations og event_observed har ulik lengde')
    agg = {}
    for t, e in zip(T, E):
        if t not in agg:
            agg[t] = [0, 0]
        if e:
            agg[t][0] += 1
        else:
            agg[t][1] += 1
    times = sorted(agg.keys())
    n = len(T)
    rows = []
    if not times or times[0] != 0.0:
        rows.append({'t': 0.0, 'removed': 0, 'observed': 0, 'censored': 0,
                     'entrance': n, 'at_risk': n})
    at_risk = n
    for t in times:
        obs = agg[t][0]
        cen = agg[t][1]
        rows.append({'t': t, 'removed': obs + cen, 'observed': obs,
                     'censored': cen, 'entrance': n if t == 0.0 else 0,
                     'at_risk': at_risk})
        at_risk -= obs + cen
    return rows


def _frame(cols, names):
    """{'timeline': [...], kol: [...]} -> pandas-shim-DataFrame hvis
    konfigurert, ellers dict-en selv. `names` gir kolonnerekkefølgen."""
    if _pd is None:
        return cols
    data = {}
    for nm in names:
        data[nm] = cols[nm]
    return _pd.DataFrame(data)


# ---- fitters ------------------------------------------------------------

class _UnivariateFitter:
    def __init__(self, alpha=0.05):
        self.alpha = alpha
        self.timeline = []
        self._label = None

    def _fit_table(self, durations, event_observed, label, default_label):
        self._label = label if label is not None else default_label
        self._rows = _survival_table(durations, event_observed)
        self.timeline = [r['t'] for r in self._rows]
        return self._rows

    def _plot(self, values, lower, upper, ci_show, fig, ytitle):
        if _pe is None:
            raise RuntimeError('plot krever konfigurert plotly-shim '
                               '(configure(pe=...); fasadene gjør dette)')
        palette = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728',
                   '#9467bd', '#8c564b']
        if fig is None:
            fig = _pe.PlotlyFigure({'data': [], 'layout': {
                'xaxis': {'title': 'timeline'},
                'yaxis': {'title': ytitle},
                'legend': {'orientation': 'h'}}})
        existing = 0
        for tr in fig.data:
            if tr.get('line', {}).get('shape') == 'hv':
                existing += 1
        color = palette[existing % len(palette)]
        h = color.lstrip('#')
        rgba = ('rgba(' + str(int(h[0:2], 16)) + ',' + str(int(h[2:4], 16))
                + ',' + str(int(h[4:6], 16)) + ',0.18)')
        if ci_show:
            fig.add_trace({'x': list(self.timeline), 'y': list(lower),
                           'mode': 'lines', 'line': {'shape': 'hv', 'width': 0},
                           'hoverinfo': 'skip', 'showlegend': False})
            fig.add_trace({'x': list(self.timeline), 'y': list(upper),
                           'mode': 'lines', 'line': {'shape': 'hv', 'width': 0},
                           'fill': 'tonexty', 'fillcolor': rgba,
                           'hoverinfo': 'skip', 'showlegend': False})
        fig.add_trace({'x': list(self.timeline), 'y': list(values),
                       'mode': 'lines',
                       'line': {'shape': 'hv', 'color': color},
                       'name': self._label})
        return fig

    @property
    def event_table(self):
        cols = {'timeline': self.timeline}
        for key in ('removed', 'observed', 'censored', 'entrance', 'at_risk'):
            cols[key] = [r[key] for r in self._rows]
        return _frame(cols, ['timeline', 'removed', 'observed', 'censored',
                             'entrance', 'at_risk'])


class KaplanMeierFitter(_UnivariateFitter):
    def fit(self, durations, event_observed=None, label=None, alpha=None):
        if alpha is not None:
            self.alpha = alpha
        rows = self._fit_table(durations, event_observed, label, 'KM_estimate')
        z = _norm_ppf(1.0 - self.alpha / 2.0)
        s = 1.0
        varsum = 0.0
        self._sf = []
        self._ci_lower = []
        self._ci_upper = []
        for r in rows:
            n_i = r['at_risk']
            d_i = r['observed']
            if d_i > 0 and n_i > 0:
                s *= (n_i - d_i) / float(n_i)
                if n_i > d_i:
                    varsum += d_i / float(n_i * (n_i - d_i))
            self._sf.append(s)
            # eksponentiell Greenwood (lifelines' default) på log(-log)-skala
            if s <= 0.0 or s >= 1.0 or varsum <= 0.0:
                self._ci_lower.append(1.0 if s >= 1.0 else 0.0)
                self._ci_upper.append(1.0 if s >= 1.0 else 0.0)
            else:
                lns = math.log(s)
                v = varsum / (lns * lns)
                sq = z * math.sqrt(v)
                self._ci_lower.append(s ** math.exp(sq))
                self._ci_upper.append(s ** math.exp(-sq))
        return self

    @property
    def survival_function_(self):
        cols = {'timeline': self.timeline}
        cols[self._label] = list(self._sf)
        return _frame(cols, ['timeline', self._label])

    @property
    def confidence_interval_(self):
        lo = self._label + '_lower_' + _fmt_alpha(self.alpha)
        hi = self._label + '_upper_' + _fmt_alpha(self.alpha)
        cols = {'timeline': self.timeline}
        cols[lo] = list(self._ci_lower)
        cols[hi] = list(self._ci_upper)
        return _frame(cols, ['timeline', lo, hi])

    @property
    def median_survival_time_(self):
        for t, s in zip(self.timeline, self._sf):
            if s <= 0.5:
                return t
        return float('inf')

    def plot_survival_function(self, ci_show=True, fig=None):
        return self._plot(self._sf, self._ci_lower, self._ci_upper,
                          ci_show, fig, 'S(t)')

    def plot(self, ci_show=True, fig=None):
        return self.plot_survival_function(ci_show=ci_show, fig=fig)


def _fmt_alpha(alpha):
    """0.05 -> '0.95' (lifelines' kolonnenavnkonvensjon)."""
    conf = 1.0 - alpha
    s = ('%f' % conf).rstrip('0')
    if s.endswith('.'):
        s += '0'
    return s


class NelsonAalenFitter(_UnivariateFitter):
    def fit(self, durations, event_observed=None, label=None, alpha=None):
        if alpha is not None:
            self.alpha = alpha
        rows = self._fit_table(durations, event_observed, label, 'NA_estimate')
        z = _norm_ppf(1.0 - self.alpha / 2.0)
        h = 0.0
        var = 0.0
        self._cumhaz = []
        self._ci_lower = []
        self._ci_upper = []
        for r in rows:
            n_i = r['at_risk']
            d_i = r['observed']
            # tie-korrigerte inkrementer (lifelines): sum_j 1/(n-j), j<d
            for j in range(d_i):
                if n_i - j > 0:
                    h += 1.0 / (n_i - j)
                    var += 1.0 / ((n_i - j) * (n_i - j))
            self._cumhaz.append(h)
            if h <= 0.0 or var <= 0.0:
                self._ci_lower.append(0.0)
                self._ci_upper.append(0.0)
            else:
                # log-normal KI: H * exp(±z*sqrt(var)/H)
                f = z * math.sqrt(var) / h
                self._ci_lower.append(h * math.exp(-f))
                self._ci_upper.append(h * math.exp(f))
        return self

    @property
    def cumulative_hazard_(self):
        cols = {'timeline': self.timeline}
        cols[self._label] = list(self._cumhaz)
        return _frame(cols, ['timeline', self._label])

    @property
    def confidence_interval_(self):
        lo = self._label + '_lower_' + _fmt_alpha(self.alpha)
        hi = self._label + '_upper_' + _fmt_alpha(self.alpha)
        cols = {'timeline': self.timeline}
        cols[lo] = list(self._ci_lower)
        cols[hi] = list(self._ci_upper)
        return _frame(cols, ['timeline', lo, hi])

    def plot(self, ci_show=True, fig=None):
        return self._plot(self._cumhaz, self._ci_lower, self._ci_upper,
                          ci_show, fig, 'H(t)')
```

- [ ] **Step 4: Run** — `python3 brython/tests/test_lifelines_core.py` → all PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/lifelines_core.py brython/tests/test_lifelines_core.py
git commit -m "feat(lifelines): kjerne del 1 — numerikk, KM, Nelson-Aalen"
```

---

### Task 2: logrank_test + multivariate_logrank_test + StatisticalResult

**Files:**
- Modify: `shared/lifelines_core.py` (append)
- Modify: `brython/tests/test_lifelines_core.py` (append)

**Interfaces:**
- Consumes: `_survival_table`, `_chi2_sf`, `_solve`, `_as_list`.
- Produces: `class StatisticalResult` (`test_statistic`, `p_value`, `degrees_of_freedom`, `print_summary()`, `__repr__`), `logrank_test(durations_A, durations_B, event_observed_A=None, event_observed_B=None)`, `multivariate_logrank_test(event_durations, groups, event_observed=None)`.

- [ ] **Step 1: Append failing tests** (values = probed ground truth):

```python
TA = [5, 6, 6, 2, 4, 4, 6, 7, 3, 9]
EA = [1, 0, 1, 1, 1, 0, 1, 1, 1, 0]
TB = [1, 4, 4, 5, 8, 9]
EB = [1, 1, 0, 1, 1, 1]


def test_logrank_matches_probe():
    r = ll.logrank_test(TA, TB, EA, EB)
    assert abs(r.test_statistic - 0.02639709685012403) < 1e-10, r.test_statistic
    assert abs(r.p_value - 0.8709343067602499) < 1e-10, r.p_value
    assert r.degrees_of_freedom == 1
    assert 'p' in repr(r)


def test_multivariate_logrank_two_groups_equals_logrank():
    mr = ll.multivariate_logrank_test(TA + TB, ['a'] * 10 + ['b'] * 6, EA + EB)
    assert abs(mr.test_statistic - 0.02639709685012403) < 1e-10
    assert abs(mr.p_value - 0.8709343067602499) < 1e-10


def test_multivariate_logrank_three_groups():
    T3 = TA + TB + [2, 3, 5, 7, 11]
    G3 = ['a'] * 10 + ['b'] * 6 + ['c'] * 5
    E3 = EA + EB + [1, 1, 0, 1, 1]
    mr = ll.multivariate_logrank_test(T3, G3, E3)
    assert mr.degrees_of_freedom == 2
    assert 0.0 <= mr.p_value <= 1.0 and mr.test_statistic >= 0.0
```

- [ ] **Step 2: Verify fail, Step 3: implement** — append to core:

```python
class StatisticalResult:
    def __init__(self, test_statistic, p_value, degrees_of_freedom, test_name):
        self.test_statistic = test_statistic
        self.p_value = p_value
        self.degrees_of_freedom = degrees_of_freedom
        self.test_name = test_name

    def print_summary(self):
        print(self.test_name)
        print('t_0 = -1, df = ' + str(self.degrees_of_freedom))
        print('test_statistic = %.6f, p = %.6f' % (self.test_statistic, self.p_value))

    def __repr__(self):
        return ('<StatisticalResult: ' + self.test_name
                + ' | test_statistic=%.6f, p=%.6f>' % (self.test_statistic, self.p_value))


def multivariate_logrank_test(event_durations, groups, event_observed=None):
    T = [float(t) for t in _as_list(event_durations)]
    G = _as_list(groups)
    E = ([1] * len(T) if event_observed is None
         else [1 if e else 0 for e in _as_list(event_observed)])
    labels = []
    for g in G:
        if g not in labels:
            labels.append(g)
    labels = sorted(labels, key=lambda v: str(v))
    k = len(labels)
    if k < 2:
        raise ValueError('logrank krever minst to grupper')
    gidx = [labels.index(g) for g in G]
    times = sorted({t for t, e in zip(T, E) if e})
    O = [0.0] * k
    Ex = [0.0] * k
    V = [[0.0] * k for _ in range(k)]
    for t in times:
        n_at = [0] * k
        d_at = [0] * k
        for i in range(len(T)):
            if T[i] >= t:
                n_at[gidx[i]] += 1
                if T[i] == t and E[i]:
                    d_at[gidx[i]] += 1
        n = sum(n_at)
        d = sum(d_at)
        if n < 1 or d == 0:
            continue
        for j in range(k):
            O[j] += d_at[j]
            Ex[j] += d * n_at[j] / float(n)
        if n > 1:
            f = d * (n - d) / float(n - 1)
            for a in range(k):
                for b in range(k):
                    if a == b:
                        V[a][b] += f * (n_at[a] / float(n)) * (1.0 - n_at[a] / float(n))
                    else:
                        V[a][b] += -f * n_at[a] * n_at[b] / float(n * n)
    z = [O[j] - Ex[j] for j in range(k - 1)]
    Vsub = [[V[a][b] for b in range(k - 1)] for a in range(k - 1)]
    sol = _solve(Vsub, z)
    stat = sum(z[i] * sol[i] for i in range(k - 1))
    p = _chi2_sf(stat, k - 1)
    return StatisticalResult(stat, p, k - 1, 'multivariate_logrank_test')


def logrank_test(durations_A, durations_B, event_observed_A=None,
                 event_observed_B=None):
    TA = _as_list(durations_A)
    TB = _as_list(durations_B)
    EA = ([1] * len(TA) if event_observed_A is None else _as_list(event_observed_A))
    EB = ([1] * len(TB) if event_observed_B is None else _as_list(event_observed_B))
    r = multivariate_logrank_test(list(TA) + list(TB),
                                  ['A'] * len(TA) + ['B'] * len(TB),
                                  list(EA) + list(EB))
    return StatisticalResult(r.test_statistic, r.p_value, 1, 'logrank_test')
```

- [ ] **Step 4: Run** — all PASS. **Step 5: Commit** `feat(lifelines): logrank + multivariat logrank`.

---

### Task 3: CoxPHFitter (Efron, Newton–Raphson)

**Files:**
- Modify: `shared/lifelines_core.py` (append)
- Modify: `brython/tests/test_lifelines_core.py` (append)

**Interfaces:**
- Consumes: `_solve`, `_inv`, `_norm_ppf`, `_chi2_sf`, `_as_list`, `_frame`, `configure`-globals.
- Produces: `class CoxPHFitter` — `fit(df, duration_col, event_col)` (df: pandas-shim-DataFrame eller dict av lister), `params_` (dict kol→β), `hazard_ratios_`, `standard_errors_`, `confidence_intervals_` (dict kol→[lo, hi]), `summary` (frame), `print_summary()`, `log_likelihood_`, `concordance_index_`.

- [ ] **Step 1: Append failing tests** (ground-truth values from the probe):

```python
COX_T = TA + TB
COX_E = EA + EB
COX_ALDER = [50, 61, 58, 45, 52, 66, 71, 49, 55, 63, 42, 60, 58, 67, 53, 70]
COX_GRUPPE = [0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0, 0, 1]


def test_cox_matches_probe():
    cph = ll.CoxPHFitter().fit({'T': COX_T, 'E': COX_E,
                                'alder': COX_ALDER, 'gruppe': COX_GRUPPE},
                               'T', 'E')
    assert abs(cph.params_['alder'] - (-0.038762591012489175)) < 1e-6, cph.params_
    assert abs(cph.params_['gruppe'] - (-0.9536282188095797)) < 1e-6
    assert abs(cph.standard_errors_['alder'] - 0.06316212139335002) < 1e-6
    assert abs(cph.standard_errors_['gruppe'] - 1.0009401196742758) < 1e-6
    assert abs(cph.log_likelihood_ - (-21.72683500060126)) < 1e-6
    assert abs(cph.concordance_index_ - 0.7553191489361702) < 1e-9
    hr = cph.hazard_ratios_
    assert abs(hr['gruppe'] - math.exp(-0.9536282188095797)) < 1e-6
    ci = cph.confidence_intervals_
    lo, hi = ci['alder']
    z = 1.959963984540054
    assert abs(lo - (-0.038762591012489175 - z * 0.06316212139335002)) < 1e-6
    assert abs(hi - (-0.038762591012489175 + z * 0.06316212139335002)) < 1e-6


def test_cox_summary_and_print():
    cph = ll.CoxPHFitter().fit({'T': COX_T, 'E': COX_E, 'alder': COX_ALDER},
                               'T', 'E')
    s = cph.summary
    assert 'coef' in s and 'exp(coef)' in s and 'p' in s
    import io, sys as _s
    buf = io.StringIO()
    old = _s.stdout
    _s.stdout = buf
    try:
        cph.print_summary()
    finally:
        _s.stdout = old
    out = buf.getvalue()
    assert 'alder' in out and 'concordance' in out


def test_cox_nonnumeric_raises():
    try:
        ll.CoxPHFitter().fit({'T': [1, 2], 'E': [1, 1], 'g': ['a', 'b']}, 'T', 'E')
        assert False
    except ValueError as e:
        assert 'dummy' in str(e) or 'numerisk' in str(e)


def test_cox_out_of_scope():
    try:
        ll.CoxPHFitter().fit({'T': [1], 'E': [1]}, 'T', 'E', formula='x')
        assert False
    except (NotImplementedError, TypeError):
        pass
```

- [ ] **Step 2: Verify fail, Step 3: implement** — append:

```python
def _df_to_columns(df):
    """DataFrame-shim (.columns + .to_dict()) ELLER dict av lister ->
    (kolonnenavn i rekkefølge, {navn: liste})."""
    if hasattr(df, 'columns') and hasattr(df, 'to_dict'):
        cols = list(df.columns)
        raw = df.to_dict()
        return cols, {c: list(raw[c]) for c in cols}
    if isinstance(df, dict):
        cols = list(df.keys())
        return cols, {c: list(df[c]) for c in cols}
    raise ValueError('CoxPHFitter.fit: forventer DataFrame eller dict av lister')


class CoxPHFitter:
    def __init__(self, alpha=0.05):
        self.alpha = alpha

    def fit(self, df, duration_col=None, event_col=None, **kwargs):
        for kw in kwargs:
            raise NotImplementedError('CoxPHFitter.fit(' + kw + '=...) er '
                                      'utenfor v1 (formula/strata/vekter støttes ikke)')
        if duration_col is None or event_col is None:
            raise ValueError('duration_col og event_col må oppgis')
        cols, data = _df_to_columns(df)
        covs = [c for c in cols if c != duration_col and c != event_col]
        T = [float(t) for t in data[duration_col]]
        E = [1 if e else 0 for e in data[event_col]]
        n = len(T)
        p = len(covs)
        X = []
        for i in range(n):
            row = []
            for c in covs:
                v = data[c][i]
                if isinstance(v, bool):
                    v = 1 if v else 0
                if not isinstance(v, (int, float)):
                    raise ValueError('Kovariaten «' + str(c) + '» er ikke '
                                     'numerisk — dummy-kod kategoriske '
                                     'kolonner først (f.eks. 0/1)')
                row.append(float(v))
            X.append(row)
        # mean-sentrering for numerisk stabilitet (Cox er lokasjonsinvariant)
        means = [sum(X[i][k] for i in range(n)) / n for k in range(p)]
        Xc = [[X[i][k] - means[k] for k in range(p)] for i in range(n)]
        beta = [0.0] * p
        ll_old = self._loglik(Xc, T, E, beta)
        for _ in range(50):
            grad, info = self._grad_info(Xc, T, E, beta)
            try:
                step = _solve(info, grad)
            except ValueError:
                raise RuntimeError('Cox-modellen konvergerer ikke '
                                   '(singulær informasjonsmatrise) — sjekk '
                                   'kollinearitet/separasjon i kovariatene')
            # step-halving til log-likelihood ikke faller
            factor = 1.0
            for _h in range(30):
                cand = [beta[k] + factor * step[k] for k in range(p)]
                ll_new = self._loglik(Xc, T, E, cand)
                if ll_new >= ll_old - 1e-12:
                    break
                factor *= 0.5
            beta = cand
            moved = max(abs(factor * step[k]) for k in range(p)) if p else 0.0
            converged = moved < 1e-7
            ll_old = ll_new
            if converged:
                break
        else:
            raise RuntimeError('Cox-modellen konvergerte ikke på 50 '
                               'iterasjoner — sjekk data/skala')
        _, info = self._grad_info(Xc, T, E, beta)
        covm = _inv(info)
        z = _norm_ppf(1.0 - self.alpha / 2.0)
        self._covs = covs
        self.params_ = {}
        self.standard_errors_ = {}
        self.hazard_ratios_ = {}
        self.confidence_intervals_ = {}
        self._zvals = {}
        self._pvals = {}
        for k, c in enumerate(covs):
            b = beta[k]
            se = math.sqrt(covm[k][k])
            self.params_[c] = b
            self.standard_errors_[c] = se
            self.hazard_ratios_[c] = math.exp(b)
            self.confidence_intervals_[c] = [b - z * se, b + z * se]
            zv = b / se if se > 0 else 0.0
            self._zvals[c] = zv
            self._pvals[c] = _chi2_sf(zv * zv, 1)
        self.log_likelihood_ = ll_old
        eta = [sum(Xc[i][k] * beta[k] for k in range(p)) for i in range(n)]
        self.concordance_index_ = _concordance(T, E, eta)
        self._n = n
        self._nevents = sum(E)
        return self

    def _event_blocks(self, T, E):
        """Distinkte tider synkende med indekser; brukes av loglik/grad."""
        order = sorted(range(len(T)), key=lambda i: -T[i])
        blocks = []
        i = 0
        while i < len(order):
            t = T[order[i]]
            grp = []
            while i < len(order) and T[order[i]] == t:
                grp.append(order[i])
                i += 1
            blocks.append((t, grp))
        return blocks

    def _loglik(self, X, T, E, beta):
        n = len(T)
        p = len(beta)
        eta = [sum(X[i][k] * beta[k] for k in range(p)) for i in range(n)]
        w = [math.exp(min(e, 700.0)) for e in eta]
        S0 = 0.0
        ll = 0.0
        for t, grp in self._event_blocks(T, E):
            for i in grp:
                S0 += w[i]
            D = [i for i in grp if E[i]]
            m = len(D)
            if m == 0:
                continue
            S0D = sum(w[i] for i in D)
            for i in D:
                ll += eta[i]
            for l in range(m):
                ll -= math.log(S0 - (l / float(m)) * S0D)
        return ll

    def _grad_info(self, X, T, E, beta):
        n = len(T)
        p = len(beta)
        eta = [sum(X[i][k] * beta[k] for k in range(p)) for i in range(n)]
        w = [math.exp(min(e, 700.0)) for e in eta]
        S0 = 0.0
        S1 = [0.0] * p
        S2 = [[0.0] * p for _ in range(p)]
        grad = [0.0] * p
        info = [[0.0] * p for _ in range(p)]
        for t, grp in self._event_blocks(T, E):
            for i in grp:
                S0 += w[i]
                for a in range(p):
                    S1[a] += w[i] * X[i][a]
                    for b in range(p):
                        S2[a][b] += w[i] * X[i][a] * X[i][b]
            D = [i for i in grp if E[i]]
            m = len(D)
            if m == 0:
                continue
            S0D = sum(w[i] for i in D)
            S1D = [sum(w[i] * X[i][a] for i in D) for a in range(p)]
            S2D = [[sum(w[i] * X[i][a] * X[i][b] for i in D)
                    for b in range(p)] for a in range(p)]
            for i in D:
                for a in range(p):
                    grad[a] += X[i][a]
            for l in range(m):
                f = l / float(m)
                phi = S0 - f * S0D
                s1l = [S1[a] - f * S1D[a] for a in range(p)]
                for a in range(p):
                    grad[a] -= s1l[a] / phi
                    for b in range(p):
                        s2ab = S2[a][b] - f * S2D[a][b]
                        info[a][b] += s2ab / phi - (s1l[a] / phi) * (s1l[b] / phi)
        return grad, info

    @property
    def summary(self):
        cols = {'covariate': list(self._covs)}
        cols['coef'] = [self.params_[c] for c in self._covs]
        cols['exp(coef)'] = [self.hazard_ratios_[c] for c in self._covs]
        cols['se(coef)'] = [self.standard_errors_[c] for c in self._covs]
        cols['coef lower 95%'] = [self.confidence_intervals_[c][0] for c in self._covs]
        cols['coef upper 95%'] = [self.confidence_intervals_[c][1] for c in self._covs]
        cols['z'] = [self._zvals[c] for c in self._covs]
        cols['p'] = [self._pvals[c] for c in self._covs]
        return _frame(cols, ['covariate', 'coef', 'exp(coef)', 'se(coef)',
                             'coef lower 95%', 'coef upper 95%', 'z', 'p'])

    def print_summary(self):
        print('CoxPHFitter (Efron), n=%d, antall hendelser=%d' % (self._n, self._nevents))
        print('log-likelihood = %.4f, concordance = %.4f' % (self.log_likelihood_, self.concordance_index_))
        hdr = '%-12s %9s %10s %9s %8s %9s' % ('kovariat', 'coef', 'exp(coef)', 'se', 'z', 'p')
        print(hdr)
        for c in self._covs:
            print('%-12s %9.4f %10.4f %9.4f %8.3f %9.4g' % (
                str(c), self.params_[c], self.hazard_ratios_[c],
                self.standard_errors_[c], self._zvals[c], self._pvals[c]))

    def predict_survival_function(self, *a, **kw):
        raise NotImplementedError('predict_* er utenfor v1')

    def predict_partial_hazard(self, *a, **kw):
        raise NotImplementedError('predict_* er utenfor v1')


def _concordance(T, E, risk):
    """Parvis c-indeks: par (i, j) er sammenlignbare når i har hendelse og
    T_i < T_j, eller T_i == T_j og j er sensurert. Høyere risk-skår skal
    predikere kortere tid."""
    num = 0.0
    den = 0.0
    n = len(T)
    for i in range(n):
        if not E[i]:
            continue
        for j in range(n):
            if i == j:
                continue
            if T[i] < T[j] or (T[i] == T[j] and not E[j]):
                den += 1.0
                if risk[i] > risk[j]:
                    num += 1.0
                elif risk[i] == risk[j]:
                    num += 0.5
    return num / den if den else 0.5
```

- [ ] **Step 4: Run** — all PASS (Cox matches the probed lifelines values to 1e-6; concordance to 1e-9 — if the concordance assertion alone fails, the pair-comparability rule differs: try excluding `T_i == T_j`-pairs entirely, then including both-event ties at 0.5, and keep whichever matches the oracle; the ground-truth dataset has a tie structure that disambiguates).

- [ ] **Step 5: Commit** — `feat(lifelines): CoxPHFitter (Efron, Newton-Raphson)`.

---

### Task 4: Differential tests vs real lifelines (3 datasets)

**Files:**
- Create: `brython/tests/test_lifelines_core_diff.py`

Datasets (deterministic, hardcoded): D1 = probe data (16 rows combined), D2 heavy ties: `T=[3,3,3,5,5,7,7,7,7,10,10,12,2,2,8]`, `E=[1,1,0,1,1,1,1,0,1,1,0,1,1,1,1]`, D3 n=40: `T=[(i*7) % 19 + 1 for i in range(40)]`, `E=[1 if (i*5) % 7 != 0 else 0 for i in range(40)]`, covariates `alder=[40 + (i*13) % 30 for i in range(40)]`, `beh=[i % 2 for i in range(40)]`.

- [ ] **Step 1: Write the diff tests**:

```python
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
```

- [ ] **Step 2: Run** — `python3 brython/tests/test_lifelines_core_diff.py`. On NA-variance mismatch for tied data: switch variance increments in `NelsonAalenFitter.fit` from `Σ_j 1/(n−j)²` to `d/n²`-per-time and rerun. On concordance mismatch: adjust the comparability rule per Task 3 Step 4. Fix core, never widen tolerances.

- [ ] **Step 3: Commit** — `test(lifelines): differensialtester mot ekte lifelines 0.30.3`.

---

### Task 5: Fasader + registries + mpy-røyk

**Files:**
- Create: `brython/lifelines_brython.py`, `micropython/lifelines_mpy.py`, `micropython/tests/mpy_smoke_lifelines.py`
- Modify: `js/brython-engine.js`, `js/micropython-engine.js` (LIB_REGISTRY etter folium-oppføringene)

**Interfaces:**
- Consumes: hele `lifelines_core`-API-et + `configure`.
- Produces: importnavn `lifelines` og `lifelines.statistics` i begge shim-modusene.

- [ ] **Step 1: Fasade** — `brython/lifelines_brython.py`:

```python
# Tynn fasade over shared/lifelines_core.py — eksplisitte rebind-er (aldri
# stjerneimport, _Mod-fellen) + configure-injeksjon av plotly-/pandas-
# shimene (ui_core-presedensen). Samme liste som micropython/lifelines_mpy.py.
import lifelines_core as _core
import plotly_express_brython as _pe
import pandas_brython as _pd

_core.configure(pe=_pe, pd=_pd)

KaplanMeierFitter = _core.KaplanMeierFitter
NelsonAalenFitter = _core.NelsonAalenFitter
CoxPHFitter = _core.CoxPHFitter
StatisticalResult = _core.StatisticalResult
logrank_test = _core.logrank_test
multivariate_logrank_test = _core.multivariate_logrank_test


class _Statistics:
    """lifelines.statistics-navnerommet (attributt-tilgang);
    `from lifelines.statistics import logrank_test` går via modul-aliaset."""
    logrank_test = staticmethod(_core.logrank_test)
    multivariate_logrank_test = staticmethod(_core.multivariate_logrank_test)


statistics = _Statistics()
```

`micropython/lifelines_mpy.py`: identisk, men `plotly_express_mpy`/`pandas_mpy` og filhode-referanse til brython-fila.

- [ ] **Step 2: Registries** — `js/brython-engine.js` etter `folium_core`:

```js
    // lifelines (spec 2026-07-24): ren beregning — ingen js-deps; plott
    // gjenbruker plotly-shimet (deps sørger for rekkefølgen). Dotted
    // alias-rekkefølge bindende (statsmodels-presedensen).
    lifelines_brython:      { aliases: ['lifelines', 'lifelines.statistics'],
                              deps: ['lifelines_core', 'plotly_express_brython',
                                     'pandas_brython'], js: [] },
    lifelines_core:         { aliases: [], deps: [], js: [],
                              path: 'shared/lifelines_core.py' }
```

`js/micropython-engine.js`: samme med `lifelines_mpy` og deps `['lifelines_core', 'plotly_express_mpy', 'pandas_mpy']`. Kjør `node --check` på begge.

- [ ] **Step 3: MPy-røyk** — `micropython/tests/mpy_smoke_lifelines.py`:

```python
# micropython micropython/tests/mpy_smoke_lifelines.py   (fra repo-roten)
import sys, json
sys.path.insert(0, 'shared')
sys.path.insert(0, 'micropython')
import lifelines_mpy as ll

T = [5, 6, 6, 2, 4, 4, 6, 7, 3, 9]
E = [1, 0, 1, 1, 1, 0, 1, 1, 1, 0]
kmf = ll.KaplanMeierFitter().fit(T, E)
assert abs(kmf._sf[5] - 0.35) < 1e-9
assert kmf.median_survival_time_ == 6.0
fig = kmf.plot_survival_function()
spec = json.loads(fig.to_plotly_json_str())
assert any(t.get('line', {}).get('shape') == 'hv' for t in spec['data'])
r = ll.statistics.logrank_test(T, [1, 4, 4, 5, 8, 9], E, [1, 1, 0, 1, 1, 1])
assert abs(r.p_value - 0.8709343067602499) < 1e-8
cph = ll.CoxPHFitter().fit({'T': T, 'E': E,
                            'x': [1, 0, 1, 0, 1, 0, 1, 0, 1, 0]}, 'T', 'E')
assert 'x' in cph.params_
print('MPY-LIFELINES-RØYK OK')
```

Run: `micropython micropython/tests/mpy_smoke_lifelines.py` → OK. Dialektfeil fikses i kjernen.

- [ ] **Step 4: Alle tester + commit** — kjør begge lifelines-testfilene + altair/folium-suitene + `node --check`; commit `feat(lifelines): runtime-kobling — fasader, registry`.

---

### Task 6: Eksempler + manifest

**Files:**
- Create: `examples/brython/bry29_lifelines.txt`, `examples/micropython/09_lifelines.txt`, `examples/python/py09_lifelines.txt`
- Modify (generert): `examples/manifest.json`

- [ ] **Step 1:** `examples/brython/bry29_lifelines.txt`:

```
# label: lifelines — overlevelsesanalyse
# Kaplan-Meier per gruppe + logrank + Cox-regresjon (brython-modus).
from lifelines import KaplanMeierFitter, CoxPHFitter
from lifelines.statistics import logrank_test

# Tid til hendelse (måneder) for to behandlingsgrupper
tid_a =   [5, 6, 6, 2, 4, 4, 6, 7, 3, 9, 8, 10]
status_a = [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 0]
tid_b =   [1, 4, 4, 5, 8, 9, 2, 3, 3, 6]
status_b = [1, 1, 0, 1, 1, 1, 1, 1, 0, 1]

kmf_a = KaplanMeierFitter().fit(tid_a, status_a, label="Behandling A")
kmf_b = KaplanMeierFitter().fit(tid_b, status_b, label="Behandling B")

r = logrank_test(tid_a, tid_b, status_a, status_b)
print("Logrank: chi2 = %.3f, p = %.3f" % (r.test_statistic, r.p_value))

cph = CoxPHFitter().fit({
    "tid": tid_a + tid_b,
    "status": status_a + status_b,
    "gruppe": [0] * len(tid_a) + [1] * len(tid_b),
}, "tid", "status")
cph.print_summary()

fig = kmf_a.plot_survival_function()
kmf_b.plot_survival_function(fig=fig)
```

- [ ] **Step 2:** micropython-varianten (samme innhold, MicroPython-header), og `examples/python/py09_lifelines.txt` med ekte lifelines (samme analyse, men Cox-fit med `pd.DataFrame` og `kmf.plot_survival_function()` via matplotlib — trailing `plt.gcf()`-fri, lifelines plotter på gca; avslutt cellen med de to plot-kallene).

- [ ] **Step 3:** `python3 examples/generate_manifest.py`; commit.

---

### Task 7: Browser-verifisering + full suite + finishing

- [ ] Brython-modus (server på 8123): kjør bry29 — logrank-tekst, Cox-tabell og KM-plot med to kurver + KI-bånd rendres som plotly-figur; skjermbilde.
- [ ] MicroPython-modus: 09-eksemplet; skjermbilde.
- [ ] Pyodide: py09 (ekte lifelines via micropip — kan ta tid; hvis installasjon feiler: dokumentér og verifiser at ingenting annet knakk).
- [ ] Full suite:

```bash
python3 brython/tests/test_lifelines_core.py && \
python3 brython/tests/test_lifelines_core_diff.py && \
python3 brython/tests/test_folium_core.py && \
python3 brython/tests/test_altair_core.py && \
python3 brython/tests/test_altair_core_diff.py && \
micropython micropython/tests/mpy_smoke_lifelines.py && \
micropython micropython/tests/mpy_smoke_folium.py && \
micropython micropython/tests/mpy_smoke_altair.py && \
python3 micropython/tests/test_micropython_runner.py && \
node --check js/brython-engine.js && node --check js/micropython-engine.js
```

- [ ] Commit fikser; superpowers:finishing-a-development-branch.

## Self-review notes

- Spec-dekning: numerikk+KM+NA (T1), logrank (T2), Cox (T3), diff-fasit (T4), fasader/registry/røyk (T5), eksempler (T6), browser (T7). Ingen runner-/index.html-endringer — som spesifisert.
- Kjente justeringspunkter med regel: NA-varians ved ties (T4 step 2), c-indeks-parregel (T3 step 4).
- Konsistens: `_sf`/`_cumhaz`/`_ci_lower`/`_ci_upper`/`timeline` brukes på tvers av T1/T4/T5-røyk; `configure(pe=, pd=)` i T1 konsumeres av T5-fasadene.
