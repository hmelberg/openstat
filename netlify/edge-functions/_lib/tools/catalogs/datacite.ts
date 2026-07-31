import type { DatasetHit } from "./static-catalog.ts";

const MAX = 8;

export async function dataciteSearch(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetHit[]> {
  const url = `https://api.datacite.org/dois?query=${encodeURIComponent(query)}` +
    `&resource-type-id=dataset&page%5Bsize%5D=${MAX}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`datacite-søk ${resp.status}`);
  const json = await resp.json();
  const rows = (json?.data ?? []) as { id: string; attributes: Record<string, unknown> }[];
  return rows.map((r) => {
    const a = r.attributes ?? {};
    const titles = (a.titles as { title?: string }[] | undefined) ?? [];
    const landing = typeof a.url === "string" && a.url ? a.url : `https://doi.org/${r.id}`;
    return {
      source: "datacite",
      id: r.id,
      title: titles[0]?.title ?? r.id,
      description: [a.publisher, a.publicationYear].filter(Boolean).join(", ") || undefined,
      time: a.publicationYear ? String(a.publicationYear) : undefined,
      access: "landing-page" as const,
      url: landing,
      how_to_read:
        `Forskningsdatasett (DOI ${r.id}) — IKKE direkte lastbart: web_fetch/probe landingssiden ${landing} for å finne fil-URL og kodebok; probe-✅ kreves før bruk`,
    };
  });
}
