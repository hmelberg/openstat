import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { pickValues, tableMetadata } from "./table-metadata.ts";
import { parseRegistry } from "../registry.ts";
import type { DataSource } from "../registry.ts";

const REG = parseRegistry([
  { id: "ssb", navn: "SSB", utgiver: "SSB", tillit: "offisiell", tilgang: "pxweb",
    base_url: "https://data.ssb.no/api/pxwebapi/v2-beta/", cors: true,
    sporrings_url_mal: "https://data.ssb.no/api/pxwebapi/v2-beta/tables/{id}/data?valueCodes[{var}]={koder}&outputFormat=csv" },
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

// PxWebApi v2 /tables/{id}/metadata shape (subset): JSON-stat2-like dimensions
const META_FIXTURE = {
  label: "05839: Arbeidsledige (AKU), etter kjønn og år",
  dimension: {
    Kjonn: { label: "kjønn", category: { index: { "0": 0, "1": 1, "2": 2 },
      label: { "0": "Begge kjønn", "1": "Menn", "2": "Kvinner" } } },
    Tid: { label: "år", extension: { elimination: false },
      category: { index: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(1996 + i), i])),
        label: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [String(1996 + i), String(1996 + i)])) } },
  },
  role: { time: ["Tid"] },
};

function fakeFetch(payload: unknown, capture: string[]): typeof fetch {
  return ((input: string | URL | Request) => {
    capture.push(String(input));
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  }) as typeof fetch;
}

Deno.test("pxweb metadata: variables, time flag, value cap, query template", async () => {
  const calls: string[] = [];
  const meta = await tableMetadata("ssb", "05839", { registry: REG, fetchImpl: fakeFetch(META_FIXTURE, calls) });
  assertEquals(calls[0], "https://data.ssb.no/api/pxwebapi/v2-beta/tables/05839/metadata?lang=no");
  assertEquals(meta.title.startsWith("05839"), true);
  const kjonn = meta.variables.find((v) => v.code === "Kjonn")!;
  assertEquals(kjonn.time, false);
  assertEquals(kjonn.values.length, 3);
  assertEquals(kjonn.values[1], { code: "1", label: "Menn" });
  const tid = meta.variables.find((v) => v.code === "Tid")!;
  assertEquals(tid.time, true);
  assertEquals(tid.values.length, 40);          // capped
  assertEquals(tid.valuesTruncated, true);
  assertEquals(meta.queryUrlTemplate?.includes("{id}") ?? true, false); // {id} substituted
});

Deno.test("non-pxweb source throws with probe guidance", async () => {
  let threw = "";
  try { await tableMetadata("owid", "co2", { registry: REG }); } catch (e) { threw = String(e); }
  if (!threw.includes("probe")) throw new Error("ventet probe-henvisning: " + threw);
});

Deno.test("fhi metadata: kode fra categories[].value, ingen tids-flagg", async () => {
  const fetchImpl = ((input: string | URL | Request) => {
    if (String(input).includes("daar/table/754/dimension")) {
      return Promise.resolve(new Response(JSON.stringify({
        dimensions: [
          { code: "DAAR", label: "Dødsår", categories: [{ label: "2020", value: "2020", children: [] }] },
        ],
      }), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  const meta = await tableMetadata("fhi", "daar/754", { registry: REG, fetchImpl });
  const daar = meta.variables.find((v) => v.code === "DAAR")!;
  assertEquals(daar.time, false);
  assertEquals(daar.values[0], { code: "2020", label: "2020" });
});

// --- dst adapter (Task 3) ---

Deno.test("dst metadata: time-flagg direkte per variabel", async () => {
  const fetchImpl = ((input: string | URL | Request) => {
    if (String(input).includes("tableinfo/FOLK1A")) {
      return Promise.resolve(new Response(JSON.stringify({
        text: "Befolkningen den 1. i kvartalet",
        variables: [
          { id: "OMRÅDE", text: "område", elimination: true, time: false, values: [{ id: "000", text: "Hele landet" }] },
          { id: "Tid", text: "tid", time: true, values: [{ id: "2024K1", text: "2024K1" }] },
        ],
      }), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  const meta = await tableMetadata("dst", "FOLK1A", { registry: REG, fetchImpl });
  assertEquals(meta.variables.find((v) => v.code === "Tid")!.time, true);
  assertEquals(meta.variables.find((v) => v.code === "OMRÅDE")!.time, false);
});

// --- statfin adapter (Task 4) ---

Deno.test("statfin metadata: parallelle values/valueTexts-arrayer", async () => {
  const fetchImpl = ((input: string | URL | Request) => {
    if (String(input).includes("tyti/11pk.px")) {
      return Promise.resolve(new Response(JSON.stringify({
        title: "Employees by sex",
        variables: [
          { code: "sukupuoli", text: "Sex", values: ["1", "2"], valueTexts: ["Men", "Women"], elimination: true },
          { code: "timeperiod_m", text: "Month", values: ["2025M01"], valueTexts: ["2025M01"], time: true },
        ],
      }), { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
  const meta = await tableMetadata("statfin", "tyti/11pk.px", { registry: REG, fetchImpl });
  const sex = meta.variables.find((v) => v.code === "sukupuoli")!;
  assertEquals(sex.values, [{ code: "1", label: "Men" }, { code: "2", label: "Women" }]);
  assertEquals(meta.variables.find((v) => v.code === "timeperiod_m")!.time, true);
});

// --- sdmx adapter (Task 5) ---

const NB_EXR_DSD_FIXTURE = {
  data: {
    dataStructures: [{
      name: "Exchange rates",
      dataStructureComponents: {
        dimensionList: {
          dimensions: [
            { id: "BASE_CUR", localRepresentation: { enumeration: "urn:sdmx:org.sdmx.infomodel.codelist.Codelist=NB:CL_CURRENCY(1.0)" } },
          ],
          timeDimensions: [
            { id: "TIME_PERIOD", localRepresentation: { textFormat: { textType: "ObservationalTimePeriod" } } },
          ],
        },
      },
    }],
    codelists: [
      { id: "CL_CURRENCY", codes: [{ id: "NOK", name: "Norwegian krone" }, { id: "USD", name: "US dollar" }] },
    ],
  },
};

function fakeSdmxFetch(payload: unknown, capture: string[] = []): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    capture.push(String(input));
    capture.push(String((init?.headers as Record<string, string> | undefined)?.["Accept-Language"] ?? ""));
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  }) as typeof fetch;
}

Deno.test("sdmx metadata: kodeliste koblet via enumeration-URN, tidsdimensjon fra timeDimensions", async () => {
  const calls: string[] = [];
  const meta = await tableMetadata("norgesbank", "NB/EXR", { registry: REG, fetchImpl: fakeSdmxFetch(NB_EXR_DSD_FIXTURE, calls) });
  const baseCur = meta.variables.find((v) => v.code === "BASE_CUR")!;
  assertEquals(baseCur.values, [{ code: "NOK", label: "Norwegian krone" }, { code: "USD", label: "US dollar" }]);
  const time = meta.variables.find((v) => v.code === "TIME_PERIOD")!;
  assertEquals(time.time, true);
  assertEquals(time.values, []);
  assertEquals(calls[0], "https://data.norges-bank.no/api/dataflow/NB/EXR/latest?references=all");
  // Verifisert 2026-07-25: OECDs strukturendepunkt svarer 500 uten denne
  // headeren (Denos fetch, ikke curl) — sendes derfor alltid, for alle sdmx-kilder.
  assertEquals(calls[1], "en");
});

Deno.test("sdmx metadata: komma-form id (som search_catalog nå returnerer) godtas likt", async () => {
  // search_catalog gir flowRef-en på komma-form («NB,EXR» — det read() tar);
  // strukturendepunktet trenger agency/flow som separate path-segmenter.
  const calls: string[] = [];
  const meta = await tableMetadata("norgesbank", "NB,EXR", { registry: REG, fetchImpl: fakeSdmxFetch(NB_EXR_DSD_FIXTURE, calls) });
  assertEquals(meta.title, "Exchange rates");
  assertEquals(calls[0], "https://data.norges-bank.no/api/dataflow/NB/EXR/latest?references=all");
});

// --- ecb adapter (XML, Task 1) ---

const ECB_EXR_DSD_XML = `<?xml version='1.0' encoding='UTF-8'?><mes:Structure xmlns:mes="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/message" xmlns:str="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/structure" xmlns:com="http://www.sdmx.org/resources/sdmxml/schemas/v2_1/common"><mes:Structures><str:DataStructures><str:DataStructure agencyID="ECB" id="ECB_EXR1"><com:Name xml:lang="en">Exchange Rates</com:Name><str:DataStructureComponents><str:DimensionList><str:Dimension id="CURRENCY"><str:LocalRepresentation><str:Enumeration><Ref agencyID="ECB" id="CL_CURRENCY" version="1.0" package="codelist"/></str:Enumeration></str:LocalRepresentation></str:Dimension><str:TimeDimension id="TIME_PERIOD"/></str:DimensionList></str:DataStructureComponents></str:DataStructure></str:DataStructures><str:Codelists><str:Codelist id="CL_CURRENCY"><str:Code id="NOK"><com:Name xml:lang="en">Norwegian krone</com:Name></str:Code><str:Code id="USD"><com:Name xml:lang="en">US dollar</com:Name></str:Code></str:Codelist></str:Codelists></mes:Structures></mes:Structure>`;

function fakeEcbXmlMetaFetch(xml: string, capture: string[] = []): typeof fetch {
  return ((input: string | URL | Request) => {
    capture.push(String(input));
    return Promise.resolve(new Response(xml, { status: 200 }));
  }) as typeof fetch;
}

Deno.test("ecb metadata: kodeliste koblet via Ref.id (ingen URN-parsing), tidsdimensjon fra TimeDimension", async () => {
  const calls: string[] = [];
  const meta = await tableMetadata("ecb", "ECB/EXR", { registry: REG, fetchImpl: fakeEcbXmlMetaFetch(ECB_EXR_DSD_XML, calls) });
  const currency = meta.variables.find((v) => v.code === "CURRENCY")!;
  assertEquals(currency.values, [{ code: "NOK", label: "Norwegian krone" }, { code: "USD", label: "US dollar" }]);
  const time = meta.variables.find((v) => v.code === "TIME_PERIOD")!;
  assertEquals(time.time, true);
  assertEquals(time.values, []);
  assertEquals(calls[0], "https://data-api.ecb.europa.eu/service/dataflow/ECB/EXR/latest?references=all");
});

Deno.test("ecb metadata: find via pickValues — kort liste (<=MAX_VALUES) tømmes ikke (sluttreview, bundlet med pxweb-regelen)", async () => {
  const meta = await tableMetadata("ecb", "ECB/EXR", {
    registry: REG,
    fetchImpl: fakeEcbXmlMetaFetch(ECB_EXR_DSD_XML),
    find: "usd",
  });
  const currency = meta.variables.find((v) => v.code === "CURRENCY")!;
  // CURRENCY har bare 2 koder — find skal IKKE filtrere en så kort liste,
  // samme regel som pxwebMetadata nå bruker.
  assertEquals(currency.values, [{ code: "NOK", label: "Norwegian krone" }, { code: "USD", label: "US dollar" }]);
});

// --- worldbank/dbnomics adapters (Task 5, delegerer til catalogs/*.ts) ---

Deno.test("tableMetadata: kind worldbank delegerer til worldbankMetadata", async () => {
  const f = (() => Promise.resolve(new Response(JSON.stringify([
    { page: 1 },
    [{ id: "SP.POP.TOTL", name: "Population, total", source: { value: "WDI" }, sourceNote: "…" }],
  ]), { status: 200 }))) as unknown as typeof fetch;
  const reg = parseRegistry([{ id: "worldbank", navn: "Verdensbanken", utgiver: "WB",
    tillit: "etablert", tilgang: "rest", kind: "worldbank",
    base_url: "https://api.worldbank.org/v2/", cors: true }]);
  const m = await tableMetadata("worldbank", "SP.POP.TOTL", { registry: reg, fetchImpl: f }) as Record<string, unknown>;
  assertEquals(m.navn, "Population, total");
});

Deno.test("tableMetadata: kind dbnomics delegerer til dbnomicsMetadata", async () => {
  const f = (() => Promise.resolve(new Response(JSON.stringify({
    datasets: { docs: [{
      code: "CPI", name: "Consumer Price Index", provider_code: "IMF",
      dimensions_codes_order: ["freq"],
      dimensions_labels: { freq: "Frequency" },
      dimensions_values_labels: { freq: { M: "Monthly", A: "Annual" } },
    }] },
  }), { status: 200 }))) as unknown as typeof fetch;
  const reg = parseRegistry([{ id: "dbnomics", navn: "DBnomics", utgiver: "Cepremap",
    tillit: "etablert", tilgang: "rest", kind: "dbnomics",
    base_url: "https://api.db.nomics.world/v22/series/", cors: true }]);
  const m = await tableMetadata("dbnomics", "IMF/CPI", { registry: reg, fetchImpl: f }) as Record<string, unknown>;
  assertEquals(m.navn, "Consumer Price Index");
});

// --- mandatory-flagg + find-param (Task 1, ssb-mandatory) ---

Deno.test("pickValues: find-filter treffer kode OG etikett, case-insensitivt, FØR kuttet", () => {
  const all = Array.from({ length: 100 }, (_, i) => ({ code: `K${i}`, label: `Sted ${i}` }));
  all.push({ code: "0301", label: "Oslo" });
  const r = pickValues(all, "oslo");
  assertEquals(r.values, [{ code: "0301", label: "Oslo" }]);
  assertEquals(r.valuesTruncated, false);
  const rKode = pickValues(all, "030");
  assertEquals(rKode.values.length, 1);
});

Deno.test("pickValues: uten find — første 40 + truncated-flagg", () => {
  const all = Array.from({ length: 50 }, (_, i) => ({ code: `${i}`, label: `${i}` }));
  const r = pickValues(all);
  assertEquals(r.values.length, 40);
  assertEquals(r.valuesTruncated, true);
});

// Fake pxweb-metadata: ContentsCode/Tid elimination=false, Region=true.
// Region har >40 koder (som ekte kommune-lister) slik at find fortsatt
// filtrerer DER — mens ContentsCode (kort, obligatorisk liste, som SSBs
// egen 4-koders variant) skal beholde ALLE koder selv når find er satt
// (sluttreview 2026-07-31: find skal aldri tømme en mandatory-dimensjon).
const REGION_ENTRIES = Array.from({ length: 45 }, (_, i) => ({ code: `K${i}`, label: `Sted ${i}` }));
REGION_ENTRIES.push({ code: "0301", label: "Oslo" });
const REGION_INDEX: Record<string, number> = {};
const REGION_LABEL: Record<string, string> = {};
REGION_ENTRIES.forEach((c, i) => { REGION_INDEX[c.code] = i; REGION_LABEL[c.code] = c.label; });

const PXMETA = {
  label: "11342: Areal og befolkning",
  role: { time: ["Tid"] },
  dimension: {
    Region: {
      label: "region",
      category: { index: REGION_INDEX, label: REGION_LABEL },
      extension: { elimination: true },
    },
    ContentsCode: {
      label: "statistikkvariabel",
      category: {
        index: { Folkemengde: 0, Fodte: 1, Dode: 2, Innflytting: 3 },
        label: { Folkemengde: "Personer", Fodte: "Fødte", Dode: "Døde", Innflytting: "Innflytting" },
      },
      extension: { elimination: false },
    },
    Tid: {
      label: "år",
      category: { index: { "2024": 0 }, label: { "2024": "2024" } },
      extension: { elimination: false },
    },
  },
};
const SSB_SRC: DataSource[] = [{
  id: "ssb", navn: "SSB", utgiver: "SSB", tillit: "offisiell",
  tilgang: "pxweb", base_url: "https://data.ssb.no/api/pxwebapi/v2/",
} as unknown as DataSource];
const fakeMandatoryFetch = ((_url: string) =>
  Promise.resolve(new Response(JSON.stringify(PXMETA), { status: 200 }))) as typeof fetch;

Deno.test("pxwebMetadata: mandatory fra elimination; find når fram (lang liste filtreres)", async () => {
  const m = await tableMetadata("ssb", "11342", { registry: SSB_SRC, fetchImpl: fakeMandatoryFetch, find: "oslo" });
  const region = m.variables.find((v) => v.code === "Region")!;
  const contents = m.variables.find((v) => v.code === "ContentsCode")!;
  assertEquals(region.mandatory, false);
  assertEquals(contents.mandatory, true);
  assertEquals(region.values, [{ code: "0301", label: "Oslo" }]);
  assert(m.variables.find((v) => v.code === "Tid")!.mandatory);
});

Deno.test("pxwebMetadata: find tømmer IKKE en kort mandatory-dimensjon (ContentsCode)", async () => {
  const m = await tableMetadata("ssb", "11342", { registry: SSB_SRC, fetchImpl: fakeMandatoryFetch, find: "oslo" });
  const contents = m.variables.find((v) => v.code === "ContentsCode")!;
  // Ingen av ContentsCode-kodene matcher "oslo" — hadde find filtrert denne
  // korte, obligatoriske listen ville values vært tom (og modellen ville
  // trodd tabellen ikke hadde noe å måle). Den skal stå urørt.
  assertEquals(contents.values.length, 4);
  assertEquals(contents.valuesTruncated, false);
});
