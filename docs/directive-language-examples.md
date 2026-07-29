# The m2py directive language — examples

Directives are plain comments at the start of a line, understood by
`js/data-directives.js` before any script actually runs. The comment marker
can be `#`, `--`, or `//` (whichever the active mode uses) — the parser
treats them identically.

## §0. When you don't need a directive

A plain GET URL that returns a table needs no directive at all — read it
with ordinary pandas:

```
iris = pd.read_csv("https://raw.githubusercontent.com/hmelberg/openstat/main/data/iris.csv")
```

This works in every Python mode (Pyodide, Brython, MicroPython) and is
unchanged code outside the app too. Reach for `ost` only when something more
than a URL is needed: registry sources, `secret_key`, the canonical query
vocabulary (`years=`/`indicators=` — safest against SDMX sources, which
silently ignore unknown parameters in a raw URL), POST bodies,
databases/tables, encryption, `use` and mounting. Everything below this
point is about that `ost` side of the line.

## Grammar

```
line        := marker (assignment | methodcall)
marker      := "#" | "--" | "//"
assignment  := NAME "=" expr
             | "meta" "." PATH "=" literal
methodcall  := NAME "." METHOD "(" args ")"
expr        := "ost" "." VERB "(" args ")" | NAME "." METHOD "(" args ")"
args        := literal ("," literal)* ("," IDENT "=" literal)*
literal     := string | number | True | False | None
             | "[" literal* "]" | "{" pairs "}" | SOURCE-NAME
VERB        := connect | read | create | use
METHOD      := read | add | join | filter

target      := registry-id | url | anvil-name    (first argument to connect/read)
```

There are **no aliases**. `load`, `import`, `create-dataset` and `require` were
removed with the Python-style syntax on 2026-07-27; writing them produces an
error message that suggests the new form. Common named arguments:
`kind=`, `secret_key=`, `exec="local"|"remote"`, `cache=`, the canonical query
vocabulary (`years=`, `countries=`, `regions=`, `indicators=`, `filters={…}`,
`all=True`), `how="left"|"inner"|"outer"` on `add`/`join`, and `where="<expr>"` on `add`.

> **Directive lines are not Python.** The grammar is closed: no variables in
> arguments (except source names), no expressions, no f-strings, no arithmetic,
> no loops or conditionals, no imports. A trailing comment on a directive line
> is not legal either.

`target` resolves in this order:
1. **Registry id** — an entry in `data/data-sources.json` (`ssb`, `eurostat`, `worldbank`, `oecd`, `who`, ...) → public web API, fetched with that entry's `base_url`/proxy rules.
2. **URL** (`http(s)://...`) → fetched directly. If the bytes turn out to be a `safepy-enc-v1` encrypted envelope, a key is required.
3. **Bare name that isn't a known registry id** → treated as a **registered Anvil source** (`GET /_/api/source_access?id=<name>`); the source's registered `level`/`local_mode` then decides whether it downloads locally, requires a key, or is remote-only.

---

## 1. Public registry source — no options needed

```
# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2-beta/tables")
# ledighet = ssb.read("05839/data?outputFormat=csv")
```
`ssb` is connected as an alias for a base URL; `ssb.read(…)` appends a path to it and binds the result into the script under the name `ledighet`.

Using the short registry id instead of the full URL works the same way:
```
# ssb = ost.connect("ssb")
# ledighet = ssb.read("tables/05839/data?outputFormat=csv")
```

## 2. Plain public URL, no `connect` needed at all

```
// co2 = ost.read("https://ourworldindata.org/grapher/co2-emissions.csv")
```
A bare URL can be `read` directly — no `connect` line required, no alias indirection.

## 3. What replaced `require`

```
# gammel = ost.read("https://x.example/gammel-data.csv")
```
The old `# require <url> as <navn>` was a URL-only alias for `read`; `ost.read`
covers it exactly. The **named** form (`# require <registered-source> as <alias>`
— a registered source referenced without a `connect` line, routed straight to
the server) has **no successor**; see §12 for why.

## 4. FRED — a registry source that needs the CORS proxy + an API key

```
# fred = ost.connect("fred")
# us = fred.read("series/observations?series_id=UNRATE&file_type=json")
```
Because the FRED registry entry declares `cors:false` and an `auth` block, the fetch is silently routed through `/api/hent` (the same-origin proxy) instead of a direct browser fetch — the script itself doesn't change.

## 5. Registered protected source — key supplied interactively

```
# h = ost.connect("helse2025", secret_key="ask")
# df = h.read()
```
`helse2025` isn't a public registry id, so it resolves as an Anvil-registered source. `secret_key="ask"` means: don't hard-code a secret in the script — pop a password modal at run time, held in memory only for that session (never written to localStorage, never logged).

The argument is called `secret_key`, not `key`: since 2026-07-26 `key=` means **column names** and nothing else (`ost.create(key=["kommune_nr", "year"])`). Writing `key=` on `connect`/`read` is an error with the suggestion *«mente du «secret_key»?»*.

## 6. Registered source with a literal key and forced remote execution

```
# k = ost.connect("kilde2", secret_key="qL7xK2mN9pR4sT6v", exec="remote")
# df = k.read()
```
`exec="remote"` forces the whole script for this source onto the server, even if the source's policy would otherwise allow local analysis. (The reverse, `exec="local"`, is refused by the client if the source's registered level is non-public — protected/sensitive sources can never be forced local.)

## 7. Directly loading an encrypted file by URL

```
# df = ost.read("https://raw.githubusercontent.com/owner/repo/data.enc.json", secret_key="abcDEF123")
```
No `connect`/registration needed if the owner just hands you a URL and a key: the loader sniffs the `safepy-enc-v1` envelope, verifies its fingerprint, and decrypts client-side with WebCrypto using the supplied key.

## 8. Secret precedence — `read`-level key overrides `connect`-level key

```
# h = ost.connect("helse2025", secret_key="K1")
# df = h.read(secret_key="K2")
```
`df` is decrypted with `K2`. A `secret_key` on `connect` is just the default for everything read through that alias; a `secret_key` on the individual `read` line wins.

## 9. Mixing several sources of different kinds in one script

```
# s = ost.connect("ssb")
# h = ost.connect("helse2025", secret_key="ask")
# offentlig = s.read("tables")
# beskyttet = h.read()
# owid = ost.read("https://ourworldindata.org/grapher/life-expectancy.csv")
```
`offentlig` comes from the public SSB registry, `beskyttet` from a key-gated Anvil source, and `owid` from a plain public URL — each resolved independently by the same script.

## 9b. API sources by kind — OECD, ECB, Norges Bank, Verdensbanken, DBnomics (2026-07-25)

The registry carries the kind, so the source name is all you need — the user
knows the source, not the protocol:

```
# o = ost.connect("oecd")
# levealder = o.read("OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE/all?startPeriod=2020")

# wb = ost.connect("worldbank")
# bnp = wb.read("country/NOR;SWE/indicator/NY.GDP.MKTP.CD?date=2015:2024")

# dbn = ost.connect("dbnomics")
# vekst = dbn.read("IMF/WEO:latest/NOR.NGDP_RPCH")
```

With a bare URL, name the kind explicitly — source names (`oecd`, `ecb`,
`norgesbank`, `imf`) are aliases for the underlying protocol (`sdmx`), and
`worldbank`/`dbnomics` are protocols of their own:

```
# ecb = ost.connect("https://data-api.ecb.europa.eu/service/data", kind="sdmx")
# kurs = ecb.read("EXR/D.USD.EUR.SP00.A?startPeriod=2026-01-01")
```

All deliver a tidy long-format frame (the API's own column names —
`REF_AREA`/`TIME_PERIOD`/`OBS_VALUE` for SDMX sources, `indicator`/`country`/
`date`/`value` for Verdensbanken, `series_code`/dimensions/`period`/`value`
for DBnomics).

## 9c. Canonical query vocabulary — translated per source (2026-07-25)

`years="a:b"`, `countries=[…]`, `regions=[…]`, `indicators=[…]` and
`filters={…}` on the `read` line are translated to each source's own
query model — and fail loudly when a field can't be translated verifiably
for that source (SDMX 2.1 APIs silently ignore unknown parameters, which
would return wrong-but-plausible data):

```
# o = ost.connect("oecd")
# le = o.read("OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE", countries=["NOR", "SWE"], years="2020:2023")

# wb = ost.connect("worldbank")
# bnp = wb.read(indicators=["NY.GDP.MKTP.CD"], countries=["NOR", "SWE"], years="2015:2024")

# eu = ost.connect("eurostat")
# bnp2 = eu.read("nama_10_gdp", countries=["NO"], years="2020:", filters={"na_item": "B1GQ", "unit": "CP_MEUR"})

# ssb = ost.connect("ssb")
# bef = ssb.read("05839", years="2007:", regions=["0"], indicators=["Personer"])
```

For SDMX sources, `countries=`/`indicators=`/`filters=` build the dotted
key path automatically (one small `lastNObservations=1` probe reveals the
dataflow's dimensions); `years="a:b"` maps to `startPeriod`/`endPeriod`
(SDMX), `date=` (Verdensbanken), `sinceTimePeriod`/`untilTimePeriod`
(Eurostat) and `valueCodes[Tid]` (PxWeb). Open ends work: `years="2020:"`.
Single values need no list: `countries="NOR"` ≡ `countries=["NOR"]`.
A number is an error, not something to coerce — `years=2020` would silently
have meant one year instead of five, so it is rejected.

## 10. Variable-level assembly — `create` / `add` / `join`

A separate, richer directive set lets you assemble one analysis dataset out of *columns* pulled from multiple registered sources, rather than loading each source as a whole frame:

```
# p = ost.connect("people")
# s = ost.connect("sales_src")
# panel = ost.create(key="pid")
# panel.add(p, ["income", "edu"])
# panel.add(p, ["region"])
# sales = s.read()
# panel.join(sales, on="pid")
```
This declares a dataset called `panel`, keyed on `pid`; pulls the `income` and `edu` columns from source `p` (plus `region` in a second `add` line); separately reads all of `sales_src` as `sales`; then joins `sales` into `panel` on the `pid` key. `add` takes **one** column parameter (a string or a list) — `panel.add(p, "income", "edu")` is an error, because the package signature is `add(source, columns, table=None, how=None)` and `"edu"` would silently become `table=`. `add`/`join` default to a `left` join; `how=` is a closed set (`left`/`inner`/`outer`):

```
# panel.add(p, ["x"], how="inner")
# panel.join(sales, on="pid", how="outer")
```

Row filtering comes in two distinct forms:

```text
# panel.add(p, ["income"], where="income > 5000")   # filters the SOURCE, before the join
# panel.filter("income != 99999")                    # filters the ASSEMBLED dataset, after all add/join
```

`where=` runs before the join — with a left join, rows that fail the
condition in a secondary source stay in the panel with NA. `filter(...)`
runs after all `add`/`join` lines (wherever it appears in the script) and
drops rows. The expression grammar is closed: `column op value`, combined
with `and`; `op` is `== != < <= > >= in`; values are numbers, `'strings'`
or `[lists]` (for `in`); column names may be backtick-quoted. Anything
else — `or`, parentheses, arithmetic, column-vs-column — is a loud error.
NA semantics are SQL-canonical in every mode: rows with NA in a filter
column are dropped by every condition, including `!=`. `where=` may
reference source columns that are not imported. For API sources
(pxweb/eurostat/sdmx/dbnomics/worldbank) the extract is materialized
first, so `where`/`filter` reduce rows locally — they do not shrink the
API download itself (use `filters=`/`years()`/`countries()` on the source
for that). For remote parquet/sqlite/duckdb, `where` is pushed into the
source query.

## 11. Comment-marker flexibility (same directive, three syntaxes)

These three lines are parsed identically — only the comment marker differs, matching whichever language mode the script segment is in:
```
# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2-beta/tables")
-- ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2-beta/tables")
// ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2-beta/tables")
```

## 11b. Your own metadata — `#meta.`

The second form in the grammar is a namespace assignment. It carries the
script author's own description of a dataset into the ⓘ modal in the dataset
panel:

```
# meta.lonn.title = "Lønnsundersøkelsen 2024"
# meta.lonn.note = "Spørreundersøkelse om lønn, innsamlet 2024"
# meta.lonn.publisher = "Eget prosjekt"
# meta.lonn.link = {"https://x.example/skjema.pdf": "Spørreskjema"}
# meta.lonn.alder.note = "Alder ved utgangen av inntektsåret"
```

The path is positional, not keyword-driven:

- **Two segments** = dataset level. `title`, `note`, `link` and `labels` have
  fixed meanings; **any other name becomes a display field** with the name as
  its label, which is what makes the model extensible without new syntax.
- **Three segments** = variable level, and the last segment must be `label`,
  `note` or `link`. Variable level *always* needs three segments.

`link` takes a string (one link), a list (several, unlabelled) or a dict
(`url: label`). `note` takes a string or a list. `=` **overwrites** and `+=`
**appends** (standard Python semantics; `+=` is valid only for `note` and
`link` — on single-value keys it errors rather than silently concatenating):

```
# meta.lonn.note += "Uteliggerne i alder er verifisert mot originalskjemaet"
# meta.lonn.link += {"https://doi.org/10.xxxx": "Metodeartikkelen"}
```

Repeated `=` on `note`/`link` that actually drops an earlier entry raises a
⚠-warning in the sidebar (never silent — the pre-2026-07-27 syntax
accumulated, so the habit lingers). Source metadata from `/api/metadata` is
merged separately; the author's text is rendered first and never silently
overridden.

## 12. Homomorphically-encrypted (HE) tier

HE sources (`format="he"`, Paillier-encrypted) use the **same** `ost.connect`/`.read` directives as any other registered source — there is no separate directive syntax. What's different is the *editor mode/dialect* the script runs under, and what happens on resolution: the ciphertext is useless without the authority key, so an HE source is **always executed remotely** through the HE facade, never fetched or decrypted into the browser.

Referencing a registered HE source is written exactly like a protected source (§5 above):
```
# h = ost.connect("helse_he", secret_key="ask")
# df = h.read()
```
The difference is invisible in the directive text — it's the registered source's `format` field, checked at `/source_access` resolution time, that routes it into the HE facade instead of a normal remote run.

> **Removed with the Python-style syntax (2026-07-27).** The legacy
> `# require helse_he as h` form — a registered source referenced *without* a
> `connect` line, wired to the "Kryptert" (HE) editor tab whose `dialect` was
> fixed to `'he'` — has **no successor**. The new grammar has no way to say
> "reference a registered source with no connect": write the `connect` line.
> The HE tab itself is not part of OpenStat (it lives in SafeStat), so nothing
> in this repo lost a working path — but do not expect `require` to parse.

**`exec="local"` is always refused on an HE source** — there's no plaintext to run against locally:
```
# h = ost.connect("helse_he", exec="local")
# df = h.read()
```
→ rejected with the same "cannot run locally" error protected/sensitive sources get, except here it's unconditional (HE has no local mode at all, unlike `protected`/`sensitive` which can allow `local_mode="open"`/`"strict"`).

**You cannot mix an HE (or any named) source with a plain URL source in one remote run yet:**
```
# h = ost.connect("helse_he", secret_key="ask")
# df = h.read()
# co2 = ost.read("https://ourworldindata.org/grapher/co2.csv")
```
→ refused: "Server-kjøring kan ikke kombinere navngitte kilder og URL-kilder (ennå)" (server execution can't yet combine named sources and URL sources — use only named sources).

---

**Source:** grammar and resolution order from
`docs/superpowers/specs/2026-07-05-encrypted-external-sources-design.md` §1;
parsing implemented in `js/data-directives.js`; fetch/decrypt implemented in
`js/data-loader.js`; every example above (except #9, a composite) mirrors a
case asserted in `netlify/edge-functions/_lib/data-directives.test.ts`.
