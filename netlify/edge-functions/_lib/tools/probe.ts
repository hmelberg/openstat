// probe tool: the grounding step. Verifies an endpoint exists and reports
// OBSERVED schema (columns) + CORS, so generation never guesses.
import { fetchGuarded, isPublicHttpUrl } from "../ssrf.ts";
import { sourceForUrl, type DataSource } from "../registry.ts";

// Samme Accept som js/api-kinds.js sender ved faktisk lasting. Probe MÅ se den
// representasjonen lasteren får: uten denne svarer OECD med SDMX-ML, og probe
// rapporterte et «skjema» (XML-en som én kolonne) scriptet aldri møter.
const SDMX_DATA_ACCEPT = "application/vnd.sdmx.data+csv;labels=id";

export interface ProbeResult {
  ok: boolean;
  status: number;
  contentType: string;
  cors: boolean;
  columns: string[];
  sampleRows: string[][];
  truncated: boolean;
  note?: string;
}

const MAX_PROBE_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_ORIGIN = "https://openstat.app";

export async function probeUrl(
  url: string,
  deps: { fetchImpl?: typeof fetch; registry?: DataSource[] } = {},
): Promise<ProbeResult> {
  const empty: ProbeResult = {
    ok: false, status: 0, contentType: "", cors: false,
    columns: [], sampleRows: [], truncated: false,
  };
  if (!isPublicHttpUrl(url)) {
    return { ...empty, note: "blokkert: ikke en offentlig http(s)-URL" };
  }
  // DST-klassen av kilder sender ACAO kun når forespørselen har Origin-header.
  // Uten denne sender vi ingen Origin, så betinget-ACAO-kilder rapporterer falsk cors:false.
  const headers: Record<string, string> = { Origin: PROBE_ORIGIN };
  const src = deps.registry ? sourceForUrl(deps.registry, url) : null;
  if (src?.tilgang === "sdmx") {
    headers["Accept"] = SDMX_DATA_ACCEPT;
    // Målt live 2026-08-01: OECDs data-endepunkt svarer HTTP 500 «languageTag1»
    // på Denos fetch uten en eksplisitt Accept-Language (samme felle som
    // strukturendepunktet, se search-catalog.ts). Harmløs for de andre.
    headers["Accept-Language"] = "en";
  }
  let res;
  try {
    res = await fetchGuarded(url, {
      maxBytes: MAX_PROBE_BYTES,
      timeoutMs: PROBE_TIMEOUT_MS,
      headers,
      fetchImpl: deps.fetchImpl,
    });
  } catch (e) {
    return { ...empty, note: `probe feilet: ${String(e).slice(0, 200)}` };
  }
  const contentType = res.headers.get("content-type") ?? "";
  const acao = res.headers.get("access-control-allow-origin");
  const cors = acao === "*" || acao === PROBE_ORIGIN;
  if (res.status < 200 || res.status >= 300) {
    return { ...empty, status: res.status, contentType, cors, note: `HTTP ${res.status}` };
  }
  const text = new TextDecoder().decode(res.body);
  // XML er ALDRI et lastbart tabellskjema her. Uten denne vakten havnet hele
  // SDMX-ML-dokumentet (målt: 85 000 tegn) i ÉN columns-oppføring, med
  // ok:true og note «CSV» — modellen fikk ✅ på et skjema den ikke kan bruke,
  // og konteksten ble spist opp. En ærlig ok:false er langt bedre.
  if (looksXml(text, contentType)) {
    return {
      ...empty, status: res.status, contentType, cors,
      note: "svaret er XML, ikke en lastbar tabell — be om CSV/JSON " +
        "(SDMX-kilder: bruk registerets <kilde>.read(...) i stedet for en rå URL)",
    };
  }
  const { columns, sampleRows, note } = inferSchema(text, contentType);
  return {
    ok: true, status: res.status, contentType, cors,
    columns, sampleRows, truncated: res.truncated, note,
  };
}

function looksXml(text: string, contentType: string): boolean {
  const t = text.trimStart();
  if (/\b(xml)\b/i.test(contentType) && !contentType.includes("json")) return true;
  return t.startsWith("<?xml") || /^<[a-zA-Z_][\w.-]*:[\w.-]+[\s>]/.test(t);
}

function inferSchema(text: string, contentType: string): {
  columns: string[]; sampleRows: string[][]; note?: string;
} {
  const t = text.trimStart();
  const looksJson = contentType.includes("json") || t.startsWith("{") || t.startsWith("[");
  if (looksJson) {
    try {
      const json = JSON.parse(sliceCompleteJson(t));
      if (json && typeof json === "object" && !Array.isArray(json) && json.dimension) {
        return { columns: Object.keys(json.dimension), sampleRows: [], note: "JSON-stat" };
      }
      if (Array.isArray(json) && json.length && typeof json[0] === "object") {
        return {
          columns: Object.keys(json[0]),
          sampleRows: json.slice(0, 2).map((r: Record<string, unknown>) => Object.values(r).map(String)),
          note: "JSON-array",
        };
      }
      if (json && typeof json === "object") {
        return { columns: Object.keys(json), sampleRows: [], note: "JSON-objekt (toppnivå-nøkler)" };
      }
    } catch {
      return { columns: [], sampleRows: [], note: "JSON kunne ikke parses (trunkert?)" };
    }
  }
  // CSV: sniff separator on the header line
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0).slice(0, 3);
  if (!lines.length) return { columns: [], sampleRows: [], note: "tomt svar" };
  const sep = (lines[0].match(/;/g)?.length ?? 0) > (lines[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const split = (l: string) => l.split(sep).map((c) => c.replace(/^"|"$/g, "").trim());
  return { columns: split(lines[0]), sampleRows: lines.slice(1).map(split), note: `CSV (skilletegn '${sep}')` };
}

/** Best-effort: probe reads a byte-capped prefix, so JSON may be cut off. */
function sliceCompleteJson(t: string): string {
  try { JSON.parse(t); return t; } catch { /* fall through */ }
  // For arrays: retry on the largest complete prefix ending at a '}' + ']'
  const lastObj = t.lastIndexOf("}");
  if (t.startsWith("[") && lastObj > 0) return t.slice(0, lastObj + 1) + "]";
  return t;
}
