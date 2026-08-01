import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { searchCatalog, clearApdCatalogCache } from "./search-catalog.ts";
import { parseRegistry } from "../registry.ts";

const ORIGIN = "https://app.test";

const REG = parseRegistry([
  { id: "ssb", navn: "SSB", utgiver: "SSB", tillit: "offisiell", tilgang: "pxweb",
    base_url: "https://data.ssb.no/api/pxwebapi/v2-beta/",
    sok_endepunkt: "https://data.ssb.no/api/pxwebapi/v2-beta/tables?query={q}&lang=no", cors: true },
  { id: "datanorge", navn: "data.norge.no", utgiver: "Digdir", tillit: "offisiell", tilgang: "ckan",
    base_url: "https://data.norge.no/",
    sok_endepunkt: "https://search.api.fellesdatakatalog.digdir.no/search", cors: true },
  { id: "apd", navn: "Awesome Public Datasets", utgiver: "apd-core", tillit: "funnet",
    tilgang: "fil", kind: "apd", base_url: "https://github.com/awesomedata/apd-core", cors: false },
  { id: "owid", navn: "OWID", utgiver: "OWID", tillit: "etablert", tilgang: "fil",
    base_url: "https://ourworldindata.org/grapher/", cors: true },
  { id: "fhi", navn: "FHI", utgiver: "FHI", tillit: "offisiell", tilgang: "rest",
    kind: "fhi", base_url: "https://statistikk-data.fhi.no/api/open/v1/", cors: true },
  { id: "dst", navn: "DST", utgiver: "DST", tillit: "offisiell", tilgang: "rest",
    kind: "dst", base_url: "https://api.statbank.dk/v1/", cors: true },
  { id: "statfin", navn: "StatFin", utgiver: "Tilastokeskus", tillit: "offisiell", tilgang: "rest",
    kind: "statfin", base_url: "https://statfin.stat.fi/PXWeb/api/v1/en/StatFin/", cors: false },
  { id: "norgesbank", navn: "Norges Bank", utgiver: "Norges Bank", tillit: "offisiell",
    tilgang: "sdmx", kind: "sdmx", base_url: "https://data.norges-bank.no/api/data/", cors: true },
  { id: "ecb", navn: "ECB", utgiver: "ECB", tillit: "offisiell",
    tilgang: "sdmx", kind: "sdmx", base_url: "https://data-api.ecb.europa.eu/service/data/", cors: true },
]);

// PxWebApi v2 /tables response shape (subset)
const PXWEB_FIXTURE = {
  tables: [
    { id: "07459", label: "Befolkning, etter region, år og alder", firstPeriod: "1986", lastPeriod: "2026" },
    { id: "05839", label: "Arbeidsledige (AKU)", firstPeriod: "1996", lastPeriod: "2026" },
  ],
};

// Felles datakatalog /search response shape (subset)
const FDK_FIXTURE = {
  hits: [
    { id: "abc-123", title: { nb: "Drivstoffpriser" }, uri: "https://data.norge.no/datasets/abc-123" },
  ],
};

function fakeFetch(payload: unknown, capture: string[], bodies?: string[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    capture.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (bodies) bodies.push(String(init?.body ?? ""));
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  }) as typeof fetch;
}

Deno.test("pxweb adapter: builds search URL, maps hits", async () => {
  const calls: string[] = [];
  const hits = await searchCatalog("ssb", "arbeidsledighet", { registry: REG, origin: ORIGIN, fetchImpl: fakeFetch(PXWEB_FIXTURE, calls) });
  assertEquals(calls[0], "GET https://data.ssb.no/api/pxwebapi/v2-beta/tables?query=arbeidsledighet&lang=no");
  assertEquals(hits.length, 2);
  assertEquals(hits[1], {
    source: "ssb", id: "05839", title: "Arbeidsledige (AKU)", period: "1996–2026",
    url: "https://data.ssb.no/api/pxwebapi/v2-beta/tables/05839",
  });
});

Deno.test("ckan/fdk adapter: POSTs query, maps hits", async () => {
  const calls: string[] = [];
  const bodies: string[] = [];
  const hits = await searchCatalog("datanorge", "drivstoff", { registry: REG, origin: ORIGIN, fetchImpl: fakeFetch(FDK_FIXTURE, calls, bodies) });
  assertEquals(calls[0].startsWith("POST https://search.api.fellesdatakatalog"), true);
  // Live API quirk (verified 2026-07-03): param is "q" (not "query"), and
  // filters.type must be restricted to "datasets" or results are dominated
  // by CONCEPT/other entity types.
  assertEquals(JSON.parse(bodies[0]), { q: "drivstoff", filters: { type: { value: "datasets" } } });
  assertEquals(hits[0].title, "Drivstoffpriser");
  assertEquals(hits[0].url, "https://data.norge.no/datasets/abc-123");
});

Deno.test("unknown and unsearchable sources throw clear errors", async () => {
  for (const [id, msg] of [["nope", "ukjent kilde"], ["owid", "ikke søkbar"]] as const) {
    let threw = "";
    try { await searchCatalog(id, "x", { registry: REG, origin: ORIGIN }); } catch (e) { threw = String(e); }
    if (!threw.includes(msg)) throw new Error(`${id}: ventet '${msg}', fikk: ${threw}`);
  }
});

// --- apd adapter (local pre-harvested catalog, Task 4) ---

function fakeCatalogFetch(entries: unknown[]): typeof fetch {
  return (() => Promise.resolve(new Response(JSON.stringify(entries), { status: 200 }))) as typeof fetch;
}

const APD_FIXTURE = [
  { identifier: "Agriculture/Lemon-Dataset", name: "Lemons quality control dataset",
    description: "Fruit quality control dataset with annotated images.",
    url: "https://github.com/softwaremill/lemon-dataset", keywords: ["fruit", "quality"], category: "Agriculture" },
  { identifier: "Economics/GDP-Panel", name: "Global GDP panel",
    description: "Country-year GDP series.", url: "https://example.com/gdp",
    keywords: ["gdp", "economics"], category: "Economics" },
];

Deno.test("apdSearch: matches by name/description/keywords/category, case-insensitive", async () => {
  clearApdCatalogCache();
  const hits = await searchCatalog("apd", "FRUIT", { registry: REG, origin: ORIGIN, fetchImpl: fakeCatalogFetch(APD_FIXTURE) });
  assertEquals(hits.length, 1);
  assertEquals(hits[0].id, "Agriculture/Lemon-Dataset");
  assertEquals(hits[0].source, "apd");
  assertEquals(hits[0].url, "https://github.com/softwaremill/lemon-dataset");
  clearApdCatalogCache();
});

Deno.test("apdSearch: no match returns empty array", async () => {
  clearApdCatalogCache();
  const hits = await searchCatalog("apd", "zzznomatch", { registry: REG, origin: ORIGIN, fetchImpl: fakeCatalogFetch(APD_FIXTURE) });
  assertEquals(hits, []);
  clearApdCatalogCache();
});

Deno.test("apdSearch: caps at 20 hits", async () => {
  clearApdCatalogCache();
  const many = Array.from({ length: 25 }, (_, i) => ({
    identifier: `Cat/item-${i}`, name: `Matching item ${i}`, description: "", url: "https://x", keywords: [], category: "Cat",
  }));
  const hits = await searchCatalog("apd", "matching", { registry: REG, origin: ORIGIN, fetchImpl: fakeCatalogFetch(many) });
  assertEquals(hits.length, 20);
  clearApdCatalogCache();
});

Deno.test("apdSearch: caches the catalog across repeated calls (no re-fetch)", async () => {
  clearApdCatalogCache();
  let fetchCount = 0;
  const countingFetch = ((input: string | URL | Request, init?: RequestInit) => {
    fetchCount++;
    return Promise.resolve(new Response(JSON.stringify(APD_FIXTURE), { status: 200 }));
  }) as typeof fetch;

  // First call should fetch the catalog
  const hits1 = await searchCatalog("apd", "fruit", { registry: REG, origin: ORIGIN, fetchImpl: countingFetch });
  assertEquals(hits1.length, 1);
  assertEquals(fetchCount, 1);

  // Second call with different query should use cached catalog (no additional fetch)
  const hits2 = await searchCatalog("apd", "gdp", { registry: REG, origin: ORIGIN, fetchImpl: countingFetch });
  assertEquals(hits2.length, 1);
  assertEquals(fetchCount, 1, "Second call should use cached catalog, not fetch again");

  clearApdCatalogCache();
});

Deno.test("source without sok_endepunkt or apd-kind is not searchable", async () => {
  let threw = "";
  try { await searchCatalog("owid", "co2", { registry: REG, origin: ORIGIN }); } catch (e) { threw = String(e); }
  if (!threw.includes("ikke søkbar")) throw new Error("ventet 'ikke søkbar': " + threw);
});

// --- fhi adapter (Task 2) ---

function fakeFhiFetch(): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("Common/source")) {
      return Promise.resolve(new Response(JSON.stringify([
        { id: "daar", title: "Dødsårsaksregisteret (DÅR)", description: "...", aboutUrl: "https://www.fhi.no/op/dodsarsaksregisteret/", publishedBy: "FHI" },
        { id: "nokkel", title: "Folkehelsestatistikk", description: "...", aboutUrl: "https://www.fhi.no/op/nokkel/", publishedBy: "FHI" },
      ]), { status: 200 }));
    }
    if (url.endsWith("daar/table")) {
      return Promise.resolve(new Response(JSON.stringify([
        { tableId: 754, title: "D5c_hjertekar_rater", publishedAt: "2026-04-27T05:00:00Z", modifiedAt: "2026-05-26T13:25:14Z" },
        { tableId: 868, title: "D6a_kreft_krg", publishedAt: "2026-04-27T05:00:00Z", modifiedAt: "2026-04-22T11:17:35Z" },
      ]), { status: 200 }));
    }
    if (url.endsWith("nokkel/table")) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (url.includes("daar/table/754/dimension")) {
      return Promise.resolve(new Response(JSON.stringify({
        dimensions: [
          { code: "DAAR", label: "Dødsår", categories: [{ label: "2020", value: "2020", children: [] }, { label: "2021", value: "2021", children: [] }] },
          { code: "KJONN", label: "Kjønn", categories: [{ label: "Menn", value: "1", children: [] }, { label: "Kvinner", value: "2", children: [] }] },
        ],
      }), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

Deno.test("fhiSearch: søker over alle registre, treffer på tittel", async () => {
  const hits = await searchCatalog("fhi", "hjertekar", { registry: REG, origin: "https://app.test", fetchImpl: fakeFhiFetch() });
  assertEquals(hits.length, 1);
  assertEquals(hits[0].id, "daar/754");
  assertEquals(hits[0].source, "fhi");
});

Deno.test("fhiSearch: ingen treff gir tom liste", async () => {
  const hits = await searchCatalog("fhi", "zzznomatch", { registry: REG, origin: "https://app.test", fetchImpl: fakeFhiFetch() });
  assertEquals(hits, []);
});

// --- dst adapter (Task 3) ---

function fakeDstFetch(): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("tables?format=JSON")) {
      return Promise.resolve(new Response(JSON.stringify([
        { id: "FOLK1A", text: "Befolkningen den 1. i kvartalet", firstPeriod: "2008K1", lastPeriod: "2026K2", variables: ["område", "køn", "alder", "civilstand", "tid"] },
        { id: "BEFOLK3", text: "Befolkningen 1. januar", firstPeriod: "2007", lastPeriod: "2026", variables: ["område", "tid"] },
      ]), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

Deno.test("dstSearch: filtrerer tabellisten på tittel", async () => {
  const hits = await searchCatalog("dst", "kvartalet", { registry: REG, origin: "https://app.test", fetchImpl: fakeDstFetch() });
  assertEquals(hits.length, 1);
  assertEquals(hits[0].id, "FOLK1A");
});

// --- statfin adapter (Task 4) ---

function fakeStatfinFetch(): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("StatFin/")) {
      return Promise.resolve(new Response(JSON.stringify([
        { id: "tyti", type: "l", text: "Labour force survey" },
        { id: "synt", type: "l", text: "Births" },
      ]), { status: 200 }));
    }
    if (url.endsWith("StatFin/tyti/")) {
      return Promise.resolve(new Response(JSON.stringify([
        { id: "11pk.px", type: "t", text: "Employees aged 15-74 by type of employment relationship and sex, 2009-2025", updated: "2026-07-01T18:34:06" },
      ]), { status: 200 }));
    }
    if (url.endsWith("StatFin/synt/")) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

Deno.test("statfinSearch: rekurserer inn i mapper, treffer på tabelltittel", async () => {
  const hits = await searchCatalog("statfin", "employment", { registry: REG, origin: "https://app.test", fetchImpl: fakeStatfinFetch() });
  assertEquals(hits.length, 1);
  assertEquals(hits[0].id, "tyti/11pk.px");
});

function fakeStatfinRootFailureFetch(): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("StatFin/")) {
      return Promise.resolve(new Response("server error", { status: 500 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

Deno.test("statfinSearch: rot-mappe feiler (HTTP 500) kaster feil, returnerer ikke tom liste", async () => {
  let threw = "";
  try {
    await searchCatalog("statfin", "employment", { registry: REG, origin: "https://app.test", fetchImpl: fakeStatfinRootFailureFetch() });
  } catch (e) {
    threw = String(e);
  }
  if (!threw.includes("statfin mappeliste feilet")) throw new Error(`ventet 'statfin mappeliste feilet'-feil, fikk: ${threw}`);
});

// --- sdmx adapter (Task 5) ---

const NB_DATAFLOW_FIXTURE = {
  data: {
    dataflows: [
      { id: "EXR", agencyID: "NB", name: "Exchange rates" },
      { id: "ANN_FX_SPU", agencyID: "NB", name: "Announcement of foreign exchange transactions on behalf of SPU" },
    ],
  },
};

function fakeSdmxFetch(payload: unknown, capture: { accept: string; lang: string }[] = []): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    capture.push({ accept: headers?.Accept ?? "", lang: headers?.["Accept-Language"] ?? "" });
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  }) as typeof fetch;
}

Deno.test("sdmxSearch: filtrerer dataflow-navn, bruker kilde-spesifikk Accept-versjon + Accept-Language", async () => {
  const calls: { accept: string; lang: string }[] = [];
  // Ordscoring rangerer i stedet for å frase-filtrere: "exchange rates" gir
  // EXR (2 ordtreff) foran ANN_FX_SPU ("foreign exchange…", 1 ordtreff).
  const hits = await searchCatalog("norgesbank", "exchange rates", { registry: REG, origin: "https://app.test", fetchImpl: fakeSdmxFetch(NB_DATAFLOW_FIXTURE, calls) });
  assertEquals(hits.length, 2);
  // Komma-form (2026-08-01): id-en er flowRef-en read() faktisk tar
  // (<agency>,<flow> — slash-formen 404-er hos OECD, målt live).
  assertEquals(hits[0].id, "NB,EXR");
  assertEquals(hits[0].url, "https://data.norges-bank.no/api/data/NB,EXR");
  assertEquals(calls[0].accept, "application/vnd.sdmx.structure+json;version=1.0.0");
  // Verifisert 2026-07-25: OECDs strukturendepunkt svarer 500 uten denne
  // headeren (Denos fetch, ikke curl) — sendes derfor alltid, for alle sdmx-kilder.
  assertEquals(calls[0].lang, "en");
});

Deno.test("sdmxSearch: ordbasert scoring — flerords-spørring uten eksakt frasetreff finner riktig flow", async () => {
  // Frase-substring ga 0 treff for naturlige flerords-spørringer («health
  // spending»-klassen, målt 2026-08-01) — ordscoring rangerer i stedet.
  const hits = await searchCatalog("norgesbank", "exchange announcement spu", { registry: REG, origin: "https://app.test", fetchImpl: fakeSdmxFetch(NB_DATAFLOW_FIXTURE) });
  assertEquals(hits.length, 2);
  assertEquals(hits[0].id, "NB,ANN_FX_SPU");   // 3 ordtreff, foran EXR (1)
  assertEquals(hits[1].id, "NB,EXR");
});

// --- ecb adapter (XML, Task 1) ---

const ECB_DATAFLOW_XML = `<?xml version='1.0' encoding='UTF-8'?><mes:Structure xmlns:mes="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:str="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" xmlns:com="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common"><mes:Structures><str:Dataflows><str:Dataflow agencyID="ECB" id="EXR" version="1.0"><com:Name xml:lang="en">Exchange Rates</com:Name><str:Structure><Ref agencyID="ECB" id="ECB_EXR1" version="1.0" package="datastructure"/></str:Structure></str:Dataflow><str:Dataflow agencyID="ECB" id="AGR" version="1.0"><com:Name xml:lang="en">AGR</com:Name><str:Structure><Ref agencyID="ECB" id="ECB_BCS1" version="1.0" package="datastructure"/></str:Structure></str:Dataflow></str:Dataflows></mes:Structures></mes:Structure>`;

function fakeEcbXmlFetch(xml: string, capture: { url: string; accept: string }[] = []): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    capture.push({ url: String(input), accept: String((init?.headers as Record<string, string> | undefined)?.Accept ?? "") });
    return Promise.resolve(new Response(xml, { status: 200 }));
  }) as typeof fetch;
}

Deno.test("ecbSearch: parser XML-dataflow-liste, filtrerer på navn, bruker application/xml (ingen Accept-Language)", async () => {
  const calls: { url: string; accept: string }[] = [];
  const hits = await searchCatalog("ecb", "exchange", { registry: REG, origin: "https://app.test", fetchImpl: fakeEcbXmlFetch(ECB_DATAFLOW_XML, calls) });
  assertEquals(hits.length, 1);
  assertEquals(hits[0].id, "ECB,EXR");
  assertEquals(hits[0].title, "Exchange Rates");
  assertEquals(hits[0].source, "ecb");
  assertEquals(calls[0].accept, "application/xml");
});

Deno.test("ecbSearch: ingen treff gir tom liste", async () => {
  const hits = await searchCatalog("ecb", "zzznomatch", { registry: REG, origin: "https://app.test", fetchImpl: fakeEcbXmlFetch(ECB_DATAFLOW_XML) });
  assertEquals(hits, []);
});
