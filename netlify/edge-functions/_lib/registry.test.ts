import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clearRegistryCache, findSource, loadRegistry, parseRegistry,
  renderRegistryBlock, sourceForUrl, type DataSource,
} from "./registry.ts";

const VALID = [{
  id: "ssb", navn: "Statistisk sentralbyrå (PxWebApi)", utgiver: "SSB",
  tillit: "offisiell", tilgang: "pxweb",
  base_url: "https://data.ssb.no/api/pxwebapi/v2-beta/",
  sok_endepunkt: "https://data.ssb.no/api/pxwebapi/v2-beta/tables?query={q}&lang=no",
  cors: true, join_nokler: ["kommunenummer", "år"],
}, {
  id: "fred", navn: "FRED", utgiver: "St. Louis Fed", tillit: "etablert",
  tilgang: "rest", base_url: "https://api.stlouisfed.org/fred/", cors: false,
  auth: { type: "api_key", env: "FRED_API_KEY", plassering: "query:api_key" },
}];

Deno.test("parseRegistry accepts valid entries", () => {
  const reg = parseRegistry(VALID);
  assertEquals(reg.length, 2);
  assertEquals(reg[0].id, "ssb");
});

Deno.test("parseRegistry rejects missing base_url and bad tillit", () => {
  assertThrows(() => parseRegistry([{ id: "x", tilgang: "rest", cors: true }]));
  assertThrows(() => parseRegistry([{ ...VALID[0], tillit: "hemmelig" }]));
  assertThrows(() => parseRegistry({ not: "an array" }));
});

Deno.test("findSource / sourceForUrl", () => {
  const reg = parseRegistry(VALID);
  assertEquals(findSource(reg, "fred")?.id, "fred");
  assertEquals(findSource(reg, "nope"), null);
  assertEquals(sourceForUrl(reg, "https://api.stlouisfed.org/fred/series?x=1")?.id, "fred");
  assertEquals(sourceForUrl(reg, "https://evil.example/fred/"), null);
  assertEquals(sourceForUrl(reg, "not a url"), null);
});

Deno.test("loadRegistry fetches once and caches", async () => {
  clearRegistryCache();
  let calls = 0;
  const fetchImpl = ((_u: string | URL | Request) => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 }));
  }) as typeof fetch;
  const a = await loadRegistry("https://app.test", fetchImpl);
  const b = await loadRegistry("https://app.test", fetchImpl);
  assertEquals(a.length, 2);
  assertEquals(b, a);
  assertEquals(calls, 1);
  clearRegistryCache();
});

Deno.test("renderRegistryBlock is compact and byte-stable", () => {
  const reg = parseRegistry(VALID) as DataSource[];
  const block = renderRegistryBlock(reg);
  assertEquals(block, renderRegistryBlock(reg)); // stable
  if (!block.includes("ssb") || !block.includes("søkbar")) throw new Error("mangler innhold:\n" + block);
  if (block.includes("FRED_API_KEY")) throw new Error("auth-detaljer skal ikke i prompt");
});

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
