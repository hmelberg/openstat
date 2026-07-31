#!/usr/bin/env python3
"""Høster Verdensbankens indikatorliste til data/worldbank-catalog.json.

Kuratert (spec 2026-07-30): kun source-id 2 (World Development Indicators,
~1500) og 16 (Health Nutrition and Population Statistics) — hele listen er
29 544 indikatorer og ville sprengt 1 MB-taket. Kjøres manuelt ved behov,
som tools/harvest_apd_catalog.py.
"""
import datetime
import json
import pathlib
import urllib.request

API = "https://api.worldbank.org/v2/indicator?format=json&per_page=1000&source={src}&page={page}"
SOURCES = ["2", "16"]
OUT = pathlib.Path(__file__).resolve().parents[1] / "data" / "worldbank-catalog.json"


def trim_indicator(raw):
    t = {"id": raw["id"], "name": (raw.get("name") or "").strip()}
    unit = (raw.get("unit") or "").strip()
    if unit:
        t["unit"] = unit
    src = ((raw.get("source") or {}).get("value") or "").strip()
    if src:
        t["src"] = src
    note = " ".join(((raw.get("sourceNote") or "")).split())[:160]
    if note:
        t["note"] = note
    return t


def fetch_source(src):
    page, pages, rows = 1, 1, []
    while page <= pages:
        with urllib.request.urlopen(API.format(src=src, page=page), timeout=60) as r:
            meta, data = json.load(r)
        pages = meta["pages"]
        rows += [trim_indicator(x) for x in (data or [])]
        page += 1
    return rows


def main():
    seen, indicators = set(), []
    for src in SOURCES:
        for row in fetch_source(src):
            if row["id"] in seen:
                continue
            seen.add(row["id"])
            indicators.append(row)
    OUT.write_text(json.dumps({
        "generated": datetime.date.today().isoformat(),
        "count": len(indicators),
        "indicators": indicators,
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"skrev {OUT} ({len(indicators)} indikatorer, {OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
