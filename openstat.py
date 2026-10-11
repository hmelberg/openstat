"""openstat — connect/read/create/add-verbene i og utenfor nettleseren.

Ring 1-ren (ROADMAP 2026-07-25, pakke-diskusjonen): kun stdlib + pandas som
harde avhengigheter. Samme fil kjører i CPython og i Pyodide/emscripten —
i appen ruter transporten via ReadBridge (delt cache + proxy-fallback),
utenfor appen synkron XHR (pyodide-http-trikset), i CPython urllib.
duckdb brukes KUN hvis den kan importeres (kolonne-pushdown for parquet).

    import openstat as ost
    ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2/tables", kind="pxweb")
    bef = ssb.read("05839", valueCodes={"Tid": "*"})
    panel = ost.create(key=["kommune_nr", "year"])
    panel.add(kilde, "SB12843_KOSTRA_EIENDOMSSKATT_I_ALT")
    df = panel.frame()

pxweb-logikken speiler js/pxweb.js — kontrakts-pariteten håndheves av delt
fixture (tests/fixtures/pxweb_dataset.json) i begge testsuitene.
"""

import io
import json as _json
import re as _re
import sys

import pandas as pd

__all__ = ["connect", "read", "create", "datasets",
           "data_url", "metadata_url", "eurostat_data_url", "recognize_url", "columns_from_jsonstat",
           "read_csv", "apply_meta", "convert_dtypes",
           "SDMX_ACCEPT", "sdmx_fallback_url", "worldbank_data_url", "worldbank_page_url",
           "worldbank_meta", "worldbank_columns", "dbnomics_data_url", "dbnomics_columns"]

_MEMO = {}


def _fetch_bytes(url, headers=None):
    """Rå bytes fra URL, memoisert per (URL, headere) i økten. I appen ruter
    emscripten-grenen via ReadBridge («samme bro, to fasader»: delt bytecache
    og proxy-fallback m/ auth ved CORS, som pd.read_csv-fasaden); standalone
    Pyodide uten ReadBridge bruker naken synkron XHR (binærtrygg via
    x-user-defined-charset), CPython urllib."""
    memo_key = (url, tuple(sorted((headers or {}).items())))
    if memo_key in _MEMO:
        return _MEMO[memo_key]
    if sys.platform == "emscripten":
        rb = None
        try:
            from js import window as _w
            rb = getattr(_w, "ReadBridge", None)
        except Exception:
            rb = None
        if rb is not None:
            r = rb.forPyodideSync(url, _json.dumps(headers)) if headers \
                else rb.forPyodideSync(url)
            if r.error:
                raise RuntimeError(str(r.error))
            data = bytes(r.bytes.to_py())
        else:
            from js import XMLHttpRequest
            req = XMLHttpRequest.new()
            req.open("GET", url, False)
            req.overrideMimeType("text/plain; charset=x-user-defined")
            for hk, hv in (headers or {}).items():
                req.setRequestHeader(hk, hv)
            req.send(None)
            if req.status >= 400:
                raise RuntimeError("HTTP " + str(req.status) + " for " + url)
            data = bytes(ord(c) & 0xFF for c in req.responseText)
    else:
        from urllib.request import Request, urlopen
        hdrs = {"User-Agent": "openstat"}
        hdrs.update(headers or {})
        with urlopen(Request(url, headers=hdrs)) as r:
            data = r.read()
    _MEMO[memo_key] = data
    return data


# ── pxweb (paritet med js/pxweb.js — endres den ene, endres den andre) ──────

def _build_url(url, endpoint, force_jsonstat):
    s = str(url or "")
    base, _, query = s.partition("?")
    parts = [p for p in query.split("&") if p]
    if force_jsonstat:
        # outputFormatParams (f.eks. UseTexts) er CSV-visningsparametre —
        # sendt sammen med json-stat2 400-er SSB (målt i metadata-runden).
        parts = [p for p in parts
                 if p.split("=")[0].lower() not in ("outputformat", "outputformatparams")]
    if not any(p.split("=")[0].lower() == "lang" for p in parts):
        parts.insert(0, "lang=no")
    if force_jsonstat:
        parts.append("outputFormat=json-stat2")
    return base.rstrip("/") + "/" + endpoint + "?" + "&".join(parts)


def data_url(url):
    return _build_url(url, "data", True)


def metadata_url(url):
    return _build_url(url, "metadata", False)


def eurostat_data_url(url):
    """Eurostat statistics-API (paritet med js/pxweb.js eurostatDataUrl):
    <base>/<kode>?format=JSON&lang=en&<dim>=<verdi> — json-stat2-svar."""
    s = str(url or "")
    base, _, query = s.partition("?")
    parts = [p for p in query.split("&") if p and p.split("=")[0].lower() != "format"]
    if not any(p.split("=")[0].lower() == "lang" for p in parts):
        parts.insert(0, "lang=en")
    parts.append("format=JSON")
    return base.rstrip("/") + "?" + "&".join(parts)


# ── URL-gjenkjenning (paritet med js/pxweb.js recognizeUrl — endres den ene,
# endres den andre; delt fixture tests/fixtures/recognize_urls.json) ─────────

_RECOGNIZE_PATTERNS = (
    # \Z (ikke $): Pythons $ matcher også RETT FØR en trailing newline, mens
    # JS-tvillingens $ (uten /m) krever bokstavelig slutt på strengen — \Z
    # gir samme (strengere) oppførsel her, så en URL med trailing "\n" IKKE
    # gjenkjennes i CPython når den heller ikke gjør det i JS.
    ("pxweb", r"^(https?://[^/]+.*?/tables)/([A-Za-z0-9_]+)/data\Z"),
    ("eurostat", r"^(https?://ec\.europa\.eu/eurostat/api/dissemination/statistics/1\.0/data)/([A-Za-z0-9_]+)\Z"),
)


def recognize_url(url):
    """Data-URL -> {kind, base, table, query} for kilder med kjent metadata
    (pxweb-familien via /tables/<id>/data-formen, eurostat statistics-api).
    None for alt annet — aldri gjetting. /api/hent-innpakning pakkes ut én
    gang før matching."""
    s = str(url or "")
    if s.startswith("/api/hent?"):
        for part in s.split("?", 1)[1].split("&"):
            if part.startswith("url="):
                s = _unquote(part[4:])
                break
    base, _, query = s.partition("?")
    # Ingen verts-vakt: /tables/<id>/data-formen ER signaturen (verts-
    # agnostisk for pxweb-familien); v0-API-et («/table/<id>», entall, uten
    # /data) matcher aldri mønsteret — fixturens negative case håndhever det.
    for kind, pat in _RECOGNIZE_PATTERNS:
        m = _re.match(pat, base)
        if m:
            return {"kind": kind, "base": m.group(1), "table": m.group(2), "query": query}
    return None


def _unquote(s):
    """URL-dekoding (stdlib unquote — kaster aldri, ugyldig %-koding beholdes
    literal). js-tvillingens recognizeUrl bruker decodeURIComponent, som
    KASTER på samme input — se try/catch der (I2, slutt-reviewen)."""
    from urllib.parse import unquote
    return unquote(s)


def _category_codes(dim):
    idx = ((dim or {}).get("category") or {}).get("index")
    if isinstance(idx, list):
        return [str(c) for c in idx]
    return [c for c, _ in sorted((idx or {}).items(), key=lambda kv: kv[1])]


def columns_from_jsonstat(ds):
    """json-stat2-dataset -> {DimId: [koder], ..., "value": [tall|None]}.
    Row-major over id/size; value kan være array eller sparse objekt."""
    ids = ds.get("id") or []
    size = ds.get("size") or []
    codes = [_category_codes((ds.get("dimension") or {}).get(i)) for i in ids]
    total = 1
    for s in size:
        total *= s
    val = ds.get("value")
    cols = {i: [None] * total for i in ids}
    vals = [None] * total
    for flat in range(total):
        rest = flat
        for d in range(len(ids) - 1, -1, -1):
            cols[ids[d]][flat] = codes[d][rest % size[d]]
            rest //= size[d]
        v = val[flat] if isinstance(val, list) else (val or {}).get(str(flat))
        vals[flat] = None if v is None else v
    cols["value"] = vals
    return cols


# ── Typet kanonisk vei (plan 2026-07-27-typet-kanonisk-vei) ─────────────────
# json-stat2 BÆRER typesystemet: roller (time/metric), kategorirekkefølge
# (category.index), kode->etikett (category.label) og enheter (category.unit).
# Før dette parset vi payloaden og kastet alt unntatt koder+verdier — og
# brukeren måtte selv mappe {"1": "Menn"} for hånd. Kontrakten under deles
# med js/pxweb.js (typeMetaFromJsonStat) via tests/fixtures/pxweb_dataset.json
# — endres den ene siden, endres den andre.

def typemeta_from_jsonstat(ds):
    """json-stat2-dataset -> typekontrakt:
    {dims: {DimId: {categories: [koder i index-orden], labels: {kode: tekst}}},
     time: [DimId...], metric: [DimId...], units: {kode: {base, decimals}}}."""
    role = ds.get("role") or {}
    dims, units = {}, {}
    for did in (ds.get("id") or []):
        cat = ((ds.get("dimension") or {}).get(did) or {}).get("category") or {}
        dims[did] = {"categories": _category_codes({"category": cat}),
                     "labels": dict(cat.get("label") or {})}
        for k, u in (cat.get("unit") or {}).items():
            units[k] = {"base": u.get("base"), "decimals": u.get("decimals")}
    return {"dims": dims,
            "time": list(role.get("time") or []),
            "metric": list(role.get("metric") or []),
            "units": units}


def _all_intlike(codes):
    for c in codes:
        try:
            int(str(c))
        except (TypeError, ValueError):
            return False
    return bool(codes)


def apply_typemeta(df, tm):
    """Typ en columns_from_jsonstat-ramme etter kontrakten. Regler:
    - role=time + alle koder heltallsparsbare -> int64 (aritmetikk/regresjon
      krever tall; Categorical har ingen). Ellers ORDNET Categorical i kildens
      index-orden — «2024K1» sortert alfabetisk er tilfeldig, kildens orden er
      fasit.
    - Øvrige dimensjoner -> uordnet Categorical med kildens kategoriorden
      (typen REISER med kolonnen gjennom operasjoner — attrs gjør ikke det).
    - value -> to_numeric (sparse json-stat2 gir None-hull som ellers gjør
      kolonnen object).
    - Etiketter/enheter/roller -> df.attrs["ost_typemeta"] (visningslag;
      verdiene forblir KODER, som er stabile for joins og replikasjon)."""
    for did, d in (tm.get("dims") or {}).items():
        if did not in df.columns:
            continue
        cats = d.get("categories") or []
        if did in (tm.get("time") or []) and _all_intlike(cats):
            df[did] = df[did].astype("int64")
        else:
            df[did] = pd.Categorical(df[did], categories=cats,
                                     ordered=did in (tm.get("time") or []))
    if "value" in df.columns:
        df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df.attrs["ost_typemeta"] = tm
    return df


# ── portable eksplisitte funksjoner (plan 2026-07-27-metadata-runden Task 2):
# read_csv/apply_meta lar brukeren gjøre henting/parsing selv (egen pandas-
# kode, egne kwargs) og likevel få samme typing+attrs som app-veien
# (connect/read). apply_meta er den eksplisitte tvillingen av fødselstyping —
# HØYLYTT ved ukjent kilde (eksplisitt kall = brukeren mente det); read_csv
# er en pandas-passthrough som skal FØLES som pandas for ukjente URL-er. ────

def _typemeta_for(kind, base, table, query):
    """Typekontrakt for en gjenkjent kilde: json-stat2 m/ SAMME spørring
    (aldri krympet utvalg — top(1)-krymping gir hullete kategorier -> NaN i
    Categorical). _fetch_bytes memoiserer selve bytes-hentingen per økt."""
    target = base.rstrip("/") + "/" + table + (("?" + query) if query else "")
    du = eurostat_data_url(target) if kind == "eurostat" else data_url(target)
    return typemeta_from_jsonstat(_json.loads(_fetch_bytes(du).decode("utf-8")))


def _apply_best_effort(df, tm):
    """Typ kun kolonner hvis verdier er kildens KODER; etikett-verdier
    (UseTexts) får aldri dtype-endring — men attrs settes alltid (panelet
    trenger etikettene uansett)."""
    for did, d in (tm.get("dims") or {}).items():
        if did not in df.columns:
            continue
        cats = [str(c) for c in (d.get("categories") or [])]
        vals = set(df[did].dropna().astype(str))
        if not vals or not vals.issubset(set(cats)):
            continue
        if did in (tm.get("time") or []) and _all_intlike(cats):
            # NaN-hull: astype("int64") kaster — nullable "Int64" bevarer
            # BÅDE aritmetikk OG hullet. Uten hull: vanlig int64 som før.
            df[did] = df[did].astype("Int64" if df[did].isna().any() else "int64")
        else:
            df[did] = pd.Categorical(df[did].astype(str), categories=cats,
                                     ordered=did in (tm.get("time") or []))
    df.attrs["ost_typemeta"] = tm
    return df


def apply_meta(df, url_or_table, base=None):
    """Påfør registermetadata på en ramme du alt har lastet. Portabel
    tvilling av appens fødsels-annotering — samme regler, eksplisitt. Muterer
    rammen in-place og returnerer den (apply_typemeta-presedensen)."""
    rec = recognize_url(url_or_table)
    if rec is None and base:
        rec = {"kind": "pxweb", "base": str(base), "table": str(url_or_table), "query": ""}
    if rec is None:
        raise ValueError("URL-en gjenkjennes ikke som en registerkilde med kjent metadata "
                         "(pxweb/eurostat) — oppgi base= og tabell-id, eller bruk ost.read().")
    return _apply_best_effort(df, _typemeta_for(rec["kind"], rec["base"], rec["table"], rec["query"]))


# ── eksplisitt-dtypes-kirurgien (2026-07-28, Hans' overraskelsesprinsipp):
# rå pd.read_csv skal ALDRI magisk endre dtyper i appen — typing er nå KUN
# eksplisitt, enten via read_csv(url, convert=True) (default; presis den
# gamle fødselstypingen) eller via convert_dtypes() under. ──────────────────

_ISO_DATE_RE = _re.compile(r"^\d{4}-\d{2}-\d{2}([ T].*)?$")


def _is_iso_date_str(s):
    return bool(_ISO_DATE_RE.match(s))


def _has_leading_zero_code(s):
    """0301-mønsteret: heltallsdelen (før et evt. desimalpunktum) starter
    med "0" og er lengre enn ett tegn — beskytter kommune-/postnummer-
    lignende koder fra å bli lest som tall (301 mister null-en) uten å
    blokkere legitime desimaltall som "0.5"."""
    core = s[1:] if s[:1] in ("+", "-") else s
    int_part = core.split(".", 1)[0]
    return len(int_part) > 1 and int_part[0] == "0"


def convert_dtypes(df, meta=None):
    """Eksplisitt dtype-konvertering — erstatningen for automatikken som er
    fjernet fra appen (pd.read_csv endrer aldri dtyper på egen hånd lenger).
    Muterer df in-place og returnerer den (apply_typemeta/apply_meta-
    presedensen).

    - meta som dict (typemeta-kontrakten fra typemeta_from_jsonstat/
      _typemeta_for, f.eks. df.attrs["ost_typemeta"]) -> samme regler som
      _apply_best_effort: koder types (Categorical/int64/Int64), etikett-
      verdier types aldri.
    - meta som str (URL til en gjenkjent registerkilde) -> samme vei som
      apply_meta(df, meta): henter metadata for URL-en og typer etter samme
      regler. HØYLYTT for en URL som ikke gjenkjennes (eksplisitt kall =
      brukeren mente det).
    - meta=None (default) -> konservative heuristikker på object-kolonner,
      hver for seg, KUN når ALLE ikke-NA-verdier i kolonnen matcher (aldri
      kast ved rare data — kolonnen hoppes bare over):
        1. ISO-datomønster (YYYY-MM-DD, ev. med klokkeslett) -> pd.to_datetime.
        2. Fullt numerisk-parsbare UTEN ledende-null-koder (kommunenummer-
           vernet: "0301" forblir str/object) -> pd.to_numeric.
        3. Gjenværende object-kolonner (etter 1/2) med ≤50 unike verdier og
           unike/total ≤ 0.5 -> astype("category")."""
    if isinstance(meta, dict):
        return _apply_best_effort(df, meta)
    if isinstance(meta, str):
        return apply_meta(df, meta)
    if meta is not None:
        raise TypeError("meta må være dict (typemeta), str (URL) eller None (heuristikker)")

    for col in df.columns:
        s = df[col]
        # pandas 3 (pyodide v314) gir tekstkolonner dtype "str", ikke object
        if not (s.dtype == object or pd.api.types.is_string_dtype(s.dtype)):
            continue
        vals = s.dropna()
        if vals.empty:
            continue
        str_vals = vals.astype(str)
        converted = False

        if all(_is_iso_date_str(v) for v in str_vals):
            try:
                df[col] = pd.to_datetime(s, errors="raise")
                converted = True
            except Exception:
                pass  # rar data — hopp over, aldri kast

        if not converted and not any(_has_leading_zero_code(v) for v in str_vals):
            try:
                df[col] = pd.to_numeric(s, errors="raise")
                converted = True
            except Exception:
                pass

        if not converted:
            n = len(vals)
            if vals.nunique() <= 50 and (vals.nunique() / n) <= 0.5:
                df[col] = s.astype("category")

    return df


def _parse_dates_exclusion(parse_dates):
    """Kolonnenavn parse_dates dekker, for å UNNTA dem fra dtype=str-vernet:
    parse_dates OG en tvunget dtype på SAMME kolonne er en kjent pandas-felle
    som gir stille korrupsjon (datetime -> epoch-nanosekund-STRENGER, målt
    med ekte pandas i slutt-reviewen — C1). Returnerer (drop_all, names):
    drop_all=True betyr at HELE vern-injeksjonen droppes konservativt
    (parse_dates=True — meningen er indeks-parsing, ingen navngitte
    kolonner å ekskludere trygt — eller en form vi ikke leser trygt, f.eks.
    dict-formen). names dekker liste- OG nested-liste-formen (pandas slår
    sammen f.eks. parse_dates=[["a", "b"]] til én dato-kolonne av a+b)."""
    if parse_dates is None or parse_dates is False:
        return False, set()
    if parse_dates is True:
        return True, set()
    if isinstance(parse_dates, (list, tuple)):
        names = set()
        for item in parse_dates:
            if isinstance(item, (list, tuple)):
                names.update(str(x) for x in item)
            else:
                names.add(str(item))
        return False, names
    return True, set()  # uklar form (f.eks. dict) -> konservativt: dropp alt


def read_csv(url, convert=True, **kwargs):
    """pd.read_csv med metadata på: gjenkjent register-URL -> CSV-en lastes
    (brukerens form/params) og attrs["ost_typemeta"] settes når metadata er
    tilgjengelig. Ukjent URL -> ren pandas-passthrough, uendret semantikk
    (uansett convert).

    convert=True (default): dagens fulle oppførsel — dim-kolonner får
    dtype=str-vern VED parse (0301-fella kan ikke repareres etterpå), og
    rammen typles best-effort (samme regler som ost.convert_dtypes(df, meta)).

    convert=False (eksplisitt-dtypes-kirurgien 2026-07-28): INGEN dtype-
    påvirkning i det hele tatt — pd.read_csv(**kwargs) kjøres urørt, byte-lik
    naken pandas i verdier/dtyper (kodekolonner som "0301" blir da 301 som
    int64 — DET er poenget: typing er nå kun eksplisitt). Kun attrs settes,
    når metadata finnes. Bruk ost.convert_dtypes(df) etterpå for typing."""
    rec = recognize_url(url)
    raw = io.BytesIO(_fetch_bytes(str(url)))
    if rec is None:
        return pd.read_csv(raw, **kwargs)
    tm = None
    try:
        tm = _typemeta_for(rec["kind"], rec["base"], rec["table"], rec["query"])
    except Exception as e:
        sys.stderr.write("ost.read_csv: metadata utilgjengelig for %s (%s) — laster utypet.\n"
                         % (rec["table"], e))
    if not convert:
        df = pd.read_csv(raw, **kwargs)
        if tm is not None:
            df.attrs["ost_typemeta"] = tm
        return df
    if tm is not None:
        # dtype=str-vernet: brukerens egne valg vinner ALLTID, men et delvis
        # dtype-DICT skal ikke stille slå av vernet for dim-kolonner brukeren
        # ikke selv navnga (da gjenoppstår 0301-fella). Skalar dtype (f.eks.
        # dtype=str) dekker alt selv og respekteres urørt. parse_dates på en
        # dim-kolonne skal ALDRI få dtype=str injisert samtidig (C1 —
        # epoch-nanosekund-korrupsjon); uklar parse_dates-form dropper HELE
        # injeksjonen konservativt.
        drop_all, excluded = _parse_dates_exclusion(kwargs.get("parse_dates"))
        if not drop_all:
            vern = {d: str for d in (tm.get("dims") or {}) if d not in excluded}
            if "dtype" not in kwargs:
                kwargs = dict(kwargs, dtype=vern)
            elif isinstance(kwargs["dtype"], dict):
                kwargs = dict(kwargs, dtype={**vern, **kwargs["dtype"]})
    df = pd.read_csv(raw, **kwargs)
    return _apply_best_effort(df, tm) if tm is not None else df


# ── api-kinds (paritet med js/api-kinds.js — endres den ene, endres den
# andre; kontrakten håndheves av delte fixtures i begge testsuitene).
# Spec docs/superpowers/specs/2026-07-25-api-kinds-design.md §1.
# SDMX-fellen (spec §0): 2.1-API-ene ignorerer ukjente parametre STILLE —
# send aldri noe kilden ikke garantert forstår. ─────────────────────────────

_KIND_ALIAS = {"oecd": "sdmx", "ecb": "sdmx", "norgesbank": "sdmx", "imf": "sdmx",
               "sdmx": "sdmx", "dbnomics": "dbnomics", "worldbank": "worldbank"}

SDMX_ACCEPT = "application/vnd.sdmx.data+csv;labels=id"


def _split_url(url):
    base, _, query = str(url or "").partition("?")
    return base, [p for p in query.split("&") if p]


def _strip_param(parts, name):
    return [p for p in parts if p.split("=")[0].lower() != name]


def sdmx_fallback_url(url):
    """ECB 406-er på Accept-veien men tar format=csvdata (verifisert 2026-07-25)."""
    base, parts = _split_url(url)
    parts = _strip_param(parts, "format")
    parts.append("format=csvdata")
    return base + "?" + "&".join(parts)


def worldbank_data_url(url):
    """format=json tvinges; per_page=20000 når brukeren ikke velger (default 50!)."""
    base, parts = _split_url(url)
    parts = _strip_param(parts, "format")
    if not any(p.split("=")[0].lower() == "per_page" for p in parts):
        parts.append("per_page=20000")
    parts.append("format=json")
    return base + "?" + "&".join(parts)


def worldbank_page_url(url, n):
    base, parts = _split_url(worldbank_data_url(url))
    parts = _strip_param(parts, "page")
    parts.append("page=" + str(n))
    return base + "?" + "&".join(parts)


def worldbank_meta(doc):
    if isinstance(doc, list) and doc and isinstance(doc[0], dict) and "message" in doc[0]:
        msgs = "; ".join(m.get("value") or m.get("key") or "" for m in doc[0]["message"])
        raise ValueError("Verdensbanken avviste spørringen: " + msgs)
    if not isinstance(doc, list) or len(doc) < 2 or not doc[0]:
        raise ValueError("Uventet svar fra Verdensbanken (ikke [meta, rader])")
    return {"pages": int(doc[0].get("pages") or 1), "total": int(doc[0].get("total") or 0)}


def worldbank_columns(docs):
    cols = {"indicator": [], "country": [], "countryiso3code": [], "date": [], "value": []}
    for doc in docs:
        for r in (doc[1] or []):
            r = r or {}
            cols["indicator"].append((r.get("indicator") or {}).get("id") or "")
            cols["country"].append((r.get("country") or {}).get("id") or "")
            cols["countryiso3code"].append(r.get("countryiso3code") or "")
            cols["date"].append(r.get("date") or "")
            cols["value"].append(r.get("value"))
    return cols


def dbnomics_data_url(url):
    """observations=1 tvinges (uten den kommer bare metadata)."""
    base, parts = _split_url(url)
    parts = _strip_param(parts, "observations")
    parts.append("observations=1")
    return base + "?" + "&".join(parts)


def sdmx_key_dims(header_line):
    """Nøkkeldimensjonene fra SDMX-CSV-headeren (paritet med js/api-kinds.js
    sdmxKeyDims): kolonnene mellom prefikset (DATAFLOW | STRUCTURE,
    STRUCTURE_ID,ACTION | KEY) og TIME_PERIOD."""
    cols = str(header_line or "").rstrip("\r").split(",")
    if "TIME_PERIOD" not in cols:
        return []
    t = cols.index("TIME_PERIOD")
    start = 0
    if cols[0] == "STRUCTURE" and len(cols) > 1 and cols[1] == "STRUCTURE_ID":
        start = 3 if len(cols) > 2 and cols[2] == "ACTION" else 2
    elif cols[0] in ("DATAFLOW", "KEY"):
        start = 1
    return cols[start:t]


def sdmx_key_path(dims, canonical):
    """countries → REF_AREA, indicators → MEASURE, filters → navngitt
    dimensjon; flere verdier med + (SDMX-ELLER). Ukjent dimensjon → ValueError
    som lister gyldige (hard-feil-regelen)."""
    want = {}

    def put(dim_id, values, label):
        if dim_id not in dims:
            raise ValueError(label + ": dataflowen har ingen " + dim_id +
                             "-dimensjon — dimensjonene er " + ", ".join(dims))
        want[dims.index(dim_id)] = "+".join(values)

    if canonical.get("countries"):
        put("REF_AREA", canonical["countries"], "countries()")
    if canonical.get("indicators"):
        put("MEASURE", canonical["indicators"], "indicators()")
    for k, v in (canonical.get("filters") or {}).items():
        put(k, [v], "filters(" + k + "=…)")
    return ".".join(want.get(i, "") for i in range(len(dims)))


# «all» hører med her selv om pakken ikke kan utføre den (se _translate_canonical):
# uten den falt all=True gjennom som en RÅ spørringsparameter («&all=True»),
# som kilden ignorerer — brukeren ba om alle verdier og fikk kildens
# standardutvalg, uten et ord. Spec §0: aldri stille passthrough.
_CANONICAL_KEYS = ("years", "countries", "regions", "indicators", "filters", "all")


def _as_code_list(v):
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    return [s for s in _re.split(r"[\s,]+", str(v)) if s]


def _canonical_from_query(query):
    """Trekk kanoniske felt ut av read(**query) — muterer query."""
    c = {}
    for k in _CANONICAL_KEYS:
        if k not in query:
            continue
        v = query.pop(k)
        if k == "years":
            if isinstance(v, (list, tuple)) and len(v) == 2:
                c["years"] = {"from": str(v[0]) if v[0] else None, "to": str(v[1]) if v[1] else None}
            else:
                s = str(v)
                a, sep, b = s.partition(":")
                c["years"] = {"from": a.strip() or None,
                              "to": (b.strip() or None) if sep else (a.strip() or None)}
        elif k == "filters":
            c["filters"] = {str(fk): str(fv) for fk, fv in dict(v).items()}
        elif k == "all":
            c["all"] = bool(v)
        else:
            c[k] = _as_code_list(v)
    return c or None


def _translate_canonical(kind, rest, c):
    """Paritet med js/data-directives.js translateCanonical — samme regler,
    samme feiltekster; -> (rest, params, needs_key, client_years)."""
    params, needs_key, client_years = [], None, None
    y = c.get("years")
    # Speiler js/data-directives.js translateCanonical: all() er kun definert
    # for pxweb. Editoren ekspanderer der de uspesifiserte dimensjonene fra
    # kildens json-stat2-metadata; pakken har ikke det steget, så den sier fra
    # i stedet for å late som (spec §0 — en hard feil slår stille feil data).
    if c.get("all"):
        if kind != "pxweb":
            raise ValueError("all() støttes foreløpig kun for pxweb-kilder — for andre kilder, "
                             "angi utvalg eksplisitt")
        raise ValueError("all=True ekspanderes foreløpig bare i OpenStat-editoren, som leser "
                         "kildens json-stat2-metadata for å liste dimensjonsverdiene. Angi "
                         "utvalget eksplisitt her, f.eks. regions(…), indicators(…) eller "
                         "filters(<variabel>=…)")
    if kind == "worldbank":
        if c.get("regions"):
            raise ValueError("regions() støttes ikke for worldbank — bruk landkoder i countries()")
        if c.get("indicators"):
            if rest:
                raise ValueError("både ressurssti og indicators() angitt — velg én form")
            rest = ("country/" + (";".join(c["countries"]) if c.get("countries") else "all") +
                    "/indicator/" + ";".join(c["indicators"]))
        elif c.get("countries"):
            raise ValueError("countries() uten indicators() for worldbank — angi indikatoren også, "
                             "eller bygg stien selv (country/NOR/indicator/…)")
        if y:
            params.append("date=" + (y["from"] or "1900") + ":" + (y["to"] or "2100"))
        for k, v in (c.get("filters") or {}).items():
            params.append(k + "=" + v)
    elif kind == "eurostat":
        if c.get("indicators"):
            raise ValueError("Eurostat har ikke et felles indikatorbegrep — bruk filters(na_item=…) "
                             "e.l. for dette datasettet")
        for g in (c.get("countries") or []) + (c.get("regions") or []):
            params.append("geo=" + g)
        if y and y["from"]:
            params.append("sinceTimePeriod=" + y["from"])
        if y and y["to"]:
            params.append("untilTimePeriod=" + y["to"])
        for k, v in (c.get("filters") or {}).items():
            params.append(k + "=" + v)
    elif kind == "pxweb":
        if c.get("countries"):
            raise ValueError("countries() gjelder ikke pxweb-kilder (SSB er norske data) — "
                             "bruk regions() eller filters(<variabel>=…)")
        if c.get("regions"):
            params.append("valueCodes[Region]=" + ",".join(c["regions"]))
        if c.get("indicators"):
            params.append("valueCodes[ContentsCode]=" + ",".join(c["indicators"]))
        if y:
            if y["from"] and y["to"]:
                a, b = int(y["from"]), int(y["to"])
                if b < a or b - a > 500:
                    raise ValueError("years(%s:%s): kan ikke enumerere intervallet for pxweb — bruk "
                                     "filters(Tid=…)" % (y["from"], y["to"]))
                params.append("valueCodes[Tid]=" + ",".join(str(x) for x in range(a, b + 1)))
            elif y["from"]:
                params.append("valueCodes[Tid]=from(" + y["from"] + ")")
            else:
                raise ValueError("years(:%s) for pxweb: angi startår også — from()-uttrykket har "
                                 "ingen bakover-variant" % y["to"])
        for k, v in (c.get("filters") or {}).items():
            params.append("valueCodes[" + k + "]=" + v)
    elif kind == "sdmx":
        if c.get("regions"):
            raise ValueError("regions() støttes ikke for sdmx-kilder — bruk countries() (REF_AREA) "
                             "eller filters(<DIM>=…)")
        if y and y["from"]:
            params.append("startPeriod=" + y["from"])
        if y and y["to"]:
            params.append("endPeriod=" + y["to"])
        if c.get("countries") or c.get("indicators") or c.get("filters"):
            needs_key = {"countries": c.get("countries"), "indicators": c.get("indicators"),
                         "filters": c.get("filters")}
    elif kind == "dbnomics":
        if c.get("countries") or c.get("indicators") or c.get("regions") or c.get("filters"):
            raise ValueError("countries()/indicators()/filters() støttes ikke for dbnomics — "
                             "dimensjonene ligger i serie-masken i stien "
                             "(f.eks. IMF/WEO:latest/NOR+SWE.NGDP_RPCH)")
        if y:
            client_years = y
    return rest, params, needs_key, client_years


def dbnomics_columns(doc):
    series = (doc or {}).get("series") or {}
    docs = series.get("docs") or []
    if (series.get("num_found") or 0) > len(docs):
        raise ValueError("DBnomics-spørringen traff " + str(series["num_found"]) + " serier, men "
                         "API-et leverer maks " + str(series.get("limit") or len(docs)) +
                         " — snevre inn med dimensjonsfiltre i stien")
    dim_names = sorted({k for d in docs for k in (d.get("dimensions") or {})})
    cols = {"series_code": []}
    for k in dim_names:
        cols[k] = []
    cols["period"] = []
    cols["value"] = []
    for d in docs:
        periods = d.get("period") or []
        values = d.get("value") or []
        for i, per in enumerate(periods):
            cols["series_code"].append(d.get("series_code") or "")
            for k in dim_names:
                cols[k].append(str((d.get("dimensions") or {}).get(k) or ""))
            cols["period"].append(str(per))
            v = values[i] if i < len(values) else None
            cols["value"].append(None if v is None or v == "NA" else v)
    return cols


# ── verbene ──────────────────────────────────────────────────────────────────

_SNIFF = ((".parquet", "parquet"), (".csv", "csv"), (".json", "json"))


def _sniff_kind(url):
    base = url.split("?")[0].lower()
    for ext, kind in _SNIFF:
        if base.endswith(ext):
            return kind
    return "csv"


# Editor-argumenter har ingen mening utenfor nettleseren. Uten denne vakten
# blir de STILLE til spørringsparametere: read(url, secret_key="ask") ville
# sendt «secret_key=ask» til kilden og fått et rart svar i stedet for en feil.
# «source» står bevisst IKKE her — det er en ekte World Bank-parameter
# (?source=<db-id>), og editor-formen er ost.use(navn, source=…), som ikke
# finnes i pakken (se use() nederst).
_EDITOR_ONLY = {
    "secret_key": "nøkkelhåndtering skjer i nettleseren (passordmodal / lagret nøkkel)",
    "key":        "nøkkelhåndtering skjer i nettleseren — argumentet het «key» før 2026-07-26",
    "exec":       "kjøringslokalitet (lokal/server) er en editor-innstilling",
    "cache":      "cache= bruker nettleserens Cache-API",
}


class Source:
    """Én datakilde: en fil-URL eller en API-base (kind='pxweb')."""

    def __init__(self, url, kind=None):
        self.url = str(url)
        self.kind = kind

    def read(self, table=None, columns=None, **query):
        for _bad in _EDITOR_ONLY:
            if _bad in query:
                raise ValueError(
                    "«%s» er et editor-argument uten mening utenfor nettleseren (%s). "
                    "Fjern det, eller kjør scriptet i OpenStat." % (_bad, _EDITOR_ONLY[_bad]))
        kind = self.kind or _sniff_kind(self.url)
        kind = _KIND_ALIAS.get(str(kind).lower(), kind)
        if kind in ("sdmx", "worldbank", "dbnomics"):
            canonical = _canonical_from_query(query)
            rest = str(table) if table else ""
            needs_key = client_years = None
            qs = ["%s=%s" % (k, v) for k, v in query.items()]
            if canonical:
                rest, cparams, needs_key, client_years = _translate_canonical(kind, rest, canonical)
                qs += cparams
            if not rest:
                raise ValueError(kind + "-kilder krever en ressurssti: kilde.read('EXR/D.USD.EUR.SP00.A')")
            target = self.url.rstrip("/") + "/" + rest + (("?" + "&".join(qs)) if qs else "")

            def _sdmx_csv(url):
                try:
                    return _fetch_bytes(url, headers={"Accept": SDMX_ACCEPT})
                except Exception:
                    return _fetch_bytes(sdmx_fallback_url(url))   # ECB-veien
            if kind == "sdmx":
                if needs_key:
                    # Kanonisk countries()/indicators()/filters(): nøkkelen
                    # bygges fra CSV-headeren til en lastNObservations=1-probe
                    # (query-params ville blitt STILLE ignorert, spec §0).
                    base = self.url.rstrip("/") + "/" + rest
                    probe = _sdmx_csv(base + "/all?lastNObservations=1")
                    dims = sdmx_key_dims(probe.decode("utf-8").split("\n")[0])
                    if not dims:
                        raise ValueError("fant ikke dimensjonene i kildens CSV-header — angi nøkkelstien selv")
                    target = base + "/" + sdmx_key_path(dims, needs_key) + (("?" + "&".join(qs)) if qs else "")
                raw = _sdmx_csv(target)
                df = pd.read_csv(io.BytesIO(raw))
            elif kind == "worldbank":
                docs = [_json.loads(_fetch_bytes(worldbank_data_url(target)).decode("utf-8"))]
                meta = worldbank_meta(docs[0])
                if meta["pages"] > 10:
                    raise ValueError(str(meta["total"]) + " rader fordelt på " + str(meta["pages"]) +
                                     " sider — snevre inn spørringen (date=…, færre land/indikatorer)")
                for p in range(2, meta["pages"] + 1):
                    docs.append(_json.loads(_fetch_bytes(worldbank_page_url(target, p)).decode("utf-8")))
                df = pd.DataFrame(worldbank_columns(docs))
            else:
                doc = _json.loads(_fetch_bytes(dbnomics_data_url(target)).decode("utf-8"))
                df = pd.DataFrame(dbnomics_columns(doc))
                if client_years is not None and len(df):
                    # years() for dbnomics: API-et har ikke tidsvindu-parametre
                    # — filtrer klient-side (trygt: vi holder alle radene).
                    # Ikke-numeriske perioder beholdes (kan ikke bedømmes).
                    yr = pd.to_numeric(df["period"].astype(str).str[:4], errors="coerce")
                    keep = pd.Series(True, index=df.index)
                    if client_years["from"]:
                        keep &= yr.isna() | (yr >= int(client_years["from"]))
                    if client_years["to"]:
                        keep &= yr.isna() | (yr <= int(client_years["to"]))
                    df = df[keep].reset_index(drop=True)
            return df[list(columns)] if columns else df
        if kind in ("pxweb", "eurostat"):
            if not table:
                raise ValueError(kind + "-kilder krever tabell-id: kilde.read('05839')")
            canonical_px = _canonical_from_query(query)
            qs = []
            for k, v in query.items():
                if isinstance(v, dict):
                    qs += [str(k) + "[" + str(dk) + "]=" + str(dv) for dk, dv in v.items()]
                else:
                    qs.append(str(k) + "=" + str(v))
            if canonical_px:
                _, cparams_px, _, _ = _translate_canonical(kind, str(table), canonical_px)
                qs += cparams_px
            target = self.url.rstrip("/") + "/" + str(table) + (("?" + "&".join(qs)) if qs else "")
            du = eurostat_data_url(target) if kind == "eurostat" else data_url(target)
            ds = _json.loads(_fetch_bytes(du).decode("utf-8"))
            df = apply_typemeta(pd.DataFrame(columns_from_jsonstat(ds)),
                                typemeta_from_jsonstat(ds))
            return df[list(columns)] if columns else df
        url = self.url if table is None else self.url.rstrip("/") + "/" + str(table)
        if kind == "parquet":
            if columns:
                try:
                    import duckdb  # valgfri akselerator: bare valgte kolonner hentes
                    collist = ", ".join('"' + str(c).replace('"', '""') + '"' for c in columns)
                    return duckdb.sql(
                        "SELECT " + collist + " FROM read_parquet('" + url.replace("'", "''") + "')"
                    ).df()
                except ImportError:
                    pass
            df = pd.read_parquet(io.BytesIO(_fetch_bytes(url)))
        elif kind == "json":
            df = pd.DataFrame(_json.loads(_fetch_bytes(url).decode("utf-8")))
        else:
            df = pd.read_csv(io.BytesIO(_fetch_bytes(url)), sep=None, engine="python")
        return df[list(columns)] if columns else df


def connect(url, kind=None):
    return Source(url, kind)


def read(url, table=None, columns=None, kind=None, **query):
    return Source(url, kind).read(table, columns=columns, **query)


_DATASETS = {}

_FORMATS = ("pandas", "polars", "duckdb")


def _deliver(df, fmt):
    """format= fra direktivet, levert på ekte. Å ignorere en ukjent format-
    verdi og returnere pandas ville flyttet feilen til neste linje, der den
    ser ut som noe helt annet."""
    if fmt in (None, "pandas"):
        return df
    if fmt == "polars":
        try:
            import polars
        except ImportError:
            raise ValueError('format="polars" krever polars — pip install polars')
        return polars.from_pandas(df)
    if fmt == "duckdb":
        try:
            import duckdb
        except ImportError:
            raise ValueError('format="duckdb" krever duckdb — pip install duckdb')
        return duckdb.from_df(df)
    if fmt in ("data.table", "tibble"):
        raise ValueError('format="%s" finnes bare i R-modus i OpenStat — bruk %s her'
                         % (fmt, " eller ".join(_FORMATS)))
    raise ValueError('ukjent format «%s» — gyldige: %s' % (fmt, ", ".join(_FORMATS)))


class Dataset:
    """Variabel-for-variabel-bygging: deklarer nøkkelen én gang, add() legger
    til kolonner fra rammer eller kilder, frame() gir resultatet."""

    def __init__(self, key, name=None, how="left", format=None):
        self.key = [key] if isinstance(key, str) else list(key)
        self.name = name
        self.how = how
        self.format = format
        self._df = None
        if name:
            _DATASETS[name] = self

    def add(self, source, columns, table=None, how=None):
        cols = [columns] if isinstance(columns, str) else list(columns)
        want = self.key + [c for c in cols if c not in self.key]
        if isinstance(source, pd.DataFrame):
            piece = source[want]
        else:
            piece = source.read(table, columns=want)
        if self._df is None:
            self._df = piece.copy()
        else:
            self._df = self._df.merge(piece, on=self.key, how=how or self.how)
        return self

    def join(self, other, on, how=None):
        """Slå sammen en ramme eller kilde på en EKSPLISITT nøkkel — i motsetning
        til add(), som bruker datasettets deklarerte nøkkel."""
        keys = [on] if isinstance(on, str) else list(on)
        piece = other if isinstance(other, pd.DataFrame) else other.read()
        if self._df is None:
            raise ValueError("join krever at datasettet har innhold — bruk add() først")
        for _side, _frame in (("venstre", self._df), ("høyre", piece)):
            _miss = [k for k in keys if k not in _frame.columns]
            if _miss:
                raise ValueError("join: kolonnen(e) %s finnes ikke i %s ramme"
                                 % (", ".join(_miss), _side))
        self._df = self._df.merge(piece, on=keys, how=how or self.how)
        return self

    def frame(self):
        if self._df is None:
            raise ValueError("datasettet er tomt — bruk add() først")
        return _deliver(self._df, self.format)


def create(key, name=None, how="left", format=None):
    """Lag et tomt datasett med deklarert nøkkel — bygg det med add()/join()."""
    return Dataset(key, name=name, how=how, format=format)


def use(name, source=None):
    """ost.use finnes bare i editoren — her er datasettet allerede en variabel."""
    raise ValueError(
        "ost.use kopierer datasett MELLOM kjøretider (python/r/duckdb) i "
        "OpenStat-editoren og har ingen mening i pakken — «%s» er allerede en "
        "variabel i dette scriptet." % name)


def datasets():
    """Navnregisteret over Dataset-objekter bygget i denne økten."""
    return dict(_DATASETS)
