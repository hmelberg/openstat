import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

for (const f of ["data-directives.js", "data-loader.js", "enc-crypto.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../../js/${f}`, import.meta.url)));
}
// deno-lint-ignore no-explicit-any
const DL = (globalThis as any).DataLoader;

Deno.test("resolveAndFetchLoads: fetches, sniffs format, proxy fallback on CORS", async () => {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url + ((init?.headers as Record<string, string>)?.Authorization ? " [auth]" : ""));
    if (url.startsWith("https://blocked.example/")) return Promise.reject(new TypeError("CORS"));
    const body = url.includes("/api/hent?") ? "a;b\n1;2" : "x,y\n3,4";
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const script = [
    "# load https://open.example/d.csv as direkte",
    "# load https://blocked.example/d.csv as sperret",
  ].join("\n");
  const out = await DL.resolveAndFetchLoads(script, { fetchImpl, registry: [], authToken: "T" });
  assertEquals(out.loads.map((o: { alias: string; format: string }) => [o.alias, o.format]),
    [["direkte", "csv"], ["sperret", "csv"]]);
  assertEquals(out.remote, []);
  // blocked URL retried via proxy with auth header
  const proxyCall = calls.find((c) => c.includes("/api/hent?url=https%3A%2F%2Fblocked.example"));
  if (!proxyCall?.includes("[auth]")) throw new Error("proxy-fallback mangler auth: " + calls.join(" | "));
});

// NB (testisolasjon): js/data-loader.js har en modul-scoped byte-cache per
// resolved URL (_bufCache, «page reload is the reset, by design») — testene i
// denne fila deler prosess, så hver test MÅ bruke URL-er ingen tidligere test
// har lastet, ellers ser den cachede bytes og null fetch-kall. Cache-
// semantikken pinnes eksplisitt av testen nederst.

Deno.test("resolveAndFetchLoads: BYOK-nøkkel sendes som X-Anthropic-Key på proxy-kall når token mangler", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers as Record<string, string>) ?? {} });
    if (url.startsWith("https://blocked-byok.example/")) return Promise.reject(new TypeError("CORS"));
    return Promise.resolve(new Response("x,y\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const script = "# load https://blocked-byok.example/d.csv as sperret";
  await DL.resolveAndFetchLoads(script, { fetchImpl, registry: [], anthropicKey: "sk-ant-test123" });
  const proxy = calls.find((c) => c.url.includes("/api/hent?url="));
  if (!proxy) throw new Error("ingen proxy-kall: " + calls.map((c) => c.url).join(" | "));
  assertEquals(proxy.headers["X-Anthropic-Key"], "sk-ant-test123");
  assertEquals(proxy.headers["Authorization"], undefined);
});

Deno.test("resolveAndFetchLoads: innloggingstoken har forrang over BYOK-nøkkel", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return Promise.resolve(new Response("x,y\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const script = "# load /api/hent?url=https%3A%2F%2Fx.example%2Fd.csv as via";
  await DL.resolveAndFetchLoads(script, { fetchImpl, registry: [], authToken: "T", anthropicKey: "sk-ant-test123" });
  const proxy = calls.find((c) => c.url.includes("/api/hent?url="));
  if (!proxy) throw new Error("ingen proxy-kall");
  assertEquals(proxy.headers["Authorization"], "Bearer T");
  assertEquals(proxy.headers["X-Anthropic-Key"], undefined);
});

Deno.test("sniffFormat: content-type wins over URL", () => {
  const mk = (ct: string) => new Response("", { headers: { "content-type": ct } });
  assertEquals(DL._sniffFormat(mk("text/html; charset=utf-8"), "https://x/api"), "html");
  assertEquals(DL._sniffFormat(mk("application/json"), "https://x/d.csv"), "json");
  assertEquals(DL._sniffFormat(mk("text/csv"), "https://x/tabell?format=csv"), "csv");
});

// deno-lint-ignore no-explicit-any
const EC = (globalThis as any).EncCrypto;

function jsonResp(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

Deno.test("resolveAndFetchLoads: connect/load to an unregistered name errors", async () => {
  const fetchImpl = (() =>
    Promise.resolve(new Response("", { status: 200 }))) as typeof fetch;
  // Etter safestat-synk 23ad822 anvil-rutes ukjente navn i resolve; i den
  // offentlige liten-utgaven (ingen Anvil-API-base) feiler de her i stedet.
  await assertRejects(
    () => DL.resolveAndFetchLoads("# connect ukjent as u\n# load u as df",
      { fetchImpl, registry: [] }),
    Error, "ingen API-base konfigurert for kilden «ukjent»");
});

Deno.test("url envelope + key literal decrypts", async () => {
  const plain = new TextEncoder().encode("x,y\n9,8\n");
  const { envelope, key } = await EC.encryptBytes(plain, "csv");
  const fetchImpl = (() => Promise.resolve(jsonResp(envelope))) as typeof fetch;
  const out = await DL.resolveAndFetchLoads(
    `# load https://x.example/d.enc.json as df, key(${key})`,
    { fetchImpl, registry: [] });
  assertEquals(new TextDecoder().decode(out.loads[0].bytes), "x,y\n9,8\n");
});

Deno.test("envelope without key prompts via promptKey(ask)", async () => {
  const plain = new TextEncoder().encode("q\n1\n");
  const { envelope, key } = await EC.encryptBytes(plain, "csv");
  const fetchImpl = (() => Promise.resolve(jsonResp(envelope))) as typeof fetch;
  let asked = "";
  // Egen URL (d-ask.enc.json): testen over cachet alt bytes for d.enc.json —
  // samme URL her ville dekryptert FEIL envelope («feil nøkkel eller ødelagt fil»).
  const out = await DL.resolveAndFetchLoads(
    "# load https://x.example/d-ask.enc.json as df, key(ask)",
    { fetchImpl, registry: [], promptKey: (alias: string) => { asked = alias; return Promise.resolve(key); } });
  assertEquals(asked, "df");
  assertEquals(new TextDecoder().decode(out.loads[0].bytes), "q\n1\n");
});

Deno.test("byte-cache: samme URL hentes ikke på nytt i samme økt (page reload = reset)", async () => {
  let fetches = 0;
  const fetchImpl = (() => {
    fetches++;
    return Promise.resolve(new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const script = "# load https://cachetest.example/d.csv as df";
  await DL.resolveAndFetchLoads(script, { fetchImpl, registry: [] });
  const out = await DL.resolveAndFetchLoads(script, { fetchImpl, registry: [] });
  assertEquals(fetches, 1);   // andre kjøring traff _bufCache
  assertEquals(new TextDecoder().decode(out.loads[0].bytes), "a,b\n1,2");
});

Deno.test("resolveAndAssemble: fetches spec sources + returns spec", async () => {
  const fetchImpl = ((input: string | URL | Request) => {
    const url = String(input);
    const body = url.includes("people") ? "pid,income\n1,10\n2,20" : "pid,amount\n1,5";
    return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const script = [
    "# connect https://x.example/people.csv as p",
    "# connect https://x.example/sales.csv as s",
    "# create-dataset panel, key(pid)",
    "# import p/income into panel",
    "# load s as sales",
    "# join sales into panel on pid",
  ].join("\n");
  const out = await DL.resolveAndAssemble(script, { fetchImpl, registry: [] });
  assertEquals(out.remote, []);
  assertEquals(out.sources.map((x: {alias: string}) => x.alias).sort(), ["p", "s"]);
  assertEquals(out.spec.datasets.find((d: {name: string}) => d.name === "panel").key, "pid");
  const p = out.sources.find((x: {alias: string}) => x.alias === "p");
  assertEquals(new TextDecoder().decode(p.bytes), "pid,income\n1,10\n2,20");
});

const KAGGLE_REG = [{
  id: "kaggle", navn: "Kaggle", utgiver: "Kaggle", tillit: "etablert", tilgang: "rest",
  base_url: "https://www.kaggle.com/api/v1/", cors: false,
  auth: { type: "api_key", user: true, plassering: "basic" },
}];

Deno.test("data-loader: X-Source-Key settes på proxy-kall for user-auth-kilde", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return Promise.resolve(new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const inner = encodeURIComponent("https://www.kaggle.com/api/v1/datasets/download/own/slug/fil-a.csv");
  const script = "# load /api/hent?url=" + inner + " as kag";
  const keysApi = { get: (t: string) => (t === "kaggle" ? "bruker:K9" : "") };
  const out = await DL.resolveAndFetchLoads(script, { fetchImpl, registry: KAGGLE_REG, keysApi });
  assertEquals(out.loads[0].alias, "kag");
  const proxy = calls.find((c) => c.url.includes("/api/hent?url="));
  assertEquals(proxy?.headers["X-Source-Key"], "bruker:K9");
});

Deno.test("data-loader: manglende brukernøkkel → norsk feil før fetch", async () => {
  const calls: string[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.resolve(new Response("x", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const inner = encodeURIComponent("https://www.kaggle.com/api/v1/datasets/download/own/slug/fil-b.csv");
  const script = "# load /api/hent?url=" + inner + " as kag2";
  await assertRejects(
    () => DL.resolveAndFetchLoads(script, { fetchImpl, registry: KAGGLE_REG, keysApi: { get: () => "" } }),
    Error, "krever API-nøkkel",
  );
  assertEquals(calls.filter((c) => c.includes("kaggle")).length, 0);
});

Deno.test("data-loader: connect-basert user-auth-kilde rutes via proxy med nøkkel", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return Promise.resolve(new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const script = [
    "# connect kaggle",
    "# load kaggle/datasets/download/own/slug/fil-c.csv as kag3",
  ].join("\n");
  const keysApi = { get: (t: string) => (t === "kaggle" ? "bruker:K10" : "") };
  await DL.resolveAndFetchLoads(script, { fetchImpl, registry: KAGGLE_REG, keysApi });
  const proxy = calls.find((c) => c.url.includes("/api/hent?url="));
  if (!proxy) throw new Error("ingen proxy-kall: " + calls.map((c) => c.url).join(" | "));
  assertEquals(proxy.headers["X-Source-Key"], "bruker:K10");
});

Deno.test("data-loader: bar URL mot user-auth-kilde rutes via proxy (aldri direkte)", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return Promise.resolve(new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const script = "# load https://www.kaggle.com/api/v1/datasets/download/own/slug/fil-d.csv as kag4";
  const keysApi = { get: (t: string) => (t === "kaggle" ? "bruker:K11" : "") };
  await DL.resolveAndFetchLoads(script, { fetchImpl, registry: KAGGLE_REG, keysApi });
  assertEquals(calls.length, 1);
  if (!calls[0].url.includes("/api/hent?url=")) throw new Error("gikk ikke via proxy: " + calls[0].url);
  assertEquals(calls[0].headers["X-Source-Key"], "bruker:K11");
});

const KAGGLE_FRI_REG = [{
  id: "kagglefri", navn: "KaggleFri", utgiver: "K", tillit: "etablert", tilgang: "rest",
  base_url: "https://open.kagglefri.example/api/", cors: false,
  auth: { type: "api_key", user: true, valgfri: true, plassering: "basic" },
}];

Deno.test("data-loader: valgfri kilde uten nøkkel kaster ikke — via proxy uten X-Source-Key", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return Promise.resolve(new Response("a,b\n1,2", { status: 200, headers: { "content-type": "text/csv" } }));
  }) as typeof fetch;
  const inner = encodeURIComponent("https://open.kagglefri.example/api/fil-e.csv");
  const out = await DL.resolveAndFetchLoads("# load /api/hent?url=" + inner + " as fri",
    { fetchImpl, registry: KAGGLE_FRI_REG, keysApi: { get: () => "" } });
  assertEquals(out.loads[0].alias, "fri");
  const proxy = calls.find((c) => c.url.includes("/api/hent?url="));
  assertEquals(proxy?.headers["X-Source-Key"], undefined);
});
