# OpenStat — browser statistics workbench (public, BYOK-only build)

> Sister projects: [SafeStat](https://github.com/hmelberg/safestat) — the full
> build with login, protected/encrypted data sources, restricted (strict)
> execution, and server-side remote analysis — and
> [Microdata](https://github.com/hmelberg/microdata) — the dedicated
> microdata.no emulator (persona locked on, UI tracking microdata.no).
> OpenStat is the open general workbench; engine fixes land in SafeStat first
> and are ported to the siblings.

A browser app for running statistics scripts in several languages — microdata,
Python, R, DuckDB, Brython, jamovi, Statx — with the microdata language powered
by an engine that emulates [microdata.no](https://microdata.no): it translates
microdata scripts to Python and runs them in the browser via Pyodide, and
generates synthetic register data from metadata. Around it: Python/R runners,
Python/R → microdata translators, a step-by-step tutorial mode, and AI features
(code generation, a data-minimization/privacy review, and result
interpretation). Microdata is an ordinary mode here (its special UI shows only
while microdata mode is active); the always-on emulator experience lives in the
`microdata` sibling repo. The default mode is chosen per subdomain
(`js/notebook-links.js` `hostnameMode()`: py.* → python, r.* → r,
duck.* → duckdb, micro… → microdata), with **python** as the fallback.

This is the **public, lite** version: no login, no accounts, no protected/
sensitive data sources, and no server-side remote execution. The AI features
work only via a user-supplied Anthropic API key (BYOK), pasted into the
Settings dialog and stored only in the browser's `localStorage` — our Netlify
edge functions relay each request straight to Anthropic and don't store the
key or the request content. See `personvern.html` for the full privacy
statement.

## Layout

| Path | What |
|------|------|
| `index.html` | The front-end app shell (editor, runners, mode system, settings) + remaining inline modules. |
| `app.css`, `js/` | Extracted front-end: `app.css` (styles); `js/ai-chat.js`, `js/github-storage.js`, `js/data-directives.js`, `js/data-loader.js`, `js/enc-crypto.js` (classic `<script src>` modules loaded after the inline block, sharing the `window.*` surface). |
| `js/cells.js` | Notebook cells: `#%%` parsing/serialisering (ren halvdel, node-testet) + celle-rendrer for visningene + hover-verktøylinje (add/delete/move/type/split/merge) (spec `docs/superpowers/specs/2026-07-13-notebook-cells-design.md`). |
| `m2py.py` | The interpreter: `MicroParser` + `MicroInterpreter` (engine, mock-data, stats, disclosure control). |
| `functions.py` | microdata functions used in generate/replace/if expressions. |
| `protect.py` | `scrub-*` data-protection verbs (noise, swap, k-anon, risk, …) — a local disclosure-control toolkit you can call on your own scripts; no server involved. |
| `mockdata_export.py`, `static_source.py`, `build_static_data.py` | Static synthetic-data build (Parquet/DuckDB) + the static data source. |
| `netlify/edge-functions/` | The AI endpoints (`dm-vurder`, `kode-svar`, `kode-svar-v2`, `tolk-resultat`, `data-svar`, `hent`) + shared `_lib/`. All accept a BYOK Anthropic key (`X-Anthropic-Key`) — no account/token required. |
| `manual_scripts/` | End-to-end example scripts run as a smoke suite. |
| `tests/` | pytest suite (engine, regressions, equivalence, mock-data, performance). |

### Relationship to the full/advanced `m2py` repo

This repo was forked from the sibling `m2py` repo, which additionally supports
protected/sensitive data sources, Anvil-hosted login and AI, and server-side
remote execution. Those features (and their supporting files —
`m2py_remote.py`, `m2py_protection.py`, `js/login.js`, `js/strict-worker.js`,
`vendor/safepy.zip`, `sync_to_api.py`) were removed here on purpose; they are
not needed for the public/lite use case.

The **three** repos (safestat, openstat, microdata) share a core engine —
`m2py.py`, `functions.py`, `m2py_translate.py`, `m2py_runtime/`,
`protect.py`, and most of `index.html`'s mode-switching/editor/
run-pipeline logic. (The `py2m/`/`r2m/` translators and the Oversett button
were removed from openstat/safestat 2026-07-10 — they live in the
`microdata` repo only.) There is no shared package or submodule between them
(deliberately, to avoid infrastructure this project doesn't need yet) — when
you fix a bug in one of those files, check whether the sibling repos have the
same bug. Engine fixes land in SafeStat first and are ported out. The
`microdata` repo was cloned from this one 2026-07-10 with full git history
(`git cherry-pick` works across them); its UI drifts toward microdata.no and
should not be blind-synced.

## Common commands

```bash
# Python tests (engine, regressions, equivalence, mock-data)
.venv/bin/python -m pytest tests/

# End-to-end smoke suite (exits non-zero on any CRASH/PARTIAL)
.venv/bin/python manual_scripts/run_manual_scripts.py

# Edge functions (Deno)
cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/

# Build the static synthetic dataset (writes static_data/*.parquet + manifest.json)
.venv/bin/python build_static_data.py --persons 100000 --from 2015 --to 2023
```

CI lives in `.github/workflows/` (pytest + manual scripts, edge).

## Examples

Built-in examples live in `examples/<mode>/` — one folder per editor mode
(`micropython/`, `microdata/`, …), with an optional one level of `NN_category/`
subfolders (e.g. `microdata/03_deskriptiv_statistikk/`) that become categories
in the modal. Add or remove a file, then regenerate the manifest:

```bash
# Rebuild examples/manifest.json from the folder tree
.venv/bin/python examples/generate_manifest.py
```

The «Eksempler» button opens a mode-scoped modal built from
`examples/manifest.json` (fetched lazily the first time the modal opens — no
startup cost). Each example's label comes from a `# label: <text>` line in the
file (else `#options.title`, else the filename). No `index.html` edit is
needed to add or remove examples.

## Deployment

The site deploys on Netlify (`netlify.toml`): static files + the edge
functions. Set `ANTHROPIC_API_KEY` only if you want a server-side fallback for
non-BYOK requests — otherwise every AI request requires the caller's own key.
`sw.js` precaches Pyodide — **bump `CACHE` whenever the precache list
changes.**
