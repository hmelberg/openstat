import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { clearStaticCatalogCache } from "./static-catalog.ts";
import { eurostatSearch } from "./eurostat.ts";

const CATALOG = JSON.stringify({
  generated: "2026-07-30", count: 2,
  tables: [
    { code: "une_rt_m", title: "Unemployment by sex and age – monthly data", start: "1983", end: "2026" },
    { code: "nrg_pc_202", title: "Gas prices for household consumers", start: "2007", end: "2026" },
  ],
});

Deno.test("eurostatSearch: substring-treff, time-felt og kanonisk how_to_read", async () => {
  clearStaticCatalogCache();
  const f = (() => Promise.resolve(new Response(CATALOG, { status: 200 }))) as unknown as typeof fetch;
  const hits = await eurostatSearch("unemployment", "https://app.test", f);
  assertEquals(hits.length, 1);
  assertEquals(hits[0].id, "une_rt_m");
  assertEquals(hits[0].time, "1983–2026");
  assert(hits[0].how_to_read.includes('eurostat.read("une_rt_m"'));
});
