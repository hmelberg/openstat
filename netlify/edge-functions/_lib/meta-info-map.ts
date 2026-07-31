// _lib/meta-info-map.ts — pure mapping from a registry entry (+ optional
// TableMeta) to the MetaInfo JSON shape the sidebar consumes (js/meta-
// info.js) and /api/metadata produces. No fetch, no I/O — a data transform
// only, so it stays directly unit-testable and the endpoint itself is thin
// wiring. Spec: docs/superpowers/specs/2026-07-25-metadata-sidebar-design.md
//   §1 — MetaInfo-formen (tittel/beskrivelse/felter/lenker/variabler).
//   §4 — /api/metadata: register-nivå-info uten tabell, + tittel/variabler
//        fra TableMeta med tabell.
import type { DataSource } from "./registry.ts";
import type { TableMeta, TableVariable } from "./tools/table-metadata.ts";

export interface MetaFelt {
  label: string;
  verdi: string;
}

export interface MetaLenke {
  label: string;
  url: string;
}

export interface MetaKode {
  kode: string;
  label: string;
}

// variabler-formen speiler TableVariable bevisst (spec §1: "ett vokabular
// gjennom hele systemet") — code/label/values blir navn/label/kodeliste;
// TableVariable.time blir det norske flagget `tid` (satt kun når true).
export interface MetaVariabel {
  navn: string;
  label?: string;
  beskrivelse?: string;
  kodeliste?: MetaKode[];
  lenker?: MetaLenke[];
  tid?: boolean;
}

export interface MetaInfo {
  tittel?: string;
  beskrivelse?: string;
  felter: MetaFelt[];
  lenker: MetaLenke[];
  variabler: MetaVariabel[];
}

// isValidTableId: strukturell sjekk av `table`-parameteren til /api/metadata,
// FØR den når noen adapter. statfin-adapteren (tools/table-metadata.ts) bygger
// `new URL(tableId, src.base_url)` — en absolutt (`https://attacker.example/x`)
// eller protokoll-relativ (`//attacker.example/x`) id ville overstyrt
// vertsnavnet og gitt SSRF på et offentlig, uautentisert endepunkt. Første
// tegn må være alfanumerisk (blokkerer ledende / \ .); resten er begrenset
// til et tillatt tegnsett som dekker alle reelle id-former: pxweb ("05839"),
// dst ("FOLK1A"), statfin/fhi ("tyti/135y.px", "register/tallId" — slash og
// punktum), sdmx-dataflow-ider ("DSD_LFS@DF_IALFS,1.0" — @ , . - _). ":", "?",
// "#", "\" og whitespace/kontrolltegn er dermed alltid avvist (ikke i settet).
const TABLE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.@,-]*$/;
export function isValidTableId(s: string): boolean {
  if (!s || s.length > 128) return false;
  if (!TABLE_ID_RE.test(s)) return false;
  if (s.includes("..")) return false;
  return true;
}

function mapVariable(v: TableVariable): MetaVariabel {
  const out: MetaVariabel = {
    navn: v.code,
    label: v.label,
    kodeliste: v.values.map((c) => ({ kode: c.code, label: c.label })),
  };
  if (v.time) out.tid = true;
  return out;
}

/**
 * Registeroppføringen alene gir navn/utgiver/tillit/base_url — nok til en
 * kilde-nivå container uten nettverkskall utover selve registerlasten. En
 * TableMeta (fra tableMetadata(); null når kallet ikke ba om en spesifikk
 * tabell) legger til en mer presis tittel og variabellisten; felter/lenker
 * (register-nivå-fakta) er alltid med, uavhengig av tm.
 */
export function mapToMetaInfo(src: DataSource, tm: TableMeta | null): MetaInfo {
  // Federerte oppføringer (kind:"federated") mangler base_url med hensikt
  // (registry.ts: ikke søkbar, serveren ruter aldri dit) — bygg Kilde-lenken
  // kun når den finnes, ellers ville MetaLenke.url (påkrevd string) blitt
  // undefined og stille droppet av JSON.stringify.
  const lenker: MetaLenke[] = src.base_url ? [{ label: "Kilde", url: src.base_url }] : [];
  return {
    tittel: tm ? tm.title : src.navn,
    felter: [
      { label: "Utgiver", verdi: src.utgiver },
      { label: "Tillit", verdi: src.tillit },
    ],
    lenker,
    variabler: tm ? tm.variables.map(mapVariable) : [],
  };
}
