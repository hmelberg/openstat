# Two-tier LLM provider support + optional source keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users run Web mode (`data-svar`) and `tolk-resultat` against non-Anthropic providers — anthropic-compat base-URL (tier 1), OpenAI-compatible chat completions (tier 2, no web search, memory-URLs-must-probe), OpenAI Responses API (tier 2 with native `web_search`) — plus optional source keys (anonymous Kaggle).

**Architecture:** One global provider config (client: `md_llm_provider` + key in `md_keys.llm`; per request: `provider` body field + `X-Llm-Key` header). The edge keeps the Anthropic path byte-for-byte unchanged; custom types go through a new `_lib/providers/` layer: config validation (SSRF-guarded base-URL), per-type adapters translating to/from the Anthropic message format that the shared resume state keeps using, and a generic non-streaming agentic loop that mirrors `runAgenticStream`'s SSE protocol (progress/heartbeat/continue/text/done/error) so the client is untouched by provider choice.

**Tech Stack:** Deno TypeScript edge functions (`netlify/edge-functions/`), Deno tests in `_lib/`, classic-script JS in `js/` + inline `index.html`.

**Spec:** `docs/superpowers/specs/2026-07-23-llm-provider-tiers-design.md`

## Global Constraints

- Test command (README:79): `cd netlify/edge-functions && deno check *.ts _lib/*.ts _lib/providers/*.ts && deno test --allow-all _lib/`
- The default Anthropic path must remain byte-for-byte unchanged in behavior: no provider config in the request → exactly today's code paths run.
- Keys (`X-Llm-Key`, `X-Source-Key`, BYOK) must NEVER appear in: URLs, error bodies returned to clients, or server logs. Upstream error details may be logged ONLY after scrubbing the key (`detail.split(key).join("***")`).
- Provider fetches use `redirect: "error"` — an LLM API that redirects is abnormal and redirects could leak auth headers.
- base_url convention (all types): everything before the endpoint name — anthropic-compat calls `{base}/messages`, openai-compat `{base}/chat/completions`, openai-responses `{base}/responses`. UI placeholders show `https://api.anthropic.com/v1` / `https://api.openai.com/v1`.
- Exact validation values from the spec: model `[A-Za-z0-9._:/-]{1,100}`, key ≤ 250 chars, base_url must pass `isPublicHttpUrl` (`_lib/ssrf.ts`).
- Norwegian user-facing messages; exact strings where the spec fixes them (A4/A6 error messages — copied verbatim in the tasks below).
- Commit messages: `feat(...)`/`fix(...)`/`docs(...)` + Norwegian summary; commits on `main` (repo convention).
- TDD per task: test → RED → implement → GREEN → full check → commit.

---

### Task 1: `X-Llm-Key` accepted as BYOK-equivalent in the gates

**Files:**
- Modify: `netlify/edge-functions/_lib/auth.ts` (add `extractLlmKey`; touch `runGate` ~line 166-206 and `runAdminGate` ~line 295-333)
- Test: `netlify/edge-functions/_lib/auth.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `extractLlmKey(request: Request): string | null` — returns the `X-Llm-Key` header value when 8–250 chars of printable ASCII, else null. Both gates treat a non-null llm key exactly like a non-null BYOK key (bypass token auth; base checks still run) when `opts.allowByok` is set. Tasks 8–9 rely on requests with only `X-Llm-Key` passing `adminGate`/`gate`.

- [ ] **Step 1: Write the failing tests**

Append to `netlify/edge-functions/_lib/auth.test.ts` (match the file's existing helper style — read its first ~40 lines for the deps/request builders it already has and reuse them; the assertions below are what matters):

```ts
Deno.test("extractLlmKey accepts printable ASCII 8-250, rejects junk", () => {
  const mk = (v: string) => new Request("https://a.test/x", { headers: { "X-Llm-Key": v } });
  assertEquals(extractLlmKey(mk("sk-proj-abc123XYZ")), "sk-proj-abc123XYZ");
  assertEquals(extractLlmKey(mk("short")), null);                  // < 8
  assertEquals(extractLlmKey(mk("x".repeat(251))), null);          // too long
  assertEquals(extractLlmKey(mk("har mellomrom-i-seg")), null);    // space
  assertEquals(extractLlmKey(mk("nøkkel-med-æøå-1234")), null);    // non-ASCII
  assertEquals(extractLlmKey(new Request("https://a.test/x")), null);
});

Deno.test("runGate: X-Llm-Key bypasses token auth when allowByok", async () => {
  const req = new Request("https://a.test/api/x", {
    method: "POST", headers: { "X-Llm-Key": "sk-proj-abc123XYZ" },
  });
  const resp = await runGate(req, { endpoint: "t", maxBodyBytes: 1000, allowByok: true }, {
    checkRateLimit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    validateToken: () => Promise.resolve(false),
    now: () => 0, cache: new Map(),
  });
  assertEquals(resp, null);
});

Deno.test("runGate: X-Llm-Key does NOT bypass without allowByok", async () => {
  const req = new Request("https://a.test/api/x", {
    method: "POST", headers: { "X-Llm-Key": "sk-proj-abc123XYZ" },
  });
  const resp = await runGate(req, { endpoint: "t", maxBodyBytes: 1000 }, {
    checkRateLimit: () => Promise.resolve({ allowed: true, retryAfterSeconds: 0 }),
    validateToken: () => Promise.resolve(false),
    now: () => 0, cache: new Map(),
  });
  assertEquals(resp?.status, 401);
});
```

Add `extractLlmKey` to the file's import from `./auth.ts`.

- [ ] **Step 2: Run to verify RED**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/auth.test.ts`
Expected: FAIL (`extractLlmKey` not exported).

- [ ] **Step 3: Implement**

In `auth.ts`, below `extractByokKey` (line 56):

```ts
/**
 * Custom-provider key from the X-Llm-Key header (spec 2026-07-23-llm-provider-
 * tiers A1). Format-agnostic (providers differ) but sane: printable ASCII,
 * 8–250 chars. Same BYOK trust position as extractByokKey: the user brings
 * their own credentials and billing. Never logged or cached.
 */
export function extractLlmKey(request: Request): string | null {
  const raw = (request.headers.get("x-llm-key") ?? "").trim();
  if (raw.length < 8 || raw.length > 250) return null;
  return /^[\x21-\x7E]+$/.test(raw) ? raw : null;
}
```

In `runGate` (line 171) change:

```ts
  const byokKey = opts.allowByok ? (extractByokKey(request) ?? extractLlmKey(request)) : null;
```

In `runAdminGate` (line 300) make the identical change. (The variable keeps its name; both keys mean "user brings own credentials".)

- [ ] **Step 4: GREEN + full check**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/auth.test.ts` → PASS.
Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts && deno test --allow-all _lib/` → all green.

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/auth.ts netlify/edge-functions/_lib/auth.test.ts
git commit -m "feat(auth): X-Llm-Key godtas som BYOK-ekvivalent i gatene (egen leverandørnøkkel = egne kredentialer)"
```

---

### Task 2: Provider config parsing — `_lib/providers/config.ts`

**Files:**
- Create: `netlify/edge-functions/_lib/providers/config.ts`
- Test: `netlify/edge-functions/_lib/providers/config.test.ts`

**Interfaces:**
- Consumes: `isPublicHttpUrl` from `../ssrf.ts`, `extractLlmKey` from `../auth.ts` (Task 1).
- Produces (Tasks 4, 5, 8, 9 use these exact shapes):

```ts
export type ProviderType = "anthropic-compat" | "openai-compat" | "openai-responses";
export interface ProviderConfig {
  type: ProviderType;
  baseUrl: string;              // trimmed, no trailing slash, SSRF-validated
  model: string;
  key: string;                  // from X-Llm-Key
  webSearch: "none" | "native"; // derived: openai-compat → none, else native
}
export function parseProviderConfig(raw: unknown, request: Request):
  ProviderConfig | { error: Response } | null;   // null = no custom provider
export function scrubKey(text: string, key: string): string;
```

- [ ] **Step 1: Write the failing tests**

Create `netlify/edge-functions/_lib/providers/config.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseProviderConfig, scrubKey } from "./config.ts";

const req = (key?: string) =>
  new Request("https://a.test/x", { headers: key ? { "X-Llm-Key": key } : {} });
const KEY = "sk-proj-abc123XYZ";

Deno.test("parseProviderConfig: absent or type anthropic → null", () => {
  assertEquals(parseProviderConfig(undefined, req(KEY)), null);
  assertEquals(parseProviderConfig(null, req(KEY)), null);
  assertEquals(parseProviderConfig({ type: "anthropic" }, req(KEY)), null);
});

Deno.test("parseProviderConfig: valid openai-compat", () => {
  const cfg = parseProviderConfig(
    { type: "openai-compat", base_url: "https://api.openai.com/v1/", model: "gpt-5.6" },
    req(KEY),
  );
  if (!cfg || "error" in cfg) throw new Error("uventet avvisning");
  assertEquals(cfg.baseUrl, "https://api.openai.com/v1");   // trailing slash strippet
  assertEquals(cfg.webSearch, "none");
  assertEquals(cfg.key, KEY);
});

Deno.test("parseProviderConfig: openai-responses gets webSearch native", () => {
  const cfg = parseProviderConfig(
    { type: "openai-responses", base_url: "https://api.openai.com/v1", model: "gpt-5.6" },
    req(KEY),
  );
  if (!cfg || "error" in cfg) throw new Error("uventet avvisning");
  assertEquals(cfg.webSearch, "native");
});

Deno.test("parseProviderConfig: rejections are 400 with named field, no key echo", async () => {
  const cases: [unknown, Request][] = [
    [{ type: "gemini", base_url: "https://x.example", model: "m" }, req(KEY)],       // ukjent type
    [{ type: "openai-compat", base_url: "http://169.254.169.254/v1", model: "m" }, req(KEY)], // SSRF
    [{ type: "openai-compat", base_url: "https://x.example", model: "har mellomrom" }, req(KEY)], // modell
    [{ type: "openai-compat", base_url: "https://x.example", model: "m" }, req()],   // mangler nøkkel
  ];
  for (const [raw, r] of cases) {
    const out = parseProviderConfig(raw, r);
    if (!out || !("error" in out)) throw new Error("skulle vært avvist: " + JSON.stringify(raw));
    assertEquals(out.error.status, 400);
    const text = await out.error.clone().text();
    if (text.includes(KEY)) throw new Error("nøkkel i feilkropp");
  }
});

Deno.test("scrubKey replaces every occurrence", () => {
  assertEquals(scrubKey(`err ${KEY} og ${KEY}`, KEY), "err *** og ***");
  assertEquals(scrubKey("ren tekst", KEY), "ren tekst");
  assertEquals(scrubKey("x", ""), "x");
});
```

- [ ] **Step 2: RED**

Run: `cd netlify/edge-functions && deno test --allow-all _lib/providers/config.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `config.ts`**

```ts
// Custom-LLM provider config (spec 2026-07-23-llm-provider-tiers A1/A2).
// Parsed per request from the JSON body's `provider` field + the X-Llm-Key
// header. base_url is user-supplied and the edge will POST the prompt AND the
// key there — hence the SSRF guard and the everything-before-endpoint-name
// convention ({base}/messages | {base}/chat/completions | {base}/responses).
import { isPublicHttpUrl } from "../ssrf.ts";

export type ProviderType = "anthropic-compat" | "openai-compat" | "openai-responses";

export interface ProviderConfig {
  type: ProviderType;
  baseUrl: string;
  model: string;
  key: string;
  webSearch: "none" | "native";
}

const TYPES = new Set<string>(["anthropic-compat", "openai-compat", "openai-responses"]);
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,100}$/;

export function parseProviderConfig(
  raw: unknown,
  request: Request,
): ProviderConfig | { error: Response } | null {
  if (raw === undefined || raw === null) return null;
  const p = raw as Record<string, unknown>;
  if (p.type === "anthropic" || p.type === undefined) return null;
  if (typeof p.type !== "string" || !TYPES.has(p.type)) {
    return { error: new Response("Ukjent leverandørtype", { status: 400 }) };
  }
  const baseUrl = typeof p.base_url === "string" ? p.base_url.trim().replace(/\/+$/, "") : "";
  if (!baseUrl || !isPublicHttpUrl(baseUrl)) {
    return { error: new Response("Ugyldig eller blokkert base-URL for leverandøren", { status: 400 }) };
  }
  const model = typeof p.model === "string" ? p.model.trim() : "";
  if (!MODEL_RE.test(model)) {
    return { error: new Response("Ugyldig modellnavn", { status: 400 }) };
  }
  const key = (request.headers.get("x-llm-key") ?? "").trim();
  if (!key || key.length > 250) {
    return { error: new Response("Mangler eller ugyldig X-Llm-Key", { status: 400 }) };
  }
  return {
    type: p.type as ProviderType,
    baseUrl,
    model,
    key,
    webSearch: p.type === "openai-compat" ? "none" : "native",
  };
}

/** Scrub a key out of upstream error text before it may be logged. */
export function scrubKey(text: string, key: string): string {
  return key ? text.split(key).join("***") : text;
}
```

- [ ] **Step 4: GREEN + full check** (`deno check *.ts _lib/*.ts _lib/providers/*.ts` from now on)

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/providers/config.ts netlify/edge-functions/_lib/providers/config.test.ts
git commit -m "feat(providers): config-parsing m/ SSRF-vern av base-URL, modell/nøkkel-validering, webSearch-kapabilitet per type"
```

---

### Task 3: Generic non-streaming agentic loop — `_lib/providers/agentic.ts`

**Files:**
- Create: `netlify/edge-functions/_lib/providers/agentic.ts`
- Modify: `netlify/edge-functions/_lib/anthropic.ts:326-336` (`AgenticResumeState` gains one optional field)
- Test: `netlify/edge-functions/_lib/providers/agentic.test.ts`

**Interfaces:**
- Consumes: `AgenticResumeState`, `RetryDeps` from `../anthropic.ts`.
- Produces (Tasks 4, 5, 8 use these exact shapes):

```ts
export interface ProviderTurnResult {
  text: string;
  toolUses: { id: string; name: string; input: Record<string, unknown> }[];
  searchNotes: string[];       // hosted-search progress lines, pre-formatted
  stop: "tool_use" | "end";
  usage: { inputTokens: number; outputTokens: number };
  responseId?: string;         // openai-responses only
}
export interface TurnOpts { system: string; tools: unknown[]; maxTokens: number; deps?: RetryDeps }
export type RunTurn = (state: AgenticResumeState, opts: TurnOpts) => Promise<ProviderTurnResult>;
export interface ProviderAgenticOptions {
  runTurn: RunTurn;
  system: string; userContent: string; tools: unknown[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  progressLabel?: (name: string, input: Record<string, unknown>) => string;
  maxTokens?: number; maxClientToolCalls?: number; maxTurns?: number;
  resume?: AgenticResumeState; turnsPerCall?: number;
  continueExtra?: () => Record<string, unknown>; deps?: RetryDeps;
}
export function runProviderAgenticStream(opts: ProviderAgenticOptions): ReadableStream<Uint8Array>;
```

- `AgenticResumeState` gains `prevResponseId?: string;` (in `anthropic.ts` — harmless for the Anthropic path, carried verbatim through the client resume round-trip).
- SSE events emitted are identical in shape to `runAgenticStream`'s: `progress` (with `replace: true` for heartbeat), `text`, `done` (usage fields; cache fields emitted as 0), `continue` (`state` + `continueExtra()`), `error`.

- [ ] **Step 1: Write the failing tests**

Create `netlify/edge-functions/_lib/providers/agentic.test.ts`:

```ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runProviderAgenticStream, type ProviderTurnResult } from "./agentic.ts";

async function collect(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter(Boolean)
    .map((l) => JSON.parse(l.replace(/^data: /, "")));
}

Deno.test("løkka: tool-tur → verktøy kjøres → neste tur gir svar (2 turer, turnsPerCall=2)", async () => {
  const turns: ProviderTurnResult[] = [
    { text: "", toolUses: [{ id: "c1", name: "probe", input: { url: "https://x.example/d.csv" } }],
      searchNotes: [], stop: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } },
    { text: "Svaret.", toolUses: [], searchNotes: ["🔎 Websøk: testquery"], stop: "end",
      usage: { inputTokens: 20, outputTokens: 15 } },
  ];
  const seenStates: number[] = [];
  const executed: string[] = [];
  const events = await collect(runProviderAgenticStream({
    runTurn: (state) => { seenStates.push(state.messages.length); return Promise.resolve(turns.shift()!); },
    system: "SYS", userContent: "Q?", tools: [{ name: "probe" }],
    executeTool: (name, input) => { executed.push(`${name}:${input.url}`); return Promise.resolve("ok=true"); },
    turnsPerCall: 2,
  }));
  assertEquals(executed, ["probe:https://x.example/d.csv"]);
  assertEquals(seenStates, [1, 3]);            // Q → +assistant +tool_result
  const texts = events.filter((e) => e.type === "text");
  assertEquals(texts, [{ type: "text", text: "Svaret." }]);
  const done = events.find((e) => e.type === "done") as Record<string, number>;
  assertEquals(done.inputTokens, 30);
  assertEquals(done.outputTokens, 20);
  assertEquals(done.cacheReadTokens, 0);
  if (!events.some((e) => e.type === "progress" && String(e.text).includes("Websøk"))) {
    throw new Error("searchNotes ble ikke til progress-events");
  }
});

Deno.test("løkka: turnsPerCall brukt opp → continue-event med state + extra", async () => {
  const events = await collect(runProviderAgenticStream({
    runTurn: () => Promise.resolve({
      text: "", toolUses: [{ id: "c1", name: "probe", input: {} }],
      searchNotes: [], stop: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
    } as ProviderTurnResult),
    system: "SYS", userContent: "Q?", tools: [],
    executeTool: () => Promise.resolve("ok"),
    turnsPerCall: 1,
    continueExtra: () => ({ probed: [{ url: "u" }] }),
  }));
  const cont = events.find((e) => e.type === "continue") as Record<string, unknown>;
  if (!cont) throw new Error("mangler continue: " + JSON.stringify(events));
  const state = cont.state as { messages: unknown[]; turn: number };
  assertEquals(state.turn, 1);
  assertEquals(state.messages.length, 3);
  assertEquals((cont.probed as unknown[]).length, 1);
});

Deno.test("løkka: responseId lagres i state.prevResponseId, verktøybudsjett håndheves", async () => {
  let calls = 0;
  const events = await collect(runProviderAgenticStream({
    runTurn: () => Promise.resolve({
      text: "", toolUses: [{ id: `c${++calls}`, name: "probe", input: {} }],
      searchNotes: [], stop: "tool_use", usage: { inputTokens: 1, outputTokens: 1 },
      responseId: `resp_${calls}`,
    } as ProviderTurnResult),
    system: "SYS", userContent: "Q?", tools: [],
    executeTool: () => Promise.resolve("ok"),
    maxClientToolCalls: 1, turnsPerCall: 2,
  }));
  const cont = events.find((e) => e.type === "continue") as Record<string, unknown>;
  const state = cont.state as { prevResponseId?: string; messages: Record<string, unknown>[] };
  assertEquals(state.prevResponseId, "resp_2");
  // andre verktøykallet skal ha fått budsjett-beskjeden i tool_result
  const lastResults = state.messages[state.messages.length - 1].content as { content: string }[];
  if (!lastResults[0].content.includes("Verktøy-budsjettet")) {
    throw new Error("budsjettmelding mangler: " + JSON.stringify(lastResults));
  }
});

Deno.test("løkka: runTurn-feil → error-event, aldri exception", async () => {
  const events = await collect(runProviderAgenticStream({
    runTurn: () => Promise.reject(new Error("Leverandørfeil 500")),
    system: "SYS", userContent: "Q?", tools: [], executeTool: () => Promise.resolve("ok"),
  }));
  const err = events.find((e) => e.type === "error");
  if (!err || !String(err.message).includes("Leverandørfeil 500")) {
    throw new Error("mangler error-event: " + JSON.stringify(events));
  }
});
```

- [ ] **Step 2: RED** — `deno test --allow-all _lib/providers/agentic.test.ts` → module not found.

- [ ] **Step 3: Implement**

First, in `anthropic.ts`, extend `AgenticResumeState` (line 326-336) with one field after `clientCalls`:

```ts
  // openai-responses (spec A6): server-side samtaletilstand — bare id-en
  // rundtures via klienten; meldingsarrayet bærer da kun siste tool-results.
  prevResponseId?: string;
```

Then create `_lib/providers/agentic.ts`:

```ts
// Generic non-streaming agentic loop for custom providers (spec 2026-07-23-
// llm-provider-tiers A3). Mirrors runAgenticStream's SSE protocol exactly
// (progress/heartbeat/continue/text/done/error) so js/ai-chat.js is untouched
// by provider choice; the provider call is a runTurn callback so this module
// knows no wire formats. State stays in Anthropic message format — adapters
// translate at their boundary.
import type { AgenticResumeState, RetryDeps } from "../anthropic.ts";

export interface ProviderTurnResult {
  text: string;
  toolUses: { id: string; name: string; input: Record<string, unknown> }[];
  searchNotes: string[];
  stop: "tool_use" | "end";
  usage: { inputTokens: number; outputTokens: number };
  responseId?: string;
}

export interface TurnOpts {
  system: string;
  tools: unknown[];
  maxTokens: number;
  deps?: RetryDeps;
}

export type RunTurn = (state: AgenticResumeState, opts: TurnOpts) => Promise<ProviderTurnResult>;

export interface ProviderAgenticOptions {
  runTurn: RunTurn;
  system: string;
  userContent: string;
  tools: unknown[];
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  progressLabel?: (name: string, input: Record<string, unknown>) => string;
  maxTokens?: number;
  maxClientToolCalls?: number;
  maxTurns?: number;
  resume?: AgenticResumeState;
  turnsPerCall?: number;
  continueExtra?: () => Record<string, unknown>;
  deps?: RetryDeps;
}

const HEARTBEAT_MS = 10_000;

export function runProviderAgenticStream(opts: ProviderAgenticOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const maxClientCalls = opts.maxClientToolCalls ?? 12;
  const maxTurns = opts.maxTurns ?? 24;
  const turnsPerCall = opts.turnsPerCall ?? 1;

  return new ReadableStream({
    async start(controller) {
      const emit = (obj: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      const state: AgenticResumeState = opts.resume ?? {
        messages: [{ role: "user", content: opts.userContent }],
        turn: 0,
        clientCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      };

      try {
        for (let i = 0; i < turnsPerCall; i++) {
          if (state.turn >= maxTurns) throw new Error("tool-loopen nådde maks antall turer");
          const turnLabel = state.turn === 0
            ? "🧠 Tolker spørsmålet og planlegger"
            : `🤔 Arbeider med svaret (tur ${state.turn + 1})`;
          emit({ type: "progress", text: `${turnLabel} …`, replace: true });
          const turnStart = Date.now();
          const beat = setInterval(() => {
            const s = Math.round((Date.now() - turnStart) / 1000);
            try {
              emit({ type: "progress", text: `${turnLabel} … (${s} s)`, replace: true });
            } catch (_) { /* stream already closed */ }
          }, HEARTBEAT_MS);
          let turn: ProviderTurnResult;
          try {
            turn = await opts.runTurn(state, {
              system: opts.system,
              tools: opts.tools,
              maxTokens: opts.maxTokens ?? 8192,
              deps: opts.deps,
            });
          } finally {
            clearInterval(beat);
          }
          state.turn++;
          state.usage.inputTokens += turn.usage.inputTokens;
          state.usage.outputTokens += turn.usage.outputTokens;
          if (turn.responseId) state.prevResponseId = turn.responseId;
          for (const note of turn.searchNotes) emit({ type: "progress", text: note });

          if (turn.stop === "tool_use" && turn.toolUses.length) {
            const content: Record<string, unknown>[] = [];
            if (turn.text) content.push({ type: "text", text: turn.text });
            for (const tu of turn.toolUses) {
              content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
            }
            state.messages.push({ role: "assistant", content });
            const results: Record<string, unknown>[] = [];
            for (const tu of turn.toolUses) {
              state.clientCalls++;
              const label = opts.progressLabel?.(tu.name, tu.input) ?? `Kjører ${tu.name} …`;
              emit({ type: "progress", text: label });
              let out: string;
              if (state.clientCalls > maxClientCalls) {
                out = "Verktøy-budsjettet er brukt opp — generer svaret NÅ med det du allerede har funnet. Vær ærlig om hva som mangler.";
              } else {
                try {
                  out = await opts.executeTool(tu.name, tu.input);
                } catch (e) {
                  out = `Verktøyfeil: ${String(e).slice(0, 300)}`;
                }
              }
              results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
            }
            state.messages.push({ role: "user", content: results });
            continue;
          }

          if (turn.text) emit({ type: "text", text: turn.text });
          emit({ type: "done", ...state.usage });
          controller.close();
          return;
        }
        emit({ type: "continue", state, ...(opts.continueExtra?.() ?? {}) });
        controller.close();
        return;
      } catch (e) {
        emit({ type: "error", message: String(e) });
        controller.close();
      }
    },
  });
}
```

- [ ] **Step 4: GREEN + full check** (note the expanded check glob: `deno check *.ts _lib/*.ts _lib/providers/*.ts`)

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/providers/agentic.ts netlify/edge-functions/_lib/providers/agentic.test.ts netlify/edge-functions/_lib/anthropic.ts
git commit -m "feat(providers): generisk ikke-streamende agentic-løkke — samme SSE-protokoll som runAgenticStream, leverandørkall som runTurn-callback; prevResponseId i resume-state"
```

---

### Task 4: OpenAI chat-completions adapter — `_lib/providers/openai-compat.ts`

**Files:**
- Create: `netlify/edge-functions/_lib/providers/openai-compat.ts`
- Test: `netlify/edge-functions/_lib/providers/openai-compat.test.ts`

**Interfaces:**
- Consumes: `ProviderConfig`/`scrubKey` (Task 2), `ProviderTurnResult`/`TurnOpts` (Task 3), `fetchWithRetry`/`RetryDeps`/`AgenticResumeState` from `../anthropic.ts`.
- Produces (Tasks 8, 9):

```ts
export function makeOpenAiCompatTurn(cfg: ProviderConfig): RunTurn;
export function messageOpenAiCompat(cfg: ProviderConfig,
  o: { system: string; prompt: string; maxTokens: number }, deps?: RetryDeps):
  Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
export function toOpenAiTools(anthropicTools: unknown[]): unknown[];       // exported for tests + Task 5
export function toOpenAiMessages(system: string, messages: Record<string, unknown>[]): unknown[];
```

- Endpoint: `POST {cfg.baseUrl}/chat/completions`, `Authorization: Bearer {key}`, `redirect: "error"`.
- Spec-fixed error message when the API rejects tools (400 + /tool/i in detail): `data-svar krever en modell med verktøystøtte (tool-calling) — leverandøren avviste tools-parameteren`.

- [ ] **Step 1: Write the failing tests**

Create `openai-compat.test.ts`:

```ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeOpenAiCompatTurn, messageOpenAiCompat, toOpenAiMessages, toOpenAiTools } from "./openai-compat.ts";
import type { ProviderConfig } from "./config.ts";
import type { AgenticResumeState } from "../anthropic.ts";

const CFG: ProviderConfig = {
  type: "openai-compat", baseUrl: "https://llm.example/v1",
  model: "test-m", key: "sk-proj-abc123XYZ", webSearch: "none",
};
const freshState = (): AgenticResumeState => ({
  messages: [{ role: "user", content: "Spørsmål?" }], turn: 0, clientCalls: 0,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
});
function fakeFetch(status: number, body: unknown, captured: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {}): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    captured.url = String(input);
    captured.body = JSON.parse(String(init?.body));
    captured.headers = (init?.headers as Record<string, string>) ?? {};
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
}

Deno.test("toOpenAiTools: input_schema → function.parameters", () => {
  const out = toOpenAiTools([{ name: "probe", description: "d", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }]) as Record<string, Record<string, unknown>>[];
  assertEquals(out[0].function.name, "probe");
  assertEquals((out[0].function.parameters as Record<string, unknown>).required, ["url"]);
});

Deno.test("toOpenAiMessages: tool_use/tool_result-historikk oversettes", () => {
  const msgs = toOpenAiMessages("SYS", [
    { role: "user", content: "Q?" },
    { role: "assistant", content: [
      { type: "text", text: "tenker" },
      { type: "tool_use", id: "c1", name: "probe", input: { url: "u1" } },
    ]},
    { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok=true" }] },
  ]) as Record<string, unknown>[];
  assertEquals(msgs[0], { role: "system", content: "SYS" });
  assertEquals(msgs[1], { role: "user", content: "Q?" });
  const asst = msgs[2] as { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
  assertEquals(asst.tool_calls[0].id, "c1");
  assertEquals(JSON.parse(asst.tool_calls[0].function.arguments), { url: "u1" });
  assertEquals(msgs[3], { role: "tool", tool_call_id: "c1", content: "ok=true" });
});

Deno.test("makeOpenAiCompatTurn: tool_calls → toolUses, stop tool_use", async () => {
  const captured: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {};
  const turn = makeOpenAiCompatTurn(CFG);
  const res = await turn(freshState(), {
    system: "SYS", maxTokens: 100,
    tools: [{ name: "probe", description: "d", input_schema: { type: "object", properties: {} } }],
    deps: { fetchImpl: fakeFetch(200, {
      choices: [{ message: { content: null, tool_calls: [
        { id: "c9", type: "function", function: { name: "probe", arguments: `{"url":"u9"}` } },
      ]}}],
      usage: { prompt_tokens: 11, completion_tokens: 3 },
    }, captured) },
  });
  assertEquals(captured.url, "https://llm.example/v1/chat/completions");
  assertEquals(captured.headers?.["Authorization"], "Bearer sk-proj-abc123XYZ");
  assertEquals(res.stop, "tool_use");
  assertEquals(res.toolUses, [{ id: "c9", name: "probe", input: { url: "u9" } }]);
  assertEquals(res.usage, { inputTokens: 11, outputTokens: 3 });
});

Deno.test("makeOpenAiCompatTurn: 400 m/ tool-avvisning → spec-melding; nøkkel aldri i feil", async () => {
  const turn = makeOpenAiCompatTurn(CFG);
  const err = await assertRejects(() => turn(freshState(), {
    system: "S", maxTokens: 10, tools: [{ name: "probe", input_schema: {} }],
    deps: { fetchImpl: fakeFetch(400, { error: { message: "'tools' is not supported, key sk-proj-abc123XYZ" } }), retries: 0 },
  }), Error);
  if (!err.message.includes("verktøystøtte")) throw new Error("feil melding: " + err.message);
  if (err.message.includes("sk-proj")) throw new Error("nøkkel i feilmelding");
});

Deno.test("messageOpenAiCompat: enkel tur uten tools", async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const res = await messageOpenAiCompat(CFG, { system: "SYS", prompt: "P", maxTokens: 55 },
    { fetchImpl: fakeFetch(200, { choices: [{ message: { content: "Svar." } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }, captured) });
  assertEquals(res.text, "Svar.");
  assertEquals(captured.body?.tools, undefined);
  assertEquals(captured.body?.max_tokens, 55);
});
```

- [ ] **Step 2: RED** — module not found.

- [ ] **Step 3: Implement `openai-compat.ts`**

```ts
// OpenAI chat-completions adapter (spec A3, tier 2). Translates between the
// Anthropic-format resume state and the chat.completions wire format; one
// non-streaming turn per call. The lowest-common-denominator API most
// providers implement (Mistral/Groq/DeepSeek/Ollama/vLLM/gateways).
import { type AgenticResumeState, fetchWithRetry, type RetryDeps } from "../anthropic.ts";
import { type ProviderConfig, scrubKey } from "./config.ts";
import type { ProviderTurnResult, RunTurn, TurnOpts } from "./agentic.ts";

export function toOpenAiTools(anthropicTools: unknown[]): unknown[] {
  return (anthropicTools as Record<string, unknown>[]).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: t.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

export function toOpenAiMessages(
  system: string,
  messages: Record<string, unknown>[],
): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const content = m.content;
    if (typeof content === "string") {
      out.push({ role: m.role, content });
      continue;
    }
    const blocks = (Array.isArray(content) ? content : []) as Record<string, unknown>[];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const msg: Record<string, unknown> = { role: "assistant", content: text || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else {
      for (const b of blocks) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(b.content ?? "") });
        } else if (b.type === "text") {
          out.push({ role: "user", content: b.text ?? "" });
        }
      }
    }
  }
  return out;
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v as Record<string, unknown> : {};
  } catch (_) {
    return {};
  }
}

async function throwUpstream(resp: Response, cfg: ProviderConfig, hadTools: boolean): Promise<never> {
  const detail = await resp.text().catch(() => "");
  console.error(`LLM provider error ${resp.status}: ${scrubKey(detail, cfg.key)}`);
  if (resp.status === 400 && hadTools && /tool/i.test(detail)) {
    throw new Error("data-svar krever en modell med verktøystøtte (tool-calling) — leverandøren avviste tools-parameteren");
  }
  throw new Error(`Leverandørfeil ${resp.status}`);
}

export function makeOpenAiCompatTurn(cfg: ProviderConfig): RunTurn {
  return async (state: AgenticResumeState, opts: TurnOpts): Promise<ProviderTurnResult> => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: opts.maxTokens,
      stream: false,
      messages: toOpenAiMessages(opts.system, state.messages),
    };
    if (opts.tools.length) body.tools = toOpenAiTools(opts.tools);
    const resp = await fetchWithRetry(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
    }, opts.deps);
    if (!resp.ok) await throwUpstream(resp, cfg, opts.tools.length > 0);
    const json = await resp.json();
    const msg = (json?.choices?.[0]?.message ?? {}) as Record<string, unknown>;
    const toolUses = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
      .map((tc: Record<string, Record<string, unknown>>) => ({
        id: String(tc.id ?? ""),
        name: String(tc.function?.name ?? ""),
        input: safeParseJson(tc.function?.arguments),
      }));
    return {
      text: typeof msg.content === "string" ? msg.content : "",
      toolUses,
      searchNotes: [],
      stop: toolUses.length ? "tool_use" : "end",
      usage: {
        inputTokens: json?.usage?.prompt_tokens ?? 0,
        outputTokens: json?.usage?.completion_tokens ?? 0,
      },
    };
  };
}

/** Single text turn without tools — tolk-resultat (spec A5). */
export async function messageOpenAiCompat(
  cfg: ProviderConfig,
  o: { system: string; prompt: string; maxTokens: number },
  deps?: RetryDeps,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  const resp = await fetchWithRetry(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: o.maxTokens,
      stream: false,
      messages: [{ role: "system", content: o.system }, { role: "user", content: o.prompt }],
    }),
  }, deps);
  if (!resp.ok) await throwUpstream(resp, cfg, false);
  const json = await resp.json();
  return {
    text: String(json?.choices?.[0]?.message?.content ?? ""),
    usage: {
      inputTokens: json?.usage?.prompt_tokens ?? 0,
      outputTokens: json?.usage?.completion_tokens ?? 0,
    },
  };
}
```

- [ ] **Step 4: GREEN + full check**

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/providers/openai-compat.ts netlify/edge-functions/_lib/providers/openai-compat.test.ts
git commit -m "feat(providers): openai-compat-adapter — chat.completions m/ function calling, format-oversettelse begge veier, nøkkel-scrubbing i logg"
```

---

### Task 5: OpenAI Responses adapter — `_lib/providers/openai-responses.ts`

**Files:**
- Create: `netlify/edge-functions/_lib/providers/openai-responses.ts`
- Test: `netlify/edge-functions/_lib/providers/openai-responses.test.ts`

**Interfaces:**
- Consumes: same as Task 4 plus `prevResponseId` on `AgenticResumeState` (Task 3).
- Produces (Tasks 8, 9):

```ts
export function makeOpenAiResponsesTurn(cfg: ProviderConfig): RunTurn;
export function messageOpenAiResponses(cfg: ProviderConfig,
  o: { system: string; prompt: string; maxTokens: number }, deps?: RetryDeps):
  Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
```

- Endpoint: `POST {cfg.baseUrl}/responses`, `Authorization: Bearer`, `redirect: "error"`, `store: true`.
- First turn: `instructions` = system, `input` = the first user message's text, `tools` = flat function tools + `{type:"web_search"}`.
- Later turns: `previous_response_id` = `state.prevResponseId`, `input` = the LAST message's `tool_result` blocks mapped to `{type:"function_call_output", call_id, output}` — no instructions/history re-sent.
- Output mapping: `function_call` items → toolUses; `web_search_call` items → searchNotes (`🔎 Websøk: …`); `message` items' `output_text` parts → text; `json.id` → responseId.
- Spec-fixed error messages: store rejected (400 + /store|previous_response/i) → `leverandøren støtter ikke lagret samtaletilstand (store) — bruk typen openai-kompatibel i stedet`; tools rejected (400 + /tool/i) → same message as Task 4.

- [ ] **Step 1: Write the failing tests**

Create `openai-responses.test.ts`:

```ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeOpenAiResponsesTurn, messageOpenAiResponses } from "./openai-responses.ts";
import type { ProviderConfig } from "./config.ts";
import type { AgenticResumeState } from "../anthropic.ts";

const CFG: ProviderConfig = {
  type: "openai-responses", baseUrl: "https://api.openai.example/v1",
  model: "gpt-test", key: "sk-proj-abc123XYZ", webSearch: "native",
};
function fakeFetch(status: number, body: unknown, captured: { url?: string; body?: Record<string, unknown> } = {}): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    captured.url = String(input);
    captured.body = JSON.parse(String(init?.body));
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
}
const TOOLS = [{ name: "probe", description: "d", input_schema: { type: "object", properties: {} } }];

Deno.test("første tur: instructions+input+web_search-tool; output mappes", async () => {
  const captured: { url?: string; body?: Record<string, unknown> } = {};
  const state: AgenticResumeState = {
    messages: [{ role: "user", content: "Q?" }], turn: 0, clientCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  const res = await makeOpenAiResponsesTurn(CFG)(state, {
    system: "SYS", tools: TOOLS, maxTokens: 99,
    deps: { fetchImpl: fakeFetch(200, {
      id: "resp_1",
      output: [
        { type: "web_search_call", action: { query: "norsk rente" } },
        { type: "function_call", call_id: "c1", name: "probe", arguments: `{"url":"u"}` },
      ],
      usage: { input_tokens: 7, output_tokens: 2 },
    }, captured) },
  });
  assertEquals(captured.url, "https://api.openai.example/v1/responses");
  assertEquals(captured.body?.instructions, "SYS");
  assertEquals(captured.body?.input, "Q?");
  assertEquals(captured.body?.store, true);
  assertEquals(captured.body?.max_output_tokens, 99);
  const tools = captured.body?.tools as Record<string, unknown>[];
  assertEquals(tools[0].type, "function");
  assertEquals(tools[0].name, "probe");
  assertEquals(tools[tools.length - 1], { type: "web_search" });
  assertEquals(res.responseId, "resp_1");
  assertEquals(res.toolUses, [{ id: "c1", name: "probe", input: { url: "u" } }]);
  assertEquals(res.searchNotes, ["🔎 Websøk: norsk rente"]);
  assertEquals(res.stop, "tool_use");
});

Deno.test("senere tur: previous_response_id + kun function_call_output", async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const state: AgenticResumeState = {
    messages: [
      { role: "user", content: "Q?" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "probe", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok=true" }] },
    ],
    turn: 1, clientCalls: 1, prevResponseId: "resp_1",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  const res = await makeOpenAiResponsesTurn(CFG)(state, {
    system: "SYS", tools: TOOLS, maxTokens: 99,
    deps: { fetchImpl: fakeFetch(200, {
      id: "resp_2",
      output: [{ type: "message", content: [{ type: "output_text", text: "Svar." }] }],
      usage: { input_tokens: 5, output_tokens: 4 },
    }, captured) },
  });
  assertEquals(captured.body?.previous_response_id, "resp_1");
  assertEquals(captured.body?.instructions, undefined);
  assertEquals(captured.body?.input, [{ type: "function_call_output", call_id: "c1", output: "ok=true" }]);
  assertEquals(res.text, "Svar.");
  assertEquals(res.stop, "end");
  assertEquals(res.responseId, "resp_2");
});

Deno.test("store-avvisning → spec-melding; nøkkel aldri i feilmelding", async () => {
  const state: AgenticResumeState = {
    messages: [{ role: "user", content: "Q?" }], turn: 0, clientCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  };
  const err = await assertRejects(() => makeOpenAiResponsesTurn(CFG)(state, {
    system: "S", tools: TOOLS, maxTokens: 10,
    deps: { fetchImpl: fakeFetch(400, { error: { message: "store is not supported, sk-proj-abc123XYZ" } }), retries: 0 },
  }), Error);
  if (!err.message.includes("lagret samtaletilstand")) throw new Error("feil melding: " + err.message);
  if (err.message.includes("sk-proj")) throw new Error("nøkkel i feilmelding");
});

Deno.test("messageOpenAiResponses: enkel tur uten tools", async () => {
  const captured: { body?: Record<string, unknown> } = {};
  const res = await messageOpenAiResponses(CFG, { system: "SYS", prompt: "P", maxTokens: 44 },
    { fetchImpl: fakeFetch(200, {
      id: "resp_9",
      output: [{ type: "message", content: [{ type: "output_text", text: "Tolket." }] }],
      usage: { input_tokens: 3, output_tokens: 1 },
    }, captured) });
  assertEquals(res.text, "Tolket.");
  assertEquals(captured.body?.tools, undefined);
  assertEquals(captured.body?.store, false);
});
```

- [ ] **Step 2: RED** — module not found.

- [ ] **Step 3: Implement `openai-responses.ts`**

```ts
// OpenAI Responses API adapter (spec A6): native hosted web_search + server-
// side conversation state. Non-streaming per hop by design — the hop model and
// the edge-generated SSE progress are reused unchanged; provider-side
// streaming is a later optimization, not a capability gap. State contract:
// prevResponseId carries the stored-conversation id through the client resume
// round-trip; each follow-up sends ONLY the pending function_call_output items.
import { type AgenticResumeState, fetchWithRetry, type RetryDeps } from "../anthropic.ts";
import { type ProviderConfig, scrubKey } from "./config.ts";
import type { ProviderTurnResult, RunTurn, TurnOpts } from "./agentic.ts";

function toResponsesTools(anthropicTools: unknown[]): unknown[] {
  const fns = (anthropicTools as Record<string, unknown>[]).map((t) => ({
    type: "function",
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema ?? { type: "object", properties: {} },
  }));
  return [...fns, { type: "web_search" }];
}

function safeParseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v as Record<string, unknown> : {};
  } catch (_) {
    return {};
  }
}

async function throwUpstream(resp: Response, cfg: ProviderConfig): Promise<never> {
  const detail = await resp.text().catch(() => "");
  console.error(`LLM provider error ${resp.status}: ${scrubKey(detail, cfg.key)}`);
  if (resp.status === 400 && /store|previous_response/i.test(detail)) {
    throw new Error("leverandøren støtter ikke lagret samtaletilstand (store) — bruk typen openai-kompatibel i stedet");
  }
  if (resp.status === 400 && /tool/i.test(detail)) {
    throw new Error("data-svar krever en modell med verktøystøtte (tool-calling) — leverandøren avviste tools-parameteren");
  }
  throw new Error(`Leverandørfeil ${resp.status}`);
}

function parseOutput(json: Record<string, unknown>): ProviderTurnResult {
  const outItems = (Array.isArray(json?.output) ? json.output : []) as Record<string, unknown>[];
  const searchNotes = outItems
    .filter((o) => o.type === "web_search_call")
    .map((o) => {
      const action = (o.action ?? {}) as Record<string, unknown>;
      return `🔎 Websøk: ${String(action.query ?? "").slice(0, 120)}`;
    });
  const toolUses = outItems
    .filter((o) => o.type === "function_call")
    .map((o) => ({
      id: String(o.call_id ?? ""),
      name: String(o.name ?? ""),
      input: safeParseJson(o.arguments),
    }));
  const text = outItems
    .filter((o) => o.type === "message")
    .flatMap((o) => (Array.isArray(o.content) ? o.content : []) as Record<string, unknown>[])
    .filter((c) => c.type === "output_text")
    .map((c) => String(c.text ?? ""))
    .join("");
  const usage = (json?.usage ?? {}) as Record<string, number>;
  return {
    text,
    toolUses,
    searchNotes,
    stop: toolUses.length ? "tool_use" : "end",
    usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 },
    responseId: String(json?.id ?? ""),
  };
}

export function makeOpenAiResponsesTurn(cfg: ProviderConfig): RunTurn {
  return async (state: AgenticResumeState, opts: TurnOpts): Promise<ProviderTurnResult> => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_output_tokens: opts.maxTokens,
      stream: false,
      store: true,
      tools: toResponsesTools(opts.tools),
    };
    if (state.prevResponseId) {
      body.previous_response_id = state.prevResponseId;
      const last = state.messages[state.messages.length - 1] as Record<string, unknown>;
      const blocks = (Array.isArray(last?.content) ? last.content : []) as Record<string, unknown>[];
      body.input = blocks
        .filter((b) => b.type === "tool_result")
        .map((b) => ({ type: "function_call_output", call_id: b.tool_use_id, output: String(b.content ?? "") }));
    } else {
      body.instructions = opts.system;
      const first = state.messages[0] as Record<string, unknown>;
      body.input = typeof first?.content === "string" ? first.content : "";
    }
    const resp = await fetchWithRetry(`${cfg.baseUrl}/responses`, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
    }, opts.deps);
    if (!resp.ok) await throwUpstream(resp, cfg);
    return parseOutput(await resp.json());
  };
}

/** Single text turn without tools — tolk-resultat (spec A5). store:false: no
 *  follow-up will reference this response, so nothing needs persisting. */
export async function messageOpenAiResponses(
  cfg: ProviderConfig,
  o: { system: string; prompt: string; maxTokens: number },
  deps?: RetryDeps,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  const resp = await fetchWithRetry(`${cfg.baseUrl}/responses`, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      max_output_tokens: o.maxTokens,
      stream: false,
      store: false,
      instructions: o.system,
      input: o.prompt,
    }),
  }, deps);
  if (!resp.ok) await throwUpstream(resp, cfg);
  const parsed = parseOutput(await resp.json());
  return { text: parsed.text, usage: parsed.usage };
}
```

- [ ] **Step 4: GREEN + full check**

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/providers/openai-responses.ts netlify/edge-functions/_lib/providers/openai-responses.test.ts
git commit -m "feat(providers): openai-responses-adapter — hosted web_search, previous_response_id-tilstand, function_call_output-oppfølging, spec-faste feilmeldinger"
```

---

### Task 6: `apiBase` override for the Anthropic paths (tier 1)

**Files:**
- Modify: `netlify/edge-functions/_lib/anthropic.ts` (`AnthropicStreamOptions` line 4-16, `streamAnthropic` line 113, `messageAnthropic` line 175, `AgenticOptions` line 300-321, `runAgenticStream` line 397)
- Test: `netlify/edge-functions/_lib/anthropic.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `AnthropicStreamOptions` and `AgenticOptions` gain `apiBase?: string` — when set, requests go to `${apiBase}/messages` with `redirect: "error"`; when unset, `ANTHROPIC_API` and today's exact behavior (no redirect option added — byte-for-byte default path). Tasks 8-9 pass `cfg.baseUrl` here for type `anthropic-compat`.

- [ ] **Step 1: Write the failing test**

Append to `netlify/edge-functions/_lib/anthropic.test.ts` (reuse its existing fake-fetch style — read the top of the file first):

```ts
Deno.test("messageAnthropic: apiBase overstyrer mål-URL og setter redirect:error", async () => {
  let seenUrl = "", seenRedirect: string | undefined;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input);
    seenRedirect = init?.redirect;
    return Promise.resolve(new Response(JSON.stringify({
      content: [{ type: "text", text: "hei" }], usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 }));
  }) as typeof fetch;
  const res = await messageAnthropic(
    { apiKey: "sk-ant-x", model: "m", prompt: "p", apiBase: "https://gw.example/v1" },
    { fetchImpl },
  );
  assertEquals(seenUrl, "https://gw.example/v1/messages");
  assertEquals(seenRedirect, "error");
  assertEquals(res.text, "hei");
});

Deno.test("messageAnthropic: uten apiBase går kallet til api.anthropic.com uten redirect-opsjon", async () => {
  let seenUrl = "", seenRedirect: string | undefined = "unset" as string | undefined;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(input);
    seenRedirect = init?.redirect;
    return Promise.resolve(new Response(JSON.stringify({ content: [], usage: {} }), { status: 200 }));
  }) as typeof fetch;
  await messageAnthropic({ apiKey: "sk-ant-x", model: "m", prompt: "p" }, { fetchImpl });
  assertEquals(seenUrl, "https://api.anthropic.com/v1/messages");
  assertEquals(seenRedirect, undefined);
});
```

- [ ] **Step 2: RED** — `apiBase` not a known option / URL mismatch.

- [ ] **Step 3: Implement**

In `anthropic.ts`:

1. Add to `AnthropicStreamOptions` (after `cacheTtl`):
```ts
  // Tier 1 (spec A1/A3): anthropic-compat base-URL override. Convention:
  // everything before the endpoint name — we call `${apiBase}/messages`.
  // Custom bases get redirect:"error" (a redirecting LLM API is abnormal and
  // could leak the auth header); the default path is left byte-for-byte as-is.
  apiBase?: string;
```
2. Add a helper below the constants (line 2):
```ts
function apiTarget(apiBase?: string): { url: string; init: Pick<RequestInit, "redirect"> } {
  return apiBase
    ? { url: `${apiBase}/messages`, init: { redirect: "error" } }
    : { url: ANTHROPIC_API, init: {} };
}
```
3. In `streamAnthropic` replace the `fetchWithRetry(ANTHROPIC_API, {` call (line 113) with:
```ts
  const target = apiTarget(opts.apiBase);
  const upstream = await fetchWithRetry(target.url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
    ...target.init,
  });
```
4. Same substitution in `messageAnthropic` (line 175) — `const target = apiTarget(opts.apiBase);` and spread `...target.init` into the init object, with `target.url` as the URL.
5. Add `apiBase?: string;` to `AgenticOptions` (after `cacheTtl` line 309) and in `runAgenticStream` replace `fetchWithRetry(ANTHROPIC_API, {` (line 397) the same way (compute `const target = apiTarget(opts.apiBase);` once before the loop, next to `deps` at line 354).

- [ ] **Step 4: GREEN + full check**

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/anthropic.ts netlify/edge-functions/_lib/anthropic.test.ts
git commit -m "feat(anthropic): apiBase-override for nivå 1 (anthropic-kompatible gatewayer) m/ redirect:error — standardstien uendret"
```

---

### Task 7: Prompt — `CLIENT_TOOL_DEFS` split + `MEMORY_URLS` block

**Files:**
- Modify: `netlify/edge-functions/_lib/data-svar-prompt.ts` (`TOOL_DEFS` line 154-190, `buildDataSvarSystem` line ~150-152/162)
- Test: `netlify/edge-functions/_lib/data-svar-prompt.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 8):
  - `export const CLIENT_TOOL_DEFS: unknown[]` — exactly the three client tools (search_catalog, table_metadata, probe); `TOOL_DEFS` becomes `[...CLIENT_TOOL_DEFS, <web_search>, <web_fetch>]` (same objects, same order — byte-stable for the default path).
  - `buildDataSvarSystem(mode: DataMode, registryBlock: string, opts?: { memoryUrls?: boolean })` — when `opts.memoryUrls` is true, a `MEMORY_URLS` block is inserted between `SEARCH_HINTS` and the registry block. Default call (2 args) produces exactly today's output.

- [ ] **Step 1: Write the failing tests**

Append to `data-svar-prompt.test.ts`:

```ts
Deno.test("CLIENT_TOOL_DEFS er de tre klientverktøyene; TOOL_DEFS utvider dem", () => {
  const names = (CLIENT_TOOL_DEFS as { name: string }[]).map((t) => t.name);
  assertEquals(names, ["search_catalog", "table_metadata", "probe"]);
  assertEquals(TOOL_DEFS.slice(0, 3), CLIENT_TOOL_DEFS);
  assertEquals((TOOL_DEFS as { name: string }[]).map((t) => t.name).slice(3), ["web_search", "web_fetch"]);
});

Deno.test("buildDataSvarSystem: memoryUrls-blokk kun når bedt om, mellom Søketips og register", () => {
  const reg = "## Kilderegister (kuratert)\n\n- **ssb** …";
  const uten = buildDataSvarSystem("python", reg);
  if (uten.includes("modellkunnskaps-URL")) throw new Error("MEMORY_URLS lekket inn i default");
  const med = buildDataSvarSystem("python", reg, { memoryUrls: true });
  if (!med.includes("modellkunnskaps-URL")) throw new Error("MEMORY_URLS mangler");
  const iHints = med.indexOf("## Søketips");
  const iMem = med.indexOf("## Uten websøk");
  const iReg = med.indexOf("## Kilderegister");
  if (!(iHints < iMem && iMem < iReg)) throw new Error("feil blokkrekkefølge");
});
```

Add `CLIENT_TOOL_DEFS` to the test file's import from `./data-svar-prompt.ts`.

- [ ] **Step 2: RED**

- [ ] **Step 3: Implement**

In `data-svar-prompt.ts`:

1. Split the tool list (replace the current `export const TOOL_DEFS` structure — keep the three client tool objects VERBATIM as they are today, lines 155-187):
```ts
export const CLIENT_TOOL_DEFS: unknown[] = [
  /* the existing search_catalog object, unchanged */,
  /* the existing table_metadata object, unchanged */,
  /* the existing probe object, unchanged */,
];

export const TOOL_DEFS: unknown[] = [
  ...CLIENT_TOOL_DEFS,
  { type: "web_search_20250305", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 },
];
```
2. Add after `SEARCH_HINTS`:
```ts
const MEMORY_URLS = `\
## Uten websøk: modellkunnskaps-URL-er

Denne kjøringen har IKKE web_search/web_fetch. Registerverktøyene
(search_catalog → table_metadata → probe) er primærveien. For behov utenfor
registeret KAN du foreslå konkrete data-URL-er fra egen kunnskap (f.eks. hos
kildene i Søketips-blokken over) — men HVER slik URL MÅ verifiseres med probe
før den brukes i scriptet. Feiler proben: prøv en annen kandidat, eller si
ærlig at kilden ikke ble funnet. ALDRI lever en uprobet URL, og ALDRI merk noe
«probe-verifisert» uten at probe faktisk returnerte ok=true for akkurat den
URL-en.`;
```
3. Change `buildDataSvarSystem`:
```ts
export function buildDataSvarSystem(
  mode: DataMode,
  registryBlock: string,
  opts?: { memoryUrls?: boolean },
): string {
  const blocks = [INTRO, DELIVERY, SCIENCE, INLINE, MULTI, MODE[mode], SEARCH_HINTS];
  if (opts?.memoryUrls) blocks.push(MEMORY_URLS);
  blocks.push(registryBlock);
  return blocks.join("\n\n");
}
```

- [ ] **Step 4: GREEN + full check**

- [ ] **Step 5: Mirror + commit**

Add the `## Uten websøk: modellkunnskaps-URL-er` section text to `netlify/edge-functions/prompts/data-svar.md` (near the Søketips section) with a changelog comment in the file's format:

```html
<!-- 2026-07-23 (2): + MEMORY_URLS-blokk (kun nivå 2-leverandører uten websøk,
  spec 2026-07-23-llm-provider-tiers A4) mellom Søketips og registerblokken;
  TOOL_DEFS delt i CLIENT_TOOL_DEFS + hostede verktøy. -->
```

```bash
git add netlify/edge-functions/_lib/data-svar-prompt.ts netlify/edge-functions/_lib/data-svar-prompt.test.ts netlify/edge-functions/prompts/data-svar.md
git commit -m "feat(prompt): CLIENT_TOOL_DEFS-splitt + MEMORY_URLS-blokk for leverandører uten websøk (probe-tvang for modellkunnskaps-URL-er)"
```

---

### Task 8: `data-svar.ts` provider dispatch

**Files:**
- Modify: `netlify/edge-functions/data-svar.ts` (imports line 1-12, `RequestBody` line 16-22, `validResumeState` line 31-36, key/model selection line 69-75, system/tools/stream assembly line 84-133)

**Interfaces:**
- Consumes: Tasks 1-7 (`parseProviderConfig`, `makeOpenAiCompatTurn`, `makeOpenAiResponsesTurn`, `runProviderAgenticStream`, `CLIENT_TOOL_DEFS`, `buildDataSvarSystem` opts, `apiBase`).
- Produces: request contract for Task 10's client — body field `provider: {type, base_url, model}` + `X-Llm-Key` header; everything else (SSE events, resume protocol) unchanged.

- [ ] **Step 1: Implement (no separate test file — the handler stays thin; all logic is in tested `_lib` modules; `deno check` + reviewer gate this task)**

1. Imports: add
```ts
import { parseProviderConfig } from "./_lib/providers/config.ts";
import { runProviderAgenticStream } from "./_lib/providers/agentic.ts";
import { makeOpenAiCompatTurn } from "./_lib/providers/openai-compat.ts";
import { makeOpenAiResponsesTurn } from "./_lib/providers/openai-responses.ts";
```
and add `CLIENT_TOOL_DEFS` to the existing `data-svar-prompt.ts` import.

2. `RequestBody` gains `provider?: unknown;` (after `available_keys`).

3. `validResumeState` (line 31-36): add one condition to the returned conjunction:
```ts
    (s.prevResponseId === undefined ||
      (typeof s.prevResponseId === "string" && s.prevResponseId.length <= 200)) &&
```

4. After the `resumeState` block (line 67), parse the provider:
```ts
  const provider = parseProviderConfig(body.provider, request);
  if (provider && "error" in provider) return provider.error;
```

5. Key/model selection (line 69-75) becomes:
```ts
  const byokKey = extractByokKey(request);
  const apiKey = provider ? provider.key : (byokKey ?? Deno.env.get("ANTHROPIC_API_KEY"));
  const model = provider
    ? provider.model
    : (Deno.env.get("DATA_SVAR_MODEL") ?? Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6");
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    return new Response("Server configuration error", { status: 500 });
  }
```

6. System build (line 85) becomes:
```ts
  const memoryUrls = provider ? provider.webSearch === "none" : false;
  const system = buildDataSvarSystem(mode, renderRegistryBlock(registry, availableKeys), { memoryUrls });
```

7. Stream assembly (replace the single `runAgenticStream` call, line 119-129):
```ts
  const commonOpts = {
    system, userContent,
    executeTool, progressLabel,
    maxTokens: 8192,
    maxClientToolCalls: 12,
    resume: resumeState,
    continueExtra: () => ({ probed }),
  };
  let inner: ReadableStream<Uint8Array>;
  if (provider && provider.type === "openai-compat") {
    inner = runProviderAgenticStream({ ...commonOpts, runTurn: makeOpenAiCompatTurn(provider), tools: CLIENT_TOOL_DEFS });
  } else if (provider && provider.type === "openai-responses") {
    inner = runProviderAgenticStream({ ...commonOpts, runTurn: makeOpenAiResponsesTurn(provider), tools: CLIENT_TOOL_DEFS });
  } else {
    inner = runAgenticStream({
      ...commonOpts,
      apiKey, model,
      tools: TOOL_DEFS,
      cacheTtl: "1h",
      apiBase: provider?.type === "anthropic-compat" ? provider.baseUrl : undefined,
    });
  }
```

- [ ] **Step 2: Full check**

Run: `cd netlify/edge-functions && deno check *.ts _lib/*.ts _lib/providers/*.ts && deno test --allow-all _lib/`
Expected: all green (no behavior change without a provider field).

- [ ] **Step 3: Commit**

```bash
git add netlify/edge-functions/data-svar.ts
git commit -m "feat(data-svar): leverandør-dispatch — anthropic-compat via apiBase, openai-typene via provider-løkka m/ klientverktøy og memoryUrls-prompt"
```

---

### Task 9: `tolk-resultat.ts` provider dispatch + `singleTextStream`

**Files:**
- Modify: `netlify/edge-functions/_lib/sse-util.ts` (add one function)
- Modify: `netlify/edge-functions/tolk-resultat.ts` (imports line 1-3, `RequestBody` line 5-10, key/model line 90-96, stream call line 117-134)
- Test: `netlify/edge-functions/_lib/sse-util.test.ts`

**Interfaces:**
- Consumes: `parseProviderConfig`, `messageOpenAiCompat`, `messageOpenAiResponses`, `apiBase` (Tasks 2, 4, 5, 6).
- Produces: `singleTextStream(text: string, usage: Record<string, number>): ReadableStream<Uint8Array>` in `sse-util.ts` — emits one `text` event and one `done` event in the existing SSE shape.

- [ ] **Step 1: Write the failing test**

Append to `sse-util.test.ts` (match its import line):

```ts
Deno.test("singleTextStream: ett text-event + done med usage", async () => {
  const events = (await new Response(singleTextStream("Hei.", { inputTokens: 3, outputTokens: 1 })).text())
    .split("\n\n").filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, "")));
  assertEquals(events, [
    { type: "text", text: "Hei." },
    { type: "done", inputTokens: 3, outputTokens: 1 },
  ]);
});
```

- [ ] **Step 2: RED** → implement in `sse-util.ts`:

```ts
/** Wrap a completed (non-streamed) answer as the standard SSE event pair, so
 *  provider paths that buffer the whole reply reuse the client's stream path. */
export function singleTextStream(
  text: string,
  usage: Record<string, number>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "text", text })}\n\n`));
      c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "done", ...usage })}\n\n`));
      c.close();
    },
  });
}
```

- [ ] **Step 3: GREEN, then wire `tolk-resultat.ts`**

1. Imports: add
```ts
import { parseProviderConfig } from "./_lib/providers/config.ts";
import { messageOpenAiCompat } from "./_lib/providers/openai-compat.ts";
import { messageOpenAiResponses } from "./_lib/providers/openai-responses.ts";
import { singleTextStream } from "./_lib/sse-util.ts";
```
2. `RequestBody` gains `provider?: unknown;`.
3. After the body-validation block (line 88), add:
```ts
  const provider = parseProviderConfig(body.provider, request);
  if (provider && "error" in provider) return provider.error;
```
4. Key check (line 90-96): only require an Anthropic key when no provider:
```ts
  const byokKey = extractByokKey(request);
  const apiKey = byokKey ?? Deno.env.get("ANTHROPIC_API_KEY");
  const model = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6";
  if (!provider && !apiKey) {
    console.error("ANTHROPIC_API_KEY is not set");
    return new Response("Server configuration error", { status: 500 });
  }
```
5. Replace the `try { const stream = await streamAnthropic({...}) ... }` block (line 117-134) with:
```ts
  try {
    let stream: ReadableStream<Uint8Array>;
    if (provider && provider.type === "openai-compat") {
      const r = await messageOpenAiCompat(provider, { system: TOLK_SYSTEM, prompt, maxTokens: 1800 });
      stream = singleTextStream(r.text, r.usage);
    } else if (provider && provider.type === "openai-responses") {
      const r = await messageOpenAiResponses(provider, { system: TOLK_SYSTEM, prompt, maxTokens: 1800 });
      stream = singleTextStream(r.text, r.usage);
    } else {
      stream = await streamAnthropic({
        apiKey: provider ? provider.key : apiKey!,
        model: provider ? provider.model : model,
        prompt,
        maxTokens: 1800,
        system: TOLK_SYSTEM,
        cacheTtl: "1h",
        apiBase: provider?.type === "anthropic-compat" ? provider.baseUrl : undefined,
      });
    }
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  } catch (e) {
    return upstreamErrorResponse(e, byokKey);
  }
```

- [ ] **Step 4: Full check** → all green.

- [ ] **Step 5: Commit**

```bash
git add netlify/edge-functions/_lib/sse-util.ts netlify/edge-functions/_lib/sse-util.test.ts netlify/edge-functions/tolk-resultat.ts
git commit -m "feat(tolk): leverandør-dispatch — openai-typene ikke-streamende via singleTextStream, anthropic-compat via apiBase"
```

---

### Task 10: Client — provider settings UI

**Files:**
- Modify: `index.html` (settings dialog — insert after the `#aiCfgSourceKeys` div, before `.ai-modal-actions`)
- Modify: `js/ai-chat.js` (`cacheDom`, near `renderSourceKeys`, `openSettings`, `saveSettings`)
- Modify: `js/i18n/en.js`

**Interfaces:**
- Consumes: `window.Keys` (`llm` type is just another key).
- Produces (Task 11): `providerConfig(): {type, base_url, model} | null` in `js/ai-chat.js` (module-internal; null when type is `anthropic` or config incomplete); localStorage key `md_llm_provider` (JSON `{type, base_url, model}`); LLM key stored as `Keys.set('llm', …)`.
- No unit tests (DOM module) — `node --check` + browser smoke test in Task 13.

- [ ] **Step 1: index.html markup**

Insert after the `<div id="aiCfgSourceKeys" …></div>` line:

```html
      <div style="margin-bottom:18px;">
        <label for="aiCfgProviderType" data-i18n>AI-leverandør</label>
        <select id="aiCfgProviderType">
          <option value="anthropic" data-i18n>Anthropic (standard)</option>
          <option value="anthropic-compat" data-i18n>Anthropic-kompatibel URL</option>
          <option value="openai-compat" data-i18n>OpenAI-kompatibel URL</option>
          <option value="openai-responses" data-i18n>OpenAI Responses (med websøk)</option>
        </select>
        <div id="aiCfgProviderFields" style="display:none; margin-top:6px;">
          <input type="text" id="aiCfgProviderUrl" placeholder="https://api.openai.com/v1" autocomplete="off">
          <input type="text" id="aiCfgProviderModel" placeholder="gpt-5.6" autocomplete="off" style="margin-top:4px;">
          <input type="password" id="aiCfgLlmKey" autocomplete="off" style="margin-top:4px;">
          <div class="ai-modal-help" data-i18n>Base-URL er alt før endepunktnavnet (typisk t.o.m. /v1). Nøkkelen lagres kun i denne nettleseren; forespørsler går via appens server til leverandøren du velger, og forbruk (inkludert eventuelt websøk hos OpenAI) belastes din konto der. Web-modus med OpenAI-typene krever en modell med verktøystøtte. Microdata-AI krever fortsatt Anthropic-nøkkel.</div>
        </div>
      </div>
```

- [ ] **Step 2: js/ai-chat.js wiring**

1. `cacheDom`: add
```js
        aiCfgProviderType: document.getElementById('aiCfgProviderType'),
        aiCfgProviderFields: document.getElementById('aiCfgProviderFields'),
        aiCfgProviderUrl: document.getElementById('aiCfgProviderUrl'),
        aiCfgProviderModel: document.getElementById('aiCfgProviderModel'),
        aiCfgLlmKey: document.getElementById('aiCfgLlmKey'),
```
2. Above `openSettings`, add:
```js
      // Global AI-leverandør (spec 2026-07-23-llm-provider-tiers A1): type +
      // base-URL + modell i md_llm_provider (ikke hemmelig); nøkkelen i det
      // felles nøkkellageret (js/keys.js, type 'llm').
      var LS_PROVIDER = 'md_llm_provider';
      function providerConfig() {
        var p = null;
        try { p = JSON.parse(localStorage.getItem(LS_PROVIDER) || 'null'); } catch (e) { /* korrupt → ignorer */ }
        if (!p || !p.type || p.type === 'anthropic') return null;
        if (!p.base_url || !p.model) return null;
        return { type: p.type, base_url: p.base_url, model: p.model };
      }
      function syncProviderFields() {
        if (!dom.aiCfgProviderType || !dom.aiCfgProviderFields) return;
        var custom = dom.aiCfgProviderType.value !== 'anthropic';
        dom.aiCfgProviderFields.style.display = custom ? '' : 'none';
        if (dom.aiCfgLlmKey) {
          dom.aiCfgLlmKey.placeholder = (window.Keys && window.Keys.get('llm'))
            ? '••••••••' : T('lim inn nøkkel');
        }
      }
```
3. In `openSettings`, before the backdrop opens:
```js
        var provRaw = null;
        try { provRaw = JSON.parse(localStorage.getItem(LS_PROVIDER) || 'null'); } catch (e) {}
        if (dom.aiCfgProviderType) dom.aiCfgProviderType.value = (provRaw && provRaw.type) || 'anthropic';
        if (dom.aiCfgProviderUrl) dom.aiCfgProviderUrl.value = (provRaw && provRaw.base_url) || '';
        if (dom.aiCfgProviderModel) dom.aiCfgProviderModel.value = (provRaw && provRaw.model) || '';
        if (dom.aiCfgLlmKey) dom.aiCfgLlmKey.value = '';
        syncProviderFields();
```
4. In `init()`, next to the other listeners:
```js
        if (dom.aiCfgProviderType) dom.aiCfgProviderType.addEventListener('change', syncProviderFields);
```
5. In `saveSettings`, before `closeSettings();`:
```js
        if (dom.aiCfgProviderType) {
          var ptype = dom.aiCfgProviderType.value;
          if (ptype === 'anthropic') {
            localStorage.removeItem(LS_PROVIDER);
          } else {
            localStorage.setItem(LS_PROVIDER, JSON.stringify({
              type: ptype,
              base_url: (dom.aiCfgProviderUrl ? dom.aiCfgProviderUrl.value.trim() : ''),
              model: (dom.aiCfgProviderModel ? dom.aiCfgProviderModel.value.trim() : ''),
            }));
          }
          var lk = dom.aiCfgLlmKey ? dom.aiCfgLlmKey.value.trim() : '';
          if (lk && window.Keys) window.Keys.set('llm', lk);
        }
```

- [ ] **Step 3: i18n**

Add to `js/i18n/en.js` (skip existing keys — `"lim inn nøkkel"` exists from the previous round):

```js
  "AI-leverandør": "AI provider",
  "Anthropic (standard)": "Anthropic (default)",
  "Anthropic-kompatibel URL": "Anthropic-compatible URL",
  "OpenAI-kompatibel URL": "OpenAI-compatible URL",
  "OpenAI Responses (med websøk)": "OpenAI Responses (with web search)",
  "Base-URL er alt før endepunktnavnet (typisk t.o.m. /v1). Nøkkelen lagres kun i denne nettleseren; forespørsler går via appens server til leverandøren du velger, og forbruk (inkludert eventuelt websøk hos OpenAI) belastes din konto der. Web-modus med OpenAI-typene krever en modell med verktøystøtte. Microdata-AI krever fortsatt Anthropic-nøkkel.": "The base URL is everything before the endpoint name (typically up to /v1). The key is stored only in this browser; requests go via the app's server to the provider you choose, and usage (including any web search at OpenAI) is billed to your account there. Web mode with the OpenAI types requires a model with tool support. The microdata AI still requires an Anthropic key.",
```

- [ ] **Step 4: Verify + commit**

Run: `node --check js/ai-chat.js && node --check js/i18n/en.js` → silent.

```bash
git add index.html js/ai-chat.js js/i18n/en.js
git commit -m "feat(ui): AI-leverandør-seksjon i innstillingene — type/base-URL/modell i md_llm_provider, nøkkel i md_keys.llm"
```

---

### Task 11: Client — request plumbing (Web mode + tolk)

**Files:**
- Modify: `js/ai-chat.js` (`webModeEligible` ~line 26-27, `runWebAnswer` body/headers ~line 956-984, the `/api/tolk-resultat` call ~line 833, 401-handling)
- Modify: `personvern.html` and `personvern.en.html` (one sentence each)

**Interfaces:**
- Consumes: `providerConfig()` (Task 10), server contract (Tasks 8-9).
- Produces: Web mode usable with a custom provider and no Anthropic key.

- [ ] **Step 1: Plumbing in `js/ai-chat.js`**

1. Add next to `providerConfig` (Task 10 placed it above `openSettings` — that is fine; these helpers live in the same IIFE scope):
```js
      function customProviderReady() {
        return !!(providerConfig() && window.Keys && window.Keys.get('llm'));
      }
      function providerAuthHeaders() {
        if (customProviderReady()) {
          return { 'X-Llm-Key': window.Keys.get('llm'), 'Content-Type': 'application/json' };
        }
        return edgeAuthHeaders();
      }
```
2. `webModeEligible` (grep `webModeEligible` — the `hasByok` computation at ~line 27): change to
```js
        const hasByok = !!state.anthropicKey || customProviderReady();
```
3. `runWebAnswer` gate (line 956): replace with
```js
        if (!state.anthropicKey && !customProviderReady()) {
          throw new Error(T('Web-modus krever egen Anthropic-nøkkel eller en konfigurert AI-leverandør.'));
        }
```
4. `runWebAnswer` fetch (line 970-979): `headers: providerAuthHeaders(),` and add to the body literal (after `available_keys`):
```js
              provider: providerConfig() || undefined,
```
5. `runWebAnswer` 401-handling (line 981-983): replace the message with
```js
          if (resp.status === 401) {
            throw new Error(customProviderReady()
              ? T('AI-leverandøren avviste nøkkelen (401) — sjekk i AI-innstillingene.')
              : T('Ugyldig Anthropic-nøkkel. Sjekk nøkkelen i AI-innstillingene.'));
          }
```
6. The tolk call (grep `'/api/tolk-resultat'`): change its `headers:` to `providerAuthHeaders()` and add `provider: providerConfig() || undefined,` to its body literal.
7. Microdata flows (kode-svar-v2, dm-vurder) are NOT touched — they keep `edgeAuthHeaders()`/`state.anthropicKey` and their existing «krever egen Anthropic-nøkkel»-messages, which remain accurate (spec A5).

- [ ] **Step 2: i18n for the two new strings**

```js
  "Web-modus krever egen Anthropic-nøkkel eller en konfigurert AI-leverandør.": "Web mode requires your own Anthropic key or a configured AI provider.",
  "AI-leverandøren avviste nøkkelen (401) — sjekk i AI-innstillingene.": "The AI provider rejected the key (401) — check it in the AI settings.",
```

- [ ] **Step 3: personvern sentence**

In `personvern.html`, find the sentence describing that AI requests go via the app's server to Anthropic (grep `Anthropic`), and append after it: `Har du valgt en egen AI-leverandør i innstillingene, går forespørslene i stedet til den leverandøren du selv har konfigurert.` In `personvern.en.html`, the equivalent: `If you have chosen a custom AI provider in the settings, requests go to the provider you configured instead.`

- [ ] **Step 4: Verify + commit**

Run: `node --check js/ai-chat.js && node --check js/i18n/en.js` → silent.

```bash
git add js/ai-chat.js js/i18n/en.js personvern.html personvern.en.html
git commit -m "feat(ui): leverandør-plumbing — X-Llm-Key + provider-felt på data-svar/tolk, webModeEligible godtar konfigurert leverandør, personvern-setning"
```

---

### Task 12: Part B — optional source keys (anonymous Kaggle)

**Files:**
- Modify: `netlify/edge-functions/_lib/registry.ts` (SourceAuth, parseRegistry auth block, renderRegistryBlock)
- Modify: `netlify/edge-functions/_lib/hent-core.ts` (user-key branch)
- Modify: `js/data-loader.js` (`sourceKeyHeader`)
- Modify: `data/data-sources.json` (kaggle entry)
- Tests: `registry.test.ts`, `hent-core.test.ts`, `data-loader.test.ts`

**Interfaces:**
- Consumes: the previous round's `auth.user` machinery.
- Produces: `SourceAuth.valgfri?: boolean` (valid only with `user: true`). Behavior: missing key on a `valgfri` source → anonymous upstream fetch (server) and no client-side throw; key present → injected exactly as before.

- [ ] **Step 1: Failing tests**

`registry.test.ts`:
```ts
Deno.test("parseRegistry: auth.valgfri krever user:true", () => {
  const base = { id: "k", navn: "K", utgiver: "K", tillit: "etablert", tilgang: "rest",
    base_url: "https://api.k.example/", cors: false };
  const ok = parseRegistry([{ ...base, auth: { type: "api_key", user: true, valgfri: true, plassering: "basic" } }]);
  assertEquals(ok[0].auth?.valgfri, true);
  assertThrows(() => parseRegistry([{ ...base, auth: { type: "api_key", env: "X", valgfri: true, plassering: "basic" } }]));
  assertThrows(() => parseRegistry([{ ...base, auth: { type: "api_key", user: true, valgfri: "ja", plassering: "basic" } }]));
});

Deno.test("renderRegistryBlock: valgfri-kilde markeres som brukbar uten nøkkel", () => {
  const reg = parseRegistry([{
    id: "kaggle", navn: "Kaggle", utgiver: "Kaggle", tillit: "etablert", tilgang: "rest",
    base_url: "https://www.kaggle.com/api/v1/", cors: false,
    auth: { type: "api_key", user: true, valgfri: true, plassering: "basic" },
  }]);
  const uten = renderRegistryBlock(reg);
  if (!uten.includes("brukernøkkel valgfri")) throw new Error("mangler valgfri-markering:\n" + uten);
  if (uten.includes("IKKE registrert: ikke bygg")) throw new Error("valgfri kilde feilmarkert som ubrukelig");
  const med = renderRegistryBlock(reg, ["kaggle"]);
  if (!med.includes("valgfri (registrert)")) throw new Error("mangler registrert-markering:\n" + med);
});
```

`hent-core.test.ts` — first extend the `REG` fixture's kaggle entry with `valgfri: true`? NO — add a THIRD entry instead so the required-key path stays tested:
```ts
// legg til i parseRegistry-listen øverst:
{
  id: "kagglefri", navn: "KaggleFri", utgiver: "K", tillit: "etablert", tilgang: "rest",
  base_url: "https://open.kagglefri.example/api/", cors: false,
  auth: { type: "api_key", user: true, valgfri: true, plassering: "basic" },
},
```
```ts
Deno.test("handleHent: valgfri kilde uten nøkkel → anonym henting uten auth-header", async () => {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const d = { registry: REG, getEnv: () => undefined, fetchImpl: headerLoggingFetch(log) };
  const url = encodeURIComponent("https://open.kagglefri.example/api/d.csv");
  const r = await handleHent(reqWithKey("url=" + url), d);
  assertEquals(r.status, 200);
  assertEquals(log[0].headers["authorization"], undefined);
});

Deno.test("handleHent: valgfri kilde MED nøkkel → Basic som før", async () => {
  const log: { url: string; headers: Record<string, string> }[] = [];
  const d = { registry: REG, getEnv: () => undefined, fetchImpl: headerLoggingFetch(log) };
  const url = encodeURIComponent("https://open.kagglefri.example/api/e.csv");
  await handleHent(reqWithKey("url=" + url, "bruker:K1"), d);
  assertEquals(log[0].headers["authorization"], "Basic " + btoa("bruker:K1"));
});
```

`data-loader.test.ts` (unique URLs per the file's cache rule):
```ts
const KAGGLE_FRI_REG = [{
  id: "kagglefri", navn: "KaggleFri", utgiver: "K", tillit: "etablert", tilgang: "rest",
  base_url: "https://open.kagglefri.example/api/", cors: false,
  auth: { type: "api_key", user: true, valgfri: true, plassering: "basic" },
}];

Deno.test("data-loader: valgfri kilde uten nøkkel kaster ikke — via proxy uten X-Source-Key", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return Promise.resolve(new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const inner = encodeURIComponent("https://open.kagglefri.example/api/fil-e.csv");
  const out = await DL.resolveAndFetchLoads("# load /api/hent?url=" + inner + " as fri",
    { fetchImpl, registry: KAGGLE_FRI_REG, keysApi: { get: () => "" } });
  assertEquals(out.loads[0].alias, "fri");
  const proxy = calls.find((c) => c.url.includes("/api/hent?url="));
  assertEquals(proxy?.headers["X-Source-Key"], undefined);
});
```

- [ ] **Step 2: RED**, then implement:

1. `registry.ts` `SourceAuth`: add `valgfri?: boolean;  // kun med user:true — nøkkel valgfri (anonym tilgang mulig)`. In `parseRegistry`'s auth block, after the env/user rule:
```ts
      if (a.valgfri !== undefined && (a.valgfri !== true || a.user !== true)) {
        throw new Error(`kilde ${e.id}: auth.valgfri krever user:true (og må være true)`);
      }
```
2. `renderRegistryBlock` — replace the `if (s.auth?.user)` branch with:
```ts
    if (s.auth?.user && s.auth.valgfri) {
      bits.push(userKeys.includes(s.id)
        ? "brukernøkkel valgfri (registrert) → hentes alltid via /api/hent"
        : "brukernøkkel valgfri — offentlige datasett kan hentes uten nøkkel; privat-/konkurransedata krever registrert nøkkel (AI-innstillingene)");
    } else if (s.auth?.user) {
      /* existing registered/IKKE registrert branch unchanged */
    } else if (s.auth) {
```
3. `hent-core.ts` user branch — the `if (!key)` case becomes:
```ts
      if (!key) {
        if (!a.valgfri) {
          return new Response(
            `Kilden ${src.id} krever API-nøkkel — registrer den i AI-innstillingene`,
            { status: 401 },
          );
        }
        // valgfri: anonym henting — ingen injeksjon, resten av flyten som vanlig.
      }
```
and wrap the placement-injection block in `if (key) { … }`.
4. `js/data-loader.js` `sourceKeyHeader`: change the missing-key branch:
```js
    if (!val) {
      if (src.auth && src.auth.valgfri) return {};   // valgfri: anonym henting
      throw new Error('«' + src.id + '» krever API-nøkkel — registrer den i AI-innstillingene.');
    }
```
(Note: with `{}` returned, the bare-URL proxy-forcing check `srcKey['X-Source-Key']` won't force the proxy for keyless optional loads — that is correct: `resolve()` already sets `viaProxy` for all auth sources via connect, and CORS fallback covers bare URLs, same as any `cors:false` source.)
5. `data/data-sources.json` kaggle entry: add `"valgfri": true` inside `auth`, and in quirks replace the clause `anonym nedlasting kan virke for åpne datasett, men nøkkel kreves` with `åpne datasett kan hentes uten nøkkel; privat-/konkurransedata krever registrert nøkkel`.

- [ ] **Step 3: GREEN + full check**

- [ ] **Step 4: Commit**

```bash
git add netlify/edge-functions/_lib/registry.ts netlify/edge-functions/_lib/registry.test.ts netlify/edge-functions/_lib/hent-core.ts netlify/edge-functions/_lib/hent-core.test.ts js/data-loader.js netlify/edge-functions/_lib/data-loader.test.ts data/data-sources.json
git commit -m "feat(kilder): auth.valgfri — anonym tilgang til valgfri-nøkkel-kilder (Kaggle åpne datasett) server- og klient-side; nøkkel injiseres når den finnes"
```

---

### Task 13: Docs, eval rows + browser smoke test

**Files:**
- Modify: `docs/eval/data-svar-evalsett.md` (rows 16-17)
- Browser verification is run by the CONTROLLER (static serve + Playwright), not the implementer.

- [ ] **Step 1: Eval rows**

Append to the question table:

```markdown
| 16 | python | (nivå 2-leverandør, manuell m/ OpenAI-nøkkel) Hvordan har arbeidsledigheten i Sverige utviklet seg siste 10 år? — uten websøk skal svaret bygge på search_catalog/probe; foreslåtte modellkunnskaps-URL-er skal være probet eller ærlig avvist | scb (registerverktøy, MEMORY_URLS-regelen) |
| 17 | python | (uten registrert Kaggle-nøkkel) Finn et Kaggle-datasett om Titanic og vis overlevelsesrate etter kjønn. | kaggle (valgfri nøkkel — anonym henting skal fungere for åpne datasett) |
```

- [ ] **Step 2: Commit**

```bash
git add docs/eval/data-svar-evalsett.md
git commit -m "docs(eval): spørsmål 16–17 — nivå 2 uten websøk (MEMORY_URLS) og anonym Kaggle (valgfri nøkkel)"
```

- [ ] **Step 3 (controller): browser smoke test**

Static serve + Playwright: (1) settings shows «AI-leverandør» select; choosing an OpenAI type reveals URL/model/key fields; saving persists `md_llm_provider` and `md_keys.llm`; (2) with a provider configured and llm key set, the Web button becomes visible without an Anthropic key (`webModeEligible`); (3) a `# load /api/hent?url=<kagglefri-style url>` for the real kaggle entry WITHOUT a key no longer throws client-side (valgfri). Clean up test localStorage afterwards.

---

## Post-plan notes

- Deferred by spec (do NOT implement): Gemini grounding, provider-side streaming for openai-responses, tier 2 for kode-svar/dm-vurder, multi-profile provider config.
- Eval Q16 requires a real OpenAI key — manual, per the eval doc's process; the plan only adds the row.
