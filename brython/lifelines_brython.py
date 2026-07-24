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
