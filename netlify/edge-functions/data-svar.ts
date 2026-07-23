// /api/data-svar — Web mode: agentic discovery + generation (admin-only).
// Spec: docs/superpowers/specs/2026-07-03-web-data-svar-design.md
import { adminGate, extractByokKey, extractLlmKey } from "./_lib/auth.ts";
import { type AgenticResumeState, runAgenticStream } from "./_lib/anthropic.ts";
import { loadRegistry, renderRegistryBlock } from "./_lib/registry.ts";
import { searchCatalog } from "./_lib/tools/search-catalog.ts";
import { tableMetadata } from "./_lib/tools/table-metadata.ts";
import { probeUrl } from "./_lib/tools/probe.ts";
import { injectBeforeDone } from "./_lib/sse-util.ts";
import {
  buildDataSvarSystem, CLIENT_TOOL_DEFS, coerceDataMode, progressLabel, questionTurn, repairTurn, TOOL_DEFS,
} from "./_lib/data-svar-prompt.ts";
import { parseProviderConfig } from "./_lib/providers/config.ts";
import { runProviderAgenticStream } from "./_lib/providers/agentic.ts";
import { makeOpenAiCompatTurn } from "./_lib/providers/openai-compat.ts";
import { makeOpenAiResponsesTurn } from "./_lib/providers/openai-responses.ts";

interface RepairBody { script: string; error: string; round: number; }
interface ResumeBody { state?: AgenticResumeState; probed?: unknown; }
interface RequestBody {
  question?: string;
  mode?: string;
  script?: string;
  available_keys?: unknown;
  provider?: unknown;
  repair?: RepairBody;
  resume?: ResumeBody;
}

// Continuation protocol (see runAgenticStream): each invocation runs one API
// turn and, if not finished, ends with {type:"continue", state, probed}; the
// client re-POSTs the same body plus `resume: {state, probed}`. The loop
// state that made 120k too small: tool results and hosted web_search blocks
// ride along in `state.messages`, so resume bodies run to a few hundred kB.
const MAX_BODY_BYTES = 2_000_000;

function validResumeState(s: AgenticResumeState | undefined): s is AgenticResumeState {
  return !!s && Array.isArray(s.messages) && s.messages.length >= 1 && s.messages.length <= 400 &&
    Number.isInteger(s.turn) && s.turn >= 1 && s.turn <= 64 &&
    Number.isInteger(s.clientCalls) && s.clientCalls >= 0 && s.clientCalls <= 200 &&
    (s.prevResponseId === undefined ||
      (typeof s.prevResponseId === "string" && s.prevResponseId.length <= 200)) &&
    typeof s.usage === "object" && s.usage !== null;
}

export default async (request: Request): Promise<Response> => {
  const gateResp = await adminGate(request, {
    endpoint: "data-svar",
    maxBodyBytes: MAX_BODY_BYTES,
    allowByok: true,
    allowLlmKey: true,
  });
  if (gateResp) return gateResp;

  let body: RequestBody;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  const question = (body.question ?? "").trim();
  if (!question) return new Response("Missing question", { status: 400 });
  const repair = body.repair;
  if (repair && (!repair.script || !repair.error || !(repair.round >= 1 && repair.round <= 3))) {
    return new Response("Invalid repair payload", { status: 400 });
  }
  let resumeState: AgenticResumeState | undefined;
  if (body.resume) {
    if (!validResumeState(body.resume.state)) {
      return new Response("Invalid resume payload", { status: 400 });
    }
    const u = body.resume.state.usage as Record<string, unknown>;
    resumeState = {
      messages: body.resume.state.messages,
      turn: body.resume.state.turn,
      clientCalls: body.resume.state.clientCalls,
      prevResponseId: body.resume.state.prevResponseId,
      usage: {
        inputTokens: Number(u.inputTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
        cacheReadTokens: Number(u.cacheReadTokens) || 0,
        cacheCreationTokens: Number(u.cacheCreationTokens) || 0,
      },
    };
  }

  const provider = parseProviderConfig(body.provider, request);
  if (provider && "error" in provider) return provider.error;
  if (!extractByokKey(request) && extractLlmKey(request) && !provider) {
    return new Response("X-Llm-Key krever komplett leverandørkonfigurasjon (provider-feltet i forespørselen)", { status: 401 });
  }

  const byokKey = extractByokKey(request);
  const apiKey = provider ? provider.key : (byokKey ?? Deno.env.get("ANTHROPIC_API_KEY"));
  const model = provider
    ? provider.model
    : (Deno.env.get("DATA_SVAR_MODEL") ?? Deno.env.get("ANTHROPIC_MODEL") ?? "claude-sonnet-4-6");
  if (!apiKey) {
    console.error("data-svar: mangler API-nøkkel (env ANTHROPIC_API_KEY eller leverandørnøkkel)");
    return new Response("Server configuration error", { status: 500 });
  }

  const origin = new URL(request.url).origin;
  let registry;
  try { registry = await loadRegistry(origin); } catch (e) {
    console.error("data-svar: registry load failed:", e);
    return new Response("Kilderegister utilgjengelig", { status: 502 });
  }

  const mode = coerceDataMode(body.mode);
  // Kun kilde-ider (aldri verdier): styrer om user-auth-kilder framstår som
  // brukbare i registerblokken. Endrer prompt-prefikset → egen cache-nøkkel
  // per nøkkeloppsett; bevisst (få varianter, riktighet > cache-treff).
  const availableKeys = Array.isArray(body.available_keys)
    ? (body.available_keys as unknown[])
      .filter((k): k is string => typeof k === "string" && /^[a-z0-9_-]{1,32}$/.test(k))
      .slice(0, 20)
    : [];
  const memoryUrls = provider ? provider.webSearch === "none" : false;
  const system = buildDataSvarSystem(mode, renderRegistryBlock(registry, availableKeys), { memoryUrls });

  // Deterministic source manifest: collected from probe calls, not model text.
  // On resume, re-seeded from the previous invocations' manifest so the final
  // sources event covers the whole run.
  const probed: { url: string; ok: boolean; cors: boolean; viaProxy: boolean }[] = [];
  if (body.resume && Array.isArray(body.resume.probed)) {
    for (const p of (body.resume.probed as Record<string, unknown>[]).slice(0, 60)) {
      if (p && typeof p.url === "string") {
        probed.push({ url: p.url, ok: !!p.ok, cors: !!p.cors, viaProxy: !!p.viaProxy });
      }
    }
  }

  const executeTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
    if (name === "search_catalog") {
      return JSON.stringify(await searchCatalog(String(input.source ?? ""), String(input.query ?? ""), { registry }));
    }
    if (name === "table_metadata") {
      return JSON.stringify(await tableMetadata(String(input.source ?? ""), String(input.table_id ?? ""), { registry }));
    }
    if (name === "probe") {
      const url = String(input.url ?? "");
      const r = await probeUrl(url);
      probed.push({ url, ok: r.ok, cors: r.cors, viaProxy: r.ok && !r.cors });
      return JSON.stringify(r);
    }
    throw new Error(`ukjent verktøy: ${name}`);
  };

  const userContent = repair
    ? repairTurn(question, repair.script, repair.error, repair.round)
    : questionTurn(question, body.script);

  const commonOpts = {
    system, userContent,
    executeTool, progressLabel,
    maxTokens: 8192,
    maxClientToolCalls: 12,
    resume: resumeState,
    continueExtra: () => ({ probed }),
  };
  // Agentic provider turns (non-idempotent, billed) get a longer timeout
  // than the default (matches anthropic's AGENTIC_TIMEOUT_MS) and fewer
  // retries — retrying a slow-but-successful turn would double-bill it.
  const providerDeps = { timeoutMs: 180_000, retries: 1 };
  let inner: ReadableStream<Uint8Array>;
  if (provider && provider.type === "openai-compat") {
    inner = runProviderAgenticStream({ ...commonOpts, deps: providerDeps, runTurn: makeOpenAiCompatTurn(provider), tools: CLIENT_TOOL_DEFS });
  } else if (provider && provider.type === "openai-responses") {
    inner = runProviderAgenticStream({ ...commonOpts, deps: providerDeps, runTurn: makeOpenAiResponsesTurn(provider), tools: CLIENT_TOOL_DEFS });
  } else {
    inner = runAgenticStream({
      ...commonOpts,
      apiKey, model,
      tools: TOOL_DEFS,
      cacheTtl: "1h",
      apiBase: provider?.type === "anthropic-compat" ? provider.baseUrl : undefined,
    });
  }

  const stream = injectBeforeDone(inner, () =>
    probed.length ? { type: "sources", sources: probed } : null);

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
};
