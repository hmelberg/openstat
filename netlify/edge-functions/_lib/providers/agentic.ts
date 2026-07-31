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
  // Klientutførte verktøy (run_code): verktøykall med disse navnene utføres
  // IKKE av executeTool — de emitteres som {type:"run_code", script} fulgt av
  // {type:"continue", state} (state.pending husker hva vi venter på), og
  // klienten re-POST-er med resume + run_result (verktøyresultat-strengen).
  clientTools?: string[];
  runResult?: string;
  maxRunCode?: number;
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
      const clientToolNames = new Set(opts.clientTools ?? []);
      const maxRunCode = opts.maxRunCode ?? 2;

      try {
        // Resume etter run_code: flett klientens kjøreresultat inn som
        // tool_result sammen med eventuelle server-verktøyresultater fra samme tur.
        if (state.pending) {
          if (typeof opts.runResult !== "string") {
            throw new Error("resume med ventende run_code mangler run_result");
          }
          const merged = [...state.pending.results,
            { tool_use_id: state.pending.awaitingId, content: opts.runResult }];
          state.messages.push({
            role: "user",
            content: merged.map((r) => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content })),
          });
          delete state.pending;
        }
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
            const results: { tool_use_id: string; content: string }[] = [];
            let clientCall: { id: string; input: Record<string, unknown> } | null = null;
            for (const tu of turn.toolUses) {
              if (clientToolNames.has(tu.name)) {
                state.runCalls = (state.runCalls ?? 0) + 1;
                if (state.runCalls > maxRunCode) {
                  results.push({ tool_use_id: tu.id, content:
                    "Kjøre-budsjettet er brukt opp — skriv sluttsvaret NÅ basert på det du allerede vet. Vær ærlig om hva som ikke ble verifisert." });
                } else if (clientCall) {
                  results.push({ tool_use_id: tu.id, content: "Kall run_code én gang per tur." });
                } else {
                  clientCall = { id: tu.id, input: tu.input };
                }
                continue;
              }
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
              results.push({ tool_use_id: tu.id, content: out });
            }
            if (clientCall) {
              state.pending = { results, awaitingId: clientCall.id };
              emit({ type: "run_code", script: String(clientCall.input.script ?? "") });
              emit({ type: "continue", state, ...(opts.continueExtra?.() ?? {}) });
              controller.close();
              return;
            }
            state.messages.push({
              role: "user",
              content: results.map((r) => ({ type: "tool_result", tool_use_id: r.tool_use_id, content: r.content })),
            });
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
