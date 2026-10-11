# tests/test_openstat.py — openstat.py (ring 1: CPython-veien). Kontrakts-
# paritet med js/pxweb.js håndheves via delt fixture
# (tests/fixtures/pxweb_dataset.json — leses også av tests/js/pxweb.test.js).
import json
import pathlib
import sys

import pandas as pd
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import openstat as ost

FIX = json.loads((pathlib.Path(__file__).parent / "fixtures" / "pxweb_dataset.json").read_text())


def _er_tekst(s):
    """Tekstkolonne uansett pandas-versjon: object (pandas 2) eller "str" (pandas 3, pyodide v314)."""
    return s.dtype == object or pd.api.types.is_string_dtype(s.dtype)

def test_data_url_defaults():
    assert ost.data_url("https://x/tables/05839") == \
        "https://x/tables/05839/data?lang=no&outputFormat=json-stat2"


def test_data_url_bevarer_query_og_overstyrer_outputformat():
    assert ost.data_url("https://x/tables/05839?valueCodes[Tid]=2020,2021&lang=en&outputFormat=csv") == \
        "https://x/tables/05839/data?valueCodes[Tid]=2020,2021&lang=en&outputFormat=json-stat2"


def test_data_url_stripper_ogsaa_outputformatparams():
    # UseTexts-fella (målt SSB-400 i Task 5): outputFormatParams er et
    # visningsparameter for CSV — sendt sammen med outputFormat=json-stat2
    # 400-er SSB, og UseTexts-laster mister metadata unødig.
    out = ost.data_url("https://x/tables/05839?outputFormat=csv&outputFormatParams=UseTexts")
    assert "outputFormat=csv" not in out
    assert "outputFormatParams" not in out
    assert out == "https://x/tables/05839/data?lang=no&outputFormat=json-stat2"


def test_metadata_url():
    assert ost.metadata_url("https://x/tables/05839") == "https://x/tables/05839/metadata?lang=no"
    assert ost.metadata_url("https://x/tables/05839?lang=en") == "https://x/tables/05839/metadata?lang=en"


def test_columns_from_jsonstat_row_major():
    cols = ost.columns_from_jsonstat(FIX)
    assert list(cols) == ["Kjonn", "Tid", "ContentsCode", "value"]
    assert cols["Kjonn"] == ["1", "1", "2", "2"]
    assert cols["Tid"] == ["2020", "2021", "2020", "2021"]
    assert cols["ContentsCode"] == ["Personer"] * 4
    assert cols["value"] == [10, 11, 20, 21]


def test_columns_from_jsonstat_sparse_verdi_objekt():
    fx = dict(FIX)
    fx["value"] = {"0": 10, "3": 21}
    assert ost.columns_from_jsonstat(fx)["value"] == [10, None, None, 21]


def test_eurostat_data_url():
    assert ost.eurostat_data_url("https://x/data/nama_10_gdp") == "https://x/data/nama_10_gdp?lang=en&format=JSON"
    assert ost.eurostat_data_url("https://x/data/tab?geo=NO&format=csv") == "https://x/data/tab?lang=en&geo=NO&format=JSON"


def test_connect_read_eurostat(monkeypatch):
    calls = []

    def fake(url):
        calls.append(url)
        return json.dumps(FIX).encode()

    monkeypatch.setattr(ost, "_fetch_bytes", fake)
    eu = ost.connect("https://x/data", kind="eurostat")
    df = eu.read("nama_10_gdp", geo="NO")
    assert calls == ["https://x/data/nama_10_gdp?lang=en&geo=NO&format=JSON"]
    assert df.shape == (4, 4)


def test_connect_read_pxweb(monkeypatch):
    calls = []

    def fake(url):
        calls.append(url)
        return json.dumps(FIX).encode()

    monkeypatch.setattr(ost, "_fetch_bytes", fake)
    ssb = ost.connect("https://x/tables", kind="pxweb")
    df = ssb.read("05839", valueCodes={"Tid": "*"})
    assert calls == ["https://x/tables/05839/data?lang=no&valueCodes[Tid]=*&outputFormat=json-stat2"]
    assert df.shape == (4, 4)
    assert list(df.columns) == ["Kjonn", "Tid", "ContentsCode", "value"]


def test_pxweb_krever_tabell(monkeypatch):
    with pytest.raises(ValueError):
        ost.connect("https://x/tables", kind="pxweb").read()


def test_read_csv_med_columns_subset(monkeypatch):
    monkeypatch.setattr(ost, "_fetch_bytes", lambda url: b"a,b,c\n1,2,3\n4,5,6\n")
    df = ost.read("https://x/f.csv", columns=["a", "c"])
    assert list(df.columns) == ["a", "c"]
    assert df.shape == (2, 2)


def test_create_add_composite_key():
    a = pd.DataFrame({"k1": [1, 1], "k2": [1, 2], "x": [10, 20]})
    b = pd.DataFrame({"k1": [1, 1], "k2": [1, 2], "y": [7, 8]})
    d = ost.create(key=["k1", "k2"], name="panel_test")
    d.add(a, "x").add(b, "y")
    df = d.frame()
    assert list(df.columns) == ["k1", "k2", "x", "y"]
    assert df.shape == (2, 4)
    assert "panel_test" in ost.datasets()


def test_create_add_fra_kilde(monkeypatch):
    monkeypatch.setattr(ost, "_fetch_bytes", lambda url: b"k,x,ekstra\n1,10,99\n2,20,98\n")
    src = ost.connect("https://x/g.csv", kind="csv")
    d = ost.create(key="k")
    d.add(src, "x")
    assert list(d.frame().columns) == ["k", "x"]


def test_create_tomt_frame_feiler():
    with pytest.raises(ValueError):
        ost.create(key=["k"]).frame()


# ── api-kinds (spec 2026-07-25-api-kinds-design §1): paritet med
# js/api-kinds.js — samme delte fixtures som tests/js/api-kinds.test.js,
# samme forventede tall begge steder ER kontrakten. ─────────────────────────

WB_FIX = json.loads((pathlib.Path(__file__).parent / "fixtures" / "worldbank_response.json").read_text())
DBN_FIX = json.loads((pathlib.Path(__file__).parent / "fixtures" / "dbnomics_response.json").read_text())


def test_kind_alias_normaliseres():
    assert ost._KIND_ALIAS["oecd"] == "sdmx"
    assert ost._KIND_ALIAS["norgesbank"] == "sdmx"
    assert ost._KIND_ALIAS["worldbank"] == "worldbank"


def test_sdmx_urler_paritet():
    assert ost.sdmx_fallback_url("https://x/data/EXR/all?format=csvfile") == "https://x/data/EXR/all?format=csvdata"
    assert ost.SDMX_ACCEPT == "application/vnd.sdmx.data+csv;labels=id"


def test_worldbank_urler_paritet():
    assert (ost.worldbank_data_url("https://api.worldbank.org/v2/country/NOR/indicator/NY.GDP.MKTP.CD?date=2015:2024")
            == "https://api.worldbank.org/v2/country/NOR/indicator/NY.GDP.MKTP.CD?date=2015:2024&per_page=20000&format=json")
    assert (ost.worldbank_page_url("https://x/v2/country/NOR/indicator/A?date=2015:2024", 3)
            == "https://x/v2/country/NOR/indicator/A?date=2015:2024&per_page=20000&format=json&page=3")


def test_worldbank_meta_og_feilform():
    assert ost.worldbank_meta(WB_FIX["page1"]) == {"pages": 2, "total": 7}
    with pytest.raises(ValueError, match="Invalid value"):
        ost.worldbank_meta(WB_FIX["error"])


def test_worldbank_columns_paritet():
    cols = ost.worldbank_columns([WB_FIX["page1"], WB_FIX["page2"]])
    assert list(cols) == ["indicator", "country", "countryiso3code", "date", "value"]
    assert len(cols["value"]) == 7
    assert cols["indicator"][0] == "NY.GDP.MKTP.CD"
    assert cols["country"][0] == "NO"
    assert cols["date"][0] == "2024"
    assert cols["value"][0] == 500886328034.123
    assert cols["value"][6] is None


def test_dbnomics_paritet():
    assert (ost.dbnomics_data_url("https://x/v22/series/A/B/C?observations=0&limit=5")
            == "https://x/v22/series/A/B/C?limit=5&observations=1")
    cols = ost.dbnomics_columns(DBN_FIX["ok"])
    assert list(cols) == ["series_code", "unit", "weo-country", "weo-subject", "period", "value"]
    assert len(cols["series_code"]) == 6
    assert cols["weo-country"][0] == "NOR"
    assert cols["weo-country"][3] == "SWE"
    assert cols["value"][0] == 2.058
    assert cols["value"][2] is None
    with pytest.raises(ValueError, match="1500 serier"):
        ost.dbnomics_columns(DBN_FIX["overflow"])


def test_connect_read_worldbank(monkeypatch):
    calls = []

    def fake(url, headers=None):
        calls.append(url)
        # NB: "&page=" — bare "page=" matcher også per_page=20000!
        return json.dumps(WB_FIX["page2"] if "&page=" in url else WB_FIX["page1"]).encode()

    monkeypatch.setattr(ost, "_fetch_bytes", fake)
    wb = ost.connect("https://api.worldbank.org/v2", kind="worldbank")
    df = wb.read("country/NOR/indicator/NY.GDP.MKTP.CD", date="2015:2024")
    assert calls[0] == "https://api.worldbank.org/v2/country/NOR/indicator/NY.GDP.MKTP.CD?date=2015:2024&per_page=20000&format=json"
    assert "&page=2" in calls[1]
    assert df.shape == (7, 5)


def test_connect_read_sdmx_accept_og_fallback(monkeypatch):
    calls = []

    def fake(url, headers=None):
        calls.append((url, headers))
        if headers and "Accept" in headers:
            raise RuntimeError("HTTP 406 for " + url)   # ECB-veien
        return b"KEY,FREQ,TIME_PERIOD,OBS_VALUE\nEXR.D.USD,D,2026-07-20,1.1426\n"

    monkeypatch.setattr(ost, "_fetch_bytes", fake)
    ecb = ost.connect("https://data-api.ecb.europa.eu/service/data", kind="ecb")
    df = ecb.read("EXR/D.USD.EUR.SP00.A", startPeriod="2026-07-20")
    assert calls[0][1] == {"Accept": ost.SDMX_ACCEPT}
    assert calls[1][0].endswith("format=csvdata")
    assert df.shape == (1, 4)
    assert list(df.columns) == ["KEY", "FREQ", "TIME_PERIOD", "OBS_VALUE"]


# ── kanonisk vokabular fase 2 (spec §3): paritet med translateCanonical
# og sdmx-headerintrospeksjonen i JS — samme fixtures, samme feiltekster. ────

HDR_FIX = json.loads((pathlib.Path(__file__).parent / "fixtures" / "sdmx_headers.json").read_text())


def test_sdmx_key_dims_alle_tre_prefiksformene():
    assert len(ost.sdmx_key_dims(HDR_FIX["oecd"])) == 13
    assert ost.sdmx_key_dims(HDR_FIX["oecd"])[0] == "REF_AREA"
    assert ost.sdmx_key_dims(HDR_FIX["nb"]) == ["FREQ", "BASE_CUR", "QUOTE_CUR", "TENOR"]
    assert ost.sdmx_key_dims(HDR_FIX["ecb"]) == ["FREQ", "CURRENCY", "CURRENCY_DENOM", "EXR_TYPE", "EXR_SUFFIX"]
    assert ost.sdmx_key_dims("A,B,C") == []


def test_sdmx_key_path_paritet():
    dims = ost.sdmx_key_dims(HDR_FIX["oecd"])
    assert ost.sdmx_key_path(dims, {"countries": ["NOR", "SWE"]}) == "NOR+SWE" + "." * 12
    ecb = ost.sdmx_key_dims(HDR_FIX["ecb"])
    assert ost.sdmx_key_path(ecb, {"filters": {"CURRENCY": "USD", "FREQ": "D"}}) == "D.USD..."
    with pytest.raises(ValueError, match="ingen REF_AREA"):
        ost.sdmx_key_path(ecb, {"countries": ["NOR"]})


def test_translate_canonical_worldbank_og_eurostat():
    rest, params, _, _ = ost._translate_canonical(
        "worldbank", "", {"indicators": ["NY.GDP.MKTP.CD"], "countries": ["NOR", "SWE"],
                          "years": {"from": "2015", "to": "2024"}})
    assert rest == "country/NOR;SWE/indicator/NY.GDP.MKTP.CD"
    assert params == ["date=2015:2024"]
    with pytest.raises(ValueError, match="én form"):
        ost._translate_canonical("worldbank", "country/NOR/indicator/A", {"indicators": ["B"]})
    _, ep, _, _ = ost._translate_canonical(
        "eurostat", "nama_10_gdp", {"countries": ["NO", "SE"], "years": {"from": "2020", "to": None},
                                    "filters": {"na_item": "B1GQ"}})
    assert "geo=NO" in ep and "geo=SE" in ep and "sinceTimePeriod=2020" in ep and "na_item=B1GQ" in ep


def test_translate_canonical_pxweb_aar():
    _, p1, _, _ = ost._translate_canonical("pxweb", "05839", {"years": {"from": "2007", "to": "2009"}})
    assert p1 == ["valueCodes[Tid]=2007,2008,2009"]
    _, p2, _, _ = ost._translate_canonical("pxweb", "05839", {"years": {"from": "2007", "to": None}})
    assert p2 == ["valueCodes[Tid]=from(2007)"]
    with pytest.raises(ValueError, match="startår"):
        ost._translate_canonical("pxweb", "05839", {"years": {"from": None, "to": "2009"}})


def test_read_sdmx_kanonisk_med_introspeksjon(monkeypatch):
    calls = []

    def fake(url, headers=None):
        calls.append(url)
        if "lastNObservations=1" in url:
            return (HDR_FIX["oecd"] + "\nOECD.X:Y(1.1),COL,A,LFEXP,Y,Y0,M,_Z,_Z,_Z,_Z,_Z,_Z,_Z,2023,73.8,1,,,,0\n").encode()
        return ("DATAFLOW,REF_AREA,TIME_PERIOD,OBS_VALUE\nX:Y(1.1),NOR,2023,84.2\n").encode()

    monkeypatch.setattr(ost, "_fetch_bytes", fake)
    o = ost.connect("https://sdmx.oecd.org/public/rest/data", kind="oecd")
    df = o.read("OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE", countries=["NOR", "SWE"], years="2020:2023")
    assert "/all?lastNObservations=1" in calls[0]
    assert "/NOR+SWE" + "." * 12 + "?" in calls[1]
    assert "startPeriod=2020" in calls[1] and "endPeriod=2023" in calls[1]
    assert df.shape == (1, 4)


def test_read_dbnomics_kanonisk_aarsfilter(monkeypatch):
    monkeypatch.setattr(ost, "_fetch_bytes",
                        lambda url, headers=None: json.dumps(DBN_FIX["ok"]).encode())
    dbn = ost.connect("https://api.db.nomics.world/v22/series", kind="dbnomics")
    df = dbn.read("IMF/WEO:latest/NOR.NGDP_RPCH", years="2025:2026")
    assert list(df["period"]) == ["2025", "2026", "2025", "2026"]


def test_dataset_join_merges_on_explicit_key():
    a = pd.DataFrame({"k": [1, 2], "x": [10, 20]})
    b = pd.DataFrame({"k": [1, 2], "y": [7, 8]})
    d = ost.create(key="k")
    d.add(a, "x")
    d.join(b, on="k")
    out = d.frame()
    assert list(out.columns) == ["k", "x", "y"]
    assert out["y"].tolist() == [7, 8]


def test_dataset_join_how_outer():
    a = pd.DataFrame({"k": [1, 2], "x": [10, 20]})
    b = pd.DataFrame({"k": [2, 3], "y": [8, 9]})
    d = ost.create(key="k")
    d.add(a, "x").join(b, on="k", how="outer")
    assert len(d.frame()) == 3


def test_dataset_join_uten_add_feiler():
    d = ost.create(key="k")
    with pytest.raises(ValueError, match="add"):
        d.join(pd.DataFrame({"k": [1]}), on="k")


def test_dataset_join_manglende_noekkelkolonne_navngir_siden():
    d = ost.create(key="k")
    d.add(pd.DataFrame({"k": [1], "x": [1]}), "x")
    with pytest.raises(ValueError, match="høyre"):
        d.join(pd.DataFrame({"annet": [1]}), on="k")


def test_create_format_leveres_ikke_bare_lagres():
    import polars
    frame = pd.DataFrame({"k": [1], "x": [2]})
    assert isinstance(ost.create(key="k", format="pandas").add(frame, "x").frame(), pd.DataFrame)
    assert isinstance(ost.create(key="k", format="polars").add(frame, "x").frame(), polars.DataFrame)
    assert hasattr(ost.create(key="k", format="duckdb").add(frame, "x").frame(), "df")


def test_create_format_r_only_og_ukjent_feiler():
    frame = pd.DataFrame({"k": [1], "x": [2]})
    with pytest.raises(ValueError, match="R-modus"):
        ost.create(key="k", format="tibble").add(frame, "x").frame()
    with pytest.raises(ValueError, match="ukjent format"):
        ost.create(key="k", format="arrow").add(frame, "x").frame()


def test_editor_only_kwargs_are_rejected_loudly():
    src = ost.connect("https://x/d.csv", kind="csv")
    for bad in ("secret_key", "key", "exec", "cache"):
        with pytest.raises(ValueError, match=bad):
            src.read(**{bad: "ask"})


def test_source_kwarg_er_ikke_avvist():
    # source= er en ekte World Bank-parameter (?source=<db-id>). Editor-formen
    # er ost.use(navn, source=…), som ikke finnes i pakken.
    src = ost.connect("https://api.worldbank.org/v2", kind="worldbank")
    try:
        src.read("country/NOR/indicator/NY.GDP.MKTP.CD", source="2")
    except ValueError as e:
        assert "editor-argument" not in str(e), e
    except Exception:
        pass          # nettverksfeil er greit — vi tester bare at den slipper vakten


def test_ost_use_feiler_hoeylytt():
    with pytest.raises(ValueError, match="editoren"):
        ost.use("df", source="python")


def test_all_kwarg_er_kanonisk_ikke_raa_spoerringsparameter():
    # Uten «all» i _CANONICAL_KEYS falt all=True gjennom som «&all=True» —
    # kilden ignorerer den, og brukeren som ba om ALLE verdier fikk kildens
    # standardutvalg uten et ord. Spec §0: aldri stille passthrough.
    q = {"all": True, "regions": ["0"]}
    assert ost._canonical_from_query(q) == {"all": True, "regions": ["0"]}
    assert q == {}, "all/regions skal være konsumert, ikke bli spørringsparametere"


def test_all_feiler_hoeylytt_i_pakken():
    with pytest.raises(ValueError, match="editoren"):
        ost._translate_canonical("pxweb", "05839", {"all": True})
    for kind in ("sdmx", "worldbank", "dbnomics", "eurostat"):
        with pytest.raises(ValueError, match="kun for pxweb"):
            ost._translate_canonical(kind, "x", {"all": True})


# ── Typet kanonisk vei (plan 2026-07-27): json-stat2 bærer typesystemet —
# roller (time/metric), kategorirekkefølge (index), etiketter og enheter.
# Før dette parset vi det og kastet alt unntatt koder+verdier. ──────────────

def test_typemeta_from_jsonstat_ekstraherer_kontrakten():
    tm = ost.typemeta_from_jsonstat(FIX)
    assert tm["time"] == ["Tid"]
    assert tm["metric"] == ["ContentsCode"]
    assert tm["dims"]["Kjonn"]["categories"] == ["1", "2"]          # index-orden
    assert tm["dims"]["Kjonn"]["labels"] == {"1": "Menn", "2": "Kvinner"}
    assert tm["units"] == {"Personer": {"base": "personer", "decimals": 0}}


def test_apply_typemeta_dimensjoner_blir_categorical_i_kildens_orden():
    tm = ost.typemeta_from_jsonstat(FIX)
    df = pd.DataFrame(ost.columns_from_jsonstat(FIX))
    out = ost.apply_typemeta(df, tm)
    assert str(out["Kjonn"].dtype) == "category"
    assert list(out["Kjonn"].cat.categories) == ["1", "2"]
    assert not out["Kjonn"].cat.ordered
    assert str(out["ContentsCode"].dtype) == "category"


def test_apply_typemeta_tidsregelen_heltallsaar_blir_int():
    # role=time + alle koder heltallsparsbare -> int64 (aritmetikk/regresjon/
    # plotting krever tall; ordinaliteten ivaretas av tallinjen selv).
    tm = ost.typemeta_from_jsonstat(FIX)
    df = pd.DataFrame(ost.columns_from_jsonstat(FIX))
    out = ost.apply_typemeta(df, tm)
    assert str(out["Tid"].dtype) == "int64"
    assert out["Tid"].max() == 2021


def test_apply_typemeta_tidsregelen_kvartaler_blir_ordnet_categorical():
    # «2024K1» kan ikke bli tall — DER er ordnet Categorical med kildens
    # index-rekkefølge nøyaktig riktig (alfabetisk sortering er tilfeldig).
    fx = json.loads(json.dumps(FIX))
    fx["dimension"]["Tid"]["category"]["index"] = ["2024K4", "2025K1"]
    fx["dimension"]["Tid"]["category"]["label"] = {"2024K4": "2024K4", "2025K1": "2025K1"}
    tm = ost.typemeta_from_jsonstat(fx)
    df = pd.DataFrame(ost.columns_from_jsonstat(fx))
    out = ost.apply_typemeta(df, tm)
    assert str(out["Tid"].dtype) == "category"
    assert out["Tid"].cat.ordered
    assert list(out["Tid"].cat.categories) == ["2024K4", "2025K1"]


def test_apply_typemeta_value_blir_numerisk_ogsaa_med_hull():
    # Sparse verdi-objekt gir None-hull; uten koersjon ble kolonnen object.
    fx = json.loads(json.dumps(FIX))
    fx["value"] = {"0": 10, "3": 21}
    tm = ost.typemeta_from_jsonstat(fx)
    df = pd.DataFrame(ost.columns_from_jsonstat(fx))
    out = ost.apply_typemeta(df, tm)
    assert str(out["value"].dtype) == "float64"
    assert out["value"].isna().sum() == 2


def test_apply_typemeta_attrs_baerer_etiketter_og_enheter():
    tm = ost.typemeta_from_jsonstat(FIX)
    df = pd.DataFrame(ost.columns_from_jsonstat(FIX))
    out = ost.apply_typemeta(df, tm)
    meta = out.attrs["ost_typemeta"]
    assert meta["dims"]["Kjonn"]["labels"]["1"] == "Menn"
    assert meta["units"]["Personer"]["decimals"] == 0


def test_typemeta_uten_role_og_label_degraderer_pent():
    fx = {"id": ["A"], "size": [2],
          "dimension": {"A": {"category": {"index": {"x": 0, "y": 1}}}},
          "value": [1, 2]}
    tm = ost.typemeta_from_jsonstat(fx)
    assert tm["time"] == [] and tm["units"] == {}
    df = pd.DataFrame(ost.columns_from_jsonstat(fx))
    out = ost.apply_typemeta(df, tm)
    assert str(out["A"].dtype) == "category"


def test_source_read_pxweb_leverer_typet(monkeypatch):
    # Hele veien: read() på en pxweb-kilde skal levere typet ramme.
    monkeypatch.setattr(ost, "_fetch_bytes",
                        lambda url, headers=None: json.dumps(FIX).encode())
    src = ost.connect("https://x.example/tables", kind="pxweb")
    df = src.read("09999")
    assert str(df["Kjonn"].dtype) == "category"
    assert str(df["Tid"].dtype) == "int64"
    assert df.attrs["ost_typemeta"]["dims"]["Kjonn"]["labels"]["2"] == "Kvinner"


def test_js_apply_source_paritet_inkl_nullpadde_koder():
    """Håndhever at python-kilden i js/pxweb.js (pyApplyTypemetaSource, injisert
    i Pyodide-preamblet) oppfører seg som openstat.py sin apply_typemeta —
    OGSÅ gjennom CSV-rundturen appen faktisk gjør, der null-padde koder
    («0301») ellers ville blitt tall og kategorisering gitt stille NaN."""
    import io
    import subprocess
    import shutil

    if not shutil.which("node"):
        import pytest as _pt
        _pt.skip("node ikke tilgjengelig")
    src = subprocess.run(
        ["node", "-e", "require('./js/pxweb.js');console.log(globalThis.PxWeb.pyApplyTypemetaSource())"],
        capture_output=True, text=True, cwd=str(pathlib.Path(__file__).resolve().parents[1]), check=True,
    ).stdout
    ns = {"pd": pd}
    exec(src, ns)

    fx = json.loads(json.dumps(FIX))
    fx["id"] = ["Region"] + fx["id"]
    fx["size"] = [1] + fx["size"]
    fx["dimension"]["Region"] = {"category": {"index": {"0301": 0}, "label": {"0301": "Oslo"}}}
    fx["value"] = fx["value"]  # 1x2x2x1 = 4 verdier, uendret
    tm = ost.typemeta_from_jsonstat(fx)
    cols = ost.columns_from_jsonstat(fx)

    # openstat.py-veien (ingen CSV): direkte
    ref = ost.apply_typemeta(pd.DataFrame(cols), tm)

    # app-veien: CSV-rundtur + dtype-vern + JS-kildens apply
    csv_text = ",".join(cols.keys()) + "\n" + "\n".join(
        ",".join(str(cols[k][i]) for k in cols) for i in range(4))
    df = pd.read_csv(io.StringIO(csv_text), dtype={str(k): str for k in tm["dims"]})
    out = ns["_ost_apply_typemeta"](df, tm)

    assert str(out["Region"].dtype) == "category"
    assert list(out["Region"].cat.categories) == ["0301"]
    assert out["Region"].isna().sum() == 0, "null-padde koder overlevde IKKE rundturen"
    for col in ref.columns:
        assert str(out[col].dtype) == str(ref[col].dtype), col
    assert out["Tid"].tolist() == ref["Tid"].tolist()
    assert out.attrs["ost_typemeta"]["units"] == ref.attrs["ost_typemeta"]["units"]


def test_recognize_url_fixture():
    cases = json.loads((pathlib.Path(__file__).parent / "fixtures" / "recognize_urls.json").read_text())["cases"]
    for c in cases:
        assert ost.recognize_url(c["url"]) == c["expect"], c["url"]


def _mini_jsonstat():
    return {"id": ["Region", "Tid"], "size": [2, 2],
            "role": {"time": ["Tid"]},
            "dimension": {
                "Region": {"category": {"index": {"0301": 0, "1103": 1},
                                        "label": {"0301": "Oslo", "1103": "Stavanger"}}},
                "Tid": {"category": {"index": {"2023": 0, "2024": 1},
                                     "label": {"2023": "2023", "2024": "2024"}}}},
            "value": [1, 2, 3, 4]}


def test_apply_meta_best_effort_koder_types(monkeypatch):
    tm = ost.typemeta_from_jsonstat(_mini_jsonstat())
    monkeypatch.setattr(ost, "_typemeta_for", lambda *a: tm)
    df = pd.DataFrame({"Region": ["0301", "1103"], "Tid": ["2023", "2024"], "verdi": [1.0, 2.0]})
    out = ost.apply_meta(df, "https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?x=1")
    assert str(out["Region"].dtype) == "category"
    assert str(out["Tid"].dtype) == "int64"          # tidsregelen
    assert out.attrs["ost_typemeta"]["dims"]["Region"]["labels"]["0301"] == "Oslo"
    assert str(out["verdi"].dtype) == "float64"       # value røres ikke


def test_apply_meta_usetexts_etiketter_typles_ikke(monkeypatch):
    tm = ost.typemeta_from_jsonstat(_mini_jsonstat())
    monkeypatch.setattr(ost, "_typemeta_for", lambda *a: tm)
    df = pd.DataFrame({"Region": ["Oslo", "Stavanger"], "Tid": ["2023", "2024"]})
    out = ost.apply_meta(df, "https://data.ssb.no/api/pxwebapi/v2/tables/05839/data")
    assert _er_tekst(out["Region"])       # etikett-verdier: aldri dtype-endring
    assert "ost_typemeta" in out.attrs                 # men attrs settes (panel)


def test_apply_meta_ukjent_url_feiler_hoylytt():
    with pytest.raises(ValueError, match="gjenkjen"):
        ost.apply_meta(pd.DataFrame(), "https://example.com/x.csv")


def test_read_csv_passthrough_ukjent(monkeypatch):
    monkeypatch.setattr(ost, "_fetch_bytes", lambda url, headers=None: b"a,b\n1,2\n")
    out = ost.read_csv("https://example.com/x.csv")
    assert list(out.columns) == ["a", "b"] and "ost_typemeta" not in out.attrs


def test_read_csv_gjenkjent_dtype_str_vern(monkeypatch):
    tm = ost.typemeta_from_jsonstat(_mini_jsonstat())
    monkeypatch.setattr(ost, "_typemeta_for", lambda *a: tm)
    monkeypatch.setattr(ost, "_fetch_bytes",
                        lambda url, headers=None: b"Region,Tid,verdi\n0301,2023,1\n1103,2024,2\n")
    out = ost.read_csv("https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?outputFormat=csv")
    # 0301-fella: uten vern hadde pandas gjort Region til int64 (301)
    assert str(out["Region"].dtype) == "category"
    assert list(out["Region"].astype(str)) == ["0301", "1103"]


def test_apply_meta_nan_i_tidskolonne_gir_nullable_int64(monkeypatch):
    # NaN i intlike tidskolonne: astype("int64") kaster — nullable "Int64"
    # bevarer BÅDE aritmetikk OG hullet. Uten NaN forblir det "int64".
    tm = ost.typemeta_from_jsonstat(_mini_jsonstat())
    monkeypatch.setattr(ost, "_typemeta_for", lambda *a: tm)
    df = pd.DataFrame({"Region": ["0301", "1103"], "Tid": ["2023", None]})
    out = ost.apply_meta(df, "https://data.ssb.no/api/pxwebapi/v2/tables/05839/data")
    assert str(out["Tid"].dtype) == "Int64"
    assert out["Tid"].tolist()[0] == 2023
    assert pd.isna(out["Tid"].tolist()[1])


def test_read_csv_delvis_dtype_dict_beholder_str_vernet(monkeypatch):
    # Delvis brukersendt dtype-DICT skal IKKE slå av str-vernet for dim-
    # kolonner brukeren ikke selv navnga (0301-fella). Brukerens egne vinner.
    tm = ost.typemeta_from_jsonstat(_mini_jsonstat())
    monkeypatch.setattr(ost, "_typemeta_for", lambda *a: tm)
    monkeypatch.setattr(ost, "_fetch_bytes",
                        lambda url, headers=None: b"Region,Tid,verdi\n0301,2023,1\n1103,2024,2\n")
    out = ost.read_csv("https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?outputFormat=csv",
                       dtype={"verdi": "float64"})
    assert str(out["Region"].dtype) == "category"
    assert list(out["Region"].astype(str)) == ["0301", "1103"]
    assert str(out["verdi"].dtype) == "float64"


# ── C1 (slutt-review, KRITISK): parse_dates + injisert dtype=str-vern på
# SAMME kolonne er en kjent pandas-felle — kombinasjonen gir stille
# datetime -> epoch-nanosekund-STRENGER i stedet for datetime64 (målt med
# ekte pandas før fiksen: Tid ble "1672531200000000000" som object-dtype).
# parse_dates-kolonner skal derfor ALDRI havne i vern-dicten. ────────────────

def test_read_csv_parse_dates_ekskluderer_kolonne_fra_dtype_vern(monkeypatch):
    tm = ost.typemeta_from_jsonstat(_mini_jsonstat())
    monkeypatch.setattr(ost, "_typemeta_for", lambda *a: tm)
    monkeypatch.setattr(
        ost, "_fetch_bytes",
        lambda url, headers=None: b"Region,Tid,verdi\n0301,2023-01-01,1\n1103,2024-01-01,2\n")
    out = ost.read_csv("https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?outputFormat=csv",
                       parse_dates=["Tid"])
    assert str(out["Tid"].dtype).startswith("datetime64"), \
        "Tid skal parses som datetime64 — ikke tvinges til str (epoch-korrupsjon)"
    assert out["Tid"].tolist() == [pd.Timestamp("2023-01-01"), pd.Timestamp("2024-01-01")]
    # 0301-fella skal fortsatt være dekket for kolonnen brukeren IKKE nevnte:
    assert str(out["Region"].dtype) == "category"
    assert list(out["Region"].astype(str)) == ["0301", "1103"]


def test_parse_dates_exclusion_helper():
    # Direkte kontrakt-test av hjelperen: liste/nested-liste ekskluderer
    # navngitte kolonner; True/uklar (dict-)form dropper HELE injeksjonen
    # konservativt (vi kan ikke si sikkert hvilke kolonner som er berørt).
    assert ost._parse_dates_exclusion(None) == (False, set())
    assert ost._parse_dates_exclusion(False) == (False, set())
    assert ost._parse_dates_exclusion(True) == (True, set())
    assert ost._parse_dates_exclusion(["Tid"]) == (False, {"Tid"})
    assert ost._parse_dates_exclusion([["Tid", "time"], "Region"]) == \
        (False, {"Tid", "time", "Region"})
    assert ost._parse_dates_exclusion({"dato": ["Tid"]}) == (True, set())


# ── eksplisitt-dtypes-kirurgien (2026-07-28, Hans' overraskelsesprinsipp):
# rå pd.read_csv skal ALDRI magisk endre dtyper — read_csv(convert=False) og
# convert_dtypes() er de nye TDD-flatene. convert=True (default, urørt
# ovenfor) er presis den gamle fødselstypingen. ─────────────────────────────

def test_read_csv_convert_false_gir_attrs_men_naken_dtype(monkeypatch):
    # DET er poenget: uten eksplisitt konvertering blir "0301" til int64 301
    # — samme 0301-fellen som convert=True (default) beskytter mot. attrs
    # settes likevel (panelet trenger dem uansett).
    tm = ost.typemeta_from_jsonstat(_mini_jsonstat())
    monkeypatch.setattr(ost, "_typemeta_for", lambda *a: tm)
    monkeypatch.setattr(ost, "_fetch_bytes",
                        lambda url, headers=None: b"Region,Tid,verdi\n0301,2023,1\n1103,2024,2\n")
    out = ost.read_csv("https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?outputFormat=csv",
                       convert=False)
    assert str(out["Region"].dtype) == "int64"
    assert out["Region"].tolist() == [301, 1103]
    assert out.attrs["ost_typemeta"] is tm


def test_read_csv_convert_false_ukjent_url_ingen_attrs(monkeypatch):
    monkeypatch.setattr(ost, "_fetch_bytes", lambda url, headers=None: b"a,b\n1,2\n")
    out = ost.read_csv("https://example.com/x.csv", convert=False)
    assert list(out.columns) == ["a", "b"] and "ost_typemeta" not in out.attrs


def test_convert_dtypes_med_meta_dict_speiler_apply_best_effort():
    tm = ost.typemeta_from_jsonstat(_mini_jsonstat())
    df = pd.DataFrame({"Region": ["0301", "1103"], "Tid": ["2023", "2024"], "verdi": [1.0, 2.0]})
    out = ost.convert_dtypes(df, meta=tm)
    assert out is df, "muterer in-place og returnerer samme ramme"
    assert str(out["Region"].dtype) == "category"
    assert str(out["Tid"].dtype) == "int64"


def test_convert_dtypes_med_meta_url_gjenbruker_apply_meta(monkeypatch):
    tm = ost.typemeta_from_jsonstat(_mini_jsonstat())
    monkeypatch.setattr(ost, "_typemeta_for", lambda *a: tm)
    df = pd.DataFrame({"Region": ["0301", "1103"], "Tid": ["2023", "2024"], "verdi": [1.0, 2.0]})
    out = ost.convert_dtypes(df, meta="https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?x=1")
    assert str(out["Region"].dtype) == "category"
    assert out.attrs["ost_typemeta"] is tm


def test_convert_dtypes_med_meta_url_ukjent_feiler_hoylytt():
    with pytest.raises(ValueError, match="gjenkjen"):
        ost.convert_dtypes(pd.DataFrame(), meta="https://example.com/x.csv")


def test_convert_dtypes_heuristikk_dato_kolonne_blir_datetime64():
    df = pd.DataFrame({"dato": ["2023-01-01", "2024-06-15", None]})
    out = ost.convert_dtypes(df)
    assert str(out["dato"].dtype).startswith("datetime64")
    assert out["dato"].tolist()[:2] == [pd.Timestamp("2023-01-01"), pd.Timestamp("2024-06-15")]


def test_convert_dtypes_heuristikk_0301_kolonne_forblir_str():
    # Kommunenummer-vernet: en kolonne med ledende-null-koder skal IKKE
    # numerisk-konverteres av heuristikken (0301->301-fella igjen).
    df = pd.DataFrame({"kommune": ["0301", "1103", "0104"]})
    out = ost.convert_dtypes(df)
    assert _er_tekst(out["kommune"])
    assert list(out["kommune"]) == ["0301", "1103", "0104"]


def test_convert_dtypes_heuristikk_numerisk_kolonne_blir_tall():
    df = pd.DataFrame({"antall": ["1", "2", "3", "4"]})
    out = ost.convert_dtypes(df)
    assert pd.api.types.is_numeric_dtype(out["antall"])
    assert out["antall"].tolist() == [1, 2, 3, 4]


def test_convert_dtypes_heuristikk_lavkardinalitet_blir_category():
    df = pd.DataFrame({"landsdel": ["Øst", "Vest", "Øst", "Sør", "Øst", "Vest", "Øst", "Sør"]})
    out = ost.convert_dtypes(df)
    assert str(out["landsdel"].dtype) == "category"


def test_convert_dtypes_heuristikk_blandet_soppel_urort():
    # Ingen ISO-dato, ingen fullt numerisk-parsbar kolonne, og for høy
    # kardinalitet til category (alle unike) — skal forbli helt urørt.
    df = pd.DataFrame({"rot": ["7xk2", "abc-2024", "?!", "3.14.15", "siste"]})
    out = ost.convert_dtypes(df)
    assert _er_tekst(out["rot"])
    assert list(out["rot"]) == ["7xk2", "abc-2024", "?!", "3.14.15", "siste"]


def test_convert_dtypes_ugyldig_meta_type_feiler():
    with pytest.raises(TypeError):
        ost.convert_dtypes(pd.DataFrame(), meta=123)


def test_convert_dtypes_i_all():
    assert "convert_dtypes" in ost.__all__


# ── runtime-ost: _fetch_bytes via ReadBridge i emscripten ────────────────────
# Fake js-modul + sys.platform-monkeypatch: emscripten-grenen er ren Python
# (sene js-imports), så den kan testes i CPython uten Pyodide.

class _FakeJsBytes:
    def __init__(self, data):
        self._d = data

    def to_py(self):
        return bytearray(self._d)


class _FakeJsResult:
    def __init__(self, data=None, error=None):
        self.bytes = _FakeJsBytes(data) if data is not None else None
        self.error = error


def _install_fake_js(monkeypatch, bridge=None, xhr=None):
    import types
    js = types.ModuleType("js")
    win = types.SimpleNamespace()
    if bridge is not None:
        win.ReadBridge = bridge
    js.window = win
    if xhr is not None:
        js.XMLHttpRequest = xhr
    monkeypatch.setitem(sys.modules, "js", js)
    monkeypatch.setattr(sys, "platform", "emscripten")
    ost._MEMO.clear()


def test_fetch_bytes_emscripten_bro_treff_og_memo(monkeypatch):
    seen = []

    class Bridge:
        @staticmethod
        def forPyodideSync(url, headers_json=None):
            seen.append((url, headers_json))
            return _FakeJsResult(data=b"a,b\n1,2\n")

    _install_fake_js(monkeypatch, bridge=Bridge)
    assert ost._fetch_bytes("https://bro.example/t1.csv") == b"a,b\n1,2\n"
    assert seen == [("https://bro.example/t1.csv", None)]
    # _MEMO-semantikken er uendret: andre kall når aldri broen.
    assert ost._fetch_bytes("https://bro.example/t1.csv") == b"a,b\n1,2\n"
    assert len(seen) == 1


def test_fetch_bytes_emscripten_bro_feil_er_runtimeerror(monkeypatch):
    class Bridge:
        @staticmethod
        def forPyodideSync(url, headers_json=None):
            return _FakeJsResult(error="HTTP 404 for " + url)

    _install_fake_js(monkeypatch, bridge=Bridge)
    with pytest.raises(RuntimeError, match="HTTP 404 for https://bro.example/borte.csv"):
        ost._fetch_bytes("https://bro.example/borte.csv")


def test_fetch_bytes_emscripten_headers_som_json(monkeypatch):
    seen = []

    class Bridge:
        @staticmethod
        def forPyodideSync(url, headers_json=None):
            seen.append(headers_json)
            return _FakeJsResult(data=b"x")

    _install_fake_js(monkeypatch, bridge=Bridge)
    ost._fetch_bytes("https://bro.example/sdmx", headers={"Accept": "text/csv"})
    assert json.loads(seen[0]) == {"Accept": "text/csv"}


def test_fetch_bytes_emscripten_uten_bro_faller_til_xhr(monkeypatch):
    # Standalone Pyodide (JupyterLite o.l.): window finnes, ReadBridge gjør
    # ikke — dagens nakne XHR-vei skal kjøre uendret.
    class _Req:
        status = 200
        responseText = "ab"

        def open(self, *a):
            pass

        def overrideMimeType(self, *a):
            pass

        def setRequestHeader(self, *a):
            pass

        def send(self, *a):
            pass

    class _XHR:
        @staticmethod
        def new():
            return _Req()

    _install_fake_js(monkeypatch, bridge=None, xhr=_XHR)
    assert ost._fetch_bytes("https://uten-bro.example/f.csv") == b"ab"
