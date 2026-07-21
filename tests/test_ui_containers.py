"""shared/ui_core.py sin grid-template-parser (_parse_grid_template) - ren
python, INGEN injeksjon (ingen configure()-kall, ingen fasade-lasting
nødvendig) - testet direkte mot ui_core-modulen i CPython, samme mønster
som test_ui_core_drift.py sin filbaserte tilnærming, men her et faktisk
import+kall (parseren har ingen dialekt-avhengighet i det hele tatt, se
shared/ui_core.py sin egen docstring-kommentar over _parse_grid_template).

fase 4b (spec 2026-07-21-explicit-containers-design.md, Task 3-brief.md
Step 1 pkt. 1): "kpi kpi | plot table" -> CSS grid-template-areas-strengen
+ unike områdenavn i første-sett-rekkefølge; ragged rader -> ValueError;
én rad uten "|" fungerer."""
import pathlib
import sys

import pytest

_SHARED = str(pathlib.Path(__file__).resolve().parents[1] / "shared")
if _SHARED not in sys.path:
    sys.path.insert(0, _SHARED)

import ui_core


def test_parse_grid_template_to_rader_gir_areas_streng_og_unike_navn():
    parsed = ui_core._parse_grid_template("kpi kpi | plot table")
    assert parsed["areas"] == '"kpi kpi" "plot table"'
    assert parsed["names"] == ["kpi", "plot", "table"]


def test_parse_grid_template_en_rad_uten_pipe():
    parsed = ui_core._parse_grid_template("side main")
    assert parsed["areas"] == '"side main"'
    assert parsed["names"] == ["side", "main"]


def test_parse_grid_template_gjentatt_navn_i_samme_omraade_teller_en_gang():
    # "kpi kpi" på én rad - kpi opptrer to ganger i cellene (gyldig CSS,
    # betyr at kpi-elementet spenner over begge kolonnene), men er ETT
    # unikt områdenavn - ikke to.
    parsed = ui_core._parse_grid_template("kpi kpi")
    assert parsed["names"] == ["kpi"]


def test_parse_grid_template_gjenbrukt_navn_pa_tvers_av_rader_teller_en_gang():
    parsed = ui_core._parse_grid_template("side main | side table")
    assert parsed["names"] == ["side", "main", "table"]


def test_parse_grid_template_ujevne_rader_gir_value_error():
    with pytest.raises(ValueError, match="ujevne rader"):
        ui_core._parse_grid_template("kpi kpi | plot")


def test_parse_grid_template_tom_rad_gir_value_error():
    with pytest.raises(ValueError):
        ui_core._parse_grid_template("kpi kpi | ")


def test_parse_grid_template_enkelt_celle():
    parsed = ui_core._parse_grid_template("kpi")
    assert parsed["areas"] == '"kpi"'
    assert parsed["names"] == ["kpi"]
