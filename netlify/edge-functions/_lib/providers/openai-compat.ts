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
