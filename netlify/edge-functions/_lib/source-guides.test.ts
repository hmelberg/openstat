import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { makeGuideAttacher } from "./source-guides.ts";

function fakeFetch(status: number, body: string): typeof fetch {
  let calls = 0;
  const f = ((_u: string) => { calls++; return Promise.resolve(new Response(body, { status })); }) as typeof fetch;
  (f as unknown as { calls: () => number }).calls = () => calls;
  return f;
}

Deno.test("attach: guide første gang, IKKE andre gang; én fetch totalt", async () => {
  const f = fakeFetch(200, "# SSB-guide");
  const attach = makeGuideAttacher("https://app.example", f);
  const r1: Record<string, unknown> = {};
  const r2: Record<string, unknown> = {};
  await attach("ssb", r1);
  await attach("ssb", r2);
  assertEquals(r1.guide, "# SSB-guide");
  assertEquals(r2.guide, undefined);
  assertEquals((f as unknown as { calls: () => number }).calls(), 1);
});

Deno.test("attach: 404 → stille no-op, resultatet urørt", async () => {
  const attach = makeGuideAttacher("https://app.example", fakeFetch(404, ""));
  const r: Record<string, unknown> = { hits: [] };
  await attach("oecd", r);
  assertEquals(r.guide, undefined);
  assert("hits" in r);
});
