# Two-tier LLM provider support + optional source keys (design)

**Status:** APPROVED 2026-07-23 (scope settled with Hans 2026-07-23 in the
provider brainstorm, directly after the user-keys/source-registry round
landed. Decisions: level 2 includes data-svar WITHOUT web search
(registry tools + memory-URLs-must-probe); tool-calling is REQUIRED for
level-2 data-svar (no two-shot fallback for non-tool models); ONE global
provider config (no per-function selection, no multi-profiles); optional
source keys (anonymous Kaggle) folded in as Part B. AMENDED same day on
Hans' call: OpenAI Responses API with native `web_search` included as a
third provider type (A6) rather than deferred to roadmap.)

## Motivation

Users should be able to run OpenStat's AI features against models other
than Claude (roadmap item prioritized in spec
2026-07-23-user-keys-and-source-registry). Full provider parity is
blocked by two Anthropic-specific dependencies: the hosted
`web_search`/`web_fetch` server tools, and the streaming protocol. Two
observations shrink the problem:

1. Only `web_search`/`web_fetch` are Anthropic-hosted. The other three
   data-svar tools (`search_catalog`, `table_metadata`, `probe`) execute
   in OUR edge function (`data-svar.ts` `executeTool`) and are
   provider-independent. Registry-driven discovery — the core value for
   statistics questions — needs no web search at all.
2. The client↔edge channel (SSE progress + final answer) is independent
   of the edge↔provider channel. The provider call can be plain
   non-streaming JSON while the user still sees live progress; each hop
   of the existing continuation protocol is one model call either way.

Separately (Part B): the Kaggle entry currently hard-requires a user key,
but public Kaggle datasets are anonymously downloadable upstream
(verified in task 7 of the previous round). An optional-key mode fixes
that without weakening keyed sources.

## Part A — Provider tiers

### A1. Configuration (one global provider)

The AI settings dialog gains an «AI-leverandør» section:

- **Type:** `anthropic` (default — exactly today's behavior) |
  `anthropic-compat` (tier 1) | `openai-compat` (tier 2) |
  `openai-responses` (tier 2 with native web search — A6).
- **Base-URL** and **modellnavn** fields (shown for the two custom types).
- **Nøkkel** stored in `md_keys` under type `llm` (via `js/keys.js`);
  the non-secret config `{type, base_url, model}` in a new localStorage
  key `md_llm_provider` (JSON), owned by a small settings section in
  `js/ai-chat.js` (no new module — it is UI state, not a key store).

Per request: the client sends `provider: {type, base_url, model}` in the
JSON body and the key in an `X-Llm-Key` header — never in URLs. With
type `anthropic` (or no provider field), nothing changes: the
`X-Anthropic-Key` path works exactly as today.

**Gate:** `_lib/auth.ts`'s BYOK gate treats a complete custom provider
config (type + base_url + `X-Llm-Key`) as BYOK-equivalent: the user
brings their own credentials and billing, same trust position as the
`sk-ant-` header. Validation: base_url must pass the SSRF guard (A2),
key ≤ 250 chars (existing BYOK cap), model name `[A-Za-z0-9._:/-]{1,100}`.

### A2. Security for user-supplied base-URLs

The edge function will POST the prompt AND the user's key to a URL the
user chose. Rules:

- base_url must pass `isPublicHttpUrl` (`_lib/ssrf.ts`) — no internal
  hosts, and the provider fetch goes through `fetchGuarded` so redirects
  are guarded too (headers already stripped on cross-host redirects).
- The key is sent ONLY to the configured host, as the provider's own
  auth header (`x-api-key` for anthropic-compat, `Authorization: Bearer`
  for openai-compat).
- Provider errors are relayed with fixed Norwegian messages plus the
  upstream HTTP status; never the key, never interpolated upstream
  bodies that could echo it (same rule as `hent-core.ts`).
- The prompt content already goes to a third party (Anthropic) by
  design; a user-chosen provider is the user's own decision. No new
  privacy-page obligations — but `personvern` wording («går via appens
  server til Anthropic») gains one sentence: with a custom provider, to
  the provider the user configured.

### A3. Provider abstraction in the edge layer

New `_lib/providers/` module with one interface:

```
runProviderTurn(cfg, {system, messages, tools, maxTokens})
  → {text, toolCalls: [{id, name, input}], stopReason, usage}
```

- **anthropic** (default): NOT routed through this interface — the
  existing streaming `runAgenticStream`/Anthropic paths stay byte-for-
  byte unchanged. Zero regression surface for current users.
- **anthropic-compat** (tier 1): the existing Anthropic code with the
  base-URL swapped in (the fetch target becomes
  `${base_url}/v1/messages`); streaming, hosted tools, caching all as
  today. This is a URL substitution, not an adapter.
- **openai-compat** (tier 2): non-streaming `POST {base_url}/chat/completions`
  with `tools` (function calling). Translation: tool defs (JSON Schema
  `input_schema` → `parameters` — near-identical), system prompt →
  system message, tool results → `role:"tool"` messages. One turn per
  call; no provider-side streaming.

The agentic loop for tier 2 reuses the continuation protocol: each hop
executes one provider turn; client tools run via the existing
`executeTool`; SSE progress lines to the browser are generated by the
edge exactly as today, plus a keepalive progress event while waiting on
the provider (so the client connection never sits silent past proxy
idle timeouts).

### A4. Discovery without web search (tier 2 data-svar)

- Tool list for tier 2: `search_catalog`, `table_metadata`, `probe` —
  `web_search`/`web_fetch` omitted.
- New prompt block, appended ONLY for tier 2 (`MODE`-style conditional in
  `data-svar-prompt.ts`): registry tools are the primary path; for
  topics outside the registry the model MAY propose concrete data-URLs
  from its own knowledge, but EVERY such URL MUST be verified with
  `probe` before use in the script — a failed probe means the answer
  says so honestly (the existing everything-from-web-search-must-probe
  rule generalized to memory URLs). The SEARCH_HINTS meta-catalogs
  (awesome-public-datasets etc.) become probe-targets the model can try
  from memory rather than web_search starting points.
- Provider config carries a capability field derived from the type:
  `webSearch: "none"` (openai-compat) or `"native"` (anthropic paths and
  openai-responses). The tool-list assembly keys off this field, so a
  future Gemini-grounding adapter slots in without redesign. The tier-2
  memory-URL prompt block is included exactly when `webSearch` is
  `"none"` — an openai-responses provider gets the standard web-search
  workflow instead.
- Tool-calling is REQUIRED: if a tier-2 provider response to the first
  turn contains no tool-call capability signal (e.g. the API rejects the
  `tools` param), data-svar fails with a clear message
  («data-svar krever en modell med verktøystøtte (tool-calling)») —
  no degraded no-tools mode.

### A5. Function coverage

- **Tier 1 (anthropic-compat):** all AI functions, unchanged behavior.
- **Tier 2 (openai-compat and openai-responses):** `data-svar` (Web
  mode) and `tolk-resultat`.
- **Anthropic-only for now:** `kode-svar`/`kode-svar-v2` and `dm-vurder`
  (deeply tied to the streamed v2 flow; the value of provider choice is
  in Web mode). The UI must say this: with a tier-2 provider active, the
  microdata AI features show «krever Anthropic-nøkkel» rather than
  failing opaquely — they keep using an Anthropic key if one is
  registered (`md_keys.anthropic`), i.e. provider config does NOT
  disable Anthropic-backed features when both are configured.

### A6. OpenAI Responses API with native web search

A third provider type, `openai-responses`, gives OpenAI users near-full
data-svar parity (added to scope 2026-07-23 after Hans confirmed the
Responses API ships both streaming and a hosted `web_search` tool; the
generic chat-completions tier cannot assume either, which is why both
tiers exist).

- **Endpoint:** non-streaming `POST {base_url}/responses` (default
  base_url `https://api.openai.com/v1`). Non-streaming is deliberate for
  v1 even though the API can stream — it reuses tier 2's hop model and
  the edge-generated SSE progress unchanged; provider-side streaming is
  a later optimization, not a capability gap.
- **Tools:** the three client tools in Responses function-tool format
  (flat `{type:"function", name, parameters}`) PLUS the hosted
  `{type: "web_search"}`. There is no `web_fetch` equivalent: the prompt
  for this type says search-result snippets/citations may be transcribed
  per the existing INLINE ladder (level 2, marked «transkribert»), and
  the probe-before-use rule stands unchanged for every URL regardless of
  how it was found.
- **Continuation state:** the Responses API is stateful; each hop's
  `previous_response_id` is carried in the existing resume state (a
  string — far smaller than tier 2's message-array state), and each new
  request sends only the pending `function_call_output` items. Requires
  the provider to support `store` (OpenAI's default); if a gateway
  rejects stored state, the run fails with a clear message rather than
  silently degrading («leverandøren støtter ikke lagret samtaletilstand
  (store) — bruk typen openai-kompatibel i stedet»).
- **Cost note surfaced in UI help text:** hosted web search bills extra
  on the user's OpenAI account, same as their own usage elsewhere.

## Part B — Optional source keys (anonymous Kaggle)

- Registry schema: `auth.valgfri?: boolean`, valid ONLY with
  `user: true` (parseRegistry rule; `env`-sources are site-configured
  and never optional).
- `hent-core.ts`: for a `user`-auth source with `valgfri: true` and no
  `X-Source-Key`, proceed WITHOUT auth injection (instead of 401). With
  a key present, inject as today. The oversized/non-Latin1 checks still
  apply when a key is present.
- `js/data-loader.js`: no fail-fast throw for `valgfri` sources when the
  key is missing; the header is attached when the key exists. (Loads
  still route via proxy — the `viaProxy`-forcing from the previous round
  keys off `auth`, unchanged.)
- `renderRegistryBlock`: `valgfri` sources render as «brukernøkkel
  valgfri — offentlige datasett kan hentes uten nøkkel; privat-/
  konkurransedata krever registrert nøkkel» (registered state still
  shown when the user has one).
- Kaggle entry: add `"valgfri": true`; quirks sentence about anonymity
  adjusted to match (it currently says the key is required regardless).
- Settings UI needs no change (the field renders from `auth.user`
  exactly as before; hint text already explains what the key unlocks).

## Error handling

- Provider HTTP errors → fixed messages with status: «AI-leverandøren
  svarte 401 — sjekk nøkkelen i AI-innstillingene», 429 → «…har
  hastighetsbegrenset deg — prøv igjen», other → generic with status.
- Missing tool support → the A4 message, surfaced as a normal chat error.
- Invalid provider config (bad URL, SSRF-blocked, missing model) → 400
  from the edge with a message naming the field.
- Anonymous-optional sources that hit an upstream 401/403 anyway (e.g. a
  private Kaggle dataset without a key) → the upstream status passes
  through the proxy as today; the data-loader's existing proxy-error
  message applies.

## Testing

- `_lib/providers/openai-compat.test.ts`: tool-def and message
  translation both directions, tool-call extraction, non-streaming turn
  against a fake fetch, key never in thrown/returned errors.
- `_lib/providers/openai-responses.test.ts`: function-tool format,
  web_search tool included, `previous_response_id` round-trip through
  resume state, function_call_output-only follow-up requests, clear
  error when the API rejects `store`/`tools`.
- `auth.ts` gate tests: custom-provider config accepted as BYOK; SSRF
  rejection of internal base_urls; oversized key/model rejected.
- `data-svar-prompt` tests: tier-2 block present only for tier 2;
  web tools omitted from the tier-2 tool list.
- `registry.test.ts`: `valgfri` validation (requires `user: true`).
- `hent-core.test.ts`: optional source without key → anonymous upstream
  fetch (no auth header, no 401); with key → Basic injection as before.
- `data-loader.test.ts`: optional source without key does not throw and
  routes via proxy without `X-Source-Key`.
- Eval set: one tier-2 question (registry-tool discovery, no web search,
  memory-URL honesty) and one anonymous-Kaggle question; result log rows
  per the eval doc's process.

## Out of scope / roadmap

- Gemini grounding (and other providers' native search) — the
  `webSearch` capability field + the openai-responses adapter establish
  the pattern; each further provider is its own small adapter.
- Provider-side streaming for openai-responses (v1 is non-streaming per
  hop by design — see A6).
- Tier 2 for `kode-svar`/`kode-svar-v2`/`dm-vurder`.
- Two-shot no-tool-calling fallback (rejected 2026-07-23 — shrinking
  category of models, whole separate flow).
- Multiple named provider profiles / per-function provider selection
  (rejected 2026-07-23 — YAGNI until someone asks).
- User prompt additions (unchanged roadmap item from the previous spec).
