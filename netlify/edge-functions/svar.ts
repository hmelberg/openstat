// /api/svar — samlet ask-pipeline: ETT agentisk løp med run_code som
// klientutført verktøy. Erstatter data-svar + tolk-ask.
// Spec: docs/superpowers/specs/2026-07-29-samlet-ask-pipeline-design.md
import { adminGate, extractByokKey, extractLlmKey, type IpContext } from "./_lib/auth.ts";
import { type AgenticResumeState, runAgenticStream } from "./_lib/anthropic.ts";
import { loadRegistry, renderRegistryBlock } from "./_lib/registry.ts";
import { makeGuideAttacher } from "./_lib/source-guides.ts";
import { searchCatalog } from "./_lib/tools/search-catalog.ts";
import { tableMetadata } from "./_lib/tools/table-metadata.ts";
import { coerceScope, searchDatasets } from "./_lib/tools/search-datasets.ts";
import { probeUrl } from "./_lib/tools/probe.ts";
import { injectBeforeDone } from "./_lib/sse-util.ts";
import {
  buildRouteToolDefs, buildSvarSystem, coerceDataMode,
  coerceDepth, coerceRoute, depthClientToolCalls, depthRunCodeCalls,
  progressLabel, questionTurn,
} from "./_lib/svar-prompt.ts";
import { searchLiterature } from "./_lib/tools/search-literature.ts";
import { parseProviderConfig } from "./_lib/providers/config.ts";
import { runProviderAgenticStream } from "./_lib/providers/agentic.ts";
import { makeOpenAiCompatTurn } from "./_lib/providers/openai-compat.ts";
import { makeOpenAiResponsesTurn } from "./_lib/providers/openai-responses.ts";

interface ResumeBody { state?: AgenticResumeState; probed?: unknown; }
interface RequestBody {
  question?: string;
  route?: string;
  mode?: string;
  depth?: string;
  script?: string;
  available_keys?: unknown;
  provider?: unknown;
  resume?: ResumeBody;
  run_result?: string;
}

// Resume-bodies bærer hele samtaletilstanden (tool-results, websøk-blokker).
const MAX_BODY_BYTES = 2_000_000;

function validResumeState(s: AgenticResumeState | undefined): s is AgenticResumeState {
  if (!s || !Array.isArray(s.messages) || s.messages.length < 1 || s.messages.length > 400) return false;
  if (!Number.isInteger(s.turn) || s.turn < 1 || s.turn > 64) return false;
  if (!Number.isInteger(s.clientCalls) || s.clientCalls < 0 || s.clientCalls > 200) return false;
  if (s.runCalls !== undefined && (!Number.isInteger(s.runCalls) || s.runCalls < 0 || s.runCalls > 50)) return false;
  if (s.prevResponseId !== undefined &&
    (typeof s.prevResponseId !== "string" || s.prevResponseId.length > 200)) return false;
  if (s.pending !== undefined) {
    const p = s.pending as Record<string, unknown>;
    if (!p || typeof p.awaitingId !== "string" || p.awaitingId.length > 200 ||
      !Array.isArray(p.results) || (p.results as unknown[]).length > 20) return false;
  }
  return typeof s.usage === "object" && s.usage !== null;
}

export default async (request: Request, context: IpContext): Promise<Response> => {
  // Ratelimiten teller SPØRSMÅL: continuation-hops er samme spørsmål, derfor
  // hoppes den over når klienten hevder å fortsette en påbegynt kjøring. Denne
  // avgjørelsen tas FØR body er lest, så den kan ikke selv sjekke at det
  // faktisk foreligger et resume-objekt — det håndheves nedenfor, rett etter
  // JSON-parsingen, så en FERSK spørring med kun headeren (+ en velformet
  // nøkkel) ikke slipper forbi ratelimiten. Merk: resume-state er fortsatt
  // usignert (ingen HMAC) — en klient som SENDER et resume-objekt kan
  // fremdeles forfalske det for å hoppe over ratelimiten på et nytt
  // spørsmål; det er en dokumentert gjenværende risiko (roadmap: HMAC over
  // state).
  const svarResumeHeader = request.headers.get("x-svar-resume") === "1";
  const gateResp = await adminGate(request, {
    endpoint: "svar",
    maxBodyBytes: MAX_BODY_BYTES,
    allowByok: true,
    allowLlmKey: true,
    skipRateLimit: svarResumeHeader,
  }, context);
  if (gateResp) return gateResp;

  let body: RequestBody;
  try { body = await request.json(); } catch { return new Response("Invalid JSON", { status: 400 }); }
  if (svarResumeHeader && !body.resume) {
    return new Response("X-Svar-Resume krever resume-state", { status: 400 });
  }
  const question = (body.question ?? "").trim();
  if (!question) return new Response("Missing question", { status: 400 });

  let resumeState: AgenticResumeState | undefined;
  if (body.resume) {
    if (!validResumeState(body.resume.state)) {
      return new Response("Invalid resume payload", { status: 400 });
    }
    const s = body.resume.state;
    const u = s.usage as Record<string, unknown>;
    resumeState = {
      messages: s.messages,
      turn: s.turn,
      clientCalls: s.clientCalls,
      runCalls: s.runCalls,
      pending: s.pending,
      prevResponseId: s.prevResponseId,
      usage: {
        inputTokens: Number(u.inputTokens) || 0,
        outputTokens: Number(u.outputTokens) || 0,
        cacheReadTokens: Number(u.cacheReadTokens) || 0,
        cacheCreationTokens: Number(u.cacheCreationTokens) || 0,
      },
    };
  }
  const runResult = typeof body.run_result === "string"
    ? body.run_result.slice(0, 30_000)
    : undefined;

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
    console.error("svar: mangler API-nøkkel (env ANTHROPIC_API_KEY eller leverandørnøkkel)");
    return new Response("Server configuration error", { status: 500 });
  }

  const route = coerceRoute(body.route);
  const mode = coerceDataMode(body.mode);
  const depth = coerceDepth(body.depth);

  // Registeret trengs bare i data-ruten (beregning/oppslag har verken
  // katalogverktøy eller registerblokk i prompten) — sparer et nettkall.
  const origin = new URL(request.url).origin;
  let registryBlock = "";
  let registry: Awaited<ReturnType<typeof loadRegistry>> | null = null;
  if (route === "data") {
    try { registry = await loadRegistry(origin); } catch (e) {
      console.error("svar: registry load failed:", e);
      return new Response("Kilderegister utilgjengelig", { status: 502 });
    }
    const availableKeys = Array.isArray(body.available_keys)
      ? (body.available_keys as unknown[])
        .filter((k): k is string => typeof k === "string" && /^[a-z0-9_-]{1,32}$/.test(k))
        .slice(0, 20)
      : [];
    registryBlock = renderRegistryBlock(registry, availableKeys);
  }

  const memoryUrls = provider ? provider.webSearch === "none" : false;
  const system = buildSvarSystem(route, mode, registryBlock, { memoryUrls, depth });

  const probed: { url: string; ok: boolean; cors: boolean; viaProxy: boolean }[] = [];
  if (body.resume && Array.isArray(body.resume.probed)) {
    for (const p of (body.resume.probed as Record<string, unknown>[]).slice(0, 60)) {
      if (p && typeof p.url === "string") {
        probed.push({ url: p.url, ok: !!p.ok, cors: !!p.cors, viaProxy: !!p.viaProxy });
      }
    }
  }

  const attachGuide = makeGuideAttacher(origin);

  const executeTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
    if (name === "search_datasets" && registry) {
      return JSON.stringify(await searchDatasets(
        String(input.query ?? ""), coerceScope(input.scope), { registry, origin },
      ));
    }
    if (name === "search_catalog" && registry) {
      const hits = await searchCatalog(String(input.source ?? ""), String(input.query ?? ""), { registry, origin });
      // searchCatalog svarer med en ARRAY (CatalogHit[]) — JSON.stringify på
      // en array dropper stille alle ikke-indekserte egenskaper, så et
      // guide-felt satt direkte på arrayen ville aldri nådd modellen. Pakk
      // derfor inn i et objekt (samme "hits"-konvensjon som
      // SearchDatasetsResult) FØR attach, uansett om kilden har guide.
      const r: Record<string, unknown> = { hits };
      await attachGuide(String(input.source ?? ""), r);
      return JSON.stringify(r);
    }
    if (name === "table_metadata" && registry) {
      const r = await tableMetadata(String(input.source ?? ""), String(input.table_id ?? ""), {
        registry,
        find: typeof input.find === "string" && input.find.trim() ? input.find : undefined,
      }) as Record<string, unknown>;
      await attachGuide(String(input.source ?? ""), r);
      return JSON.stringify(r);
    }
    if (name === "probe") {
      const url = String(input.url ?? "");
      // registry: probe må sende samme Accept som lasteren for sdmx-kilder,
      // ellers observerer den XML der scriptet får CSV (målt 2026-08-01).
      const r = await probeUrl(url, { registry: registry ?? undefined });
      probed.push({ url, ok: r.ok, cors: r.cors, viaProxy: r.ok && !r.cors });
      return JSON.stringify(r);
    }
    if (name === "search_literature") {
      const fromYear = Number.isInteger(input.from_year) ? Number(input.from_year) : undefined;
      return JSON.stringify(await searchLiterature(String(input.query ?? ""), fromYear, {
        mailto: Deno.env.get("OPENALEX_MAILTO") || undefined,
      }));
    }
    throw new Error(`ukjent verktøy: ${name}`);
  };

  const commonOpts = {
    system,
    userContent: questionTurn(question, body.script),
    executeTool,
    progressLabel,
    maxTokens: 8192,
    maxClientToolCalls: depthClientToolCalls(depth),
    clientTools: ["run_code"],
    maxRunCode: depthRunCodeCalls(depth),
    runResult,
    resume: resumeState,
    continueExtra: () => ({ probed }),
  };
  const providerDeps = { timeoutMs: 180_000, retries: 1 };
  let inner: ReadableStream<Uint8Array>;
  if (provider && provider.type === "openai-compat") {
    inner = runProviderAgenticStream({
      ...commonOpts, deps: providerDeps, runTurn: makeOpenAiCompatTurn(provider),
      tools: buildRouteToolDefs(route, depth, { hostedWeb: false }),
    });
  } else if (provider && provider.type === "openai-responses") {
    inner = runProviderAgenticStream({
      ...commonOpts, deps: providerDeps, runTurn: makeOpenAiResponsesTurn(provider),
      tools: buildRouteToolDefs(route, depth, { hostedWeb: false }),
    });
  } else {
    inner = runAgenticStream({
      ...commonOpts,
      apiKey, model,
      tools: buildRouteToolDefs(route, depth),
      turnsPerCall: 8,
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
