"""Tester for tools/migrate_directives.py — engangskonverteringen fra gammel
direktivsyntaks til den pythonske (spec 2026-07-26-pythonsk-direktivsyntaks).

Fasiten er oversettelsesorakelet i .superpowers/sdd/task-8-brief.md: 17 par som
er kjørt gjennom både den gamle parseren (45306c3~1) og den nye, og som gir
semantisk like resultater.
"""
import subprocess
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def run(tmp_path, text):
    f = tmp_path / "s.txt"
    f.write_text(text, encoding="utf-8")
    subprocess.run(
        [sys.executable, str(ROOT / "tools" / "migrate_directives.py"), str(f)],
        check=True, cwd=str(ROOT), capture_output=True,
    )
    return f.read_text(encoding="utf-8")


def test_connect_read_meta(tmp_path):
    out = run(tmp_path, "\n".join([
        "# connect https://data.ssb.no/api/pxwebapi/v2/tables as ssb, kind(pxweb)",
        "# read ssb/05839 as bef, years(2000:2009), indicators(Personer)",
        "# meta bef Folkemengde etter alder",
        "# meta bef https://www.ssb.no/befolkning Om SSB",
        "import pandas as pd",
    ]))
    assert 'ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb")' in out
    assert 'bef = ssb.read("05839", years="2000:2009", indicators=["Personer"])' in out
    assert 'meta.bef.note = "Folkemengde etter alder"' in out
    assert 'meta.bef.link = {"https://www.ssb.no/befolkning": "Om SSB"}' in out
    assert "import pandas as pd" in out          # kode urørt


def test_meta_link_med_etikett_blir_dict(tmp_path):
    # Tuppelformen ("url", "etikett") er død: parseren representerer (…) og […]
    # likt, så den ga TO lenker — den andre med url "Om SSB".
    out = run(tmp_path, "# meta bef https://www.ssb.no/befolkning Om SSB")
    assert 'meta.bef.link = {"https://www.ssb.no/befolkning": "Om SSB"}' in out


def test_meta_link_uten_etikett_blir_streng(tmp_path):
    out = run(tmp_path, "# meta bef https://www.ssb.no/befolkning")
    assert 'meta.bef.link = "https://www.ssb.no/befolkning"' in out


def test_meta_variabel_blir_note_ikke_label(tmp_path):
    # Gammel syntaks hadde ingen label-kind: alt ikke-URL-innhold var 'text'.
    out = run(tmp_path, "# meta iris.sepal_length Begerbladlengde i cm")
    assert 'meta.iris.sepal_length.note = "Begerbladlengde i cm"' in out
    assert '.label' not in out


def test_flere_meta_paa_samme_maal_slaas_sammen(tmp_path):
    # Gammel syntaks AKKUMULERTE; ny kjører dropPrevious(mål, variabel, kind).
    # Linje-for-linje-konvertering ville mistet det første notatet og den
    # første lenken i stillhet.
    out = run(tmp_path, "\n".join([
        "# meta iris Fishers irisdata (1936): 150 blomster, tre arter",
        "# meta iris Målt i cm på beger- og kronblad",
        "# meta iris https://en.wikipedia.org/wiki/Iris_flower_data_set Wikipedia",
        "# meta iris https://archive.ics.uci.edu/dataset/53/iris UCI-arkivet",
    ]))
    assert ('meta.iris.note = ["Fishers irisdata (1936): 150 blomster, tre arter", '
            '"Målt i cm på beger- og kronblad"]') in out
    assert '"https://en.wikipedia.org/wiki/Iris_flower_data_set": "Wikipedia"' in out
    assert '"https://archive.ics.uci.edu/dataset/53/iris": "UCI-arkivet"' in out
    assert out.count("meta.iris.note") == 1
    assert out.count("meta.iris.link") == 1


def test_flere_lenker_uten_etikett_blir_liste(tmp_path):
    out = run(tmp_path, "\n".join([
        "# meta iris https://a.example/en",
        "# meta iris https://b.example/to",
    ]))
    assert 'meta.iris.link = ["https://a.example/en", "https://b.example/to"]' in out


def test_komma_i_sti_overlever(tmp_path):
    # Stien har komma, @, ? og =. Et skript som deler på komma for å finne
    # opsjonshalen hakker den i biter og lager et falskt opsjonsargument.
    out = run(tmp_path, "# read oecd/OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE/all?startPeriod=2020 as le")
    assert 'le = oecd.read("OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE/all?startPeriod=2020")' in out


def test_assembly_and_markers(tmp_path):
    out = run(tmp_path, "\n".join([
        "-- connect people as p",
        "# create-dataset panel, key(kommune_nr year)",
        "# add p/income, p/edu into panel inner",
        "# join sales into panel on pid outer",
        "// use tall from duckdb",
    ]))
    assert '-- p = ost.connect("people")' in out
    assert 'panel = ost.create(key=["kommune_nr", "year"])' in out
    assert 'panel.add(p, ["income", "edu"], how="inner")' in out
    assert 'panel.join(sales, on="pid", how="outer")' in out
    assert '// tall = ost.use("tall", source="duckdb")' in out


def test_key_har_to_betydninger(tmp_path):
    # key( på create er et KOLONNENAVN og forblir key=; på read/connect er det
    # en hemmelighet og blir secret_key=. Tvetydigheten omdøpingen fjerner.
    out = run(tmp_path, "\n".join([
        "# create-dataset panel, key(pid)",
        "# connect helse2025 as h, key(ask)",
        "# read h as df, key(abcDEF123)",
    ]))
    assert 'panel = ost.create(key="pid")' in out
    assert 'h = ost.connect("helse2025", secret_key="ask")' in out
    assert 'df = h.read(secret_key="abcDEF123")' in out


def test_load_uten_sti_og_bare_bruk(tmp_path):
    out = run(tmp_path, "\n".join([
        "# load h as df",
        "# use df",
        "# load gh/iris.csv as iris",
    ]))
    assert 'df = h.read()' in out
    assert 'df = ost.use("df")' in out
    assert 'iris = gh.read("iris.csv")' in out


def test_idempotent(tmp_path):
    src = "\n".join([
        "# connect fred",
        "# read ssb/05839 as bef, years(2000:2009), indicators(Personer)",
        "# meta bef Folkemengde",
        "# meta bef https://www.ssb.no/befolkning Om SSB",
        "# create-dataset panel, key(pid)",
        "# add p/income into panel",
        "# join sales into panel on pid",
        "# use tall from duckdb",
        "",
    ])
    once = run(tmp_path, src)
    twice = run(tmp_path, once)
    assert once == twice


def test_prosa_roeres_ikke(tmp_path):
    # NB: toords-formen «# use caution» er strukturelt IDENTISK med «# use df»
    # og ble matchet av den gamle USE_RE også — den konverteres bevisst, og er
    # ikke med her. Prosa som den gamle parseren heller ikke leste som direktiv:
    src = "\n".join([
        "# Eksempel: `# meta` legger egne notater og lenker på kilder.",
        "# read this as an int",
        "# use caution here",
        "# connect early as needed, then run",
        "import pandas as pd",
        "",
    ])
    assert run(tmp_path, src) == src


def test_meta_slaas_ikke_sammen_paa_tvers_av_eksempelblokker(tmp_path):
    # .md/.html har mange uavhengige eksempler: hvert <pre><code>/```-blokk
    # er sitt eget script. Sammenslåing på tvers slettet senere linjer —
    # inkludert HTML-taggene rundt dem.
    out = run(tmp_path, "\n".join([
        "<pre><code># meta iris første</code></pre>",
        "Tekst mellom eksemplene.",
        "<pre><code># meta iris andre</code></pre>",
        "```",
        "# meta iris tredje",
        "```",
    ]))
    assert '<pre><code># meta.iris.note = "første"</code></pre>' in out
    assert '<pre><code># meta.iris.note = "andre"</code></pre>' in out
    assert '# meta.iris.note = "tredje"' in out
    assert out.count("meta.iris.note") == 3
