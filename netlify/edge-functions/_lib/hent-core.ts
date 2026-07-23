// Core of the /api/hent proxy (auth handled by the wrapper). SSRF-hardened
// generic GET (+ GET-wrapped POST-json) with server-side key injection for
// registry sources. Keys never reach the browser (spec §5).
import { fetchGuarded, isPublicHttpUrl } from "./ssrf.ts";
import { sourceForUrl, type DataSource } from "./registry.ts";

const MAX_BODY_PARAM = 20_000;      // chars, URL-decoded
const MAX_RESPONSE = 50 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const MAX_SOURCE_KEY = 300;         // chars — romslig for alle kjente nøkkelformater

export interface HentDeps {
  registry: DataSource[];
  getEnv: (k: string) => string | undefined;
  fetchImpl?: typeof fetch;
}

export async function handleHent(request: Request, deps: HentDeps): Promise<Response> {
  const u = new URL(request.url);
  const target = u.searchParams.get("url") ?? "";
  const bodyParam = u.searchParams.get("body");
  if (!target || !isPublicHttpUrl(target)) {
    return new Response("Ugyldig eller manglende url-parameter", { status: 400 });
  }
  if (bodyParam && bodyParam.length > MAX_BODY_PARAM) {
    return new Response("body-parameter for stor", { status: 413 });
  }

  // Key injection — ONLY when the host matches a registry entry with auth.
  // To nøkkelveier: env (site-nøkkel, som før) og user (X-Source-Key fra
  // js/keys.js via data-loader). Innkommende X-Source-Key videresendes ALDRI
  // oppstrøms — headers bygges fra bunnen her, og brukes bare når verten
  // matcher en user-auth-kilde.
  let finalUrl = target;
  const headers: Record<string, string> = {};
  const src = sourceForUrl(deps.registry, target);
  if (src?.auth) {
    const a = src.auth;
    let key: string;
    if (a.user) {
      key = request.headers.get("x-source-key") ?? "";
      if (key.length > MAX_SOURCE_KEY) return new Response("X-Source-Key for lang", { status: 400 });
      if (!key) {
        // Fast, ikke-interpolert utover kilde-id (aldri URL/nøkkel i feilkroppen).
        return new Response(
          `Kilden ${src.id} krever API-nøkkel — registrer den i AI-innstillingene`,
          { status: 401 },
        );
      }
    } else {
      key = deps.getEnv(a.env ?? "") ?? "";
      if (!key) return new Response(`Nøkkel for ${src.id} er ikke konfigurert`, { status: 502 });
    }
    if (a.plassering === "basic") {
      headers["authorization"] = "Basic " + btoa(key);
    } else {
      const [kind, name] = a.plassering.split(":");
      if (kind === "query") {
        const t = new URL(target);
        t.searchParams.set(name, key);
        finalUrl = t.toString();
      } else if (kind === "header") {
        headers[name] = key;
      }
    }
  }
  if (bodyParam) headers["content-type"] = "application/json";

  try {
    const res = await fetchGuarded(finalUrl, {
      method: bodyParam ? "POST" : "GET",
      body: bodyParam ?? undefined,
      headers,
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_RESPONSE,
      fetchImpl: deps.fetchImpl,
    });
    const out = new Headers({
      "content-type": res.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    if (res.truncated) out.set("x-hent-truncated", "1");
    return new Response(res.body as BodyInit, { status: res.status, headers: out });
  } catch (e) {
    // Never echo the caught error to the client: Deno fetch errors and our
    // own fetchGuarded errors embed the request URL, which may carry a
    // server-injected api_key (query-string key injection above). Log
    // server-side only; return a fixed, non-interpolated body.
    console.error("hent: proxy error:", String(e));
    return new Response("Proxy-feil ved henting av kilden", { status: 502 });
  }
}
