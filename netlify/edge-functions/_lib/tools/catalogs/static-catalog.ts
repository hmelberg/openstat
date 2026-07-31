// Felles for statiske, forhåndshøstede kataloger (apd-mønsteret): filene
// ligger i data/ på appens eget origin og caches per modul-instans.
export interface DatasetHit {
  source: string;
  id: string;
  title: string;
  description?: string;
  time?: string;
  geo?: string;
  access: "open" | "landing-page" | "restricted" | "key-required";
  how_to_read: string;
  url?: string;
}

const cache = new Map<string, unknown>();

export function clearStaticCatalogCache(): void {
  cache.clear();
}

export async function loadStaticCatalog<T>(
  origin: string,
  path: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const key = `${origin}${path}`;
  if (cache.has(key)) return cache.get(key) as T;
  const resp = await fetchImpl(key);
  if (!resp.ok) throw new Error(`katalogfil utilgjengelig: ${path} (${resp.status})`);
  const data = await resp.json() as T;
  cache.set(key, data);
  return data;
}

// Enkel relevans: antall query-ord (≥3 tegn) som substring-matcher.
export function scoreSubstring(hay: string, qWords: string[]): number {
  const h = hay.toLowerCase();
  return qWords.reduce((n, w) => n + (h.includes(w) ? 1 : 0), 0);
}

export function queryWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3);
}
