import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildRouteToolDefs, buildSvarSystem, coerceDepth, coerceRoute,
  depthClientToolCalls, depthRunCodeCalls, progressLabel, questionTurn,
} from "./svar-prompt.ts";

Deno.test("coerceRoute: ukjent → data", () => {
  assertEquals(coerceRoute("beregning"), "beregning");
  assertEquals(coerceRoute("oppslag"), "oppslag");
  assertEquals(coerceRoute("språk"), "data");
  assertEquals(coerceRoute(undefined), "data");
});

Deno.test("coerceDepth: standard er default", () => {
  assertEquals(coerceDepth("deep"), "deep");
  assertEquals(coerceDepth("fast"), "standard");
  assertEquals(coerceDepth(undefined), "standard");
});

Deno.test("buildSvarSystem(beregning): omforming + run_code, INGEN register/EVAL/ost", () => {
  const s = buildSvarSystem("beregning", "python", "REGISTERBLOKK-MARKØR");
  assert(s.includes("Omforming"));
  assert(s.includes("run_code"));
  assert(s.includes("#@param"));
  assert(!s.includes("REGISTERBLOKK-MARKØR"));
  assert(!s.includes("EVAL-REGLER"));
  assert(!s.includes("ost.connect"));
});

Deno.test("buildSvarSystem(data): beholder EVAL-regler, register, delvis-regel og run_code", () => {
  const s = buildSvarSystem("data", "python", "REGISTERBLOKK-MARKØR", { depth: "standard" });
  assert(s.includes("EVAL-REGLER"));
  assert(s.includes("REGISTERBLOKK-MARKØR"));
  assert(s.includes("Delvise resultater"));
  assert(s.includes("run_code"));
  assert(s.includes("Dybde: STANDARD"));
});

Deno.test("buildSvarSystem(oppslag): minimal — websøk-krav, ingen register", () => {
  const s = buildSvarSystem("oppslag", "python", "REGISTERBLOKK-MARKØR");
  assert(s.includes("kilde-URL"));
  assert(!s.includes("REGISTERBLOKK-MARKØR"));
  assert(s.length < 4000);
});

Deno.test("buildSvarSystem: svarformatet sier ingen kodeblokk i sluttsvaret", () => {
  const s = buildSvarSystem("data", "python", "");
  assert(s.includes("ingen kodeblokk"));
  assert(!s.includes("ÉN kjørbar"));
});

Deno.test("buildRouteToolDefs: beregning = kun run_code", () => {
  const defs = buildRouteToolDefs("beregning", "standard") as { name?: string }[];
  assertEquals(defs.length, 1);
  assertEquals(defs[0].name, "run_code");
});

Deno.test("buildRouteToolDefs: data har katalogverktøy + run_code + hostede webverktøy m/ budsjett", () => {
  const defs = buildRouteToolDefs("data", "standard") as { name?: string; max_uses?: number; max_content_tokens?: number }[];
  const names = defs.map((d) => d.name);
  assert(names.includes("search_catalog") && names.includes("probe") && names.includes("run_code"));
  const ws = defs.find((d) => d.name === "web_search");
  const wf = defs.find((d) => d.name === "web_fetch");
  assertEquals(ws?.max_uses, 2);
  assertEquals(wf?.max_uses, 1);
  assertEquals(wf?.max_content_tokens, 15_000);
});

Deno.test("buildRouteToolDefs: hostedWeb:false dropper webverktøyene", () => {
  const defs = buildRouteToolDefs("oppslag", "deep", { hostedWeb: false }) as { name?: string }[];
  assertEquals(defs.map((d) => d.name), ["run_code"]);
});

Deno.test("budsjetter per dybde", () => {
  assertEquals(depthClientToolCalls("standard"), 4);
  assertEquals(depthClientToolCalls("deep"), 12);
  assertEquals(depthRunCodeCalls("standard"), 3);
  assertEquals(depthRunCodeCalls("deep"), 4);
});

Deno.test("questionTurn: med og uten script-kontekst", () => {
  assert(questionTurn("Hva?", "x=1").includes("x=1"));
  assert(!questionTurn("Hva?").includes("Gjeldende script"));
});

Deno.test("progressLabel: run_code har egen etikett", () => {
  assert(progressLabel("run_code", {}).includes("Kjører scriptet"));
});

Deno.test("buildRouteToolDefs: data-ruten har search_datasets; beregning/oppslag har ikke", () => {
  const names = (defs: unknown[]) => (defs as { name?: string }[]).map((d) => d.name);
  assert(names(buildRouteToolDefs("data", "standard")).includes("search_datasets"));
  assert(!names(buildRouteToolDefs("beregning", "standard")).includes("search_datasets"));
  assert(!names(buildRouteToolDefs("oppslag", "standard")).includes("search_datasets"));
});

Deno.test("buildSvarSystem(data): META_SEARCH inne, SEARCH_HINTS ute, KODEBOK inne", () => {
  const s = buildSvarSystem("data", "python", "REG");
  assert(s.includes("search_datasets"));
  assert(s.includes("Kodebok"));
  assert(!s.includes("Søketips utenfor registeret"));
  assert(s.includes("SISTE utvei"));
});

Deno.test("buildSvarSystem(beregning): ingen META_SEARCH/KODEBOK", () => {
  const s = buildSvarSystem("beregning", "python", "");
  assert(!s.includes("search_datasets"));
  assert(!s.includes("Kodebok"));
});
