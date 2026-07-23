# User API keys (client-side) + curated source registry expansion (design)

**Status:** APPROVED 2026-07-23 (scope settled with Hans 2026-07-23 during
the data-sources brainstorm. Two larger alternatives were considered and
explicitly REJECTED for v1 — see Decision log. Scope: unified client-side
key handling, registry-driven auth incl. Kaggle, Nordic/health source
candidates, meta-catalog search hints in the data-svar prompt.)

## Motivation

Two threads converged:

1. **More sources for Web mode (`data-svar`).** The curated registry
   (`data/data-sources.json`, 11 sources) is the right mechanism — its
   value is machine-usable access recipes (URL templates, CORS, quirks),
   not discovery, which `web_search` + `probe` already covers. Bulk lists
   (awesome-public-datasets, Kaggle's catalog) do NOT belong in the
   registry: no uniform API, no recipe to encode, prompt bloat and rot.
   But (a) sources reusing existing adapters are nearly free to add, and
   (b) meta-catalogs are useful as *search starting points* in the prompt.
2. **More sources need keys.** FRED already requires one (site-env,
   server-injected). Kaggle requires one. Users also hold an Anthropic
   BYOK key and a GitHub PAT — today spread across three modules that
   each read localStorage directly, with no shared UI or extension point.

## Decision log

- **Server-side vault REJECTED for v1** (accepted-risk decision by Hans
  2026-07-23). A two-tier design was worked out (optional OAuth via
  Netlify Identity + write-only encrypted vault in Netlify Blobs +
  server-side injection incl. a `/api/gh` PAT proxy) whose real benefit
  is closing the exfiltration surface: main-thread Pyodide gives any
  generated/shared script `import js` access to localStorage AND to any
  same-origin endpoint with the user's session — so a vault with a
  read-back endpoint is security-equivalent to localStorage; only the
  write-only property changes the threat model. For OpenStat the stakes
  are misuse of the user's own accounts (Anthropic billing, Kaggle quota,
  PAT repo access), not confidential data; the existing confirm-before-run
  gate (`js/ai-chat.js` `confirmAutoRun`) stays as the mitigation. The
  vault design is preserved on the roadmap should the threat picture
  change (see Out of scope).
- **Netlify DB rejected** even for the vault variant — for a handful of
  small encrypted values per user, Netlify Blobs (included, no
  provisioning) is the right store; noted here so the roadmap item
  doesn't resurrect Postgres.
- **Keys are curated + registry-driven**, not free-form: key-requiring
  sources are declared via the `auth` block in `data/data-sources.json`,
  which binds each key to its source's host — the proxy can never send a
  key to the wrong domain. Adding a keyed source = one registry entry.
- **GitHub PAT stays where it is** (`m2py_github_profiles` — it carries
  repo/branch config and works); the unified settings UI links it in but
  does not migrate it.

## Design

### 1. Unified client key store — `js/keys.js` (new)

Small module owning localStorage key `md_keys`: a JSON object
`{ anthropic: "sk-ant-...", fred: "...", kaggle: "user:key", ... }`.

- API: `Keys.get(type)`, `Keys.set(type, value)`, `Keys.remove(type)`,
  `Keys.registered()` → list of types with a stored value.
- One-time migration: `md_anthropic_key` → `md_keys.anthropic` (old key
  removed after copy). `js/ai-chat.js` switches to `Keys.get('anthropic')`.
- No encryption/obfuscation — deliberate (see Decision log). Values never
  appear in generated scripts (see §3), and `DataDirectives.scrubKeys`
  continues to mask any `key(<literal>)` occurrences before share/save.

### 2. Registry-driven settings UI

The AI settings dialog gains a "Datakilde-nøkler" section generated from
the registry: one row per source whose entry has an `auth` block —
label, status («registrert» / «ikke registrert»), input to set/replace,
remove button. Anthropic keeps its existing field (now backed by
`Keys`); the GitHub section is unchanged. No per-source UI code: a new
keyed source appears automatically from its registry entry.

### 3. Key flow at fetch time — `/api/hent` + `js/data-loader.js`

- Registry `auth` block gains a discriminator for who supplies the key:
  today's `env:` (site key, server-injected — FRED, unchanged) vs new
  `user: true` (user-supplied). `plassering` gains a `basic` variant:
  `Authorization: Basic base64(<value>)` alongside existing `query:` /
  `header:` forms (`_lib/hent-core.ts`).
- `js/data-loader.js`: when materializing a `# load` for a source with
  `auth.user`, attach the user's key — directly for CORS-OK sources
  (per the placement rule), else forward it to `/api/hent` in an
  `X-Source-Key` header. The proxy injects it ONLY when the target URL
  matches that source's registry entry (`sourceForUrl` host binding);
  otherwise the header is dropped. The proxy never echoes the key in
  errors (same rule as the FRED path).
- **Scripts never contain source keys.** Directives stay clean
  (`# connect kaggle` / `# load <url> as x`); the key is attached at
  fetch time from `Keys`. Missing key → structured error pointing to
  settings («Kaggle krever API-nøkkel — registrer den under
  AI-innstillinger»).
- The `data-svar` request body gains `available_keys` (list of registered
  key types, values never sent); the prompt's registry block marks keyed
  sources as usable/unusable accordingly, so the model doesn't build on a
  source the user can't fetch — or tells the user which key to register.

### 4. Kaggle registry entry

New `data/data-sources.json` entry: `id: "kaggle"`,
`tillit: "etablert"`, `tilgang: "rest"`, `cors: false` (→ proxy),
`auth: { type: "api_key", user: true, plassering: "basic" }` (stored
value is `username:key`), download via the datasets API
(`sporrings_url_mal` for `.../api/v1/datasets/download/{owner}/{slug}`;
exact URL probe-verified during implementation). `quirks` must say:
datasets are often unofficial copies — prefer primary sources when the
registry has them (SSB/WHO/World Bank/OWID); check the dataset's license.
No `sok_endepunkt` in v1 — discovery of Kaggle datasets goes through
`web_search` + mandatory `probe`, as for any found source.

### 5. New curated sources (adapter-reuse first)

Candidates, in expected cost order. Every endpoint below MUST be
probe-verified during implementation (plan step, not assumed):

- **SCB (Sverige)** and **Statistikcentralen/StatFin (Finland)** —
  PxWeb APIs; the existing `pxweb` search + metadata adapters
  (`_lib/tools/search-catalog.ts`, `table-metadata.ts`) should work with
  a new base URL. Watch API-version skew vs SSB's v2-beta (adapters may
  need a version flag; that discovery is part of implementation).
- **Danmarks Statistik** — own simple REST API (api.statbank.dk); v1
  entry without `sok_endepunkt` (search via web_search) still pays for
  itself through `sporrings_url_mal` + quirks; a dedicated adapter is a
  possible follow-up.
- **FHI** and **NAV åpne data** — high value for the health/welfare
  domain; API shape verified during implementation (FHI's open
  statistics API; data.nav.no). If either turns out CKAN- or
  PxWeb-shaped, existing adapters apply.

All entries: `tillit: "offisiell"`, Norwegian `quirks`, `join_nokler`
where joins are realistic (år, land/ISO, kommunenummer for FHI/NAV).
Each new source gets an eval question in `docs/eval/data-svar-evalsett.md`.

### 6. Meta-catalog search hints (prompt block)

New small block (`SEARCH_HINTS`) in
`netlify/edge-functions/_lib/data-svar-prompt.ts`, appended near the
registry block and mirrored in `prompts/data-svar.md` (source-of-truth
doc + changelog): when FINN finds nothing in the registry, good
`web_search`/`web_fetch` starting points are awesome-public-datasets
(github.com/awesomedata/awesome-public-datasets), data.europa.eu, and
Google Dataset Search — with the reminder that anything found this way is
`tillit: funnet` and MUST be probe-verified before code generation
(existing rule, restated in context). A few sentences, not a catalog:
the block must not grow into a second registry.

## Error handling

- Missing user key: `/api/hent` returns a structured 4xx with source id;
  data-loader surfaces the Norwegian settings-pointer message.
- `X-Source-Key` on a URL not matching a `user: true` registry source:
  header silently dropped (never forwarded upstream).
- Keys never logged, never echoed in error bodies (extends the existing
  FRED rule in `hent-core.ts`).

## Testing

Existing patterns per module:

- `js/keys.js`: node tests — get/set/remove/migration/registered().
- `hent-core`: `basic` placement, user-key injection only on host match,
  header dropped otherwise, no key echo in errors.
- Registry: schema tests for `auth.user` + `basic` (`registry.test.ts`,
  `catalog-format.test.ts`); prompt test for `available_keys` rendering
  and the SEARCH_HINTS block (`data-svar-prompt.test.ts`).
- data-loader: attach-vs-forward decision per CORS flag; missing-key error.
- New sources: probe-based smoke checks recorded in the eval changelog.

## Out of scope / roadmap

- **User-selectable AI/LLM provider — PRIORITIZED roadmap item** (Hans
  2026-07-23: more important than prompt customization). Constraint to
  respect: `data-svar` depends on Anthropic-hosted `web_search`/
  `web_fetch` server tools and the agentic streaming protocol — a generic
  OpenAI-style passthrough breaks the discovery loop. Realistic staging:
  (1) Anthropic-compatible base-URL + model override (covers gateways/
  proxies), (2) generic provider support for the simpler endpoints
  (`tolk-resultat`, possibly `kode-svar`), (3) only then, if ever,
  provider-agnostic `data-svar` with self-hosted search tools.
- **User prompt additions** (own preferred sources / general prompt
  tweaks appended to the system prompt) — later; keep in mind that the
  prompt is byte-stably assembled and eval'd, so user text must be an
  isolated, clearly-labelled block.
- **Server-side key vault** (OAuth via Netlify Identity + write-only
  AES-GCM vault in Netlify Blobs + server injection incl. `/api/gh` PAT
  proxy) — shelved, revive if the threat picture changes; do NOT use
  Netlify DB for it.
- GitHub App to replace the PAT; Google Drive storage.
