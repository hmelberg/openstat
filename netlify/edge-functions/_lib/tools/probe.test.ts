import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { probeUrl } from "./probe.ts";

function fakeFetch(body: string, headers: Record<string, string>): typeof fetch {
  return ((_i: string | URL | Request) =>
    Promise.resolve(new Response(body, { status: 200, headers }))) as typeof fetch;
}

Deno.test("probe CSV: header + sample rows + CORS flag", async () => {
  const csv = "kommune;aar;ledighet\n0301;2024;2.1\n1103;2024;2.4\n5001;2024;1.9\n";
  const r = await probeUrl("https://x.example/d.csv", {
    fetchImpl: fakeFetch(csv, { "content-type": "text/csv", "access-control-allow-origin": "*" }),
  });
  assertEquals(r.ok, true);
  assertEquals(r.cors, true);
  assertEquals(r.columns, ["kommune", "aar", "ledighet"]);
  assertEquals(r.sampleRows.length, 2);
  assertEquals(r.sampleRows[0], ["0301", "2024", "2.1"]);
});

Deno.test("probe JSON-stat: dimension ids as columns", async () => {
  const js = JSON.stringify({ label: "t", dimension: { Region: {}, Tid: {} }, value: [1, 2] });
  const r = await probeUrl("https://x.example/js", {
    fetchImpl: fakeFetch(js, { "content-type": "application/json" }),
  });
  assertEquals(r.columns, ["Region", "Tid"]);
});

Deno.test("probe JSON array-of-objects: keys as columns", async () => {
  const j = JSON.stringify([{ date: "2024-01-01", value: 3.2 }, { date: "2024-02-01", value: 3.1 }]);
  const r = await probeUrl("https://x.example/arr", {
    fetchImpl: fakeFetch(j, { "content-type": "application/json" }),
  });
  assertEquals(r.columns, ["date", "value"]);
  assertEquals(r.cors, false);
});

Deno.test("probe: non-public URL and HTTP errors reported, not thrown", async () => {
  const bad = await probeUrl("http://localhost/x");
  assertEquals(bad.ok, false);
  if (!bad.note?.includes("blokkert")) throw new Error("ventet blokkert-notat");
  const e404 = await probeUrl("https://x.example/gone", {
    fetchImpl: ((_i: string | URL | Request) => Promise.resolve(new Response("nope", { status: 404 }))) as typeof fetch,
  });
  assertEquals(e404.ok, false);
  assertEquals(e404.status, 404);
});

Deno.test("probe sends Origin header in fetch request", async () => {
  let capturedOrigin: string | null = null;
  const fake = ((_url: string | URL | Request, init?: RequestInit) => {
    capturedOrigin = init?.headers instanceof Headers
      ? init.headers.get("origin")
      : (init?.headers as Record<string, string>)?.["Origin"] ?? null;
    return Promise.resolve(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
  }) as typeof fetch;

  await probeUrl("https://x.example/data", { fetchImpl: fake });
  assertEquals(capturedOrigin, "https://openstat.app");
});

Deno.test("probe accepts ACAO that echoes sent origin as CORS:true", async () => {
  const csv = "x;y\n1;2\n";
  const fake = ((_i: string | URL | Request) =>
    Promise.resolve(new Response(csv, {
      status: 200,
      headers: {
        "content-type": "text/csv",
        "access-control-allow-origin": "https://openstat.app",
      },
    }))) as typeof fetch;

  const r = await probeUrl("https://x.example/data.csv", { fetchImpl: fake });
  assertEquals(r.cors, true);
});

Deno.test("probe ACAO * still counts as CORS:true", async () => {
  const csv = "x;y\n1;2\n";
  const r = await probeUrl("https://x.example/data.csv", {
    fetchImpl: fakeFetch(csv, { "content-type": "text/csv", "access-control-allow-origin": "*" }),
  });
  assertEquals(r.cors, true);
});

Deno.test("probe no ACAO still counts as CORS:false", async () => {
  const csv = "x;y\n1;2\n";
  const r = await probeUrl("https://x.example/data.csv", {
    fetchImpl: fakeFetch(csv, { "content-type": "text/csv" }),
  });
  assertEquals(r.cors, false);
});

// --- SDMX-representasjon og XML-vern (2026-08-01, funnet i live smoke-test) ---

const SDMX_REG = [
  { id: "oecd", navn: "OECD SDMX", utgiver: "OECD", tillit: "offisiell",
    tilgang: "sdmx", kind: "sdmx", base_url: "https://sdmx.oecd.org/public/rest/data/", cors: true },
];

Deno.test("probe: sdmx-kilde får CSV-Accept + Accept-Language (samme representasjon som lasteren)", async () => {
  // Uten Accept svarer OECD med SDMX-ML (XML) — probe rapporterte da et
  // «skjema» lasteren aldri ser, og OECD 500-er («languageTag1») uten
  // Accept-Language på Denos fetch. Målt live 2026-08-01.
  const sett: Record<string, string>[] = [];
  const fetchImpl = ((_i: string | URL | Request, init?: RequestInit) => {
    sett.push((init?.headers ?? {}) as Record<string, string>);
    return Promise.resolve(new Response("DATAFLOW,REF_AREA,TIME_PERIOD,OBS_VALUE\nX,NOR,2020,1.5\n", {
      status: 200, headers: { "content-type": "application/vnd.sdmx.data+csv" },
    }));
  }) as typeof fetch;
  const r = await probeUrl("https://sdmx.oecd.org/public/rest/data/OECD.X,DF_Y?startPeriod=2020", {
    fetchImpl, registry: SDMX_REG as never,
  });
  assertEquals(sett[0]["Accept"], "application/vnd.sdmx.data+csv;labels=id");
  assertEquals(sett[0]["Accept-Language"], "en");
  assertEquals(r.columns, ["DATAFLOW", "REF_AREA", "TIME_PERIOD", "OBS_VALUE"]);
});

Deno.test("probe: ikke-sdmx URL får ikke sdmx-Accept (uendret oppførsel)", async () => {
  const sett: Record<string, string>[] = [];
  const fetchImpl = ((_i: string | URL | Request, init?: RequestInit) => {
    sett.push((init?.headers ?? {}) as Record<string, string>);
    return Promise.resolve(new Response("a,b\n1,2\n", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  await probeUrl("https://ourworldindata.org/grapher/co2.csv", { fetchImpl, registry: SDMX_REG as never });
  assertEquals(sett[0]["Accept"], undefined);
});

Deno.test("probe: XML-svar rapporteres som XML, ikke som én gigantisk CSV-kolonne", async () => {
  // Målt live: 85 000 tegn SDMX-ML havnet i ÉN columns-oppføring rett inn i
  // modellens kontekst, med ok:true og note «CSV» — verre enn en ærlig feil.
  const xml = `<?xml version="1.0" encoding="utf-8"?><message:GenericData xmlns:message="urn:x"><message:DataSet>${"<generic:Obs/>".repeat(50)}</message:DataSet></message:GenericData>`;
  const r = await probeUrl("https://x.example/data", {
    fetchImpl: fakeFetch(xml, { "content-type": "application/xml" }),
  });
  assertEquals(r.columns, []);
  assertEquals(r.sampleRows, []);
  assertEquals(r.ok, false);
  assertEquals(typeof r.note, "string");
  assertEquals(r.note!.includes("XML"), true);
});
