// search_datasets: meta-søk med scope — parallell utvifting til kuraterte
// kataloger, kilde-diversifisert fletting. Spec 2026-07-30-oppdagelseslaget.
import { searchCatalog } from "./search-catalog.ts";
import type { DataSource } from "../registry.ts";
import type { DatasetHit } from "./catalogs/static-catalog.ts";
import { worldbankSearch } from "./catalogs/worldbank.ts";
import { eurostatSearch } from "./catalogs/eurostat.ts";
import { dbnomicsSearch } from "./catalogs/dbnomics.ts";
import { dataciteSearch } from "./catalogs/datacite.ts";
import { dataeuropaSearch } from "./catalogs/dataeuropa.ts";

export type SearchScope = "stats" | "research" | "all";

export interface SearchDatasetsResult {
  hits: DatasetHit[];
  failed: string[];
  scope: SearchScope;
  query: string;
}

export const CATALOG_TIMEOUT_MS = 2_500;
export const MAX_PER_CATALOG = 4;
export const MAX_TOTAL = 15;

export function coerceScope(s: unknown): SearchScope {
  return s === "research" || s === "all" ? s : "stats";
}

interface Deps {
  registry: DataSource[];
  origin: string;
  fetchImpl?: typeof fetch;
  _catalogsForTest?: Record<string, () => Promise<DatasetHit[]>>;
  _timeoutMs?: number;
}

// Gjenbruk av eksisterende enkeltkilde-søk: CatalogHit → DatasetHit.
function viaSearchCatalog(
  sourceId: string,
  query: string,
  deps: Deps,
  howToRead: (id: string) => string,
): () => Promise<DatasetHit[]> {
  return async () => {
    const hits = await searchCatalog(sourceId, query, {
      registry: deps.registry, origin: deps.origin, fetchImpl: deps.fetchImpl,
    });
    return hits.slice(0, MAX_PER_CATALOG).map((h) => ({
      source: h.source, id: h.id, title: h.title,
      time: h.period || undefined, access: "open" as const,
      url: h.url || undefined, how_to_read: howToRead(h.id),
    }));
  };
}

function buildCatalogs(query: string, scope: SearchScope, deps: Deps): Record<string, () => Promise<DatasetHit[]>> {
  const f = deps.fetchImpl ?? fetch;
  const stats: Record<string, () => Promise<DatasetHit[]>> = {
    ssb: viaSearchCatalog("ssb", query, deps, (id) =>
      `table_metadata('ssb', '${id}') → # s = ssb.read("${id}", years=…)`),
    worldbank: () => worldbankSearch(query, deps.origin, f),
    eurostat: () => eurostatSearch(query, deps.origin, f),
    dbnomics: () => dbnomicsSearch(query, f),
    oecd: viaSearchCatalog("oecd", query, deps, (id) =>
      `table_metadata('oecd', '${id}') → # o = oecd.read("${id}", years=…, countries=…)`),
    apd: viaSearchCatalog("apd", query, deps, () => `probe URL-en fra treffet før bruk`),
  };
  const research: Record<string, () => Promise<DatasetHit[]>> = {
    datacite: () => dataciteSearch(query, f),
    dataeuropa: () => dataeuropaSearch(query, f),
  };
  if (scope === "stats") return stats;
  if (scope === "research") return research;
  return { ...stats, ...research };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export async function searchDatasets(
  query: string,
  scope: SearchScope,
  deps: Deps,
): Promise<SearchDatasetsResult> {
  const catalogs = deps._catalogsForTest ?? buildCatalogs(query, scope, deps);
  const timeoutMs = deps._timeoutMs ?? CATALOG_TIMEOUT_MS;
  const names = Object.keys(catalogs);
  const settled = await Promise.allSettled(
    names.map((n) => withTimeout(catalogs[n](), timeoutMs)),
  );
  const failed: string[] = [];
  const perCatalog: DatasetHit[][] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") perCatalog.push(s.value.slice(0, MAX_PER_CATALOG));
    else failed.push(names[i]);
  });
  // Round-robin-fletting: bevarer hver katalogs egen rangering, sprer kilder.
  const hits: DatasetHit[] = [];
  for (let round = 0; hits.length < MAX_TOTAL; round++) {
    let any = false;
    for (const list of perCatalog) {
      if (round < list.length && hits.length < MAX_TOTAL) {
        hits.push(list[round]);
        any = true;
      }
    }
    if (!any) break;
  }
  return { hits, failed, scope, query };
}
