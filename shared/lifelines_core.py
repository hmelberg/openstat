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
        x = ((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
             / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0))
    elif p > 1.0 - plow:
        q = math.sqrt(-2.0 * math.log(1.0 - p))
        x = -((((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
              / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1.0))
    else:
        q = p - 0.5
        r = q * q
        x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
             / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1.0))
    # ett Halley-forfiningssteg via erfc (maskinpresisjon — Acklam alene er
    # ~1.2e-9, som bommer på diff-fasitens 1e-9-toleranse). MicroPython-bygg
    # uten math.erfc beholder Acklam-presisjonen (godt nok for røyktestene).
    try:
        e = 0.5 * math.erfc(-x / math.sqrt(2.0)) - p
        u = e * math.sqrt(2.0 * math.pi) * math.exp(x * x / 2.0)
        x = x - u / (1.0 + x * u / 2.0)
    except AttributeError:
        pass
    return x


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


def _fmt_alpha(alpha):
    """0.05 -> '0.95' (lifelines' kolonnenavnkonvensjon)."""
    conf = 1.0 - alpha
    s = ('%f' % conf).rstrip('0')
    if s.endswith('.'):
        s += '0'
    return s


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
        # tell KURVER (navngitte traces) — KI-båndene bruker også 'hv'
        existing = 0
        for tr in fig.data:
            if tr.get('name'):
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
