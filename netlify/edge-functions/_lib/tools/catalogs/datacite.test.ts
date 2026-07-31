import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dataciteSearch } from "./datacite.ts";

Deno.test("dataciteSearch: landing-page-access og DOI-URL", async () => {
  const f = (() => Promise.resolve(new Response(JSON.stringify({
    data: [{ id: "10.18712/nsd-nsd3456-v2", attributes: {
      titles: [{ title: "Level of Living Survey on Working Conditions 2025" }],
      publisher: "Sikt", publicationYear: 2026,
      url: "https://surveybanken.sikt.no/study/NSD3456/2",
    } }], meta: { total: 7161 },
  }), { status: 200 }))) as unknown as typeof fetch;
  const hits = await dataciteSearch("health income survey", f);
  assertEquals(hits[0].source, "datacite");
  assertEquals(hits[0].access, "landing-page");
  assertEquals(hits[0].url, "https://surveybanken.sikt.no/study/NSD3456/2");
  assert(hits[0].how_to_read.includes("web_fetch") || hits[0].how_to_read.includes("probe"));
  assertEquals(hits[0].time, "2026");
});
