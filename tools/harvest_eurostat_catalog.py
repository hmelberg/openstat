#!/usr/bin/env python3
"""Høster Eurostats innholdsfortegnelse (TOC) til data/eurostat-catalog.json."""
import datetime
import json
import pathlib
import urllib.request

TOC = "https://ec.europa.eu/eurostat/api/dissemination/catalogue/toc/txt?lang=en"
OUT = pathlib.Path(__file__).resolve().parents[1] / "data" / "eurostat-catalog.json"


def _unquote(field):
    return field.strip().strip('"').strip()


def parse_toc_line(line):
    # Kuratert: kun "dataset" type (drop "table" derivatives) for å holde 1 MB-taket
    # uten å kutte titler, som søk (Task 2) er avhengig av.
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 7:
        return None
    title, code, typ = _unquote(parts[0]), _unquote(parts[1]), _unquote(parts[2])
    if typ != "dataset" or code in ("code", ""):
        return None
    return {"code": code, "title": title[:140],
            "start": _unquote(parts[5]), "end": _unquote(parts[6])}


def main():
    with urllib.request.urlopen(TOC, timeout=120) as r:
        text = r.read().decode("utf-8", errors="replace")
    seen, tables = set(), []
    for line in text.splitlines():
        row = parse_toc_line(line)
        if row and row["code"] not in seen:
            seen.add(row["code"])
            tables.append(row)
    OUT.write_text(json.dumps({
        "generated": datetime.date.today().isoformat(),
        "count": len(tables),
        "tables": tables,
    }, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"skrev {OUT} ({len(tables)} tabeller, {OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
