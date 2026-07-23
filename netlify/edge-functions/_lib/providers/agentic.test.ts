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
