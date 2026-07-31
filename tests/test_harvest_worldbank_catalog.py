"""Høsteskriptets rene funksjoner + formatvalidering av committet katalog."""
import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))
from harvest_worldbank_catalog import trim_indicator

CATALOG = pathlib.Path(__file__).resolve().parents[1] / "data" / "worldbank-catalog.json"


def test_trim_indicator_beholder_kun_feltene_vare():
    raw = {"id": "SH.XPD.CHEX.GD.ZS", "name": "Current health expenditure (% of GDP)",
           "unit": "", "source": {"id": "2", "value": "World Development Indicators"},
           "sourceNote": "x" * 500, "topics": [{"id": "8"}]}
    t = trim_indicator(raw)
    assert t["id"] == "SH.XPD.CHEX.GD.ZS"
    assert t["src"] == "World Development Indicators"
    assert len(t["note"]) <= 160
    assert "unit" not in t          # tom unit utelates
    assert "topics" not in t


def test_committet_katalog_er_gyldig_og_under_1mb():
    assert CATALOG.exists(), "kjør tools/harvest_worldbank_catalog.py"
    assert CATALOG.stat().st_size < 1_000_000
    d = json.loads(CATALOG.read_text())
    assert d["count"] == len(d["indicators"]) > 1000
    sample = d["indicators"][0]
    assert set(sample) >= {"id", "name"}
    # WDI-indikatoren evalene bruker skal finnes
    assert any(i["id"] == "SH.XPD.CHEX.GD.ZS" for i in d["indicators"])
