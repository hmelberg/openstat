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
  // Endret 2026-08-01: dimensjoner er en LISTE med kode + navn + verdikoder
  // (før: {etikett: antall}, som ikke kunne brukes til å bygge filters=).
  const dims = m.dimensjoner as {
    kode: string; navn: string; antall_verdier: number; verdier: { code: string; label: string }[];
  }[];
  const byNavn = Object.fromEntries(dims.map((d) => [d.navn, d]));
  assertEquals(byNavn["Reference area"].antall_verdier, 3);
  assertEquals(byNavn["Sex"].antall_verdier, 3);
  assertEquals(byNavn["Age"].antall_verdier, 3);
  assertEquals(byNavn["Sex"].verdier.length, 3);
  assert(byNavn["Sex"].kode.length > 0, "dimensjonskoden skal være med");
  assert(String(m.lesing).includes('dbnomics.read("OECD/DSD_EAG_LSO_EA@DF_LSO_NEAC_ALL'));
  assert(String(m.lesing).includes("filters="), "lesing-hintet skal vise filters=-veien");
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

Deno.test("dbnomicsMetadata: find= søker fram verdikoder i lange lister", async () => {
  // Målt i live smoke-test 2026-08-01: weo-country har 196 verdier, så NOR
  // faller utenfor 40-taket og modellen kan ikke bygge filters=. Samme
  // find-semantikk som pxweb/sdmx (table-metadata.ts pickValues): korte
  // lister returneres komplette selv med find.
  const mange = Object.fromEntries(
    Array.from({ length: 196 }, (_, i) => [`C${String(i).padStart(3, "0")}`, `Land ${i}`]),
  );
  mange["NOR"] = "Norway";
  const f = (() => Promise.resolve(new Response(JSON.stringify({
    datasets: { docs: [{
      code: "WEO", name: "WEO", provider_code: "IMF",
      dimensions_codes_order: ["weo-country", "freq"],
      dimensions_labels: { "weo-country": "Country", freq: "Frequency" },
      dimensions_values_labels: { "weo-country": mange, freq: { A: "Annual" } },
    }] },
  }), { status: 200 }))) as unknown as typeof fetch;

  const m = await dbnomicsMetadata("IMF/WEO", f, "norway") as Record<string, unknown>;
  const dims = m.dimensjoner as { kode: string; verdier: { code: string; label: string }[] }[];
  const land = dims.find((d) => d.kode === "weo-country")!;
  assertEquals(land.verdier.some((v) => v.code === "NOR"), true, "find skal grave fram NOR");
  // Kort liste tømmes ikke av find (ellers mister modellen obligatoriske koder)
  assertEquals(dims.find((d) => d.kode === "freq")!.verdier.length, 1);
});
