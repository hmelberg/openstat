import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchWithRetry, messageAnthropic, runAgenticStream } from "./anthropic.ts";

const noSleep = (_ms: number) => Promise.resolve();

function resp(status: number, headers: Record<string, string> = {}): Response {
  return new Response("body", { status, headers });
}

Deno.test("fetchWithRetry: retries on 429 then returns success", async () => {
  let calls = 0;
  const fetchImpl = ((_url: string | URL | Request, _init?: RequestInit) => {
    calls++;
    return Promise.resolve(calls < 3 ? resp(429) : resp(200));
  }) as typeof fetch;
  const r = await fetchWithRetry("https://x/", { method: "POST" }, {
    fetchImpl,
    sleep: noSleep,
    retries: 3,
  });
  assertEquals(r.status, 200);
  assertEquals(calls, 3);
});

Deno.test("fetchWithRetry: retries on 529 (overloaded)", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(calls < 2 ? resp(529) : resp(200));
  }) as typeof fetch;
  const r = await fetchWithRetry("https://x/", {}, { fetchImpl, sleep: noSleep, retries: 2 });
  assertEquals(r.status, 200);
  assertEquals(calls, 2);
});

Deno.test("fetchWithRetry: does NOT retry on 400", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(resp(400));
  }) as typeof fetch;
  const r = await fetchWithRetry("https://x/", {}, { fetchImpl, sleep: noSleep, retries: 3 });
  assertEquals(r.status, 400);
  assertEquals(calls, 1);
});

Deno.test("fetchWithRetry: gives up after exhausting retries on 429", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(resp(429));
  }) as typeof fetch;
  const r = await fetchWithRetry("https://x/", {}, { fetchImpl, sleep: noSleep, retries: 2 });
  assertEquals(r.status, 429);
  assertEquals(calls, 3); // initial + 2 retries
});

Deno.test("fetchWithRetry: retries network errors, then propagates", async () => {
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.reject(new Error("boom"));
  }) as typeof fetch;
  await assertRejects(
    () => fetchWithRetry("https://x/", {}, { fetchImpl, sleep: noSleep, retries: 2 }),
    Error,
    "boom",
  );
  assertEquals(calls, 3);
});

Deno.test("fetchWithRetry: honours numeric Retry-After (capped)", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(calls < 2 ? resp(429, { "retry-after": "3" }) : resp(200));
  }) as typeof fetch;
  await fetchWithRetry("https://x/", {}, {
    fetchImpl,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    retries: 2,
  });
  assertEquals(sleeps[0], 3000);
});

Deno.test("messageAnthropic returns text and usage from a non-streamed response", async () => {
  const fakeResponse = new Response(
    JSON.stringify({
      content: [{ type: "text", text: '["BEFOLKNING_KJOENN","INNTEKT_WLONN"]' }],
      usage: { input_tokens: 100, output_tokens: 12 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  const fetchImpl = (() => Promise.resolve(fakeResponse)) as typeof fetch;

  const out = await messageAnthropic(
    { apiKey: "k", model: "m", prompt: "q", system: "s", maxTokens: 64 },
    { fetchImpl },
  );
  assertEquals(out.text, '["BEFOLKNING_KJOENN","INNTEKT_WLONN"]');
  assertEquals(out.usage.outputTokens, 12);
});

Deno.test("messageAnthropic throws on non-OK upstream", async () => {
  const fetchImpl = (() => Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch;
  let threw = false;
  try {
    await messageAnthropic({ apiKey: "k", model: "m", prompt: "q" }, { fetchImpl });
  } catch (_e) {
    threw = true;
  }
  assertEquals(threw, true);
});

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<Record<string, unknown>[]> {
  const text = await new Response(stream).text();
  return text.split("\n\n").filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)));
}

// ── Streaming-turer (samlet ask-pipeline, spec 2026-07-29) ────────────────
function sseUpstream(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) {
        c.enqueue(enc.encode(`event: x\ndata: ${JSON.stringify(e)}\n\n`));
      }
      c.close();
    },
  });
}

function streamedTextTurn(text: string) {
  return [
    { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...text.split(" ").map((w, i) => ({
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: (i ? " " : "") + w },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
}

function streamedToolTurn(toolName: string, id: string, inputJson: string) {
  return [
    { type: "message_start", message: { usage: { input_tokens: 8 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Jeg sjekker kilden." } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: toolName, input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: inputJson.slice(0, 8) } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: inputJson.slice(8) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
}

function sseFetch(turns: unknown[][]): typeof fetch {
  let call = 0;
  return (() =>
    Promise.resolve(new Response(sseUpstream(turns[call++]), { status: 200 }))
  ) as unknown as typeof fetch;
}

Deno.test("runAgenticStream: tool round-trip then final text", async () => {
  const fetchImpl = sseFetch([
    streamedToolTurn("probe", "tu1", JSON.stringify({ url: "https://x/d.csv" })),
    streamedTextTurn("Her er scriptet."),
  ]);
  const calls: string[] = [];
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [{ name: "probe", description: "d", input_schema: { type: "object" } }],
    executeTool: (name, input) => { calls.push(`${name}:${input.url}`); return Promise.resolve('{"ok":true}'); },
    turnsPerCall: 99,
    deps: { fetchImpl },
  }));
  assertEquals(calls, ["probe:https://x/d.csv"]);
  // Turn 1 ends in tool_use — its "Jeg sjekker kilden." text was scratch work,
  // discarded via turn_discard. Turn 2's deltas (after turn_discard) are the
  // real final answer; no separate "text" event exists anymore.
  assertEquals(events.some((e) => e.type === "text"), false);
  assertEquals(events.some((e) => e.type === "turn_discard"), true);
  const discardIdx = events.findIndex((e) => e.type === "turn_discard");
  const finalDeltas = events.slice(discardIdx + 1)
    .filter((e) => e.type === "delta").map((e) => e.text).join("");
  assertEquals(finalDeltas, "Her er scriptet.");
  const done = events.at(-1)!;
  assertEquals(done.type, "done");
  assertEquals(done.inputTokens, 18); // 8 (tool turn) + 10 (final turn)
  assertEquals(done.outputTokens, 12); // 7 (tool turn) + 5 (final turn)
});

Deno.test("runAgenticStream: hosted web_search/web_fetch surface as progress labels", async () => {
  const fetchImpl = sseFetch([
    [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s1", name: "web_search", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: "utdanning lønn norge" }) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
    [
      { type: "message_start", message: { usage: { input_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "s2", name: "web_fetch", input: {} } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ url: "https://ssb.no/x" }) } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "svar" } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
  ]);
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.resolve(""),
    turnsPerCall: 99,
    deps: { fetchImpl },
  }));
  const labels = events.filter((e) => e.type === "progress" && !e.replace).map((e) => e.text);
  assertEquals(labels, ["🔎 Websøk: utdanning lønn norge", "🌐 Leser https://ssb.no/x"]);
  assertEquals(events.at(-1)?.type, "done");
});

Deno.test("runAgenticStream: budget exhausts into forced generation", async () => {
  const toolTurn = streamedToolTurn("probe", "t", JSON.stringify({}));
  const finalTurn = streamedTextTurn("ferdig");
  let toolResults: string[] = [];
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [], maxClientToolCalls: 2, turnsPerCall: 99,
    executeTool: () => { return Promise.resolve("data"); },
    deps: { fetchImpl: (( _u: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const lastUser = body.messages.filter((m: { role: string }) => m.role === "user").pop();
      if (Array.isArray(lastUser?.content)) {
        for (const c of lastUser.content) if (c.type === "tool_result") toolResults.push(String(c.content));
      }
      const turn = body.messages.length >= 7 ? finalTurn : toolTurn; // 3 tool rounds then final
      return Promise.resolve(new Response(sseUpstream(turn), { status: 200 }));
    }) as typeof fetch },
  }));
  // third call is over budget (max 2) -> its result is the budget message
  if (!toolResults[2]?.includes("budsjett")) throw new Error("ventet budsjett-melding: " + toolResults[2]);
  assertEquals(events.at(-1)?.type, "done");
});

Deno.test("runAgenticStream: default one turn per call — continue carries state, resume finishes", async () => {
  const fetchImpl = sseFetch([
    streamedToolTurn("probe", "tu1", JSON.stringify({ url: "https://x/d.csv" })),
    streamedTextTurn("ferdig svar"),
  ]);
  const base = {
    apiKey: "k", model: "m", system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.resolve('{"ok":true}'),
    continueExtra: () => ({ probed: [{ url: "https://x/d.csv", ok: true }] }),
    deps: { fetchImpl },
  };
  // Invocation 1: one tool turn, then hands back state instead of looping on.
  const ev1 = await collectSse(runAgenticStream(base));
  const cont = ev1.at(-1)!;
  assertEquals(cont.type, "continue");
  const st = cont.state as { turn: number; clientCalls: number; messages: unknown[]; usage: Record<string, number> };
  assertEquals(st.turn, 1);
  assertEquals(st.clientCalls, 1);
  assertEquals(st.messages.length, 3); // user q, assistant tool_use, user tool_result
  assertEquals((cont.probed as { url: string }[])[0].url, "https://x/d.csv");
  // Invocation 2: resumes from the state and finishes; usage summed across both.
  const ev2 = await collectSse(runAgenticStream({ ...base, resume: st as never }));
  const deltas = ev2.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assertEquals(deltas, "ferdig svar");
  const done = ev2.at(-1)!;
  assertEquals(done.type, "done");
  assertEquals(done.inputTokens, 18); // 8 (turn 1, tool) + 10 (turn 2, final)
  assertEquals(done.outputTokens, 12); // 7 (turn 1, tool) + 5 (turn 2, final)
});

Deno.test("runAgenticStream: API error surfaces as error event", async () => {
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q", tools: [],
    executeTool: () => Promise.resolve(""),
    deps: { fetchImpl: ((_u: string | URL | Request) =>
      Promise.resolve(new Response("boom", { status: 500 }))) as typeof fetch, retries: 0 },
  }));
  assertEquals(events.at(-1)?.type, "error");
});

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

Deno.test("runAgenticStream(stream): text-turn emitterer delta-events og done", async () => {
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [], executeTool: () => Promise.resolve(""),
    turnsPerCall: 8,
    deps: { fetchImpl: sseFetch([streamedTextTurn("Svaret er 42")]) },
  }));
  const deltas = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assertEquals(deltas, "Svaret er 42");
  assertEquals(events.some((e) => e.type === "text"), false);
  const done = events.find((e) => e.type === "done");
  assertEquals(done?.outputTokens, 5);
  assertEquals(done?.inputTokens, 10);
});

Deno.test("runAgenticStream: run_code emitterer run_code + continue med pending-state", async () => {
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [], turnsPerCall: 8, clientTools: ["run_code"],
    executeTool: () => Promise.reject(new Error("skal ikke kalles")),
    deps: { fetchImpl: sseFetch([
      streamedToolTurn("run_code", "tu_run1", JSON.stringify({ script: "print(1)" })),
    ]) },
  }));
  const rc = events.find((e) => e.type === "run_code");
  assertEquals(rc?.script, "print(1)");
  const cont = events.find((e) => e.type === "continue");
  const st = cont?.state as Record<string, unknown>;
  assertEquals((st.pending as Record<string, unknown>).awaitingId, "tu_run1");
  assertEquals(st.runCalls, 1);
});

Deno.test("runAgenticStream: resume med runResult fletter tool_result og fortsetter", async () => {
  // Første invokasjon: run_code → pending. Andre: resume + runResult → svar.
  const base = {
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [], turnsPerCall: 8, clientTools: ["run_code"],
    executeTool: () => Promise.resolve(""),
  };
  const ev1 = await collectSse(runAgenticStream({
    ...base,
    deps: { fetchImpl: sseFetch([streamedToolTurn("run_code", "tu_r", JSON.stringify({ script: "x" }))]) },
  }));
  const st = (ev1.find((e) => e.type === "continue")?.state ?? {}) as never;
  let capturedBody: Record<string, unknown> | null = null;
  const capturingFetch = ((_u: string, init: RequestInit) => {
    capturedBody = JSON.parse(String(init.body));
    return Promise.resolve(new Response(sseUpstream(streamedTextTurn("Ferdig")), { status: 200 }));
  }) as unknown as typeof fetch;
  const ev2 = await collectSse(runAgenticStream({
    ...base, resume: st, runResult: "OK. OUTPUT:\n42",
    deps: { fetchImpl: capturingFetch },
  }));
  assertEquals(ev2.at(-1)?.type, "done");
  // tool_result for tu_r ligger i meldingsarrayet som ble sendt oppstrøms.
  const msgs = ((capturedBody as Record<string, unknown> | null)?.messages ?? []) as Record<string, unknown>[];
  const lastUser = msgs.at(-1) as { role: string; content: { type: string; tool_use_id: string; content: string }[] };
  assertEquals(lastUser.role, "user");
  assertEquals(lastUser.content[0].tool_use_id, "tu_r");
  assertEquals(lastUser.content[0].content, "OK. OUTPUT:\n42");
});

Deno.test("runAgenticStream: run_code over budsjett får server-side tool_result i stedet for event", async () => {
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [], turnsPerCall: 8, clientTools: ["run_code"], maxRunCode: 2,
    executeTool: () => Promise.resolve(""),
    resume: {
      messages: [{ role: "user", content: "q" }], turn: 1, clientCalls: 0, runCalls: 2,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    } as never,
    deps: { fetchImpl: sseFetch([
      streamedToolTurn("run_code", "tu_over", JSON.stringify({ script: "x" })),
      streamedTextTurn("Svar uten flere kjøringer"),
    ]) },
  }));
  assertEquals(events.some((e) => e.type === "run_code"), false);
  assertEquals(events.at(-1)?.type, "done");
});

Deno.test("runAgenticStream: text fra en pause_turn-segment overlever inn i en tekstløs tool_use-tur (turn_discard emitteres likevel)", async () => {
  // Bug: turnHadText ble deklarert PER for-iterasjon, så tekst strømmet i et
  // segment som endte i pause_turn ble glemt så snart neste segment (tool_use,
  // uten ny tekst) ble håndtert — ingen turn_discard, og skraptekst ble
  // stående igjen i klientens svar-buffer. Fiks: carryHadText overlever
  // pause_turn-kontinuasjoner innad i kjøringen.
  const pauseTurn = [
    { type: "message_start", message: { usage: { input_tokens: 5 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Tenker litt" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 3 } },
    { type: "message_stop" },
  ];
  const toolOnlyTurn = [
    { type: "message_start", message: { usage: { input_tokens: 4 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "probe", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ url: "https://x/" }) } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [], turnsPerCall: 99,
    executeTool: () => Promise.resolve('{"ok":true}'),
    deps: { fetchImpl: sseFetch([pauseTurn, toolOnlyTurn, streamedTextTurn("Ferdig svar")]) },
  }));
  const discardIdx = events.findIndex((e) => e.type === "turn_discard");
  assertEquals(discardIdx >= 0, true); // turn_discard MÅ emitteres selv om segment 2 ikke hadde egen tekst
  const toolProgressIdx = events.findIndex((e) =>
    e.type === "progress" && !e.replace && String(e.text).includes("probe"));
  assertEquals(toolProgressIdx > discardIdx, true); // discard før verktøyprogresjonen
  const finalDeltas = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  assertEquals(finalDeltas, "Tenker littFerdig svar");
  assertEquals(events.at(-1)?.type, "done");
});

Deno.test("runAgenticStream(stream): tool-tur akkumulerer input_json_delta, kjører verktøyet og emitterer turn_discard", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  const events = await collectSse(runAgenticStream({
    apiKey: "k", model: "m", system: "s", userContent: "q",
    tools: [], turnsPerCall: 8,
    executeTool: (name, input) => { calls.push([name, input]); return Promise.resolve("OK"); },
    deps: { fetchImpl: sseFetch([
      streamedToolTurn("probe", "tu_1", JSON.stringify({ url: "https://x.no/a.csv" })),
      streamedTextTurn("Ferdig"),
    ]) },
  }));
  assertEquals(calls, [["probe", { url: "https://x.no/a.csv" }]]);
  assertEquals(events.some((e) => e.type === "turn_discard"), true);
  const deltas = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
  // Deltaene fra tool-turen kom FØR turn_discard; sluttsvarets deltaer etter.
  assertEquals(deltas, "Jeg sjekker kilden.Ferdig");
  assertEquals(events.at(-1)?.type, "done");
});
