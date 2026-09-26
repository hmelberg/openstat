"""NaN i varighet/hendelse/kovariat skal gi feil (som ekte lifelines), ikke
stille feil kurver: en NaN-varighet ble et eget tidspunkt, og et NaN-flagg
er sant i Python og ble talt som observert hendelse."""
import math
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "shared"))
import lifelines_core as L  # noqa: E402

NAN = float("nan")


def test_km_nan_varighet():
    with pytest.raises(TypeError, match="NaN"):
        L.KaplanMeierFitter().fit([NAN, 1, 2, NAN, 3])


def test_km_nan_hendelse():
    with pytest.raises(TypeError, match="NaN"):
        L.KaplanMeierFitter().fit([1, 2, 3], [1, NAN, 0])


def test_logrank_nan_varighet():
    with pytest.raises(TypeError, match="NaN"):
        L.multivariate_logrank_test([1, NAN, 3, 4], ["a", "a", "b", "b"])


def test_km_uten_nan_virker_som_for():
    k = L.KaplanMeierFitter().fit([1, 2, 3, 4], [1, 0, 1, 1])
    assert k is not None
    assert not math.isnan(float(k.median_survival_time_))
