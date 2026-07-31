import type { DatasetHit } from "./static-catalog.ts";

const MAX = 8;

function pickLang(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  const v = o.en ?? Object.values(o)[0];
  return typeof v === "string" ? v : "";
}

export async function dataeuropaSearch(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetHit[]> {
  const url = `https://data.europa.eu/api/hub/search/search?q=${encodeURIComponent(query)}&limit=${MAX}`;
  const resp = await fetchImpl(url);
  if (!resp.ok) throw new Error(`data.europa.eu-søk ${resp.status}`);
  const json = await resp.json();
  const rows = (json?.result?.results ?? []) as Record<string, unknown>[];
  return rows.map((r) => {
    const dists = (r.distributions as Record<string, unknown>[] | undefined) ?? [];
    // download_url peker på selve filen; access_url er ofte en DCAT-portalside
    // (HTML), ikke en fil — prøv download_url først for å unngå å merke en
    // landingsside "open" med en pd.read_csv-hint mot HTML.
    const firstUrl = dists.map((d) =>
      (Array.isArray(d.download_url) ? d.download_url[0] : d.download_url) ??
      (Array.isArray(d.access_url) ? d.access_url[0] : d.access_url)
    ).find((u) => typeof u === "string" && u) as string | undefined;
    const country = (r.country as Record<string, unknown> | undefined)?.label;
    return {
      source: "dataeuropa",
      id: String(r.id ?? ""),
      title: pickLang(r.title) || String(r.id ?? ""),
      description: pickLang(r.description).slice(0, 200) || undefined,
      geo: typeof country === "string" ? country : undefined,
      access: firstUrl ? "open" as const : "landing-page" as const,
      url: firstUrl ?? `https://data.europa.eu/data/datasets/${r.id}`,
      how_to_read: firstUrl
        ? `probe ${firstUrl} — cors:true → vanlig pd.read_csv; ellers /api/hent-innpakning`
        : `Landingsside — web_fetch/probe https://data.europa.eu/data/datasets/${r.id} for å finne fil-URL`,
    };
  });
}
