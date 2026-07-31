import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dataeuropaSearch } from "./dataeuropa.ts";

function respWith(results: unknown[]): typeof fetch {
  return (() => Promise.resolve(new Response(JSON.stringify({ result: { results, count: results.length } }), { status: 200 }))) as unknown as typeof fetch;
}

Deno.test("dataeuropaSearch: engelsk tittel foretrekkes, distribusjon → open + url", async () => {
  const hits = await dataeuropaSearch("health", respWith([{
    id: "abc-123",
    title: { de: "Gesundheit", en: "Health spending" },
    description: { en: "Yearly spending." },
    country: { label: "Italy" },
    distributions: [{ format: { id: "CSV" }, access_url: ["https://x.it/d.csv"] }],
  }]));
  assertEquals(hits[0].title, "Health spending");
  assertEquals(hits[0].access, "open");
  assertEquals(hits[0].url, "https://x.it/d.csv");
  assertEquals(hits[0].geo, "Italy");
});

Deno.test("dataeuropaSearch: begge URL-er til stede → download_url foretrekkes (access_url er ofte en portalside, ikke en fil)", async () => {
  const hits = await dataeuropaSearch("health", respWith([{
    id: "abc-124",
    title: { en: "Health spending" },
    description: { en: "Yearly spending." },
    country: { label: "Italy" },
    distributions: [{
      format: { id: "CSV" },
      access_url: ["https://x.it/dataset-page"],
      download_url: ["https://x.it/d.csv"],
    }],
  }]));
  assertEquals(hits[0].access, "open");
  assertEquals(hits[0].url, "https://x.it/d.csv");
});

Deno.test("dataeuropaSearch: uten distribusjon → landing-page mot datasettsiden", async () => {
  const hits = await dataeuropaSearch("health", respWith([{
    id: "xyz-9", title: { fr: "Santé" }, description: {},
  }]));
  assertEquals(hits[0].title, "Santé");            // første språk når en mangler
  assertEquals(hits[0].access, "landing-page");
  assertEquals(hits[0].url, "https://data.europa.eu/data/datasets/xyz-9");
});
