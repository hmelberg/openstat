// Tests for mapToMetaInfo — pure mapping from a registry entry (+ optional
// TableMeta) to the MetaInfo JSON shape. Spec §1 (form) + §4 (endpoint
// rules): docs/superpowers/specs/2026-07-25-metadata-sidebar-design.md.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseRegistry } from "./registry.ts";
import { isValidTableId, mapToMetaInfo } from "./meta-info-map.ts";
import type { TableMeta } from "./tools/table-metadata.ts";

const REG = parseRegistry([
  {
    id: "ssb",
    navn: "SSB PxWebApi",
    utgiver: "Statistisk sentralbyrå",
    tillit: "offisiell",
    tilgang: "pxweb",
    base_url: "https://data.ssb.no/api/pxwebapi/v2-beta/",
    cors: true,
  },
]);
const SRC = REG[0];

Deno.test("mapToMetaInfo uten TableMeta: felter Utgiver/Tillit + lenke Kilde->base_url, tittel=kildens navn", () => {
  const mi = mapToMetaInfo(SRC, null);
  assertEquals(mi.tittel, "SSB PxWebApi");
  assertEquals(mi.felter, [
    { label: "Utgiver", verdi: "Statistisk sentralbyrå" },
    { label: "Tillit", verdi: "offisiell" },
  ]);
  assertEquals(mi.lenker, [
    { label: "Kilde", url: "https://data.ssb.no/api/pxwebapi/v2-beta/" },
  ]);
  assertEquals(mi.variabler, []);
});

Deno.test("mapToMetaInfo med TableMeta: tittel fra tm.title, variabler mappet 1:1, time-flagg -> felt tid", () => {
  const tm: TableMeta = {
    source: "ssb",
    id: "05839",
    title: "05839: Arbeidsledige (AKU), etter kjønn og år",
    variables: [
      {
        code: "Kjonn",
        label: "kjønn",
        time: false,
        values: [{ code: "1", label: "Menn" }, { code: "2", label: "Kvinner" }],
        valuesTruncated: false,
      },
      {
        code: "Tid",
        label: "år",
        time: true,
        values: [],
        valuesTruncated: false,
      },
    ],
  };
  const mi = mapToMetaInfo(SRC, tm);
  assertEquals(mi.tittel, tm.title);
  // register-level felter/lenker still present alongside the table info
  assertEquals(mi.felter, [
    { label: "Utgiver", verdi: "Statistisk sentralbyrå" },
    { label: "Tillit", verdi: "offisiell" },
  ]);
  assertEquals(mi.lenker, [
    { label: "Kilde", url: "https://data.ssb.no/api/pxwebapi/v2-beta/" },
  ]);
  assertEquals(mi.variabler.length, 2);

  const kjonn = mi.variabler.find((v) => v.navn === "Kjonn")!;
  assertEquals(kjonn.label, "kjønn");
  assertEquals(kjonn.kodeliste, [
    { kode: "1", label: "Menn" },
    { kode: "2", label: "Kvinner" },
  ]);
  assertEquals(kjonn.tid, undefined);

  const tid = mi.variabler.find((v) => v.navn === "Tid")!;
  assertEquals(tid.label, "år");
  assertEquals(tid.tid, true);
  assertEquals(tid.kodeliste, []);
});

Deno.test("mapToMetaInfo med TableMeta: tom variables-liste er OK", () => {
  const tm: TableMeta = { source: "ssb", id: "x", title: "Tom tabell", variables: [] };
  const mi = mapToMetaInfo(SRC, tm);
  assertEquals(mi.tittel, "Tom tabell");
  assertEquals(mi.variabler, []);
});

// Federerte oppføringer (kind:"federated") har ingen base_url — mapToMetaInfo
// bygde tidligere lenker: [{label:"Kilde", url: undefined}] ubetinget, som
// JSON.stringify stille droppet (kontraktsbrudd mot MetaLenke.url: string).
const FED_SRC = parseRegistry([{
  id: "demo-federert", navn: "Demo: federert persontabell (3 deler)",
  utgiver: "openstat", tillit: "demo", tilgang: "fil",
  kind: "federated", partition: "horizontal", overlap: "none", cors: true,
  members: [
    { id: "nord", url: "data/federert/nord.parquet" },
    { id: "vest", url: "data/federert/vest.parquet" },
    { id: "sor", url: "data/federert/sor.parquet" },
  ],
}])[0];

Deno.test("mapToMetaInfo: federert kilde uten base_url gir ingen Kilde-lenke (aldri url:undefined i responsen)", () => {
  const mi = mapToMetaInfo(FED_SRC, null);
  assertEquals(mi.lenker, []);
  for (const l of mi.lenker) assertEquals(typeof l.url, "string");
  const json = JSON.stringify(mi);
  if (json.includes("undefined")) throw new Error("undefined lekker inn i JSON-responsen:\n" + json);
});

// isValidTableId — SSRF-gate for /api/metadata sin `table`-parameter (§4):
// må godta de reelle id-formene på tvers av adaptere, og avvise alt som kan
// overstyre src.base_url via new URL(tableId, base_url) i statfin-adapteren.
Deno.test("isValidTableId: godtar reelle id-former på tvers av adaptere", () => {
  assertEquals(isValidTableId("05839"), true); // ssb/pxweb
  assertEquals(isValidTableId("FOLK1A"), true); // dst
  assertEquals(isValidTableId("tyti/135y.px"), true); // statfin: slash + punktum
  assertEquals(isValidTableId("daar/754"), true); // fhi: register/tallId
  assertEquals(isValidTableId("DSD_LFS@DF_IALFS,1.0"), true); // sdmx-dataflow: @ , . -
  assertEquals(isValidTableId("EXR"), true); // sdmx: enkel id
});

Deno.test("isValidTableId: avviser SSRF-forsøk og andre ugyldige former", () => {
  assertEquals(isValidTableId("https://attacker.example/x"), false); // absolutt URL
  assertEquals(isValidTableId("//attacker.example/x"), false); // protokoll-relativ
  assertEquals(isValidTableId("../../etc"), false); // leading . + ".."
  assertEquals(isValidTableId("a b"), false); // whitespace
  assertEquals(isValidTableId("x?y=z"), false); // querystring-tegn
  assertEquals(isValidTableId("a".repeat(129)), false); // over 128 tegn
});
