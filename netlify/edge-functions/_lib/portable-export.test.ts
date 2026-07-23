import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";

for (const f of ["data-directives.js", "portable-export.js"]) {
  (0, eval)(await Deno.readTextFile(new URL(`../../../js/${f}`, import.meta.url)));
}
// deno-lint-ignore no-explicit-any
const PE = (globalThis as any).PortableExport;

Deno.test("passthrough: script uten direktiver er byte-identisk", () => {
  const s = "import pandas as pd\nprint('hei')\n";
  const out = PE.transpile(s, "python", []);
  assertEquals(out.code, s);
  assertEquals(out.warnings, []);
});

Deno.test("GET csv: direkte URL → pd.read_csv, original som kommentar, header + import lagt til", () => {
  const s = "# load https://ourworldindata.org/grapher/life-expectancy.csv as co2\nprint(co2.head())\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes("Portabel eksport fra OpenStat")) throw new Error("mangler header:\n" + out.code);
  if (!out.code.includes("import pandas as pd")) throw new Error("mangler pandas-import");
  if (!out.code.includes('# load https://ourworldindata.org/grapher/life-expectancy.csv as co2')) {
    throw new Error("originaldirektivet mangler som kommentar");
  }
  if (!out.code.includes('co2 = pd.read_csv("https://ourworldindata.org/grapher/life-expectancy.csv", sep=None, engine="python")')) {
    throw new Error("feil emisjon:\n" + out.code);
  }
  assertEquals(out.warnings, []);
});

Deno.test("proxy-utpakking: /api/hent?url=<enc> → indre URL", () => {
  const inner = "https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?valueCodes[Kjonn]=0&outputFormat=csv";
  const s = "# load /api/hent?url=" + encodeURIComponent(inner) + " as ledighet\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes(`ledighet = pd.read_csv(${JSON.stringify(inner)}, sep=None, engine="python")`)) {
    throw new Error("indre URL ikke pakket ut:\n" + out.code);
  }
  if (out.code.includes("/api/hent")) {
    // originaldirektivet (kommentaren) FÅR inneholde /api/hent — men emisjonslinjen skal ikke
    const emitted = out.code.split("\n").filter((l: string) => l.includes("pd.read_csv"));
    if (emitted.some((l: string) => l.includes("/api/hent"))) throw new Error("proxy-URL i emisjon");
  }
});

Deno.test("POST-reversering: &body= → requests.post + json.loads", () => {
  const inner = "https://statfin.stat.fi/PXWeb/api/v1/en/StatFin/tyokay/tabell.px";
  const body = JSON.stringify({ query: [], response: { format: "csv" } });
  const s = "# load /api/hent?url=" + encodeURIComponent(inner) + "&body=" + encodeURIComponent(body) + " as syss\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes("requests.post(")) throw new Error("mangler requests.post:\n" + out.code);
  if (!out.code.includes("json.loads(r'''" + body + "''')")) throw new Error("body ikke inlinet via json.loads");
  if (!out.code.includes("io.StringIO(")) throw new Error("csv-respons skal leses via io.StringIO");
  for (const imp of ["import requests", "import io", "import json"]) {
    if (!out.code.includes(imp)) throw new Error("mangler " + imp);
  }
});

Deno.test("kind(json) → .json()-emisjon m/ rå-JSON-kommentar", () => {
  const s = "# load https://api.worldbank.org/v2/country/NO/indicator/X?format=json as wb, kind(json)\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes('wb = requests.get("https://api.worldbank.org/v2/country/NO/indicator/X?format=json").json()')) {
    throw new Error("feil json-emisjon:\n" + out.code);
  }
});

Deno.test("connect + register-id løses via registry; cors:false-kilde blir DIREKTE URL", () => {
  const REG = [{ id: "ssb", navn: "SSB", utgiver: "SSB", tillit: "offisiell", tilgang: "pxweb",
    base_url: "https://data.ssb.no/api/pxwebapi/v2-beta/", cors: false }];
  const s = "# connect ssb\n# load ssb/tables/05839/metadata as meta, kind(json)\n";
  const out = PE.transpile(s, "python", REG);
  if (!out.code.includes('meta = requests.get("https://data.ssb.no/api/pxwebapi/v2-beta/tables/05839/metadata").json()')) {
    throw new Error("registry-oppløsning feilet:\n" + out.code);
  }
});

Deno.test("parquet og csv-default: endelse styrer; ukjent endelse → csv + warning", () => {
  const s = "# load https://x.example/data.parquet as p\n# load https://x.example/api/rows as r\n";
  const out = PE.transpile(s, "python", []);
  if (!out.code.includes('p = pd.read_parquet("https://x.example/data.parquet")')) throw new Error("parquet-emisjon mangler");
  if (!out.code.includes('r = pd.read_csv("https://x.example/api/rows", sep=None, engine="python")')) throw new Error("csv-default mangler");
  if (!out.warnings.some((w: string) => w.includes("r"))) throw new Error("mangler csv-default-warning: " + JSON.stringify(out.warnings));
});

Deno.test("import-dedup: eksisterende 'import pandas as pd' dupliseres ikke", () => {
  const s = "import pandas as pd\n# load https://x.example/d.csv as df\n";
  const out = PE.transpile(s, "python", []);
  const count = (out.code.match(/^import pandas as pd$/gm) || []).length;
  assertEquals(count, 1);
});

Deno.test("direktivfeil → Error('Direktivfeil: …')", () => {
  assertThrows(() => PE.transpile("# load ukjent/tab as x\n", "python", []), Error, "Direktivfeil");
});

Deno.test("ukjent mode → Error", () => {
  assertThrows(() => PE.transpile("print(1)", "duckdb", []), Error);
});
