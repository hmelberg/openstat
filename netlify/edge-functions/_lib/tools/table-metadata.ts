// table_metadata tool: variable-level lookup for a catalog hit, so the model
// can build a MINIMAL query URL (spec: build datasets from variables).
import { findSource, SDMX_STRUCTURE_ACCEPT, SDMX_XML_SOURCES, type DataSource } from "../registry.ts";
import { XMLParser } from "https://esm.sh/fast-xml-parser@4";
import { worldbankMetadata } from "./catalogs/worldbank.ts";
import { dbnomicsMetadata } from "./catalogs/dbnomics.ts";

export interface TableVariable {
  code: string;
  label: string;
  time: boolean;
  values: { code: string; label: string }[];
  valuesTruncated: boolean;
  // pxweb: fra extension.elimination === false (obligatorisk valg ved
  // filtrert spørring — SSB 400-er ellers, målt 2026-07-31). Utelates for
  // adaptere der metadataene ikke bærer informasjonen — aldri gjett.
  mandatory?: boolean;
}

export interface TableMeta {
  source: string;
  id: string;
  title: string;
  variables: TableVariable[];
  queryUrlTemplate?: string;
  // worldbank/dbnomics-adapterne (Task 5) returnerer en frittstående
  // Record<string, unknown> — ikke det variabel/kode-formede TableMeta-skjemaet
  // (de har ingen dimensjons-katalog å hente). Indekssignaturen gjør TableMeta
  // strukturelt kompatibel med Record<string, unknown> UTEN å svekke typingen
  // av de faste feltene over for de registerbaserte adapterne.
  [key: string]: unknown;
}

const MAX_VALUES = 40;

// find-filter (delstreng i kode ELLER etikett, case-insensitivt) — men KUN
// når hele listen er lengre enn MAX_VALUES. Korte lister (typisk
// obligatoriske dimensjoner som ContentsCode, som gjerne bare har noen få
// koder) returneres derfor KOMPLETTE selv når find er satt: ett
// table_metadata(find="Oslo")-kall gir dermed BÅDE regiontreffet OG de
// fullstendige kodelistene for korte, obligatoriske dimensjoner — uten et
// eget oppfølgingskall (spec 2026-07-31-ssb-mandatory-variabler task 5,
// sluttreview: find skal aldri tømme en mandatory-dimensjon appen uansett
// må ha et valg for). Trunkeringen skjer hos oss, hele listen er i minnet;
// valuesTruncated reflekterer listen ETTER (evt.) filtrering.
export function pickValues(
  all: { code: string; label: string }[],
  find?: string,
): { values: { code: string; label: string }[]; valuesTruncated: boolean } {
  const needle = (find ?? "").trim().toLowerCase();
  const filtered = needle && all.length > MAX_VALUES
    ? all.filter((v) =>
      v.code.toLowerCase().includes(needle) || v.label.toLowerCase().includes(needle))
    : all;
  return { values: filtered.slice(0, MAX_VALUES), valuesTruncated: filtered.length > MAX_VALUES };
}

export async function tableMetadata(
  sourceId: string,
  tableId: string,
  deps: { registry: DataSource[]; fetchImpl?: typeof fetch; find?: string },
): Promise<TableMeta> {
  const src = findSource(deps.registry, sourceId);
  if (!src) throw new Error(`ukjent kilde '${sourceId}'`);
  const f = deps.fetchImpl ?? fetch;
  switch (src.tilgang) {
    case "pxweb": return pxwebMetadata(src, tableId, f, deps.find);
    case "sdmx": return sdmxMetadata(src, tableId, f, deps.find);
    default:
      switch (src.kind) {
        case "fhi": return fhiMetadata(src, tableId, f, deps.find);
        case "dst": return dstMetadata(src, tableId, f, deps.find);
        case "statfin": return statfinMetadata(src, tableId, f, deps.find);
        // worldbank/dbnomics har et annet metadata-skjema (ingen
        // dimensjonsliste) — TableMetas indekssignatur gjør castet trygt.
        case "worldbank": return worldbankMetadata(tableId, f) as unknown as Promise<TableMeta>;
        // find= gjelder også her: dbnomics-dimensjoner kan ha hundrevis av
        // verdier (weo-country: 196), og uten søk faller landkoden utenfor
        // taket — da kan modellen ikke bygge filters= (målt live 2026-08-01).
        case "dbnomics": return dbnomicsMetadata(tableId, f, deps.find) as unknown as Promise<TableMeta>;
        default:
          throw new Error(
            `table_metadata støtter ikke '${sourceId}' ennå — bruk probe på data-URL-en for å se kolonner`,
          );
      }
  }
}

async function pxwebMetadata(src: DataSource, tableId: string, f: typeof fetch, find?: string): Promise<TableMeta> {
  const url = new URL(`tables/${tableId}/metadata?lang=no`, src.base_url).toString();
  const res = await f(url);
  if (!res.ok) throw new Error(`metadata for ${src.id}/${tableId} feilet: HTTP ${res.status}`);
  const json = await res.json();

  const dims = (json?.dimension ?? {}) as Record<string, {
    label?: string;
    category?: { index?: Record<string, number>; label?: Record<string, string> };
    extension?: { elimination?: boolean };
  }>;
  const timeDims = new Set<string>((json?.role?.time ?? []) as string[]);
  const variables: TableVariable[] = Object.entries(dims).map(([code, d]) => {
    const labels = d.category?.label ?? {};
    const codes = Object.keys(d.category?.index ?? labels);
    const allValues = codes.map((c) => ({ code: c, label: labels[c] ?? c }));
    const { values, valuesTruncated } = pickValues(allValues, find);
    const elim = d.extension?.elimination;
    // fallback når feltet mangler: ContentsCode + tidsdimensjonen er
    // aldri eliminerbare (janbrus: «never eliminable»)
    const mandatory = elim !== undefined
      ? elim === false
      : (code === "ContentsCode" || timeDims.has(code));
    return {
      code,
      label: d.label ?? code,
      time: timeDims.has(code),
      values,
      valuesTruncated,
      mandatory,
    };
  });

  return {
    source: src.id,
    id: tableId,
    title: String(json?.label ?? tableId),
    variables,
    queryUrlTemplate: src.sporrings_url_mal?.replace("{id}", tableId),
  };
}

interface FhiDimensionCategory { label: string; value: string; }
interface FhiDimension { code: string; label: string; categories: FhiDimensionCategory[]; }

async function fhiMetadata(src: DataSource, tableId: string, f: typeof fetch, find?: string): Promise<TableMeta> {
  // tableId kommer som "<register>/<tallId>" fra fhiSearch (search-catalog.ts)
  const [register, id] = tableId.split("/");
  if (!register || !id) throw new Error(`fhi table_id må være '<register>/<tallId>', fikk '${tableId}'`);
  const url = new URL(`${register}/table/${id}/dimension`, src.base_url).toString();
  const res = await f(url);
  if (!res.ok) throw new Error(`fhi metadata for ${tableId} feilet: HTTP ${res.status}`);
  const json = await res.json() as { dimensions?: FhiDimension[] };
  const dims = json.dimensions ?? [];
  const variables: TableVariable[] = dims.map((d) => {
    const allValues = d.categories.map((c) => ({ code: c.value, label: c.label }));
    const { values, valuesTruncated } = pickValues(allValues, find);
    return {
      code: d.code,
      label: d.label,
      time: false, // FHI gir ikke et pålitelig tids-signal (se spec §3) — ærlig forenkling
      values,
      valuesTruncated,
    };
  });
  return { source: src.id, id: tableId, title: tableId, variables };
}

interface DstVariableValue { id: string; text: string; }
interface DstVariable { id: string; text: string; time?: boolean; values: DstVariableValue[]; }

async function dstMetadata(src: DataSource, tableId: string, f: typeof fetch, find?: string): Promise<TableMeta> {
  const url = new URL(`tableinfo/${tableId}?format=JSON`, src.base_url).toString();
  const res = await f(url);
  if (!res.ok) throw new Error(`dst metadata for ${tableId} feilet: HTTP ${res.status}`);
  const json = await res.json() as { text?: string; variables?: DstVariable[] };
  const variables: TableVariable[] = (json.variables ?? []).map((v) => {
    const allValues = v.values.map((c) => ({ code: c.id, label: c.text }));
    const { values, valuesTruncated } = pickValues(allValues, find);
    return {
      code: v.id,
      label: v.text,
      time: !!v.time,
      values,
      valuesTruncated,
    };
  });
  return { source: src.id, id: tableId, title: json.text ?? tableId, variables };
}

interface StatfinVariable { code: string; text: string; values: string[]; valueTexts?: string[]; time?: boolean; }

async function statfinMetadata(src: DataSource, tableId: string, f: typeof fetch, find?: string): Promise<TableMeta> {
  const url = new URL(tableId, src.base_url).toString();
  const res = await f(url);
  if (!res.ok) throw new Error(`statfin metadata for ${tableId} feilet: HTTP ${res.status}`);
  const json = await res.json() as { title?: string; variables?: StatfinVariable[] };
  const variables: TableVariable[] = (json.variables ?? []).map((v) => {
    const codes = v.values ?? [];
    const labels = v.valueTexts ?? codes;
    const allValues = codes.map((c, i) => ({ code: c, label: labels[i] ?? c }));
    const { values, valuesTruncated } = pickValues(allValues, find);
    return {
      code: v.code,
      label: v.text,
      time: !!v.time,
      values,
      valuesTruncated,
    };
  });
  return { source: src.id, id: tableId, title: json.title ?? tableId, variables };
}

function sdmxCodelistIdFromUrn(urn: string): string | null {
  const m = urn.match(/Codelist=[^:]+:([^(]+)\(/);
  return m ? m[1] : null;
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function xmlText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)["#text"] ?? "");
  }
  return "";
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

async function sdmxMetadata(src: DataSource, dataflowKey: string, f: typeof fetch, find?: string): Promise<TableMeta> {
  const accept = SDMX_STRUCTURE_ACCEPT[src.id];
  if (!accept) {
    if (SDMX_XML_SOURCES.has(src.id)) return ecbMetadata(src, dataflowKey, f, find);
    throw new Error(`sdmx-strukturspørringer er ikke støttet for '${src.id}' ennå (kun XML) — bruk web_search + probe`);
  }
  // Komma-form er kanonisk (flowRef-en read() tar); slash-form godtas fortsatt
  // for gamle treff/modell-hukommelse. Ev. versjonsledd (NB,EXR,1.0) ignoreres
  // — strukturspørringen bruker /latest uansett.
  const [agencyID, dataflowId] = dataflowKey.split(/[,/]/);
  if (!agencyID || !dataflowId) throw new Error(`sdmx table_id må være '<agencyID>,<dataflowId>', fikk '${dataflowKey}'`);
  const url = `${src.base_url.replace(/data\/$/, "")}dataflow/${agencyID}/${dataflowId}/latest?references=all`;
  // Verifisert 2026-07-25 (live smoke-test, oppdaget FØR push): OECDs
  // ?references=all svarer 500 "languageTag1" på Denos fetch UTEN en
  // eksplisitt Accept-Language — curl sender én implisitt og feilen var
  // usynlig under research-fasen. Sendes alltid (harmløst for norgesbank).
  const res = await f(url, { headers: { Accept: accept, "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`sdmx metadata for ${dataflowKey} feilet: HTTP ${res.status}`);
  const json = await res.json();
  const dsd = json?.data?.dataStructures?.[0];
  if (!dsd) throw new Error(`fant ingen datastruktur for ${dataflowKey}`);
  const codelists = (json?.data?.codelists ?? []) as Record<string, unknown>[];
  const dimList = dsd.dataStructureComponents?.dimensionList ?? {};
  const plainDims = (dimList.dimensions ?? []) as Record<string, unknown>[];
  const timeDims = (dimList.timeDimensions ?? []) as Record<string, unknown>[];

  const codesFor = (d: Record<string, unknown>) => {
    const enumUrn = String((d.localRepresentation as Record<string, unknown> | undefined)?.enumeration ?? "");
    const clId = sdmxCodelistIdFromUrn(enumUrn);
    const cl = codelists.find((c) => c.id === clId);
    return (cl?.codes as Record<string, unknown>[] | undefined) ?? [];
  };

  const variables: TableVariable[] = [
    ...plainDims.map((d) => {
      const codes = codesFor(d);
      const allValues = codes.map((c) => ({ code: String(c.id ?? ""), label: String(c.name ?? c.id ?? "") }));
      const { values, valuesTruncated } = pickValues(allValues, find);
      return {
        code: String(d.id ?? ""),
        label: String(d.id ?? ""), // ingen egen "name" utover concept-referansen — koden ER labelen
        time: false,
        values,
        valuesTruncated,
      };
    }),
    ...timeDims.map((d) => ({
      code: String(d.id ?? ""),
      label: String(d.id ?? ""),
      time: true,
      values: [] as { code: string; label: string }[],
      valuesTruncated: false,
    })),
  ];
  return { source: src.id, id: dataflowKey, title: String(dsd.name ?? dataflowKey), variables };
}

async function ecbMetadata(src: DataSource, dataflowKey: string, f: typeof fetch, find?: string): Promise<TableMeta> {
  const [agencyID, dataflowId] = dataflowKey.split(/[,/]/);
  if (!agencyID || !dataflowId) throw new Error(`sdmx table_id må være '<agencyID>,<dataflowId>', fikk '${dataflowKey}'`);
  const url = `${src.base_url.replace(/data\/$/, "")}dataflow/${agencyID}/${dataflowId}/latest?references=all`;
  const res = await f(url, { headers: { Accept: "application/xml" } });
  if (!res.ok) throw new Error(`sdmx (xml) metadata for ${dataflowKey} feilet: HTTP ${res.status}`);
  const xml = await res.text();
  const doc = xmlParser.parse(xml);
  const structures = doc?.["mes:Structure"]?.["mes:Structures"];
  const dsds = asArray(structures?.["str:DataStructures"]?.["str:DataStructure"]) as Record<string, unknown>[];
  const dsd = dsds[0];
  if (!dsd) throw new Error(`fant ingen datastruktur for ${dataflowKey}`);
  const codelists = asArray(structures?.["str:Codelists"]?.["str:Codelist"]) as Record<string, unknown>[];
  const dimList = (dsd["str:DataStructureComponents"] as Record<string, unknown> | undefined)?.["str:DimensionList"] as Record<string, unknown> | undefined ?? {};
  const plainDims = asArray(dimList["str:Dimension"]) as Record<string, unknown>[];
  const timeDims = asArray(dimList["str:TimeDimension"]) as Record<string, unknown>[];

  const codesFor = (d: Record<string, unknown>) => {
    const localRep = d["str:LocalRepresentation"] as Record<string, unknown> | undefined;
    const enumeration = localRep?.["str:Enumeration"] as Record<string, unknown> | undefined;
    const ref = enumeration?.Ref as Record<string, unknown> | undefined;
    const clId = ref?.id;
    const cl = codelists.find((c) => c.id === clId);
    return asArray(cl?.["str:Code"]) as Record<string, unknown>[];
  };

  const variables: TableVariable[] = [
    ...plainDims.map((d) => {
      const codes = codesFor(d);
      const allValues = codes.map((c) => ({ code: String(c.id ?? ""), label: xmlText(c["com:Name"]) || String(c.id ?? "") }));
      const { values, valuesTruncated } = pickValues(allValues, find);
      return {
        code: String(d.id ?? ""),
        label: String(d.id ?? ""),
        time: false,
        values,
        valuesTruncated,
      };
    }),
    ...timeDims.map((d) => ({
      code: String(d.id ?? ""),
      label: String(d.id ?? ""),
      time: true,
      values: [] as { code: string; label: string }[],
      valuesTruncated: false,
    })),
  ];
  return { source: src.id, id: dataflowKey, title: xmlText(dsd["com:Name"]) || dataflowKey, variables };
}
