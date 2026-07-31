import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clearStaticCatalogCache } from "./static-catalog.ts";
import { worldbankMetadata, worldbankSearch } from "./worldbank.ts";

const CATALOG = JSON.stringify({
  generated: "2026-07-30", count: 3,
  indicators: [
    { id: "SH.XPD.CHEX.GD.ZS", name: "Current health expenditure (% of GDP)", src: "WDI", note: "Level of current health expenditure as share of GDP." },
    { id: "SP.POP.TOTL", name: "Population, total", src: "WDI" },
    { id: "NY.GDP.MKTP.CD", name: "GDP (current US$)", src: "WDI", note: "health systems excluded obviously" },
  ],
});

function catalogFetch(): typeof fetch {
  return ((url: string) => {
    if (String(url).endsWith("/data/worldbank-catalog.json")) {
      return Promise.resolve(new Response(CATALOG, { status: 200 }));
    }
    return Promise.reject(new Error("uventet URL: " + url));
  }) as unknown as typeof fetch;
}

Deno.test("worldbankSearch: navn-treff foran note-treff, DatasetHit-form", async () => {
  clearStaticCatalogCache();
  const hits = await worldbankSearch("health expenditure", "https://app.test", catalogFetch());
  assertEquals(hits[0].id, "SH.XPD.CHEX.GD.ZS");           // begge ord i navnet
  assertEquals(hits[0].source, "worldbank");
  assertEquals(hits[0].access, "open");
  assert(hits[0].how_to_read.includes("worldbank.read"));
  assert(hits[0].how_to_read.includes("SH.XPD.CHEX.GD.ZS"));
  // NY.GDP… matcher bare "health" i note → med, men bak
  assert(hits.some((h) => h.id === "NY.GDP.MKTP.CD"));
  assert(!hits.some((h) => h.id === "SP.POP.TOTL"));        // null treff → ute
});

Deno.test("worldbankMetadata: henter per-indikator-detalj (verifisert API-form)", async () => {
  const f = (() => Promise.resolve(new Response(JSON.stringify([
    { page: 1 },
    [{ id: "SP.POP.TOTL", name: "Population, total", unit: "",
       source: { id: "2", value: "World Development Indicators" },
       sourceNote: "Total population is based on…", sourceOrganization: "UN" }],
  ]), { status: 200 }))) as unknown as typeof fetch;
  const m = await worldbankMetadata("SP.POP.TOTL", f);
  assertEquals(m.id, "SP.POP.TOTL");
  assertEquals(m.kilde, "World Development Indicators");
  assert(String(m.definisjon).startsWith("Total population"));
});
