# User keys (client-side) + source registry expansion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unified client-side API-key handling (`js/keys.js`), registry-driven user keys forwarded per request to `/api/hent` (Kaggle first), new curated sources (SCB, StatFin, DST, FHI/NAV as verifiable), and a meta-catalog search-hints prompt block.

**Architecture:** Keys live in localStorage under one JSON blob (`md_keys`, accepted-risk decision — see spec Decision log). Key-requiring sources are declared via `auth` blocks in `data/data-sources.json`: `env:` = site key (server env, unchanged FRED path), new `user: true` = user key sent as `X-Source-Key` header to `/api/hent`, which injects it only when the target URL's host matches that source's registry entry. The data-svar prompt learns which user keys are registered via a new `available_keys` request field (ids only, never values).

**Tech Stack:** Plain classic-script JS modules in `js/` (IIFE on `window`), Deno TypeScript edge functions in `netlify/edge-functions/`, Deno tests in `netlify/edge-functions/_lib/` (js modules tested there via `eval` of the file — see `data-loader.test.ts`).

**Spec:** `docs/superpowers/specs/2026-07-23-user-keys-and-source-registry-design.md`

## Global Constraints

- Test command (README:79): `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
- Python tests are untouched by this plan; do not run them.
- Key values must NEVER appear in: generated scripts, prompt text, proxy error bodies, or console logs. `hent-core.ts` already has the fixed-error-body rule — preserve it.
- UI strings: Norwegian source text with `T('...')`; English translations added to `js/i18n/en.js` (key = exact Norwegian string). Only add en.js entries that don't already exist.
- All new registry `quirks`/UI text in Norwegian, matching existing entries.
- Commit messages in repo style: `feat(...)`/`fix(...)`/`docs(...)` prefix + Norwegian summary. All commits on `main` (repo convention).
- Each new/changed source entry must be live-verified with curl during implementation (probe-verification rule in spec §4–5). If an endpoint cannot be verified working within ~15 minutes, SKIP that entry and log the attempt in `docs/eval/data-svar-evalsett.md`'s result log instead of shipping it unverified.

---

### Task 1: `js/keys.js` — unified client key store + migration

**Files:**
- Create: `js/keys.js`
- Create: `netlify/edge-functions/_lib/keys.test.ts`
- Modify: `index.html` (script include, before `js/ai-chat.js` — the include block is near line 11777)
- Modify: `js/ai-chat.js:6` (LS const), `js/ai-chat.js:18` (getter), `js/ai-chat.js:1531-1538` (saveSettings), `js/ai-chat.js:1559-1566` (remove button)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: global `window.Keys` = `{ get(type): string, set(type, value): void, remove(type): void, registered(): string[] }`. Later tasks (4, 5, 6) call exactly these. Storage key: `md_keys` (JSON object type→value). Migration: `md_anthropic_key` → `md_keys.anthropic`, old key removed.

- [ ] **Step 1: Write the failing test**

Create `netlify/edge-functions/_lib/keys.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// js/keys.js is a classic script on window/globalThis (same eval harness as
// data-loader.test.ts). Each call re-evals with a fresh localStorage shim so
// tests are isolated and the load-time migration runs per test.
function freshKeys(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const src = Deno.readTextFileSync(new URL("../../../js/keys.js", import.meta.url));
  (0, eval)(src);
  // deno-lint-ignore no-explicit-any
  return { Keys: (globalThis as any).Keys, store };
}

Deno.test("Keys: get/set/remove/registered round-trip via md_keys", () => {
  const { Keys, store } = freshKeys();
  assertEquals(Keys.get("kaggle"), "");
  Keys.set("kaggle", "bruker:K1");
  Keys.set("fred", "F1");
  assertEquals(Keys.get("kaggle"), "bruker:K1");
  assertEquals(Keys.registered().sort(), ["fred", "kaggle"]);
  Keys.remove("fred");
  assertEquals(Keys.get("fred"), "");
  assertEquals(Keys.registered(), ["kaggle"]);
  assertEquals(JSON.parse(store.get("md_keys")!), { kaggle: "bruker:K1" });
});

Deno.test("Keys: migrates legacy md_anthropic_key and removes it", () => {
  const { Keys, store } = freshKeys({ "md_anthropic_key": "sk-ant-legacy" });
  assertEquals(Keys.get("anthropic"), "sk-ant-legacy");
  assertEquals(store.has("md_anthropic_key"), false);
});

Deno.test("Keys: corrupt md_keys JSON degrades to empty, set() repairs", () => {
  const { Keys } = freshKeys({ "md_keys": "{not json" });
  assertEquals(Keys.get("anthropic"), "");
  Keys.set("anthropic", "sk-ant-x");
  assertEquals(Keys.get("anthropic"), "sk-ant-x");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/keys.test.ts`
Expected: FAIL (`No such file or directory ... js/keys.js`)

- [ ] **Step 3: Write `js/keys.js`**

```js
// Felles klient-side nøkkellager (spec 2026-07-23-user-keys-and-source-registry).
// Én localStorage-post (md_keys, JSON-objekt type→verdi). Bevisst uten
// kryptering: trusselvurderingen (akseptert risiko, klient-only) står i
// spec-ens Decision log — nøkler holdes utenfor genererte script og prompter,
// men er lesbare for kode som kjører i siden, som før.
(function (global) {
  'use strict';
  var LS = 'md_keys';

  function readAll() {
    try { return JSON.parse(global.localStorage.getItem(LS) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function writeAll(all) { global.localStorage.setItem(LS, JSON.stringify(all)); }

  function get(type) { return readAll()[type] || ''; }
  function set(type, value) {
    var all = readAll();
    if (value) all[type] = value; else delete all[type];
    writeAll(all);
  }
  function remove(type) { set(type, ''); }
  function registered() {
    var all = readAll();
    return Object.keys(all).filter(function (k) { return !!all[k]; });
  }

  // Engangsmigrering fra md_anthropic_key (før 2026-07-23).
  var legacy = global.localStorage.getItem('md_anthropic_key');
  if (legacy) {
    if (!get('anthropic')) set('anthropic', legacy);
    global.localStorage.removeItem('md_anthropic_key');
  }

  global.Keys = { get: get, set: set, remove: remove, registered: registered };
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/keys.test.ts`
Expected: 3 passed

- [ ] **Step 5: Wire into the app**

In `index.html`, the include block near line 11777 currently reads:

```html
  <script src="js/data-directives.js"></script>
  <script src="js/enc-crypto.js"></script>
  <script src="js/data-loader.js"></script>
```

Insert `keys.js` FIRST (data-loader will use it in Task 4; ai-chat uses it now):

```html
  <script src="js/keys.js"></script>
  <script src="js/data-directives.js"></script>
  <script src="js/enc-crypto.js"></script>
  <script src="js/data-loader.js"></script>
```

In `js/ai-chat.js`:

1. Line 6 — delete the line `const LS_KEY_ANTHROPIC = 'md_anthropic_key';   // BYOK: brukerens egen Anthropic-nøkkel` and replace with a comment:
   ```js
      // BYOK-nøkkelen bor i det felles nøkkellageret (js/keys.js, type 'anthropic').
   ```
2. Line 18 — replace the getter:
   ```js
        get anthropicKey() { return (window.Keys && window.Keys.get('anthropic')) || ''; },
   ```
3. In `saveSettings` (lines 1531-1538) replace the two localStorage lines:
   ```js
        if (akey) window.Keys.set('anthropic', akey);
        else window.Keys.remove('anthropic');
   ```
4. In the `aiCfgByokRemove` handler (lines 1559-1566) replace `localStorage.removeItem(LS_KEY_ANTHROPIC);` with `window.Keys.remove('anthropic');`

Then: `grep -n "LS_KEY_ANTHROPIC" js/ai-chat.js` must return nothing.

- [ ] **Step 6: Full check + commit**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
Expected: all green.

```bash
git add js/keys.js netlify/edge-functions/_lib/keys.test.ts index.html js/ai-chat.js
git commit -m "feat(keys): felles klient-side nøkkellager md_keys m/ migrering fra md_anthropic_key; ai-chat over på Keys"
```

---

### Task 2: Registry schema — `auth.user`, `basic` placement, `nokkel_hint`, per-user rendering

**Files:**
- Modify: `netlify/edge-functions/_lib/registry.ts` (SourceAuth 5-9, parseRegistry 30-45, renderRegistryBlock 75-86)
- Test: `netlify/edge-functions/_lib/registry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `SourceAuth` = `{ type: "api_key"; env?: string; user?: boolean; plassering: string }` where `plassering` ∈ `"query:<param>" | "header:<name>" | "basic"` and exactly one of `env`/`user:true` is set. `DataSource` gains `nokkel_hint?: string`. `renderRegistryBlock(reg, userKeys: string[] = [])` — second param is the list of registered user-key source ids. Tasks 3, 6, 7 rely on these exact shapes.

- [ ] **Step 1: Write the failing tests**

Append to `netlify/edge-functions/_lib/registry.test.ts`:

```ts
Deno.test("parseRegistry validates auth: env xor user, plassering incl. basic", () => {
  const base = { id: "k", navn: "K", utgiver: "K", tillit: "etablert", tilgang: "rest",
    base_url: "https://api.k.example/", cors: false };
  // valid: user-key with basic placement
  const ok = parseRegistry([{ ...base, auth: { type: "api_key", user: true, plassering: "basic" } }]);
  assertEquals(ok[0].auth?.user, true);
  // invalid: both env and user
  assertThrows(() => parseRegistry([{ ...base, auth: { type: "api_key", env: "X", user: true, plassering: "basic" } }]));
  // invalid: neither env nor user
  assertThrows(() => parseRegistry([{ ...base, auth: { type: "api_key", plassering: "basic" } }]));
  // invalid: bad plassering
  assertThrows(() => parseRegistry([{ ...base, auth: { type: "api_key", user: true, plassering: "query:" } }]));
});

Deno.test("renderRegistryBlock marks user-key sources by registration state", () => {
  const reg = parseRegistry([{
    id: "kaggle", navn: "Kaggle", utgiver: "Kaggle", tillit: "etablert", tilgang: "rest",
    base_url: "https://www.kaggle.com/api/v1/", cors: false,
    auth: { type: "api_key", user: true, plassering: "basic" },
  }]);
  const uten = renderRegistryBlock(reg);
  if (!uten.includes("IKKE registrert")) throw new Error("mangler ikke-registrert-markering:\n" + uten);
  const med = renderRegistryBlock(reg, ["kaggle"]);
  if (!med.includes("brukernøkkel (registrert)")) throw new Error("mangler registrert-markering:\n" + med);
  if (med.includes("IKKE registrert")) throw new Error("registrert kilde feilmarkert:\n" + med);
});

Deno.test("shipped data/data-sources.json parses against the schema", async () => {
  const raw = JSON.parse(await Deno.readTextFile(new URL("../../../data/data-sources.json", import.meta.url)));
  const reg = parseRegistry(raw);
  if (reg.length < 11) throw new Error("uventet få kilder: " + reg.length);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/registry.test.ts`
Expected: the three new tests FAIL (auth not validated / no user-key rendering); existing ones pass.

- [ ] **Step 3: Implement in `registry.ts`**

Replace the `SourceAuth` interface (lines 5-9):

```ts
export interface SourceAuth {
  type: "api_key";
  env?: string;       // Netlify env var (site-nøkkel) — gjensidig utelukkende med user
  user?: boolean;     // true = brukernøkkel via X-Source-Key (js/keys.js), injiseres av /api/hent
  plassering: string; // "query:<param>" | "header:<name>" | "basic"
}
```

Add `nokkel_hint?: string;` to the `DataSource` interface (after `auth?: SourceAuth;`).

In `parseRegistry`, after the `new URL(e.base_url as string);` line, add:

```ts
    if (e.auth !== undefined) {
      const a = e.auth as Record<string, unknown>;
      if (a.type !== "api_key") throw new Error(`kilde ${e.id}: ukjent auth.type '${a.type}'`);
      const plass = a.plassering;
      const okPlass = typeof plass === "string" &&
        (/^(query|header):.+$/.test(plass) || plass === "basic");
      if (!okPlass) throw new Error(`kilde ${e.id}: ugyldig auth.plassering '${plass}'`);
      const hasEnv = typeof a.env === "string" && !!(a.env as string).trim();
      if (hasEnv === (a.user === true)) {
        throw new Error(`kilde ${e.id}: auth må ha nøyaktig én av env eller user:true`);
      }
    }
```

Replace `renderRegistryBlock` (lines 75-86) with:

```ts
/** Compact registry rendering for the cached system prefix. No auth secrets.
 *  userKeys = registrerte brukernøkkel-kilde-ider (fra available_keys) — bare
 *  ider, aldri verdier; styrer om en user-auth-kilde framstår som brukbar. */
export function renderRegistryBlock(reg: DataSource[], userKeys: string[] = []): string {
  const lines = reg.map((s) => {
    const bits = [`${s.tilgang}, base ${s.base_url}`];
    if (s.sok_endepunkt) bits.push("søkbar via search_catalog");
    if (s.auth?.user) {
      bits.push(userKeys.includes(s.id)
        ? "krever brukernøkkel (registrert) → hentes alltid via /api/hent"
        : "krever brukernøkkel — IKKE registrert: ikke bygg svaret på denne kilden; nevn i så fall at nøkkel kan registreres i AI-innstillingene");
    } else if (s.auth) {
      bits.push("krever nøkkel → hentes alltid via /api/hent");
    }
    if (!s.cors) bits.push("ikke CORS → /api/hent");
    if (s.join_nokler?.length) bits.push(`join: ${s.join_nokler.join(", ")}`);
    const quirks = s.quirks ? ` — ${s.quirks}` : "";
    return `- **${s.id}** (${s.navn}; ${s.tillit}): ${bits.join("; ")}${quirks}`;
  });
  return `## Kilderegister (kuratert)\n\n${lines.join("\n")}`;
}
```

(Note the auth line moved BEFORE the cors line — user-key state is more important; the existing "byte-stable" test only checks determinism, not ordering.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/registry.test.ts`
Expected: all pass (including the shipped-file test against the current 11 entries).

- [ ] **Step 5: Full check + commit**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
Expected: green.

```bash
git add netlify/edge-functions/_lib/registry.ts netlify/edge-functions/_lib/registry.test.ts
git commit -m "feat(registry): auth.user + basic-plassering + nokkel_hint; renderRegistryBlock markerer brukernøkkel-status; skjematest av shipped data-sources.json"
```

---

### Task 3: `/api/hent` — user-key injection via `X-Source-Key`

**Files:**
- Modify: `netlify/edge-functions/_lib/hent-core.ts` (key-injection block, lines 28-44)
- Test: `netlify/edge-functions/_lib/hent-core.test.ts`

**Interfaces:**
- Consumes: `SourceAuth.user` / `"basic"` from Task 2.
- Produces: `/api/hent` behavior — for a target URL whose host matches a registry entry with `auth.user`: header `X-Source-Key` is required (401 + Norwegian message naming the source if missing, no URL/key echo) and injected per `plassering`; for any other URL the incoming `X-Source-Key` is never forwarded upstream. Task 4's client relies on exactly this contract.

- [ ] **Step 1: Write the failing tests**

Append to `netlify/edge-functions/_lib/hent-core.test.ts` (note: `REG` at the top of the file must gain a kaggle entry — extend the `parseRegistry([...])` call to):

```ts
const REG = parseRegistry([{
  id: "fred", navn: "FRED", utgiver: "Fed", tillit: "etablert", tilgang: "rest",
  base_url: "https://api.stlouisfed.org/fred/", cors: false,
  auth: { type: "api_key", env: "FRED_API_KEY", plassering: "query:api_key" },
}, {
  id: "kaggle", navn: "Kaggle", utgiver: "Kaggle", tillit: "etablert", tilgang: "rest",
  base_url: "https://www.kaggle.com/api/v1/", cors: false,
  auth: { type: "api_key", user: true, plassering: "basic" },
}]);
```

New tests (the fake fetch must log headers — add a header-logging variant):

```ts
function headerLoggingFetch(log: { url: string; headers: Record<string, string> }[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    log.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return Promise.resolve(new Response("ok", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
}

function reqWithKey(qs: string, key?: string): Request {
  const h = new Headers();
  if (key) h.set("X-Source-Key", key);
  return new Request(`https://app.test/api/hent?${qs}`, { method: "GET", headers: h });
}

Deno.test("handleHent injects user key as Basic auth for user-auth registry host", async () => {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const d = { registry: REG, getEnv: () => undefined, fetchImpl: headerLoggingFetch(log) };
  const url = encodeURIComponent("https://www.kaggle.com/api/v1/datasets/download/o/s/f.csv");
  const r = await handleHent(reqWithKey("url=" + url, "bruker:K42"), d);
  assertEquals(r.status, 200);
  assertEquals(log[0].headers["authorization"], "Basic " + btoa("bruker:K42"));
});

Deno.test("handleHent: missing user key → 401 naming the source, no key/URL echo", async () => {
  const d = { registry: REG, getEnv: () => undefined, fetchImpl: headerLoggingFetch([]) };
  const url = encodeURIComponent("https://www.kaggle.com/api/v1/datasets/download/o/s/f.csv");
  const r = await handleHent(reqWithKey("url=" + url), d);
  assertEquals(r.status, 401);
  const text = await r.text();
  if (!text.includes("kaggle")) throw new Error("feilen navngir ikke kilden: " + text);
  if (text.includes("kaggle.com/api")) throw new Error("URL lekket: " + text);
});

Deno.test("handleHent never forwards X-Source-Key to non-user-auth hosts", async () => {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const d = { registry: REG, getEnv: (k: string) => ({ FRED_API_KEY: "F1" } as Record<string, string>)[k], fetchImpl: headerLoggingFetch(log) };
  await handleHent(reqWithKey("url=" + encodeURIComponent("https://example.org/d.csv"), "bruker:K42"), d);
  await handleHent(reqWithKey("url=" + encodeURIComponent("https://api.stlouisfed.org/fred/series?series_id=U"), "bruker:K42"), d);
  for (const c of log) {
    for (const [k, v] of Object.entries(c.headers)) {
      if (v.includes("K42") || k.toLowerCase() === "x-source-key") {
        throw new Error("brukernøkkel videresendt til " + c.url);
      }
    }
    if (c.url.includes("K42")) throw new Error("brukernøkkel i URL: " + c.url);
  }
});

Deno.test("handleHent caps oversized X-Source-Key", async () => {
  const d = { registry: REG, getEnv: () => undefined, fetchImpl: headerLoggingFetch([]) };
  const url = encodeURIComponent("https://www.kaggle.com/api/v1/x.csv");
  const r = await handleHent(reqWithKey("url=" + url, "x".repeat(301)), d);
  assertEquals(r.status, 400);
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/hent-core.test.ts`
Expected: new tests FAIL (no Basic injection, no 401); existing pass.

- [ ] **Step 3: Implement in `hent-core.ts`**

Add above `handleHent`:

```ts
const MAX_SOURCE_KEY = 300; // chars — romslig for alle kjente nøkkelformater
```

Replace the key-injection block (current lines 28-43) with:

```ts
  // Key injection — ONLY when the host matches a registry entry with auth.
  // To nøkkelveier: env (site-nøkkel, som før) og user (X-Source-Key fra
  // js/keys.js via data-loader). Innkommende X-Source-Key videresendes ALDRI
  // oppstrøms — headers bygges fra bunnen her, og brukes bare når verten
  // matcher en user-auth-kilde.
  let finalUrl = target;
  const headers: Record<string, string> = {};
  const src = sourceForUrl(deps.registry, target);
  if (src?.auth) {
    const a = src.auth;
    let key: string;
    if (a.user) {
      key = request.headers.get("x-source-key") ?? "";
      if (key.length > MAX_SOURCE_KEY) return new Response("X-Source-Key for lang", { status: 400 });
      if (!key) {
        // Fast, ikke-interpolert utover kilde-id (aldri URL/nøkkel i feilkroppen).
        return new Response(
          `Kilden ${src.id} krever API-nøkkel — registrer den i AI-innstillingene`,
          { status: 401 },
        );
      }
    } else {
      key = deps.getEnv(a.env ?? "") ?? "";
      if (!key) return new Response(`Nøkkel for ${src.id} er ikke konfigurert`, { status: 502 });
    }
    if (a.plassering === "basic") {
      headers["authorization"] = "Basic " + btoa(key);
    } else {
      const [kind, name] = a.plassering.split(":");
      if (kind === "query") {
        const t = new URL(target);
        t.searchParams.set(name, key);
        finalUrl = t.toString();
      } else if (kind === "header") {
        headers[name] = key;
      }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/hent-core.test.ts`
Expected: all pass.

- [ ] **Step 5: Full check + commit**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`

```bash
git add netlify/edge-functions/_lib/hent-core.ts netlify/edge-functions/_lib/hent-core.test.ts
git commit -m "feat(hent): brukernøkkel-injeksjon via X-Source-Key m/ vertsbinding, basic-plassering, 401 uten nøkkel — aldri videresendt til fremmede verter"
```

---

### Task 4: data-loader forwards user keys to the proxy

**Files:**
- Modify: `js/data-loader.js` (`fetchLoadTarget` lines 37-57, `fetchResolvedItems` lines 121-177, `resolveAndFetchLoads` line 108)
- Test: `netlify/edge-functions/_lib/data-loader.test.ts`

**Interfaces:**
- Consumes: `window.Keys` (Task 1), `/api/hent` `X-Source-Key` contract (Task 3), registry entries with `auth.user`.
- Produces: any `# load` whose (inner) target host matches a registry entry with `auth.user` gets `X-Source-Key: <Keys.get(id)>` on the proxy request; missing key throws `«<id>» krever API-nøkkel — registrer den i AI-innstillingene.` before any fetch. Test override: `deps.keysApi`.

- [ ] **Step 1: Write the failing tests**

Append to `netlify/edge-functions/_lib/data-loader.test.ts` (per the file's isolation note, use URLs no earlier test used):

```ts
const KAGGLE_REG = [{
  id: "kaggle", navn: "Kaggle", utgiver: "Kaggle", tillit: "etablert", tilgang: "rest",
  base_url: "https://www.kaggle.com/api/v1/", cors: false,
  auth: { type: "api_key", user: true, plassering: "basic" },
}];

Deno.test("data-loader: X-Source-Key settes på proxy-kall for user-auth-kilde", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return Promise.resolve(new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const inner = encodeURIComponent("https://www.kaggle.com/api/v1/datasets/download/own/slug/fil-a.csv");
  const script = "# load /api/hent?url=" + inner + " as kag";
  const keysApi = { get: (t: string) => (t === "kaggle" ? "bruker:K9" : "") };
  const out = await DL.resolveAndFetchLoads(script, { fetchImpl, registry: KAGGLE_REG, keysApi });
  assertEquals(out.loads[0].alias, "kag");
  const proxy = calls.find((c) => c.url.includes("/api/hent?url="));
  assertEquals(proxy?.headers["X-Source-Key"], "bruker:K9");
});

Deno.test("data-loader: manglende brukernøkkel → norsk feil før fetch", async () => {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(new Response("x", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const inner = encodeURIComponent("https://www.kaggle.com/api/v1/datasets/download/own/slug/fil-b.csv");
  const script = "# load /api/hent?url=" + inner + " as kag2";
  await assertRejects(
    () => DL.resolveAndFetchLoads(script, { fetchImpl, registry: KAGGLE_REG, keysApi: { get: () => "" } }),
    Error, "krever API-nøkkel",
  );
  assertEquals(calls.filter((c) => c.includes("kaggle")).length, 0);
});

Deno.test("data-loader: connect-basert user-auth-kilde rutes via proxy med nøkkel", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return Promise.resolve(new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const script = [
    "# connect kaggle",
    "# load kaggle/datasets/download/own/slug/fil-c.csv as kag3",
  ].join("\n");
  const keysApi = { get: (t: string) => (t === "kaggle" ? "bruker:K10" : "") };
  await DL.resolveAndFetchLoads(script, { fetchImpl, registry: KAGGLE_REG, keysApi });
  const proxy = calls.find((c) => c.url.includes("/api/hent?url="));
  if (!proxy) throw new Error("ingen proxy-kall: " + calls.map((c) => c.url).join(" | "));
  assertEquals(proxy.headers["X-Source-Key"], "bruker:K10");
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/data-loader.test.ts`
Expected: the 3 new tests FAIL; existing pass.

- [ ] **Step 3: Implement in `js/data-loader.js`**

Insert after `proxyHeaders` (after line 35):

```js
  // Brukernøkler (spec 2026-07-23): en kilde med auth.user i registeret krever
  // registrert nøkkel (js/keys.js). Nøkkelen sendes KUN som X-Source-Key til
  // /api/hent (som injiserer etter plasseringsregelen, vertsbundet) — den
  // legges aldri inn i selve kilde-URL-en klient-side, og havner dermed aldri
  // i script, delingslenker eller cache-nøkler.
  function userAuthSourceFor(url, registry) {
    var target = url;
    if (url.indexOf('/api/hent?') === 0) {
      var m = /[?&]url=([^&]+)/.exec(url);
      if (!m) return null;
      try { target = decodeURIComponent(m[1]); } catch (e) { return null; }
    }
    var host;
    try { host = new URL(target).host; } catch (e) { return null; }
    var reg = registry || [];
    for (var i = 0; i < reg.length; i++) {
      var s = reg[i];
      if (!s.auth || !s.auth.user) continue;
      try { if (new URL(s.base_url).host === host) return s; } catch (e2) {}
    }
    return null;
  }

  function sourceKeyHeader(url, registry, keysApi) {
    var src = userAuthSourceFor(url, registry);
    if (!src) return {};
    var K = keysApi || global.Keys;
    var val = K && K.get(src.id);
    if (!val) throw new Error('«' + src.id + '» krever API-nøkkel — registrer den i AI-innstillingene.');
    return { 'X-Source-Key': val };
  }
```

Change `fetchLoadTarget` (line 37) to compute and merge the header — new signature and body:

```js
  async function fetchLoadTarget(item, fetchImpl, authToken, anthropicKey, registry, keysApi) {
    var srcKey = sourceKeyHeader(item.url, registry, keysApi);   // kaster ved manglende nøkkel
    function hdrs() { return Object.assign({}, proxyHeaders(authToken, anthropicKey), srcKey); }
    async function viaProxy() {
      var pr = await fetchImpl('/api/hent?url=' + encodeURIComponent(item.url), { headers: hdrs() });
      if (!pr.ok) throw new Error('proxy ' + pr.status + ' for ' + item.alias);
      return pr;
    }
    if (item.url.indexOf('/api/hent?') === 0) {
      var r0 = await fetchImpl(item.url, { headers: hdrs() });
      if (!r0.ok) throw new Error('proxy ' + r0.status + ' for ' + item.alias);
      return r0;
    }
    if (item.viaProxy) return viaProxy();
    try {
      var r1 = await fetchImpl(item.url);
      if (!r1.ok) throw new Error('HTTP ' + r1.status + ' for ' + item.alias + ' (' + item.url + ')');
      return r1;
    } catch (e) {
      if (e instanceof TypeError) return viaProxy();   // CORS/nettverk → proxy
      throw e;
    }
  }
```

In `fetchResolvedItems` (line 121), add registry resolution at the top (after the `fetchImpl` line):

```js
    var registry = deps.registry || (fetchImpl ? await loadRegistry(fetchImpl) : []);
```

and pass it through in `fetchBytes` (line 142):

```js
        _bufCache[k] = fetchLoadTarget(item, fetchImpl, deps.authToken || null, deps.anthropicKey || null, registry, deps.keysApi || null)
```

In `resolveAndFetchLoads` (line 108), pass the already-loaded registry down so it isn't fetched twice:

```js
    var loads = await fetchResolvedItems(localItems, Object.assign({}, deps, { registry: registry }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/data-loader.test.ts`
Expected: all pass (old + 3 new).

- [ ] **Step 5: Full check + commit**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`

```bash
git add js/data-loader.js netlify/edge-functions/_lib/data-loader.test.ts
git commit -m "feat(data-loader): X-Source-Key for user-auth-kilder (vertsmatch mot register, nøkkel fra js/keys.js), norsk feil ved manglende nøkkel"
```

---

### Task 5: Settings UI — data-source key section (registry-driven)

**Files:**
- Modify: `index.html` (settings dialog, after the Anthropic field `</div>` at line 222)
- Modify: `js/ai-chat.js` (`cacheDom`, `openSettings` 1525-1529, `saveSettings` 1531-1538)
- Modify: `js/i18n/en.js` (new strings)

**Interfaces:**
- Consumes: `window.Keys` (Task 1), registry entries with `auth.user` + `nokkel_hint` (Task 2 schema; entries arrive in Task 7).
- Produces: `#aiCfgSourceKeys` container; inputs carry `data-source-key-id="<id>"`; save persists non-empty inputs via `Keys.set`. No unit tests (DOM module, untested like the rest of ai-chat.js) — browser verification in Task 10.

- [ ] **Step 1: Add the container to `index.html`**

After the Anthropic key `<div>` (closes at line 222), before the `.ai-modal-actions` div, insert:

```html
      <div id="aiCfgSourceKeys" style="margin-bottom:18px;"></div>
```

- [ ] **Step 2: Wire DOM + rendering in `js/ai-chat.js`**

In `cacheDom` (find it via `grep -n "aiCfgAnthropicKey" js/ai-chat.js` — the line caching that element, currently line 40), add alongside:

```js
        aiCfgSourceKeys: document.getElementById('aiCfgSourceKeys'),
```

Add above `openSettings` (line 1525):

```js
      // Datakilde-nøkler (spec 2026-07-23): radene genereres fra registeret —
      // én rad per kilde med auth.user. Ny nøkkelkrevende kilde = ny register-
      // oppføring, ingen UI-kode. Verdier vises aldri igjen etter lagring
      // (passordfelt + placeholder), men kan erstattes eller fjernes.
      var _srcKeyRegistry = null;
      async function userKeySources() {
        if (!_srcKeyRegistry) {
          try {
            var r = await fetch('data/data-sources.json');
            _srcKeyRegistry = r.ok ? await r.json() : [];
          } catch (e) { _srcKeyRegistry = []; }
        }
        return _srcKeyRegistry.filter(function (s) { return s.auth && s.auth.user; });
      }

      async function renderSourceKeys() {
        var box = dom.aiCfgSourceKeys;
        if (!box) return;
        var sources = await userKeySources();
        box.innerHTML = '';
        if (!sources.length) return;
        var head = document.createElement('label');
        head.textContent = T('Datakilde-nøkler');
        box.appendChild(head);
        sources.forEach(function (s) {
          var has = !!(window.Keys && window.Keys.get(s.id));
          var wrap = document.createElement('div');
          wrap.style.margin = '6px 0 10px';
          var lab = document.createElement('div');
          lab.className = 'ai-modal-help';
          lab.textContent = s.navn + (has ? ' — ' + T('nøkkel registrert') : '');
          wrap.appendChild(lab);
          var inp = document.createElement('input');
          inp.type = 'password';
          inp.autocomplete = 'off';
          inp.dataset.sourceKeyId = s.id;
          inp.placeholder = has ? '••••••••' : (s.nokkel_hint || T('lim inn nøkkel'));
          wrap.appendChild(inp);
          if (has) {
            var rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'ai-modal-btn';
            rm.style.marginTop = '4px';
            rm.textContent = T('Fjern nøkkel');
            rm.addEventListener('click', function () {
              window.Keys.remove(s.id);
              renderSourceKeys();
            });
            wrap.appendChild(rm);
          }
          box.appendChild(wrap);
        });
      }
```

In `openSettings` add `renderSourceKeys();` before `dom.aiSettingsBackdrop.classList.add('open');`.

In `saveSettings`, before `closeSettings();`:

```js
        if (dom.aiCfgSourceKeys && window.Keys) {
          dom.aiCfgSourceKeys.querySelectorAll('input[data-source-key-id]').forEach(function (inp) {
            var v = inp.value.trim();
            if (v) window.Keys.set(inp.dataset.sourceKeyId, v);
          });
        }
```

- [ ] **Step 3: i18n**

In `js/i18n/en.js`, add (skip any key that already exists — check with `grep -n '"Datakilde-nøkler"\|"nøkkel registrert"\|"lim inn nøkkel"\|"Fjern nøkkel"' js/i18n/en.js`; "Fjern nøkkel" exists at the BYOK button — do not duplicate):

```js
  "Datakilde-nøkler": "Data source keys",
  "nøkkel registrert": "key saved",
  "lim inn nøkkel": "paste key",
```

- [ ] **Step 4: Syntax check + commit**

Run: `node --check js/ai-chat.js && node --check js/i18n/en.js`
Expected: no output (both parse).

```bash
git add index.html js/ai-chat.js js/i18n/en.js
git commit -m "feat(ui): registerdrevne datakilde-nøkkelfelter i AI-innstillingene (auth.user-kilder, nokkel_hint som placeholder, fjern/erstatt)"
```

---

### Task 6: `available_keys` — from client to prompt

**Files:**
- Modify: `js/ai-chat.js` (`runWebAnswer` request body, lines 973-979)
- Modify: `netlify/edge-functions/data-svar.ts` (`RequestBody` 16-22, system build 84-85)

**Interfaces:**
- Consumes: `Keys.registered()` (Task 1), `renderRegistryBlock(reg, userKeys)` (Task 2).
- Produces: request field `available_keys: string[]` (source-type ids only, values never sent); server validates each id against `/^[a-z0-9_-]{1,32}$/`, caps at 20.

- [ ] **Step 1: Client — send the list**

In `js/ai-chat.js` `runWebAnswer`, extend the POST body (line 973-979) with one field after `mode`:

```js
              mode,
              available_keys: (window.Keys ? window.Keys.registered() : []),
```

- [ ] **Step 2: Server — validate and use**

In `netlify/edge-functions/data-svar.ts`, extend `RequestBody`:

```ts
interface RequestBody {
  question?: string;
  mode?: string;
  script?: string;
  available_keys?: unknown;
  repair?: RepairBody;
  resume?: ResumeBody;
}
```

Replace the system-build lines (84-85):

```ts
  const mode = coerceDataMode(body.mode);
  // Kun kilde-ider (aldri verdier): styrer om user-auth-kilder framstår som
  // brukbare i registerblokken. Endrer prompt-prefikset → egen cache-nøkkel
  // per nøkkeloppsett; bevisst (få varianter, riktighet > cache-treff).
  const availableKeys = Array.isArray(body.available_keys)
    ? (body.available_keys as unknown[])
      .filter((k): k is string => typeof k === "string" && /^[a-z0-9_-]{1,32}$/.test(k))
      .slice(0, 20)
    : [];
  const system = buildDataSvarSystem(mode, renderRegistryBlock(registry, availableKeys));
```

- [ ] **Step 3: Full check + commit**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/` and `node --check js/ai-chat.js`
Expected: green.

```bash
git add js/ai-chat.js netlify/edge-functions/data-svar.ts
git commit -m "feat(data-svar): available_keys (kun ider) fra klient → registerblokken markerer brukbare brukernøkkel-kilder"
```

---

### Task 7: Kaggle registry entry (live-verified)

**Files:**
- Modify: `data/data-sources.json` (append entry)
- Modify: `docs/eval/data-svar-evalsett.md` (new eval row)

**Interfaces:**
- Consumes: schema from Task 2 (`auth.user`, `basic`, `nokkel_hint`); proxy behavior from Task 3.
- Produces: source id `kaggle` — the id Task 5's UI and Task 6's available_keys will surface.

- [ ] **Step 1: Live-verify the download endpoint shape**

Kaggle downloads need a key; use one from the environment if present, otherwise verify only the unauthenticated behavior (401/redirect shape):

```bash
# Uten nøkkel — forventet 401 (bekrefter endepunktet finnes og krever auth):
curl -s -o /dev/null -w "%{http_code}\n" "https://www.kaggle.com/api/v1/datasets/download/heptapod/titanic/train_and_test2.csv"
# Med nøkkel (hopp over hvis KAGGLE_USERNAME/KAGGLE_KEY ikke er satt):
[ -n "$KAGGLE_KEY" ] && curl -sL -u "$KAGGLE_USERNAME:$KAGGLE_KEY" -o /dev/null -w "%{http_code} %{url_effective}\n" "https://www.kaggle.com/api/v1/datasets/download/heptapod/titanic/train_and_test2.csv"
```

Expected: 401 without key; with key: 200 and a `storage.googleapis.com` effective URL (download redirects there — note this in quirks). If the observed behavior differs (e.g. different path shape), adjust `sporrings_url_mal`/quirks to what was observed.

- [ ] **Step 2: Append the entry to `data/data-sources.json`**

Add before the closing `]` (after the wikipedia entry):

```json
  {
    "id": "kaggle", "navn": "Kaggle Datasets", "utgiver": "(varierer — Kaggle-brukere)",
    "tillit": "etablert", "tilgang": "rest",
    "base_url": "https://www.kaggle.com/api/v1/",
    "cors": false,
    "auth": { "type": "api_key", "user": true, "plassering": "basic" },
    "nokkel_hint": "brukernavn:nøkkel — lag på kaggle.com → Settings → API",
    "sporrings_url_mal": "https://www.kaggle.com/api/v1/datasets/download/{eier}/{slug}/{filnavn}",
    "quirks": "krever brukernøkkel (registreres i AI-innstillingene; sendes som Basic auth via /api/hent); nedlasting redirecter til Google Storage — proxyen følger redirect; enkeltfil-URL gir fila direkte, uten {filnavn} kommer hele datasettet som zip (unngå); datasett er ofte UOFFISIELLE KOPIER — foretrekk primærkilder i registeret (SSB/WHO/Verdensbanken/OWID) når de dekker spørsmålet, og sjekk datasettets lisens; discovery via web_search + probe (ingen søkeadapter)"
  }
```

- [ ] **Step 3: Schema test passes against the shipped file**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/registry.test.ts`
Expected: pass — the shipped-file test (Task 2) now validates 12 entries.

- [ ] **Step 4: Eval row**

In `docs/eval/data-svar-evalsett.md`, append to the question table:

```markdown
| 12 | python | Finn et Kaggle-datasett om Titanic-passasjerene og vis overlevelsesrate etter kjønn. | kaggle (brukernøkkel; uten registrert nøkkel skal svaret si at nøkkel må registreres — ikke fabrikkere) |
```

- [ ] **Step 5: Commit**

```bash
git add data/data-sources.json docs/eval/data-svar-evalsett.md
git commit -m "feat(kilder): kaggle-oppføring m/ brukernøkkel (basic via proxy), proveniens-quirks og evalspørsmål"
```

---

### Task 8: Nordic PxWeb sources — SCB and StatFin (live-verified)

**Files:**
- Modify: `data/data-sources.json` (two entries)
- Modify: `docs/eval/data-svar-evalsett.md` (eval rows)

**Interfaces:**
- Consumes: existing `pxweb` search adapter (`_lib/tools/search-catalog.ts:38-51` — expects JSON with `tables[].id/label/firstPeriod/lastPeriod` and a `{q}` placeholder in `sok_endepunkt`).
- Produces: source ids `scb`, `statfin`.

- [ ] **Step 1: Live-verify SCB's PxWebApi 2 search + data shape**

```bash
curl -s "https://api.scb.se/ov0104/v2beta/api/v2/tables?query=arbetsl%C3%B6shet&lang=sv" | head -c 600; echo
```

Expected: JSON containing a `"tables": [...]` array with `id`/`label` fields (adapter-compatible). Then verify a data extract (pick an id from the search result, check its metadata first):

```bash
TABLE_ID=$(curl -s "https://api.scb.se/ov0104/v2beta/api/v2/tables?query=arbetsl%C3%B6shet&lang=sv" | python3 -c "import json,sys; print(json.load(sys.stdin)['tables'][0]['id'])")
curl -s "https://api.scb.se/ov0104/v2beta/api/v2/tables/$TABLE_ID/data?lang=sv&outputFormat=csv" | head -3
curl -sI "https://api.scb.se/ov0104/v2beta/api/v2/tables/$TABLE_ID/data?lang=sv&outputFormat=csv" | grep -i "access-control" || echo "INGEN CORS"
```

Record: does `/data` work on the same version path (unlike SSB's v2-beta quirk)? Is CORS present? Put findings verbatim into quirks. If the base path 404s, try `https://api.scb.se/OV0104/v2beta/api/v2/` (case) and `lang=en`; adjust entry to observed URLs.

- [ ] **Step 2: Live-verify StatFin**

Try the PxWebApi 2 shape first; fall back to v1:

```bash
curl -s "https://pxdata.stat.fi/api/v2/tables?query=ty%C3%B6tt%C3%B6myys&lang=en" | head -c 400; echo
curl -s "https://statfin.stat.fi/PXWeb/api/v1/en/StatFin/" | head -c 400; echo
```

- If a v2-style endpoint returns `{"tables": [...]}`: add StatFin as `tilgang: "pxweb"` with that `sok_endepunkt` (adapter works).
- If only v1 exists (navigation JSON, POST-based extracts): add as `tilgang: "rest"` WITHOUT `sok_endepunkt`, and write quirks describing the v1 POST pattern GET-wrapped via the proxy's `body` param, e.g.: `POST-uttrekk GET-innpakkes: # load /api/hent?url=<url-enkodet .../api/v1/en/StatFin/.../tabell.px>&body=<url-enkodet {"query":[...],"response":{"format":"csv"}}> as navn` (hent-core already supports this — see its GET-wrap test).

- [ ] **Step 3: Add the verified entries**

Starting points (ADJUST every URL/quirk to Step 1-2 observations before committing):

```json
  {
    "id": "scb", "navn": "Statistikmyndigheten SCB (PxWebApi 2)", "utgiver": "SCB",
    "tillit": "offisiell", "tilgang": "pxweb",
    "base_url": "https://api.scb.se/ov0104/v2beta/api/v2/",
    "sok_endepunkt": "https://api.scb.se/ov0104/v2beta/api/v2/tables?query={q}&lang=sv",
    "cors": false,
    "join_nokler": ["region", "år", "kön"],
    "sporrings_url_mal": "https://api.scb.se/ov0104/v2beta/api/v2/tables/{id}/data?valueCodes[{var}]={koder}&outputFormat=csv&lang=sv",
    "quirks": "<fyll inn fra verifisering: CORS-status, om /data virker på v2beta-stien, språkvalg sv/en>"
  },
  {
    "id": "statfin", "navn": "Statistikcentralen StatFin", "utgiver": "Tilastokeskus",
    "tillit": "offisiell", "tilgang": "<pxweb eller rest per verifisering>",
    "base_url": "<verifisert base>",
    "cors": false,
    "join_nokler": ["Vuosi (år)", "Alue (region)"],
    "quirks": "<fyll inn fra verifisering — inkl. POST-innpakkingsmønster hvis v1>"
  }
```

The `<...>` placeholders MUST be replaced with observed values — the shipped-file schema test will not catch prose placeholders, so re-read the diff before committing. Set `cors` to what the header check showed.

- [ ] **Step 4: Tests + eval rows**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/registry.test.ts`
Expected: pass.

Append eval rows:

```markdown
| 13 | python | Hvordan har arbeidsledigheten i Sverige utviklet seg siste 10 år? | scb (search_catalog) |
| 14 | r | Sammenlign befolkningsveksten i Finland og Norge siden 2000. | statfin + ssb (flerkilde-join på år) |
```

- [ ] **Step 5: Commit**

```bash
git add data/data-sources.json docs/eval/data-svar-evalsett.md
git commit -m "feat(kilder): SCB og StatFin — verifiserte endepunkter, pxweb-adapter gjenbrukt der API-formen matcher; evalspørsmål 13–14"
```

---

### Task 9: Danmarks Statistik + FHI + NAV (live-verified, skip-if-unverifiable)

**Files:**
- Modify: `data/data-sources.json`
- Modify: `docs/eval/data-svar-evalsett.md`

**Interfaces:**
- Consumes: schema from Task 2.
- Produces: source ids `dst`, and `fhi`/`nav` only if verified (Global Constraints: skip + log otherwise).

- [ ] **Step 1: Verify DST**

```bash
curl -s "https://api.statbank.dk/v1/tableinfo/FOLK1A?format=JSON" | head -c 400; echo
curl -s "https://api.statbank.dk/v1/data/FOLK1A/CSV?Tid=2024K1" | head -3
curl -sI "https://api.statbank.dk/v1/data/FOLK1A/CSV?Tid=2024K1" | grep -i "access-control" || echo "INGEN CORS"
```

Expected: tableinfo JSON with variables; CSV with `;`-separator. Add:

```json
  {
    "id": "dst", "navn": "Danmarks Statistik (StatBank API)", "utgiver": "Danmarks Statistik",
    "tillit": "offisiell", "tilgang": "rest",
    "base_url": "https://api.statbank.dk/v1/",
    "cors": <fra verifisering>,
    "join_nokler": ["TID (år/kvartal)", "OMRÅDE"],
    "sporrings_url_mal": "https://api.statbank.dk/v1/data/{tabell}/CSV?{var}={koder}",
    "quirks": "GET /v1/data/{tabell}/CSV med variabelfiltre som query-parametre; /v1/tableinfo/{tabell}?format=JSON gir variabler og koder; /v1/tables lister tabeller; CSV bruker semikolon; ingen søkeadapter — finn tabell-id via web_search eller /v1/tables"
  }
```

- [ ] **Step 2: Verify FHI (time-boxed ~15 min)**

```bash
curl -s "https://statistikk-data.fhi.no/api/open/v1/Common/source" | head -c 400; echo
# Hvis 404: undersøk https://statistikk.fhi.no og https://www.fhi.no/statistikk for API-dokumentasjon (web-søk er lov).
```

If a working open API with a documented extract URL pattern is found: add an `fhi` entry (`tillit: "offisiell"`, `join_nokler` incl. `"kommunenummer"`, quirks describing the observed pattern, `tilgang` per shape). If not verifiable in the time box: SKIP, and append to the eval doc's result log: `2026-07-23: fhi-oppføring utsatt — åpent API ikke verifisert (forsøkt: <urls>)`.

- [ ] **Step 3: Verify NAV (time-boxed ~15 min)**

```bash
curl -s "https://data.nav.no/api/3/action/package_search?q=arbeidsledighet" | head -c 400; echo
```

If a standard CKAN `package_search` responds: add `nav` as `tilgang: "rest"` (NOT `ckan` — the ckan adapter is FDK-specific POST, incompatible with standard CKAN GET) with quirks giving the CKAN API pattern. If not: SKIP with a result-log note — NAV's datasets are largely indexed via `datanorge` already, say so in the note.

- [ ] **Step 4: Tests + eval row + commit**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/registry.test.ts`

Append eval row (adjust to which entries shipped):

```markdown
| 15 | python | Hvordan har folketallet i Danmark utviklet seg per kvartal siden 2020? | dst |
```

```bash
git add data/data-sources.json docs/eval/data-svar-evalsett.md
git commit -m "feat(kilder): Danmarks Statistik (+ evt. FHI/NAV etter verifisering) m/ evalspørsmål; uverifiserte kandidater logget i evalsettet"
```

---

### Task 10: `SEARCH_HINTS` prompt block + docs + browser verification

**Files:**
- Modify: `netlify/edge-functions/_lib/data-svar-prompt.ts` (new const + `buildDataSvarSystem` line 150-152)
- Test: `netlify/edge-functions/_lib/data-svar-prompt.test.ts` (keyword list, ~line 19)
- Modify: `netlify/edge-functions/prompts/data-svar.md` (mirror + changelog comment)

**Interfaces:**
- Consumes: nothing new.
- Produces: final system-prompt block order `[INTRO, DELIVERY, SCIENCE, INLINE, MULTI, MODE[mode], SEARCH_HINTS, registryBlock]`.

- [ ] **Step 1: Extend the prompt test**

In `data-svar-prompt.test.ts`, add `"Søketips"` and `"awesome-public-datasets"` to the keyword array at ~line 19 (the list currently containing `"join", "Kilderegister", "transkribert", "modellkunnskap", "site:"`).

Run: `cd netlify/edge-functions && deno test --allow-all _lib/data-svar-prompt.test.ts`
Expected: FAIL (keywords missing).

- [ ] **Step 2: Add the block**

In `data-svar-prompt.ts`, after the `MULTI` const:

```ts
const SEARCH_HINTS = `\
## Søketips utenfor registeret

Når registeret og search_catalog ikke dekker temaet, er gode startpunkter for
web_search/web_fetch: awesome-public-datasets
(github.com/awesomedata/awesome-public-datasets — kategorisert lenkeliste, en
del døde lenker), data.europa.eu (EU-landenes offisielle datasett) og Google
Dataset Search (datasetsearch.research.google.com). Alt funnet denne veien er
tillit=funnet: probe URL-en før bruk (som alltid), og foretrekk registerkilder
når de dekker spørsmålet.`;
```

Update `buildDataSvarSystem`:

```ts
export function buildDataSvarSystem(mode: DataMode, registryBlock: string): string {
  return [INTRO, DELIVERY, SCIENCE, INLINE, MULTI, MODE[mode], SEARCH_HINTS, registryBlock].join("\n\n");
}
```

Run: `cd netlify/edge-functions && deno test --allow-all _lib/data-svar-prompt.test.ts`
Expected: PASS.

- [ ] **Step 3: Mirror in the source doc**

In `netlify/edge-functions/prompts/data-svar.md`: add the same `## Søketips utenfor registeret` section text where the block order is documented, and append a changelog entry in the file's existing HTML-comment changelog format:

```html
<!-- 2026-07-23: + SEARCH_HINTS-blokk (meta-kataloger som web_search-startpunkter,
  spec 2026-07-23-user-keys-and-source-registry §6) mellom modus-blokken og
  registerblokken; registerblokken markerer nå brukernøkkel-status via
  available_keys (kun ider). Evalsettet utvidet med #12–15. -->
```

- [ ] **Step 4: Full suite + browser smoke test**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/`
Expected: everything green.

Browser verification (use the superpowers verification flow / `netlify dev` or the repo's usual local serve):
1. Open the app, open AI settings → the «Datakilde-nøkler» section lists Kaggle with `nokkel_hint` placeholder.
2. Save a dummy Kaggle key → status shows «nøkkel registrert»; `localStorage.md_keys` contains it; legacy `md_anthropic_key` migrated if present.
3. Run a script with `# load /api/hent?url=<kaggle-url> as x` WITHOUT a key registered → Norwegian error pointing to settings.

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/data-svar-prompt.ts netlify/edge-functions/_lib/data-svar-prompt.test.ts netlify/edge-functions/prompts/data-svar.md
git commit -m "feat(prompt): Søketips-blokk (meta-kataloger som web_search-startpunkter) + doc/changelog-speiling"
```

---

## Post-plan notes

- **Deferred by spec (do NOT implement):** server-side vault/OAuth, GitHub App, generic LLM provider (prioritized roadmap item — staged as Anthropic-compatible base-URL first), user prompt additions. See spec «Out of scope / roadmap».
- Eval questions 12–15 are run manually per the eval doc's own process before the next prompt-affecting deploy; this plan only adds them.
