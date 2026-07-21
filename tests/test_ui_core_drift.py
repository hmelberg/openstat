"""Fase 3 (spec 2026-07-20): tvillingdrift-snubletråd for fasadene.

De dialekt-sammenfiltrede funksjonene ble BEVISST værende per fasade
(spec §Phase 3 revidert). Risikoen er ensidige endringer: en fiks i én
fasade som aldri speiles. Denne testen feiler når (a) fasadenes
offentlige API-navnesett divergerer, (b) et navn som skal være delt
re-defineres lokalt i en fasade, eller (c) normalisert likhet for et
speilet funksjonspar faller UNDER gulvet målt 2026-07-20 — en ensidig
endring senker likheten; en synkronisert endring holder den oppe.
Gulvjustering er en BEVISST handling: oppdater tallet i samme commit
som en strukturell (synkron) omskriving, med begrunnelse i meldingen."""
import ast
import difflib
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = {
    "pyodide": ROOT / "pyodide" / "ui.py",
    "brython": ROOT / "brython" / "ui_brython.py",
    "mpy": ROOT / "micropython" / "ui_mpy.py",
}

# Speilede-men-dialektale funksjoner og deres likhetsgulv (min. parvis
# likhet målt 2026-07-20, avrundet NED til nærmeste 0.05 for slingring).
MIRRORED_FLOORS = {
    "slider": 0.80,
    "dropdown": 0.90,
    "checkbox": 0.85,
    "switch": 0.85,
    "number": 0.90,
    "text": 0.90,
    "button": 0.85,
    "on": 0.70,
    "value": 0.60,
    "_normalize_kwargs": 0.65,
    "Element": 0.80,
    "WidgetHandle": 0.90,
    "_payload_element": 0.90,
    "_lib_tag_builder": 0.85,
    "_validate_accepts": 0.70,
}

# Navn som skal komme fra ui_core og ALDRI re-defineres i en fasade.
SHARED = ["HTML_TAGS", "_SL_ACCEPTS", "_snake_to_camel", "_json_safe",
          "_spec", "_into_el_id", "kpi", "markdown", "play", "run_button",
          "run_cell", "widget", "_tag_builder", "_append_children", "_warn"]


def _defs(path):
    src = path.read_text(encoding="utf-8")
    out = {}
    lines = src.split("\n")
    for n in ast.parse(src).body:
        if isinstance(n, (ast.FunctionDef, ast.ClassDef)):
            out[n.name] = "\n".join(lines[n.lineno - 1:n.end_lineno])
    return out


def _norm(body):
    ls = [re.sub(r"\s+#.*", "", l).rstrip() for l in body.split("\n")]
    return [l for l in ls if l.strip() and not l.strip().startswith("#")]


def test_ingen_lokal_redefinisjon_av_delte_navn():
    for runtime, path in FILES.items():
        d = _defs(path)
        offenders = [n for n in SHARED if n in d]
        assert not offenders, (
            f"{runtime}: {offenders} er delte ui_core-navn men re-definert "
            f"lokalt i {path.name} — flytt endringen til shared/ui_core.py")


def test_speilede_funksjoner_har_ikke_driftet():
    ds = {k: _defs(p) for k, p in FILES.items()}
    problems = []
    for name, floor in MIRRORED_FLOORS.items():
        bodies = {k: _norm(d[name]) for k, d in ds.items() if name in d}
        assert len(bodies) == 3, f"{name} mangler i {set(FILES) - set(bodies)}"
        keys = list(bodies)
        for i in range(len(keys)):
            for j in range(i + 1, len(keys)):
                r = difflib.SequenceMatcher(None, bodies[keys[i]], bodies[keys[j]]).ratio()
                if r < floor:
                    problems.append(f"{name}: {keys[i]}~{keys[j]} = {r:.2f} < gulv {floor}")
    assert not problems, (
        "Mulig ensidig fasade-endring (speil den i tvillingene, eller "
        "juster gulvet bevisst i samme commit):\n" + "\n".join(problems))
