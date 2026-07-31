import { type DatasetHit, loadStaticCatalog, queryWords, scoreSubstring } from "./static-catalog.ts";

interface WbCatalog {
  indicators: { id: string; name: string; unit?: string; src?: string; note?: string }[];
}

const MAX = 8;

export async function worldbankSearch(
  query: string,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetHit[]> {
  const cat = await loadStaticCatalog<WbCatalog>(origin, "/data/worldbank-catalog.json", fetchImpl);
  const words = queryWords(query);
  if (!words.length) return [];
  const scored = cat.indicators.map((i) => ({
    i,
    nameScore: scoreSubstring(`${i.name} ${i.id}`, words),
    noteScore: scoreSubstring(i.note ?? "", words),
  })).filter((s) => s.nameScore > 0 || s.noteScore > 0);
  // Navn-treff foran note-treff; flere ord truffet foran færre.
  scored.sort((a, b) => (b.nameScore - a.nameScore) || (b.noteScore - a.noteScore));
  return scored.slice(0, MAX).map(({ i }) => ({
    source: "worldbank",
    id: i.id,
    title: i.name,
    description: [i.src, i.note].filter(Boolean).join(" — ") || undefined,
    geo: "global",
    access: "open",
    how_to_read:
      `table_metadata('worldbank', '${i.id}') → # x = worldbank.read("country/all/indicator/${i.id}")` +
      ` (land som ISO3 adskilt med ; i stedet for all; years= filtrerer)`,
  }));
}

// Per-indikator-detalj. Verifisert API-form 2026-07-30:
// [meta, [{id, name, unit, source:{value}, sourceNote, sourceOrganization}]]
export async function worldbankMetadata(
  indicatorId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const url = `https://api.worldbank.org/v2/indicator/${encodeURIComponent(indicatorId)}?format=json`;
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`worldbank metadata ${resp.status} for ${indicatorId}`);
  const json = await resp.json();
  const row = Array.isArray(json) && Array.isArray(json[1]) ? json[1][0] : null;
  if (!row) throw new Error(`ukjent worldbank-indikator: ${indicatorId}`);
  return {
    id: row.id,
    navn: row.name,
    enhet: row.unit || undefined,
    kilde: row.source?.value,
    definisjon: row.sourceNote,
    organisasjon: row.sourceOrganization,
    lesing: `# x = worldbank.read("country/all/indicator/${row.id}")`,
  };
}
