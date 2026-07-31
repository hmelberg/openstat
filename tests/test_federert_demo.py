"""Invarianten fra spec 2026-07-31-federert-pull §7: union av demo-shardene
== den usplittede tabellen (radantall, kolonner, innhold og radrekkefølge)."""
import pathlib

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
DELER = ["nord", "vest", "sor"]


def test_federert_demo_shards_union_equals_source():
    src = pd.read_csv(ROOT / "data" / "person_year_sample.csv")
    parts = [pd.read_parquet(ROOT / "data" / "federert" / f"{n}.parquet") for n in DELER]
    assert sum(len(p) for p in parts) == len(src)
    for p in parts:
        assert list(p.columns) == list(src.columns)
    union = pd.concat(parts, ignore_index=True)
    pd.testing.assert_frame_equal(union, src.reset_index(drop=True), check_dtype=False)
