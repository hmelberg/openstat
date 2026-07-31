import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { coerceScope, searchDatasets } from "./search-datasets.ts";
import type { DatasetHit } from "./catalogs/static-catalog.ts";

function hit(source: string, n: number): DatasetHit {
  return { source, id: `${source}-${n}`, title: `${source} treff ${n}`, access: "open", how_to_read: "x" };
}

Deno.test("coerceScope: ukjent → stats", () => {
  assertEquals(coerceScope("research"), "research");
  assertEquals(coerceScope("all"), "all");
  assertEquals(coerceScope("stat"), "stats");
  assertEquals(coerceScope(undefined), "stats");
});

Deno.test("searchDatasets: fletter m/diversitet (maks 4 per katalog, 15 totalt), failed-liste", async () => {
  const catalogs = {
    a: () => Promise.resolve([1, 2, 3, 4, 5, 6].map((n) => hit("a", n))),
    b: () => Promise.resolve([1, 2, 3].map((n) => hit("b", n))),
    c: () => Promise.reject(new Error("nede")),
    d: () => new Promise<DatasetHit[]>(() => {}),   // henger → timeout
  };
  const res = await searchDatasets("x", "stats", {
    registry: [], origin: "https://app.test",
    _catalogsForTest: catalogs, _timeoutMs: 50,
  } as never);
  assertEquals(res.failed.sort(), ["c", "d"]);
  assertEquals(res.hits.filter((h) => h.source === "a").length, 4);   // kappet fra 6
  assertEquals(res.hits.filter((h) => h.source === "b").length, 3);
  // Round-robin: første treff fra hver katalog kommer før andres andre-treff
  assertEquals(res.hits[0].id, "a-1");
  assertEquals(res.hits[1].id, "b-1");
  assert(res.hits.length <= 15);
});
