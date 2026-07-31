import { type DatasetHit, loadStaticCatalog, queryWords, scoreSubstring } from "./static-catalog.ts";

interface EsCatalog {
  tables: { code: string; title: string; start: string; end: string }[];
}

const MAX = 8;

export async function eurostatSearch(
  query: string,
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetHit[]> {
  const cat = await loadStaticCatalog<EsCatalog>(origin, "/data/eurostat-catalog.json", fetchImpl);
  const words = queryWords(query);
  if (!words.length) return [];
  const scored = cat.tables
    .map((t) => ({ t, score: scoreSubstring(`${t.title} ${t.code}`, words) }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX).map(({ t }) => ({
    source: "eurostat",
    id: t.code,
    title: t.title,
    time: t.start && t.end ? `${t.start}–${t.end}` : undefined,
    geo: "EU/EFTA",
    access: "open",
    how_to_read:
      `# e = eurostat.read("${t.code}", filters={…}, years=…) — kildens egne parametre (geo, unit, …) i filters={}; probe før bruk`,
  }));
}
