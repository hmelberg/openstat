import type { DatasetHit } from "./static-catalog.ts";

const SEARCH = "https://api.db.nomics.world/v22/search";
const MAX = 8;

interface DbnDoc { code: string; name: string; provider_code: string; provider_name: string; nb_series?: number }

async function runSearch(q: string, fetchImpl: typeof fetch): Promise<DbnDoc[]> {
  const resp = await fetchImpl(`${SEARCH}?q=${encodeURIComponent(q)}&limit=${MAX}`);
  if (!resp.ok) throw new Error(`dbnomics-søk ${resp.status}`);
  const json = await resp.json();
  return (json?.results?.docs ?? []) as DbnDoc[];
}

export async function dbnomicsSearch(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DatasetHit[]> {
  let docs = await runSearch(query, fetchImpl);
  // DBnomics-søk er AND over ordene og gir ofte 0 treff på flerords-spørringer
  // (målt 2026-07-30). Fall tilbake til det lengste ordet.
  const words = query.trim().split(/\s+/);
  if (!docs.length && words.length > 1) {
    const longest = words.sort((a, b) => b.length - a.length)[0];
    docs = await runSearch(longest, fetchImpl);
  }
  return docs.slice(0, MAX).map((d) => ({
    source: "dbnomics",
    id: `${d.provider_code}/${d.code}`,
    title: d.name,
    description: `${d.provider_name}${d.nb_series ? ` — ${d.nb_series} serier` : ""}`,
    access: "open",
    how_to_read:
      `table_metadata('dbnomics', '${d.provider_code}/${d.code}') → # d = dbnomics.read("${d.provider_code}/${d.code}/<serie-maske>") (maks 1000 serier per kall)`,
  }));
}

// Datasettstruktur — verifisert med curl (Task 3 Step 1, 2026-07-30):
// GET https://api.db.nomics.world/v22/datasets/<provider>/<datasett>
// → { datasets: { docs: [{ code, name, provider_code, provider_name, nb_series,
//       dimensions_codes_order: string[],
//       dimensions_labels: {DIM_CODE: "Lesbart navn"},
//       dimensions_values_labels: {DIM_CODE: {verdikode: "Lesbar verdi"}},
//       ... }], num_found } }
export async function dbnomicsMetadata(
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const [provider, ...rest] = ref.split("/");
  const dataset = rest.join("/");
  const providerTrim = (provider ?? "").trim();
  const datasetTrim = dataset.trim();
  // encodeURIComponent lar "." og ".." passere uendret — avvis eksplisitt for
  // å hindre en modell-styrt ref fra å bygge en path-traversal-URL.
  if (
    !providerTrim || !datasetTrim ||
    providerTrim.includes("..") || datasetTrim.includes("..")
  ) {
    throw new Error(`dbnomics-referanse skal være PROVIDER/DATASETT, fikk: ${ref}`);
  }
  const resp = await fetchImpl(
    `https://api.db.nomics.world/v22/datasets/${encodeURIComponent(providerTrim)}/${encodeURIComponent(datasetTrim)}`,
  );
  if (!resp.ok) throw new Error(`dbnomics metadata ${resp.status} for ${ref}`);
  const json = await resp.json();
  const doc = json?.datasets?.docs?.[0];
  if (!doc) {
    throw new Error(
      `dbnomics: fant ikke datasett "${ref}" — sjekk kode/provider fra søketreffets id (kilde: dbnomicsSearch)`,
    );
  }
  const codesOrder = (doc.dimensions_codes_order ?? []) as string[];
  const labels = (doc.dimensions_labels ?? {}) as Record<string, string>;
  const valuesLabels = (doc.dimensions_values_labels ?? {}) as Record<string, Record<string, string>>;
  const dimensjoner: Record<string, number> = {};
  for (const code of codesOrder) {
    const navn = labels[code] ?? code;
    dimensjoner[navn] = Object.keys(valuesLabels[code] ?? {}).length;
  }
  return {
    ref,
    navn: doc.name,
    dimensjoner,
    lesing: `# d = dbnomics.read("${ref}/<serie-maske>")`,
  };
}
