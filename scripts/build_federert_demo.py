"""Splitt data/person_year_sample.csv i tre disjunkte medlemmer for
demo-federert-kilden (spec 2026-07-31-federert-pull-design §6).
Deterministiske tredjedeler etter radrekkefølge — union av delene == den
usplittede tabellen er invarianten tests/test_federert_demo.py håndhever."""
import pathlib

import pandas as pd

ROOT = pathlib.Path(__file__).resolve().parent.parent
df = pd.read_csv(ROOT / "data" / "person_year_sample.csv")
out = ROOT / "data" / "federert"
out.mkdir(parents=True, exist_ok=True)
n = len(df)
cuts = [0, n // 3, 2 * n // 3, n]
for name, a, b in zip(["nord", "vest", "sor"], cuts, cuts[1:]):
    df.iloc[a:b].to_parquet(out / f"{name}.parquet", index=False)
    print(f"{name}: {b - a} rader")
print(f"totalt: {n} rader")
