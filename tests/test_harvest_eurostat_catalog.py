import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))
from harvest_eurostat_catalog import parse_toc_line

CATALOG = pathlib.Path(__file__).resolve().parents[1] / "data" / "eurostat-catalog.json"


def test_parse_toc_line_dataset():
    line = '"    Unemployment by sex and age"\t"une_rt_m"\t"dataset"\t" "\t" "\t"1983"\t"2026"\t'
    row = parse_toc_line(line)
    assert row == {"code": "une_rt_m", "title": "Unemployment by sex and age",
                   "start": "1983", "end": "2026"}


def test_parse_toc_line_folder_og_header_hopper():
    assert parse_toc_line('"General statistics"\t"general"\t"folder"\t" "\t" "\t" "\t" "\t') is None
    assert parse_toc_line('"title"\t"code"\t"type"\t"x"\t"x"\t"x"\t"x"\t"values"') is None


def test_committet_katalog_er_gyldig_og_under_1mb():
    assert CATALOG.exists(), "kjør tools/harvest_eurostat_catalog.py"
    assert CATALOG.stat().st_size < 1_000_000
    d = json.loads(CATALOG.read_text())
    assert d["count"] == len(d["tables"]) > 3000
    assert any(t["code"] == "une_rt_m" for t in d["tables"])
