// GET /api/metadata?source=<registry-id>[&table=<tabell-id>] — offentlig,
// rate-limited MetaInfo-oppslag for sidebaren. Wrapper table_metadata (samme
// TS-adaptere svar/hent bruker) uten AI-en/admin-låsen i veien: input er
// KUN (kilde-id, tabell-id) mot det kuraterte registeret, ALDRI rå URL-er —
// ingen SSRF-flate utover de allerede registrerte kildene selv.
// Spec: docs/superpowers/specs/2026-07-25-metadata-sidebar-design.md §4.
import { checkRateLimit } from "./_lib/rate-limit.ts";
import { clientIp } from "./_lib/auth.ts";
import { findSource, isSearchableSource, loadRegistry, type DataSource } from "./_lib/registry.ts";
import { tableMetadata, type TableMeta } from "./_lib/tools/table-metadata.ts";
import { isValidTableId, mapToMetaInfo } from "./_lib/meta-info-map.ts";

export default async (request: Request): Promise<Response> => {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const rate = await checkRateLimit("metadata", clientIp(request));
  if (!rate.allowed) {
    return new Response("Rate limited", {
      status: 429,
      headers: { "Retry-After": String(rate.retryAfterSeconds) },
    });
  }

  const u = new URL(request.url);
  const sourceId = (u.searchParams.get("source") ?? "").trim();
  const table = (u.searchParams.get("table") ?? "").trim();
  if (!/^[a-z0-9_-]{1,32}$/.test(sourceId)) {
    return new Response("Ugyldig source", { status: 400 });
  }
  // SSRF-vakt: statfin-adapteren (tools/table-metadata.ts) bygger
  // `new URL(tableId, src.base_url)` — en absolutt eller protokoll-relativ
  // `table` ville overstyrt vertsnavnet. isValidTableId dekker alle reelle
  // id-former (pxweb/dst/statfin/fhi/sdmx) uten å åpne for rå URL-er.
  if (table && !isValidTableId(table)) {
    return new Response("Ugyldig table", { status: 400 });
  }

  let registry: DataSource[];
  try {
    registry = await loadRegistry(u.origin);
  } catch (e) {
    console.error("metadata: registry load failed:", e);
    return new Response("Kilderegister utilgjengelig", { status: 502 });
  }

  const src = findSource(registry, sourceId);
  if (!src) return new Response(`ukjent kilde '${sourceId}'`, { status: 400 });

  let tm: TableMeta | null = null;
  if (table) {
    if (!isSearchableSource(src)) {
      return new Response(`kilden '${sourceId}' har ikke tabell-metadata`, { status: 400 });
    }
    try {
      tm = await tableMetadata(sourceId, table, { registry });
    } catch (e) {
      return new Response(String(e), { status: 502 });
    }
  }

  return new Response(JSON.stringify(mapToMetaInfo(src, tm)), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
