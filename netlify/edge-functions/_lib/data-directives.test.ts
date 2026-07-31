import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// js/data-directives.js is a plain browser script: evaluate it and read the global.
// js/directive-parser.js owns the grammar and must be evaluated FIRST —
// data-directives.js calls global.DirectiveParser at parse time.
for (const f of ["directive-parser.js", "data-directives.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../../js/${f}`, import.meta.url)));
}
// deno-lint-ignore no-explicit-any
const DD = (globalThis as any).DataDirectives;

const REG = [
  { id: "ssb", base_url: "https://data.ssb.no/api/pxwebapi/v2-beta/", cors: true },
  { id: "fred", base_url: "https://api.stlouisfed.org/fred/", cors: false,
    auth: { type: "api_key", env: "FRED_API_KEY", plassering: "query:api_key" } },
];

// ENDRET I TASK 8 — to assertions falt bort med den pythonske syntaksen, og
// begge er RAPPORTERT som kontraktsbrudd i .superpowers/sdd/task-8-report.md:
//   1. «# require <navngitt kilde> as srv» (uten URL) ble bevisst UTELATT fra
//      p.loads av den gamle parseren, slik at maybeRunRemote kunne rute den til
//      serveren. Verbet `require` finnes ikke i den nye grammatikken
//      (OST_VERBS = connect|read|create|use), så formen har ingen etterfølger —
//      fixture-linja er derfor fjernet, ikke oversatt.
//   2. p.loads[].verb var «read»/«load»/«require»; den nye parse() setter alltid
//      verb: "read". Ingen produksjonskode leser feltet (kun testen gjorde det).
Deno.test("parse: connect + load + URL-lesing; comment markers #, --, //", () => {
  const script = [
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2-beta/tables")',
    '-- fred = ost.connect("fred")',
    '// co2 = ost.read("https://ourworldindata.org/grapher/co2.csv")',
    '# ledighet = ssb.read("05839/data?outputFormat=csv")',
    '# gammel = ost.read("https://x.example/gammel.csv")',
    "x = 1  # load ikke-et-direktiv",          // not at line start pattern -> ignored
  ].join("\n");
  const p = DD.parse(script);
  assertEquals(p.connects, [
    { target: "https://data.ssb.no/api/pxwebapi/v2-beta/tables", alias: "ssb", options: {} },
    { target: "fred", alias: "fred", options: {} },
  ]);
  assertEquals(p.loads.map((l: { alias: string }) => l.alias), ["co2", "ledighet", "gammel"]);
  assertEquals(p.loads[2].target, "https://x.example/gammel.csv");
});

Deno.test("resolve: alias expansion, registry id, proxy flags", () => {
  const script = [
    '# ssb = ost.connect("https://data.ssb.no/api/pxwebapi/v2-beta/")',
    '# fred = ost.connect("fred")',
    '# ledighet = ssb.read("tables/05839/data?outputFormat=csv")',
    '# us = fred.read("series/observations?series_id=UNRATE&file_type=json")',
    '# co2 = ost.read("https://ourworldindata.org/grapher/co2.csv")',
    '# fi = ost.read("/api/hent?url=https%3A%2F%2Fstatfin.stat.fi%2Ft&body=%7B%7D")',
  ].join("\n");
  const r = DD.resolve(DD.parse(script), REG);
  assertEquals(r[0], {
    alias: "ledighet",
    url: "https://data.ssb.no/api/pxwebapi/v2-beta/tables/05839/data?outputFormat=csv",
    viaProxy: false,
    key: undefined,
    exec: undefined,
    kind: undefined,   // kind()-opsjonen (safestat-synk 23ad822) er alltid med i resolved form
    cache: undefined,  // cache()-opsjonen (2026-07-25) — samme mønster
  });
  assertEquals(r[1].viaProxy, true);   // fred: auth + no CORS
  assertEquals(r[1].url, "https://api.stlouisfed.org/fred/series/observations?series_id=UNRATE&file_type=json");
  assertEquals(r[2].viaProxy, false);
  assertEquals(r[3].viaProxy, true);   // explicit /api/hent
});

Deno.test("resolve: unknown alias errors; unknown registry id routes as named source", () => {
  const p = DD.parse('# x = ukjent.read("sti.csv")\n# finnesikke = ost.connect("finnesikke")');
  const r = DD.resolve(p, REG);
  if (!r[0].error) throw new Error("ventet feil for ukjent alias");
  // safestat-synk 23ad822 (spec §1 regel 3): et connect-navn utenfor
  // web-registeret er ikke lenger en resolve-feil — det rutes som navngitt
  // (Anvil-)kilde og feiler først i data-loader («ingen API-base
  // konfigurert») i denne offentlige liten-utgaven.
  const p2 = DD.parse('# fk = ost.connect("finnesikke")\n# y = fk.read("x.csv")');
  const r2 = DD.resolve(p2, REG);
  if (r2[0].error) throw new Error("ukjent register-id skal anvil-rutes, ikke feile: " + r2[0].error);
  assertEquals(r2[0].anvil, "finnesikke");
});

Deno.test("options: key() and exec() parse on connect and load", () => {
  const script = [
    '# h = ost.connect("helse2025", secret_key="ask")',
    '# k = ost.connect("kilde2", secret_key="qL7xK2mN9pR4sT6v", exec="remote")',
    '# df = ost.read("https://x.example/d.enc.json", secret_key="abcDEF123")',
  ].join("\n");
  const p = DD.parse(script);
  assertEquals(p.connects[0].options, { key: "ask" });
  assertEquals(p.connects[1].options, { key: "qL7xK2mN9pR4sT6v", exec: "remote" });
  assertEquals(p.loads[0].options, { key: "abcDEF123" });
});

Deno.test("resolve: bare name not in registry routes as named source, registry id still resolves", () => {
  const script = [
    '# h = ost.connect("helse2025", secret_key="ask")',
    "# df = h.read()",
    '# s = ost.connect("ssb")',
    '# t = s.read("tables")',
  ].join("\n");
  const r = DD.resolve(DD.parse(script), REG);
  // Samme anvil-ruting som testen over — key() fra connect-linja følger med.
  if (r[0].error) throw new Error("bart navn skal anvil-rutes, ikke feile: " + r[0].error);
  assertEquals(r[0].anvil, "helse2025");
  assertEquals(r[0].key, "ask");
  assertEquals(r[1].viaProxy, false);            // ssb stays a registry source
  if (r[1].error) throw new Error("registry-id skal fortsatt løses");
});

Deno.test("resolve: load-level key overrides connect-level key", () => {
  const p = DD.parse('# h = ost.connect("ssb", secret_key="K1")\n# df = h.read(secret_key="K2")');
  const r = DD.resolve(p, REG);
  assertEquals(r[0].key, "K2");
});

// ENDRET I TASK 8 (rapportert): maskeringsformatet er ikke lenger «key(***)».
// scrubKeys ble skrevet om i Task 5 til å treffe `secret_key=` — assertionen her
// pinnet formatet fra den GAMLE opsjonshalen, og testen var rød i baselinen
// (nøkkelen lekket rett gjennom fordi `key(` ikke lenger matches).
Deno.test("scrubKeys: literals masked, ask kept", () => {
  const s = '# h = ost.connect("x", secret_key="hemmelig123")\n# k = ost.connect("y", secret_key="ask")';
  const out = DD.scrubKeys(s);
  if (out.includes("hemmelig123")) throw new Error("nøkkel lekket");
  if (!out.includes('secret_key="***"')) throw new Error("mangler maskering");
  if (!out.includes('secret_key="ask"')) throw new Error('secret_key="ask" skal bevares');
});

Deno.test("parseAssembly: create-dataset + import + join + load", () => {
  const script = [
    '# p = ost.connect("people")',
    '# s = ost.connect("sales_src")',
    '# panel = ost.create(key="pid")',
    '# panel.add(p, ["income", "edu"])',
    '# panel.add(p, ["region"])',
    "# sales = s.read()",
    '# panel.join(sales, on="pid")',
  ].join("\n");
  const { spec, errors } = DD.parseAssembly(script);
  assertEquals(errors, []);
  assertEquals(spec.sources.sort(), ["p", "s"]);
  const panel = spec.datasets.find((d: {name: string}) => d.name === "panel");
  assertEquals(panel.key, ["pid"]);
  assertEquals(panel.steps.length, 3);
  assertEquals(panel.steps[0], {op: "import", source: "p", columns: ["income", "edu"], how: "left"});
  assertEquals(panel.steps[2], {op: "join", from: "sales", on: ["pid"], how: "left"});
  const sales = spec.datasets.find((d: {name: string}) => d.name === "sales");
  assertEquals(sales.load, "s");
});

Deno.test("parseAssembly: how override", () => {
  const { spec } = DD.parseAssembly(
    '# p = ost.connect("p")\n# d = ost.create(key="id")\n# d.add(p, ["x"], how="inner")');
  assertEquals(spec.datasets[0].steps[0].how, "inner");
});

Deno.test("parseAssembly: import into missing dataset errors", () => {
  const { errors } = DD.parseAssembly('# p = ost.connect("p")\n# ghost.add(p, ["x"])');
  if (!errors.some((e: string) => e.includes("ghost"))) throw new Error("ventet feil for ukjent datasett");
});

Deno.test("parseAssembly: inline-URL load is NOT assembly (stays on the old path)", () => {
  // Assembly sources must be connect'd; a bare `load <url> as df` is the
  // legacy web-data path, so parseAssembly ignores it (empty spec).
  const { spec, errors } = DD.parseAssembly('# df = ost.read("https://x.example/d.csv")');
  assertEquals(errors, []);
  assertEquals(spec.datasets, []);
  assertEquals(spec.sources, []);
});

Deno.test("meta-direktiv: tekst, lenke m/etikett, variabel-nivå, akkumulering", () => {
  const p = DD.parse([
    '# lonn = ost.read("https://x.example/lonn.csv")',
    '# meta.lonn.note = "Spørreundersøkelse om lønn, innsamlet 2024"',
    '# meta.lonn.link = {"https://x.example/skjema.pdf": "Spørreskjema"}',
    '# meta.lonn.alder.note = "Alder ved utgangen av inntektsåret"',
    '-- meta.lonn.alder.link = "https://x.example/kodebok#alder"',
  ].join("\n"));
  assertEquals(p.metas.length, 4);
  assertEquals(p.metas[0], { target: "lonn", variable: null, kind: "text",
    text: "Spørreundersøkelse om lønn, innsamlet 2024", url: undefined, label: undefined,
    line: '# meta.lonn.note = "Spørreundersøkelse om lønn, innsamlet 2024"' });
  assertEquals(p.metas[1].kind, "link");
  assertEquals(p.metas[1].url, "https://x.example/skjema.pdf");
  assertEquals(p.metas[1].label, "Spørreskjema");
  assertEquals(p.metas[2].target, "lonn");
  assertEquals(p.metas[2].variable, "alder");
  assertEquals(p.metas[3].kind, "link");
  assertEquals(p.metas[3].label, undefined); // ingen etikett etter URL
});

// ENDRET I TASK 8 (rapportert): den gamle regelen «alt etter FØRSTE punktum er
// variabelnavnet» ga variabelnavn med punktum i («d.a.b» → variabel «a.b»).
// Den nye grammatikken er posisjonell — meta.<datasett>.<variabel>.<nøkkel>,
// spec §3.1 — så et fjerde ledd er en feil, ikke et sammensatt variabelnavn.
// Variabelnavn med punktum kan derfor ikke lenger uttrykkes.
Deno.test("meta-direktiv: for dyp sti er feil, // og -- kommentartegn, tom linje ignoreres", () => {
  const p = DD.parse('// meta.d.a.b.note = "tekst her"\n# meta   \n# meta d');
  assertEquals(p.metas.length, 0);           // de to ufullstendige er prosa, ikke direktiver
  assertEquals(p.errors.length, 1);
  if (!p.errors[0].includes("for dyp")) throw new Error("ventet «for dyp meta-sti»: " + p.errors[0]);

  const ok = DD.parse('// meta.d.a.note = "tekst her"');
  assertEquals(ok.metas.length, 1);
  assertEquals(ok.metas[0].variable, "a");
});

Deno.test("federert: liste i ost.read og register-oppslag (spec 2026-07-31)", () => {
  const fedReg = [{ id: "demo-fed", kind: "federated", overlap: "possible",
    members: [{ id: "nord", url: "data/f/nord.parquet" }, { id: "vest", url: "data/f/vest.parquet" }] }];
  const p = DD.parse('# person = ost.read(["data/nord.parquet", "data/vest.parquet"])');
  assertEquals(p.errors, []);
  assertEquals(p.loads[0].members, [
    { id: "nord", url: "data/nord.parquet" },
    { id: "vest", url: "data/vest.parquet" },
  ]);
  const r = DD.resolve(DD.parse('# person = ost.read("demo-fed")'), fedReg);
  assertEquals(r[0].federated.length, 2);
  assertEquals(r[0].overlap, "possible");
});
