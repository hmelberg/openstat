// Materialisering av connect/load-direktiver: parse → resolve → fetch.
// Ingen runtime-binding her — index.html binder bytes inn i pyodide/webr/
// duckdb med ~10 linjer per modus. deps er injiserbar for tester.
(function (global) {
  'use strict';

  var _registryCache = null;
  async function loadRegistry(fetchImpl) {
    if (_registryCache) return _registryCache;
    try {
      var r = await fetchImpl('data/data-sources.json');
      _registryCache = r.ok ? await r.json() : [];
    } catch (e) { _registryCache = []; }
    return _registryCache;
  }

  // Proxy-auth: innloggingstoken har forrang; ellers BYOK-nøkkel (hent-
  // endepunktet godtar X-Anthropic-Key via allowByok, jf. B5 i roadmapen).
  function proxyHeaders(authToken, anthropicKey) {
    if (authToken) return { 'Authorization': 'Bearer ' + authToken };
    if (anthropicKey) return { 'X-Anthropic-Key': anthropicKey };
    return {};
  }

  async function fetchLoadTarget(item, fetchImpl, authToken, anthropicKey) {
    async function viaProxy() {
      var pr = await fetchImpl('/api/hent?url=' + encodeURIComponent(item.url), { headers: proxyHeaders(authToken, anthropicKey) });
      if (!pr.ok) throw new Error('proxy ' + pr.status + ' for ' + item.alias);
      return pr;
    }
    if (item.url.indexOf('/api/hent?') === 0) {
      var r0 = await fetchImpl(item.url, { headers: proxyHeaders(authToken, anthropicKey) });
      if (!r0.ok) throw new Error('proxy ' + r0.status + ' for ' + item.alias);
      return r0;
    }
    if (item.viaProxy) return viaProxy();
    try {
      var r1 = await fetchImpl(item.url);
      if (!r1.ok) throw new Error('HTTP ' + r1.status + ' for ' + item.alias + ' (' + item.url + ')');
      return r1;
    } catch (e) {
      if (e instanceof TypeError) return viaProxy();   // CORS/nettverk → proxy
      throw e;
    }
  }

  function sniffFormat(resp, url) {
    var ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('parquet') >= 0 || /\.parquet(\?|$)/.test(url)) return 'parquet';
    if (ct.indexOf('json') >= 0) return 'json';
    if (ct.indexOf('html') >= 0) return 'html';   // f.eks. Wikipedia: bind som råtekst
    return 'csv';
  }

  // Hoved-API: {loads: [{alias, bytes(Uint8Array), format}], remote: []}
  // eller kast norsk feil. `remote` er alltid tom i denne appen (ingen
  // registrerte kilder / server-eksekvering) — bevart for kall-kompatibilitet.
  async function resolveAndFetchLoads(script, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    var DD = global.DataDirectives;
    if (!DD || !fetchImpl) return { loads: [], remote: [] };
    var parsed = DD.parse(script);
    if (!parsed.loads.length) return { loads: [], remote: [] };
    var registry = deps.registry || await loadRegistry(fetchImpl);
    var resolved = DD.resolve(parsed, registry);
    var bad = resolved.filter(function (r) { return r.error; });
    if (bad.length) throw new Error('Direktivfeil: ' + bad.map(function (b) { return b.error; }).join('; '));

    resolved.forEach(function (item) {
      if (item.exec === 'remote') throw new Error('exec(remote) støttes ikke: ' + item.alias);
    });

    var loads = await Promise.all(resolved.map(async function (item) {
      var resp = await fetchLoadTarget(item, fetchImpl, deps.authToken || null, deps.anthropicKey || null);
      var buf = new Uint8Array(await resp.arrayBuffer());
      var format = sniffFormat(resp, item.url);
      var dec = await maybeDecrypt(item, buf, format, deps);
      var out = { alias: item.alias, bytes: dec.bytes, format: dec.format };
      if (dec.envelope) { out.envelope = dec.envelope; out.key = dec.key; }
      return out;
    }));
    return { loads: loads, remote: [] };
  }

  // safepy-enc-v1: sniffFormat sier json — sjekk konvolutt, verifiser
  // fingerprint (bytte-vern) og dekrypter lokalt (WebCrypto).
  async function maybeDecrypt(item, buf, format, deps) {
    var EC = global.EncCrypto;
    if (!EC || format !== 'json') return { bytes: buf, format: format };
    var env;
    try { env = JSON.parse(new TextDecoder().decode(buf)); } catch (e) { return { bytes: buf, format: format }; }
    if (!EC.isEnvelope(env)) return { bytes: buf, format: format };
    var computed = await EC.envelopeFingerprint(env);
    if (env.fingerprint && computed !== env.fingerprint)
      throw new Error('«' + item.alias + '»: ødelagt fil (fingerprint stemmer ikke)');
    var key = (item.key && item.key !== 'ask') ? item.key
        : deps.promptKey ? await deps.promptKey(item.alias)
        : null;
    if (!key) throw new Error('«' + item.alias + '» er kryptert og krever nøkkel — bruk key(...) eller key(ask)');
    var plain = await EC.decryptEnvelope(env, key);
    return { bytes: plain, format: env.payload_format || 'csv' };
  }

  // Project A: fetch the SOURCES a spec needs (each connect alias as a whole
  // table), honoring grants/decrypt/remote routing exactly like load does, and
  // return the spec so the runtime can assemble. Same fetch layer as
  // resolveAndFetchLoads — only the shape of the request changes.
  async function resolveAndAssemble(script, deps) {
    deps = deps || {};
    var DD = global.DataDirectives;
    if (!DD) return { sources: [], remote: [], spec: { sources: [], datasets: [] } };
    var parsed = DD.parseAssembly(script);
    if (parsed.errors.length) throw new Error('Monteringsfeil: ' + parsed.errors.join('; '));
    var spec = parsed.spec;
    if (!spec.sources.length) return { sources: [], remote: [], spec: spec };

    // Synthesize a "load <alias> as <alias>" per source and run the existing
    // pipeline against just the connect lines, so each source is fetched
    // exactly once (skip any original bare `load` lines from the script).
    var connectLines = script.split(/\r?\n/).filter(function (ln) { return /^[ \t]*(?:#|--|\/\/)[ \t]*connect\b/i.test(ln); }).join('\n');
    var srcScript = connectLines + '\n' + spec.sources.map(function (a) { return '# load ' + a + ' as ' + a; }).join('\n');
    var loaded = await resolveAndFetchLoads(srcScript, deps);
    return { sources: loaded.loads, remote: loaded.remote, spec: spec };
  }

  global.DataLoader = { resolveAndFetchLoads: resolveAndFetchLoads, resolveAndAssemble: resolveAndAssemble, _sniffFormat: sniffFormat };
})(typeof window !== 'undefined' ? window : globalThis);
