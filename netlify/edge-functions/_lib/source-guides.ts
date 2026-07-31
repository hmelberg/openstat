// Kildeguider (spec 2026-07-31-ssb-mandatory-variabler §fiks 4):
// skills-mønsteret internt — per-kilde-referanse levert i FØRSTE
// search_catalog-/table_metadata-svar for kilden, hentet som statisk
// asset fra egen origin (Deno Deploy bundler ikke .md ved kjøretid).
// Feil (404/nett) → stille no-op: verktøysvaret er ellers uendret.
const MAX_GUIDE_CHARS = 8_000;

export function makeGuideAttacher(origin: string, fetchImpl: typeof fetch = fetch) {
  const sent = new Set<string>();
  return async function attach(sourceId: string, result: Record<string, unknown>): Promise<void> {
    if (!sourceId || sent.has(sourceId)) return;
    sent.add(sourceId);   // også ved feil: ikke re-fetch en død guide i samme løp
    try {
      const res = await fetchImpl(`${origin}/data/source-guides/${sourceId}.md`);
      if (!res.ok) return;
      const text = (await res.text()).slice(0, MAX_GUIDE_CHARS);
      if (text.trim()) result.guide = text;
    } catch { /* stille — guiden er berikelse, aldri avhengighet */ }
  };
}
