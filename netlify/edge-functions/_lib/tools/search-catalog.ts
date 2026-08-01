// search_catalog tool: per-source-type adapters over live catalog APIs.
// Adapters exist for pxweb (SSB & friends), ckan (Felles datakatalog), og
// apd (lokal, forhåndshøstet katalog — se
// docs/superpowers/specs/2026-07-25-apd-catalog-design.md). Andre tilgang-
// verdier nås via web_search + probe (prompt-regel).
import { findSource, isSearchableSource, SDMX_STRUCTURE_ACCEPT, SDMX_XML_SOURCES, type DataSource } from "../registry.ts";
import { queryWords, scoreSubstring } from "./catalogs/static-catalog.ts";
import { XMLParser } from "https://esm.sh/fast-xml-parser@4";

export interface CatalogHit {
  source: string;
  id: string;
  title: string;
  period?: string;
  url: string;
}

export interface CatalogDeps {
  registry: DataSource[];
  origin: string;
  fetchImpl?: typeof fetch;
}

const MAX_HITS = 20;

export async function searchCatalog(
  sourceId: string,
  query: string,
  deps: CatalogDeps,
): Promise<CatalogHit[]> {
  const src = findSource(deps.registry, sourceId);
  if (!src) throw new Error(`ukjent kilde '${sourceId}' — bruk en id fra kilderegisteret`);
  const f = deps.fetchImpl ?? fetch;
  // sdmx-tilgang hopper over denne blanke sperren: sdmxSearch har sin egen,
  // mer presise SDMX_STRUCTURE_ACCEPT-sjekk (f.eks. ecb → "ikke støttet ennå
  // (kun XML)") — isSearchableSource sin blanke "ikke søkbar" ville ellers
  // maskert den mer nyttige feilmeldingen.
  if (src.tilgang !== "sdmx" && !isSearchableSource(src)) {
    throw new Error(`kilden '${sourceId}' er ikke søkbar — bruk web_search + probe i stedet`);
  }
  switch (src.tilgang) {
    case "pxweb": return pxwebSearch(src, query, f);
    case "ckan": return fdkSearch(src, query, f);
    case "sdmx": return sdmxSearch(src, query, f);
    default:
      switch (src.kind) {
        case "apd": return apdSearch(query, deps.origin, f);
        case "fhi": return fhiSearch(src, query, f);
        case "dst": return dstSearch(src, query, f);
        case "statfin": return statfinSearch(src, query, f);
        default:
          throw new Error(`ingen søkeadapter for tilgang='${src.tilgang}' (kilde '${sourceId}') — bruk web_search + probe`);
      }
  }
}

async function pxwebSearch(src: DataSource, query: string, f: typeof fetch): Promise<CatalogHit[]> {
  const url = src.sok_endepunkt!.replace("{q}", encodeURIComponent(query));
  const res = await f(url);
  if (!res.ok) throw new Error(`katalogsøk mot ${src.id} feilet: HTTP ${res.status}`);
  const json = await res.json();
  const tables = Array.isArray(json?.tables) ? json.tables : [];
  return tables.slice(0, MAX_HITS).map((t: Record<string, unknown>) => ({
    source: src.id,
    id: String(t.id ?? ""),
    title: String(t.label ?? ""),
    period: t.firstPeriod ? `${t.firstPeriod}–${t.lastPeriod ?? ""}` : undefined,
    url: new URL(`tables/${t.id}`, src.base_url).toString(),
  }));
}

async function fdkSearch(src: DataSource, query: string, f: typeof fetch): Promise<CatalogHit[]> {
  // Live API quirk (verified 2026-07-03): the query param is "q" (not "query"),
  // and without filters.type the search spans concepts/informationmodels/services
  // too — restrict to datasets or hits are dominated by CONCEPT entries.
  const res = await f(src.sok_endepunkt!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: query, filters: { type: { value: "datasets" } } }),
  });
  if (!res.ok) throw new Error(`katalogsøk mot ${src.id} feilet: HTTP ${res.status}`);
  const json = await res.json();
  const hits = Array.isArray(json?.hits) ? json.hits : [];
  return hits.slice(0, MAX_HITS).map((h: Record<string, unknown>) => {
    const title = h.title as Record<string, string> | string | undefined;
    return {
      source: src.id,
      id: String(h.id ?? ""),
      title: typeof title === "object" ? (title?.nb ?? Object.values(title ?? {})[0] ?? "") : String(title ?? ""),
      url: String(h.uri ?? ""),
    };
  });
}

interface ApdCatalogEntry {
  identifier: string;
  name: string;
  description: string;
  url: string;
  keywords: string[];
  category: string;
}

let _apdCache: ApdCatalogEntry[] | null = null;
export function clearApdCatalogCache(): void { _apdCache = null; }

async function loadApdCatalog(origin: string, f: typeof fetch): Promise<ApdCatalogEntry[]> {
  if (_apdCache) return _apdCache;
  const res = await f(new URL("/data/apd-catalog.json", origin).toString());
  if (!res.ok) throw new Error(`kunne ikke hente apd-katalog: HTTP ${res.status}`);
  _apdCache = await res.json() as ApdCatalogEntry[];
  return _apdCache;
}

async function apdSearch(query: string, origin: string, f: typeof fetch): Promise<CatalogHit[]> {
  const catalog = await loadApdCatalog(origin, f);
  const q = query.toLowerCase();
  const hits = catalog.filter((e) =>
    e.name.toLowerCase().includes(q) ||
    e.description.toLowerCase().includes(q) ||
    e.category.toLowerCase().includes(q) ||
    e.keywords.some((k) => k.toLowerCase().includes(q))
  );
  return hits.slice(0, MAX_HITS).map((e) => ({
    source: "apd",
    id: e.identifier,
    title: e.name,
    url: e.url,
  }));
}

interface FhiRegister { id: string; title: string; }
interface FhiTable { tableId: number; title: string; }

async function fhiSearch(src: DataSource, query: string, f: typeof fetch): Promise<CatalogHit[]> {
  const registersRes = await f(new URL("Common/source", src.base_url).toString());
  if (!registersRes.ok) throw new Error(`fhi registerliste feilet: HTTP ${registersRes.status}`);
  const registers = await registersRes.json() as FhiRegister[];
  const q = query.toLowerCase();
  const hits: CatalogHit[] = [];
  for (const reg of registers) {
    const tablesRes = await f(new URL(`${reg.id}/table`, src.base_url).toString());
    if (!tablesRes.ok) continue; // ett register feiler ikke søket i de andre
    const tables = await tablesRes.json() as FhiTable[];
    for (const t of tables) {
      if (t.title.toLowerCase().includes(q)) {
        hits.push({
          source: src.id,
          id: `${reg.id}/${t.tableId}`,
          title: t.title,
          url: new URL(`${reg.id}/table/${t.tableId}/data`, src.base_url).toString(),
        });
        if (hits.length >= MAX_HITS) return hits;
      }
    }
  }
  return hits;
}

interface DstTable { id: string; text: string; }

async function dstSearch(src: DataSource, query: string, f: typeof fetch): Promise<CatalogHit[]> {
  const res = await f(new URL("tables?format=JSON", src.base_url).toString());
  if (!res.ok) throw new Error(`dst tabelliste feilet: HTTP ${res.status}`);
  const tables = await res.json() as DstTable[];
  const q = query.toLowerCase();
  return tables
    .filter((t) => t.text.toLowerCase().includes(q))
    .slice(0, MAX_HITS)
    .map((t) => ({
      source: src.id,
      id: t.id,
      title: t.text,
      url: new URL(`data/${t.id}/CSV`, src.base_url).toString(),
    }));
}

interface StatfinEntry { id: string; type: string; text: string; }

const MAX_FOLDER_FETCHES = 50; // hardt tak — unngå å hamre StatFin på brede søk

async function statfinSearch(src: DataSource, query: string, f: typeof fetch): Promise<CatalogHit[]> {
  const q = query.toLowerCase();
  const hits: CatalogHit[] = [];
  let folderFetches = 0;
  async function walk(path: string): Promise<void> {
    if (hits.length >= MAX_HITS || folderFetches >= MAX_FOLDER_FETCHES) return;
    folderFetches++;
    const res = await f(new URL(path, src.base_url).toString());
    if (!res.ok) {
      if (path === "") throw new Error(`statfin mappeliste feilet: HTTP ${res.status}`);
      return; // én feilet undermappe stopper ikke resten av søket
    }
    const entries = await res.json() as StatfinEntry[];
    for (const e of entries) {
      if (hits.length >= MAX_HITS) return;
      if (e.type === "t" && e.text.toLowerCase().includes(q)) {
        hits.push({
          source: src.id,
          id: `${path}${e.id}`,
          title: e.text,
          url: new URL(`${path}${e.id}`, src.base_url).toString(),
        });
      } else if (e.type === "l" && folderFetches < MAX_FOLDER_FETCHES) {
        await walk(`${path}${e.id}/`);
      }
    }
  }
  await walk("");
  return hits;
}

function sdmxStructureBase(baseUrl: string): string {
  // base_url peker på data-endepunktet (f.eks. .../api/data/); strukturroten
  // er et søsken-nivå — strip siste "data/"-segment. Verifisert 2026-07-25
  // for norgesbank og oecd.
  return baseUrl.replace(/data\/$/, "");
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function xmlText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"] ?? "");
  }
  return "";
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// Verifisert 2026-07-25 (live smoke-test, oppdaget FØR push): OECDs
// strukturendepunkt (særlig ?references=all) svarer 500 "languageTag1" på
// Denos fetch UTEN en eksplisitt Accept-Language-header — curl sender én
// implisitt og feilen var derfor usynlig under research-fasen. Sendes alltid
// (også for norgesbank, der den er harmløs) for å unngå denne fellen.

async function sdmxSearch(src: DataSource, query: string, f: typeof fetch): Promise<CatalogHit[]> {
  const accept = SDMX_STRUCTURE_ACCEPT[src.id];
  if (!accept) {
    if (SDMX_XML_SOURCES.has(src.id)) return ecbSearch(src, query, f);
    throw new Error(`sdmx-strukturspørringer er ikke støttet for '${src.id}' ennå (kun XML) — bruk web_search + probe`);
  }
  const url = `${sdmxStructureBase(src.base_url)}dataflow/all/all/latest?references=none`;
  const res = await f(url, { headers: { Accept: accept, "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`sdmx dataflow-liste for ${src.id} feilet: HTTP ${res.status}`);
  const json = await res.json();
  const flows = (json?.data?.dataflows ?? []) as Record<string, unknown>[];
  // Ordbasert scoring (2026-08-01): frase-substring ga 0 treff for naturlige
  // flerords-spørringer («health spending»-klassen) — samme modell som
  // worldbankSearch. Id-en er flowRef-en på KOMMA-form (<agency>,<flow>) —
  // det read() faktisk tar; slash-formen 404-er hos OECD (målt live).
  return rankFlows(flows, query, (d) => String(d.name ?? "")).map((d) => ({
    source: src.id,
    id: `${d.agencyID},${d.id}`,
    title: String(d.name ?? ""),
    url: new URL(`${d.agencyID},${d.id}`, src.base_url).toString(),
  }));
}

function rankFlows(
  flows: Record<string, unknown>[],
  query: string,
  name: (d: Record<string, unknown>) => string,
): Record<string, unknown>[] {
  const words = queryWords(query);
  const q = query.trim().toLowerCase();
  // Kortords-spørringer («ai»): queryWords filtrerer alt bort — fall tilbake
  // til hel-frase-substring i stedet for å returnere blankt.
  const score = (d: Record<string, unknown>) =>
    words.length ? scoreSubstring(name(d), words) : (name(d).toLowerCase().includes(q) ? 1 : 0);
  return flows
    .map((d) => ({ d, s: score(d) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, MAX_HITS)
    .map(({ d }) => d);
}

async function ecbSearch(src: DataSource, query: string, f: typeof fetch): Promise<CatalogHit[]> {
  const url = `${sdmxStructureBase(src.base_url)}dataflow/all/all/latest?references=none`;
  const res = await f(url, { headers: { Accept: "application/xml" } });
  if (!res.ok) throw new Error(`sdmx (xml) dataflow-liste for ${src.id} feilet: HTTP ${res.status}`);
  const xml = await res.text();
  const doc = xmlParser.parse(xml);
  const flows = asArray(doc?.["mes:Structure"]?.["mes:Structures"]?.["str:Dataflows"]?.["str:Dataflow"]) as Record<string, unknown>[];
  return rankFlows(flows, query, (d) => xmlText(d["com:Name"])).map((d) => ({
    source: src.id,
    id: `${d.agencyID},${d.id}`,
    title: xmlText(d["com:Name"]),
    url: new URL(`${d.agencyID},${d.id}`, src.base_url).toString(),
  }));
}
