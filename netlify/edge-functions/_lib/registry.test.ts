import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clearRegistryCache, findSource, isSearchableSource, loadRegistry, parseRegistry,
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

Deno.test("parseRegistry rejects user-key with query-plassering (nøkkel ville havnet i URL/logg)", () => {
  const base = { id: "q", navn: "Q", utgiver: "Q", tillit: "etablert", tilgang: "rest",
    base_url: "https://api.q.example/", cors: false };
  assertThrows(() => parseRegistry([{ ...base, auth: { type: "api_key", user: true, plassering: "query:key" } }]));
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

Deno.test("renderRegistryBlock marks kind=apd as søkbar even without sok_endepunkt", () => {
  const reg = parseRegistry([{
    id: "apd", navn: "APD", utgiver: "apd-core", tillit: "funnet", tilgang: "fil",
    kind: "apd", base_url: "https://github.com/awesomedata/apd-core", cors: false,
  }]);
  const block = renderRegistryBlock(reg);
  if (!block.includes("søkbar via search_catalog")) throw new Error("apd skal markeres søkbar:\n" + block);
});

Deno.test("isSearchableSource: sok_endepunkt, kjent kind, eller sdmx+id i SDMX_STRUCTURE_ACCEPT", () => {
  const reg = parseRegistry([
    { id: "ssb", navn: "SSB", utgiver: "SSB", tillit: "offisiell", tilgang: "pxweb",
      base_url: "https://data.ssb.no/api/pxwebapi/v2-beta/",
      sok_endepunkt: "https://data.ssb.no/api/pxwebapi/v2-beta/tables?query={q}&lang=no", cors: true },
    { id: "apd", navn: "APD", utgiver: "apd-core", tillit: "funnet", tilgang: "fil",
      kind: "apd", base_url: "https://github.com/awesomedata/apd-core", cors: false },
    { id: "norgesbank", navn: "Norges Bank", utgiver: "Norges Bank", tillit: "offisiell",
      tilgang: "sdmx", kind: "sdmx", base_url: "https://data.norges-bank.no/api/data/", cors: true },
    { id: "ecb", navn: "ECB", utgiver: "ECB", tillit: "offisiell", tilgang: "sdmx", kind: "sdmx",
      base_url: "https://data-api.ecb.europa.eu/service/data/", cors: true },
    { id: "owid", navn: "OWID", utgiver: "OWID", tillit: "etablert", tilgang: "fil",
      base_url: "https://ourworldindata.org/grapher/", cors: true },
  ]);
  assertEquals(isSearchableSource(reg[0]), true);  // sok_endepunkt
  assertEquals(isSearchableSource(reg[1]), true);  // kind apd
  assertEquals(isSearchableSource(reg[2]), true);  // sdmx + norgesbank i SDMX_STRUCTURE_ACCEPT
  assertEquals(isSearchableSource(reg[3]), true);  // sdmx + ecb er nå i SDMX_XML_SOURCES (XML-adapter)
  assertEquals(isSearchableSource(reg[4]), false); // verken sok_endepunkt, kjent kind, eller sdmx
});

Deno.test("isSearchableSource: ecb blir søkbar etter XML-støtte (SDMX_XML_SOURCES)", () => {
  const reg = parseRegistry([
    { id: "ecb", navn: "ECB", utgiver: "ECB", tillit: "offisiell", tilgang: "sdmx", kind: "sdmx",
      base_url: "https://data-api.ecb.europa.eu/service/data/", cors: true },
  ]);
  assertEquals(isSearchableSource(reg[0]), true);
});

const FED_ENTRY = {
  id: "demo-federert", navn: "Demo: federert persontabell (3 deler)",
  utgiver: "openstat", tillit: "demo", tilgang: "fil",
  kind: "federated", partition: "horizontal", overlap: "none", cors: true,
  members: [
    { id: "nord", url: "data/federert/nord.parquet" },
    { id: "vest", url: "data/federert/vest.parquet" },
    { id: "sor", url: "data/federert/sor.parquet" },
  ],
};

Deno.test("parseRegistry: federert kilde uten base_url godtas", () => {
  const reg = parseRegistry([FED_ENTRY]);
  assertEquals(reg[0].id, "demo-federert");
  assertEquals(reg[0].members!.length, 3);
});

Deno.test("parseRegistry: federert kilde uten members avvises", () => {
  assertThrows(() => parseRegistry([{ ...FED_ENTRY, members: [] }]), Error, "members");
  assertThrows(() => parseRegistry([{ ...FED_ENTRY, members: [{ id: "x" }] }]), Error, "id og url");
});
