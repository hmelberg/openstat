import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dbnomicsMetadata, dbnomicsSearch } from "./dbnomics.ts";

const HIT = { code: "DSD_EAG@DF_X", name: "Educational attainment", provider_code: "OECD", provider_name: "OECD", nb_series: 893103 };

function searchFetch(byQuery: Record<string, unknown[]>): typeof fetch {
  return ((url: string) => {
    const q = new URL(String(url)).searchParams.get("q") ?? "";
    const docs = byQuery[q] ?? [];
    return Promise.resolve(new Response(JSON.stringify({ results: { docs, num_found: docs.length } }), { status: 200 }));
  }) as unknown as typeof fetch;
}

Deno.test("dbnomicsSearch: DatasetHit-form med provider/kode-id", async () => {
  const hits = await dbnomicsSearch("unemployment", searchFetch({ unemployment: [HIT] }));
  assertEquals(hits[0].source, "dbnomics");
  assertEquals(hits[0].id, "OECD/DSD_EAG@DF_X");
  assert(hits[0].how_to_read.includes("dbnomics.read"));
  assert(String(hits[0].description).includes("893103") || String(hits[0].description).includes("893 103"));
});

Deno.test("dbnomicsSearch: flerords-null-treff prøver lengste ord (AND-fellen, målt 2026-07-30)", async () => {
  const hits = await dbnomicsSearch("unemployment nordic", searchFetch({
    "unemployment nordic": [], unemployment: [HIT],
  }));
  assertEquals(hits.length, 1);
});

// Fixture: trunkert/trimmet ekte respons fra
// curl -s "https://api.db.nomics.world/v22/datasets/OECD/DSD_EAG_LSO_EA@DF_LSO_NEAC_ALL"
// (kjørt 2026-07-30). Ekte respons har 17 dimensjoner og opptil 339 verdier
// per dimensjon (AGE); trimmet her til 3 dimensjoner / få verdier hver for
// lesbarhet, men feltnavnene og nøstingen er de observerte.
const DATASET_FIXTURE = {
  _meta: { args: { limit: 50, offset: 0 }, version: "22.1.17" },
  datasets: {
    docs: [{
      code: "DSD_EAG_LSO_EA@DF_LSO_NEAC_ALL",
      name: "National Educational Attainment Classification (NEAC) and labour market status (full dataset)",
      provider_code: "OECD",
      provider_name: "Organisation for Economic Co-operation and Development",
      nb_series: 893103,
      discontinued: false,
      dimensions_codes_order: ["REF_AREA", "SEX", "AGE"],
      dimensions_labels: { REF_AREA: "Reference area", SEX: "Sex", AGE: "Age" },
      dimensions_values_labels: {
        REF_AREA: { AUS: "Australia", USA: "United States", NOR: "Norway" },
        SEX: { F: "Female", M: "Male", _T: "Total" },
        AGE: { BIRTH: "At birth", D29T60: "From 29 to 60 days", D91T365: "From 91 to 365 days" },
      },
    }],
    limit: 50,
    offset: 0,
    num_found: 1,
  },
};

Deno.test("dbnomicsMetadata: normaliserer datasets-endepunktets observerte form", async () => {
  const f = (() => Promise.resolve(new Response(JSON.stringify(DATASET_FIXTURE), { status: 200 }))) as unknown as typeof fetch;
  const m = await dbnomicsMetadata("OECD/DSD_EAG_LSO_EA@DF_LSO_NEAC_ALL", f);
  assertEquals(m.ref, "OECD/DSD_EAG_LSO_EA@DF_LSO_NEAC_ALL");
  assert(String(m.navn).includes("NEAC"));
  const dims = m.dimensjoner as Record<string, number>;
  assertEquals(dims["Reference area"], 3);
  assertEquals(dims["Sex"], 3);
  assertEquals(dims["Age"], 3);
  assert(String(m.lesing).includes('dbnomics.read("OECD/DSD_EAG_LSO_EA@DF_LSO_NEAC_ALL'));
});

Deno.test("dbnomicsMetadata: avviser '..' i provider/datasett uten å kalle fetch", async () => {
  const f = (() => {
    throw new Error("fetch skal ikke kalles");
  }) as unknown as typeof fetch;
  await assertRejects(() => dbnomicsMetadata("../x", f));
  await assertRejects(() => dbnomicsMetadata("OECD/..", f));
});

Deno.test("dbnomicsMetadata: tomt docs-treff kaster norsk feilmelding", async () => {
  const f = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ datasets: { docs: [], num_found: 0 } }), { status: 200 }),
    )) as unknown as typeof fetch;
  await assertRejects(() => dbnomicsMetadata("OECD/UKJENT", f));
});
