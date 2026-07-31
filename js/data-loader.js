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

  // Module-scoped (not per-call, like _registryCache above): every click of
  // Run previously re-fetched (and for duckdb/sqlite, re-extracted) every
  // source from scratch, even when nothing about the script changed since
  // the last run — the highest-frequency friction point in the app given
  // how often a script gets tweaked and re-run during iteration. Keyed by
  // resolved URL; only raw bytes are cached (decryption still runs fresh
  // per item/run, and strict-source key authorization is deliberately never
  // cached — see authorizeStrict below). No TTL/invalidation, same as
  // _registryCache above — a page reload is the reset, by design (2026-07-07,
  // docs/superpowers/2026-07-07-code-review.md §6 item 1).
  var _bufCache = {};

  // Proxy-auth: innloggingstoken har forrang; ellers BYOK-nøkkel (hent-
  // endepunktet godtar X-Anthropic-Key via allowByok, jf. B5 i roadmapen).
  function proxyHeaders(authToken, anthropicKey) {
    if (authToken) return { 'Authorization': 'Bearer ' + authToken };
    if (anthropicKey) return { 'X-Anthropic-Key': anthropicKey };
    return {};
  }

  // x-hent-truncated (R-URL-bro-oppfølging §2): proxyen avkorter ved 50MB
  // og flagger det — en avkortet CSV er FEIL DATA og skal feile høylytt,
  // aldri leveres stille (husets aldri-stille-feil-data).
  function assertNotTruncated(resp, what) {
    if (resp && resp.headers && typeof resp.headers.get === 'function' &&
        resp.headers.get('x-hent-truncated')) {
      throw new Error('avkortet ved proxyens 50MB-grense (x-hent-truncated) for ' + what);
    }
  }

  // Brukernøkler (spec 2026-07-23): en kilde med auth.user i registeret krever
  // registrert nøkkel (js/keys.js). Nøkkelen sendes KUN som X-Source-Key til
  // /api/hent (som injiserer etter plasseringsregelen, vertsbundet) — den
  // legges aldri inn i selve kilde-URL-en klient-side, og havner dermed aldri
  // i script, delingslenker eller cache-nøkler.
  function userAuthSourceFor(url, registry) {
    var target = url;
    if (url.indexOf('/api/hent?') === 0) {
      var m = /[?&]url=([^&]+)/.exec(url);
      if (!m) return null;
      try { target = decodeURIComponent(m[1]); } catch (e) { return null; }
    }
    var host;
    try { host = new URL(target).host; } catch (e) { return null; }
    var reg = registry || [];
    for (var i = 0; i < reg.length; i++) {
      var s = reg[i];
      if (!s.auth || !s.auth.user) continue;
      try { if (new URL(s.base_url).host === host) return s; } catch (e2) {}
    }
    return null;
  }

  function sourceKeyHeader(url, registry, keysApi) {
    var src = userAuthSourceFor(url, registry);
    if (!src) return {};
    var K = keysApi || global.Keys;
    var val = K && K.get(src.id);
    if (!val) {
      if (src.auth && src.auth.valgfri) return {};   // valgfri: anonym henting
      throw new Error('«' + src.id + '» krever API-nøkkel — registrer den i AI-innstillingene.');
    }
    return { 'X-Source-Key': val };
  }

  async function fetchLoadTarget(item, fetchImpl, authToken, anthropicKey, registry, keysApi) {
    var srcKey = sourceKeyHeader(item.url, registry, keysApi);   // kaster ved manglende nøkkel
    // item.fetchHeaders (api-kinds-spec §1): per-item-headere (sdmx-Accept) —
    // sendes både direkte og via proxy (hent-core videresender accept).
    function hdrs() { return Object.assign({}, proxyHeaders(authToken, anthropicKey), srcKey, item.fetchHeaders || {}); }
    async function viaProxy() {
      var pr = await fetchImpl('/api/hent?url=' + encodeURIComponent(item.url), { headers: hdrs() });
      if (!pr.ok) throw new Error('proxy ' + pr.status + ' for ' + item.alias);
      assertNotTruncated(pr, item.alias);
      return pr;
    }
    if (item.url.indexOf('/api/hent?') === 0) {
      var r0 = await fetchImpl(item.url, { headers: hdrs() });
      if (!r0.ok) throw new Error('proxy ' + r0.status + ' for ' + item.alias);
      assertNotTruncated(r0, item.alias);
      return r0;
    }
    // User-auth-kilder skal ALLTID via proxy (serveren injiserer nøkkelen
    // vertsbundet) — også når direktivet er en bar URL som resolve() ikke
    // proxy-merket (den konsulterer ikke registeret for den greinen).
    if (item.viaProxy || srcKey['X-Source-Key']) return viaProxy();
    try {
      var r1 = await fetchImpl(item.url, item.fetchHeaders ? { headers: item.fetchHeaders } : undefined);
      if (!r1.ok) throw new Error('HTTP ' + r1.status + ' for ' + item.alias + ' (' + item.url + ')');
      return r1;
    } catch (e) {
      if (e instanceof TypeError) return viaProxy();   // CORS/nettverk → proxy
      throw e;
    }
  }

  // Rå URL-henting for pandas-URL-broen (plan 2026-07-27): pd.read_csv(url)
  // i motorene ruter hit. Kontrakten er «aldri stille feil data»: HTTP-feil
  // KASTER (med status og URL) i stedet for å levere en feilkropp som
  // parseren ville gjort om til en absurd én-kolonnes ramme. CORS/nettverk
  // (TypeError) prøver proxyen — samme fallback som direktiv-veien.
  async function fetchRawUrl(url, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    if (!fetchImpl) throw new Error('fetchRawUrl: ingen fetch tilgjengelig');
    async function viaProxy() {
      // /api/hent er auth-portet (Bearer eller X-Anthropic-Key) — uten samme
      // headere som direktiv-veien er fallbacken død (401, målt i smoke 6).
      // Headerne sendes KUN til proxyen, aldri til eksterne kilder.
      var pr = await fetchImpl('/api/hent?url=' + encodeURIComponent(url),
                               { headers: proxyHeaders(deps.authToken, deps.anthropicKey) });
      if (!pr.ok) throw new Error('proxy ' + pr.status + ' for ' + url);
      return pr;
    }
    var resp;
    if (url.indexOf('/api/hent?') === 0) {
      resp = await fetchImpl(url, { headers: proxyHeaders(deps.authToken, deps.anthropicKey) });
      if (!resp.ok) throw new Error('proxy ' + resp.status + ' for ' + url);
    } else {
      try {
        resp = await fetchImpl(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
      } catch (e) {
        if (e instanceof TypeError) resp = await viaProxy();
        else throw e;
      }
    }
    assertNotTruncated(resp, url);
    var buf = await resp.arrayBuffer();
    return { bytes: new Uint8Array(buf), contentType: resp.headers.get('content-type') || '' };
  }

  // cache(<ttl>)-opsjonen (plan 2026-07-25 Task 1): '90'/'90s'/'30m'/'2h'/'1d'
  // -> millisekunder; '0'/'no'/'off' -> 0 (bust); ugyldig -> null (ingen cache).
  function parseCacheTtl(v) {
    var s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return null;
    if (s === 'no' || s === 'off') return 0;
    var m = /^(\d+)\s*(s|m|h|d)?$/.exec(s);
    if (!m) return null;
    var mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] || 's'];
    return parseInt(m[1], 10) * mult;
  }

  // Opt-in disk-L2 under _bufCache (Cache API i side-konteksten — overlever
  // reload; SW-varianten blir aktuell først når pakke-sync-XHR skal dele
  // cache, se ROADMAP). Hentetidspunktet ligger i x-m2py-fetched-at-headeren;
  // ttl 0 sletter oppføringen og går på nett. Utenfor browser (node-tester)
  // finnes ikke caches — ren nettvei, uendret oppførsel.
  var DATA_CACHE = 'm2py-data';
  async function fetchViaDiskCache(item, fetchImpl, deps, registry) {
    var ttl = parseCacheTtl(item.cache);
    var canDisk = typeof caches !== 'undefined' && ttl !== null;
    if (canDisk) {
      try {
        var c = await caches.open(DATA_CACHE);
        if (ttl === 0) { await c.delete(item.url); }
        else {
          var hit = await c.match(item.url);
          if (hit) {
            var at = Number(hit.headers.get('x-m2py-fetched-at') || 0);
            if (at && (Date.now() - at) < ttl) {
              // Cache API-treff er en ekte Response (has headers.get) — samme
              // høylytte vakt som de andre tre proxy-konsumentene, så en
              // avkortet oppføring (uansett hvordan den havnet på disk)
              // aldri leveres stille fra L2-cachen heller.
              assertNotTruncated(hit, item.url);
              var ab0 = await hit.arrayBuffer();
              return { resp: hit, buf: new Uint8Array(ab0) };
            }
          }
        }
      } catch (e) { canDisk = false; }
    }
    var resp = await fetchLoadTarget(item, fetchImpl, deps.authToken || null, deps.anthropicKey || null, registry, deps.keysApi || null);
    var ab = await resp.arrayBuffer();
    var buf = new Uint8Array(ab);
    if (canDisk && ttl > 0) {
      try {
        var hdrs = { 'x-m2py-fetched-at': String(Date.now()) };
        var ct = resp.headers.get('content-type');
        if (ct) hdrs['content-type'] = ct;
        await (await caches.open(DATA_CACHE)).put(item.url, new Response(buf, { headers: hdrs }));
      } catch (e2) {}
    }
    return { resp: resp, buf: buf };
  }

  function sniffFormat(resp, url, kind) {
    // Eksplisitt kind() vinner alltid — sniffing er en heuristikk for de
    // uregistrerte tilfellene (spec 2026-07-06-remote-columnar-sources §4).
    if (kind) return kind;
    var ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('parquet') >= 0 || /\.parquet(\?|$)/.test(url)) return 'parquet';
    if (/\.duckdb(\?|$)/.test(url)) return 'duckdb';
    if (/\.sqlite3?(\?|$)/.test(url)) return 'sqlite';
    if (ct.indexOf('json') >= 0) return 'json';
    if (ct.indexOf('html') >= 0) return 'html';   // f.eks. Wikipedia: bind som råtekst
    return 'csv';
  }

  // Hoved-API: {loads: [{alias, bytes(Uint8Array), format}],
  //             remote: [{alias, sourceId, key}]} eller kast norsk feil.
  // remote = registrerte kilder som IKKE kan analyseres lokalt (level != public):
  // index.html ruter hele scriptet til serveren med source_keys (spec §4).
  async function resolveAndFetchLoads(script, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    var DD = global.DataDirectives;
    if (!DD || !fetchImpl) return { loads: [], remote: [] };
    // Kallere utenfra sender et script; resolveAndAssemble sender et ferdig
    // parset objekt, så det ikke må omveien om en streng den selv nettopp
    // bygget (se DD.makeLoad). Testen er «er det et objekt», ikke «er det en
    // streng»: DD.parse(null) er tolerant og gir tomt resultat, og den
    // toleransen skal ikke bli til en TypeError her.
    var parsed = (script && typeof script === 'object') ? script : DD.parse(script);
    if (!parsed.loads.length) return { loads: [], remote: [] };
    var registry = deps.registry || await loadRegistry(fetchImpl);
    var resolved = DD.resolve(parsed, registry);
    var bad = resolved.filter(function (r) { return r.error; });
    if (bad.length) throw new Error('Direktivfeil: ' + bad.map(function (b) { return b.error; }).join('; '));

    var remote = [];
    var localItems = [];
    for (var i = 0; i < resolved.length; i++) {
      var item = resolved[i];
      if (item.anvil) {
        var grant = await fetchSourceAccess(item, deps, fetchImpl);
        if (grant.remote_only || item.exec === 'remote') {
          if (item.exec === 'local') throw new Error('«' + item.anvil + '» er ikke offentlig — kan ikke kjøres lokalt (kjøres på server).');
          remote.push({ alias: item.alias, sourceId: item.anvil, key: item.key });
          continue;
        }
        item.url = grant.location;
        item.grant = grant;
        item.viaProxy = false;
      } else if (item.exec === 'remote') {
        throw new Error('exec(remote) krever en registrert kilde (navn), ikke URL: ' + item.alias);
      }
      localItems.push(item);
    }

    var loads = await fetchResolvedItems(localItems, Object.assign({}, deps, { registry: registry }));
    return { loads: loads, remote: remote };
  }

  // Fetch+decrypt+cache for an already-resolved item list (each
  // {alias, url, kind, key, table, viaProxy, grant?}) — the part of
  // resolveAndFetchLoads that doesn't depend on connect/load-directive
  // syntax at all. Extracted (2026-07-09) so a mode with its OWN directive
  // syntax (SafeStat mode's bare `require <url> as <alias>` DSL statement,
  // not a "#"/"--"/"//"-prefixed comment directive DataDirectives.parse can
  // recognize) can still get key()/kind()/caching for free instead of a
  // second, narrower hand-rolled fetch — see index.html's runSafeStatScript.
  // -> [{alias, bytes, format, table?, kind?, envelope?, key?, level?, strict?}]
  async function fetchResolvedItems(localItems, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    var registry = deps.registry || (fetchImpl ? await loadRegistry(fetchImpl) : []);
    // V3 (spec browser-strict): strict-kilder får ALDRI nøkkel via
    // /source_access — HVER strict-kjøring (kryptert eller ei) autoriseres og
    // logges via /local_run_authorize (deps.authorizeStrict), som utleverer
    // eventuelle nøkler. Ingen caching: callbacken kalles per kjøring.
    var strictItems = localItems.filter(function (it) {
      return it.grant && it.grant.local_profile === 'strict';
    });
    if (strictItems.length) {
      if (!deps.authorizeStrict) throw new Error('strict-kilder krever autorisert kjøring — mangler authorizeStrict');
      var runKeys = await deps.authorizeStrict(strictItems.map(function (it) { return it.anvil; }));
      strictItems.forEach(function (it) {
        if (runKeys && runKeys[it.anvil]) it.grant = Object.assign({}, it.grant, { key: runKeys[it.anvil] });
      });
    }

    function fetchBytes(item) {
      var k = item.url;
      // cache(0)/cache(no) skal buste BEGGE lag: minne-L1 ville ellers
      // skygget for både re-fetch og disk-slettingen (funnet i
      // browser-verifiseringen 2026-07-25).
      if (parseCacheTtl(item.cache) === 0) delete _bufCache[k];
      if (!_bufCache[k]) {
        _bufCache[k] = fetchViaDiskCache(item, fetchImpl, deps, registry);
        // A failed fetch must NOT poison future runs — _bufCache is now
        // module-scoped (persists across runs, not just within one), so a
        // transient network error would otherwise be "cached" forever until
        // a page reload. Drop the entry on rejection so the next run retries.
        _bufCache[k].catch(function () { delete _bufCache[k]; });
      }
      return _bufCache[k];
    }
    return Promise.all(localItems.map(async function (item) {
      if (item.federated) {
        // Federert pull (spec 2026-07-31-federert-pull §4): hvert medlem
        // gjennom samme fetch/cache-vei som et vanlig load-item, deretter
        // union via injisert executor (index.html = duckdb-wasm; tester =
        // fake). Ett medlem som feiler feiler HELE lesingen — delresultater
        // presentert som helheten er en korrekthetsfelle.
        if (!deps.unionExec) throw new Error('federert kilde «' + item.alias + '» krever union-motoren (unionExec mangler)');
        var memberLoads = await Promise.all(item.federated.map(async function (mem) {
          var mf = await fetchBytes(mem);
          var mfmt = mem.format || sniffFormat(mf.resp, mem.url, mem.kind);
          var mdec = await maybeDecrypt(mem, mf.buf, mfmt, deps);
          return { id: mem.id, bytes: mdec.bytes, format: mdec.format };
        }));
        var fedMeta = {};
        if (item.overlap) fedMeta.overlap = item.overlap;
        if (item.entity) fedMeta.entity = item.entity;
        var merged = await deps.unionExec(item.alias, memberLoads, fedMeta);
        var fedOut = { alias: item.alias, bytes: merged.bytes, format: 'parquet', federated: true };
        if (item.overlap) fedOut.overlap = item.overlap;
        return fedOut;
      }
      // pxweb (spec 2026-07-24-pxweb-sources-design §2): hent json-stat2
      // (alltid lang-format, UTF-8 — default-CSV-en er pivotert og
      // iso-8859-1) og lever uttrekket som CSV-bytes med format 'csv' —
      // alle eksisterende csv-konsumenter virker uendret. Delt
      // _bufCache/proxy-fallback via fetchBytes på data-URL-en.
      // Offentlige API-data: maybeDecrypt/konvolutter er ikke aktuelle her.
      if (item.kind === 'pxweb' || item.kind === 'eurostat') {
        var PX = global.PxWeb;
        if (!PX) throw new Error('PxWeb-modulen mangler (js/pxweb.js må lastes før data-loader.js)');
        // all()-direktivet (Task 3, spec 2026-07-26-all-direktiv-design §3):
        // kun pxweb (Task 1 setter aldri item.all for eurostat — guard er
        // belte-og-seler). Hent metadata, ekspander base-tabell-URL-en til
        // valueCodes[*] for hver dimensjon uten eksplisitt utvalg (med
        // cellevakt), FØR den vanlige dataUrlFor/data-hentingen kjører — item
        // er en vanlig funksjonsparameter (ikke const), så reassignment her
        // er trygt og lokalt til denne map-kallbacken.
        if (item.all && item.kind === 'pxweb') {
          var metaBytesA = await fetchBytes(Object.assign({}, item, { url: PX.metadataUrl(item.url) }));
          var metaObjA = JSON.parse(new TextDecoder().decode(metaBytesA.buf));
          var expA = PX.expandAllUrl(item.url, metaObjA, PX.PXWEB_ALL_MAX_CELLS);
          if (expA.error) throw new Error(expA.error);
          item = Object.assign({}, item, { url: expA.url });
        }
        var fetchedPx;
        try {
          fetchedPx = await fetchBytes(Object.assign({}, item, { url: PX.dataUrlFor(item.kind, item.url) }));
        } catch (ePx) {
          // 400-oversettelse (spec 2026-07-31): «Missing selection» er den
          // målte hovedfeilen — oversett til en reparérbar melding med
          // gyldige koder, KUN på feilveien (én ekstra metadata-henting).
          var er400 = item.kind === 'pxweb' && /(HTTP|proxy) 400 /.test(String(ePx && ePx.message));
          if (!er400) throw ePx;
          var missingPx = [];
          try {
            var mBytes = await fetchBytes(Object.assign({}, item, { url: PX.metadataUrl(item.url) }));
            missingPx = PX.missingMandatory(item.url, JSON.parse(new TextDecoder().decode(mBytes.buf)));
          } catch (eMeta) { throw ePx; }   // metadata-feil → original feil
          if (!missingPx.length) throw ePx;
          throw new Error(PX.mandatoryErrorMessage(item.table || item.alias, missingPx));
        }
        var dsPx = JSON.parse(new TextDecoder().decode(fetchedPx.buf));
        var csvPx = PX.columnsToCsv(PX.columnsFromJsonStat(dsPx));
        // Typet kanonisk vei (plan 2026-07-27): CSV-en mister typesystemet
        // json-stat2 bærer — typemeta følger med SEPARAT så Pyodide-preamblet
        // kan gjenreise det (Categorical i kildens orden, tidsregelen, attrs).
        return { alias: item.alias, bytes: new TextEncoder().encode(csvPx),
                 format: 'csv', table: item.table, kind: 'pxweb',
                 typemeta: PX.typeMetaFromJsonStat(dsPx) };
      }
      // API-kinds (spec 2026-07-25-api-kinds-design §1): sdmx = CSV rett fra
      // API-et (Accept-vei m/ format=csvdata-fallback — ECB 406-er på Accept,
      // og 3.0-filtre ignoreres STILLE av 2.1-API-er, så vi sender aldri
      // uverifiserte parametre); worldbank/dbnomics = JSON → flatener → CSV.
      // Samme leveranseform som pxweb: CSV-bytes, alle konsumenter uendret.
      if (item.kind === 'sdmx' || item.kind === 'worldbank' || item.kind === 'dbnomics') {
        var AK = global.ApiKinds, PXc = global.PxWeb;
        if (!AK || !PXc) throw new Error('ApiKinds/PxWeb-modulen mangler (js/api-kinds.js må lastes før data-loader.js)');
        // Accept-vei m/format=csvdata-fallback — delt av datahenting og
        // nøkkel-introspeksjonsproben (samme to-forsøks-logikk begge steder).
        async function sdmxFetchCsv(url) {
          var f1 = null;
          try {
            f1 = await fetchBytes(Object.assign({}, item, { url: url, fetchHeaders: { 'Accept': AK.SDMX_ACCEPT } }));
          } catch (eAcc) {
            // 406 = kilden avviser Accept-veien (ECB) → param-fallback;
            // alt annet er ekte feil (404 NoResultsFound, 422 nøkkelform …).
            if (!/\b406\b/.test(String(eAcc && eAcc.message))) throw eAcc;
          }
          if (!f1 || AK.sdmxNeedsFallback(f1.resp.status, f1.resp.headers.get('content-type'))) {
            var f2 = await fetchBytes(Object.assign({}, item, { url: AK.sdmxFallbackUrl(url) }));
            return new TextDecoder().decode(f2.buf);
          }
          return new TextDecoder().decode(f1.buf);
        }
        var csvText;
        if (item.kind === 'sdmx') {
          var dataUrl = item.url;
          if (item.needsSdmxKey) {
            // Kanonisk countries()/indicators()/filters() (spec §3): bygg
            // punktumnøkkelen fra CSV-headeren til en lastNObservations=1-
            // probe mot /all — query-params ville blitt STILLE ignorert.
            var uq = item.url.indexOf('?');
            var uBase = uq >= 0 ? item.url.slice(0, uq) : item.url;
            var probeCsv = await sdmxFetchCsv(uBase.replace(/\/+$/, '') + '/all?lastNObservations=1');
            var dims = AK.sdmxKeyDims(probeCsv.split('\n')[0]);
            if (!dims.length) throw new Error('«' + item.alias + '»: fant ikke dimensjonene i kildens CSV-header — angi nøkkelstien selv (…/' + '<nøkkel>)');
            var keyPath;
            try { keyPath = AK.sdmxKeyPath(dims, item.needsSdmxKey); }
            catch (eKey) { throw new Error('«' + item.alias + '»: ' + eKey.message); }
            dataUrl = uBase.replace(/\/+$/, '') + '/' + keyPath + (uq >= 0 ? '?' + item.url.slice(uq + 1) : '');
          }
          csvText = await sdmxFetchCsv(dataUrl);
        } else if (item.kind === 'worldbank') {
          var wbUrl = AK.worldbankDataUrl(item.url);
          var d1 = JSON.parse(new TextDecoder().decode((await fetchBytes(Object.assign({}, item, { url: wbUrl }))).buf));
          var wbMeta = AK.worldbankMeta(d1);          // kaster norsk feil på WB-feilformen
          if (wbMeta.pages > 10) throw new Error('«' + item.alias + '»: ' + wbMeta.total + ' rader fordelt på ' + wbMeta.pages + ' sider — snevre inn spørringen (date=…, færre land/indikatorer)');
          var wbDocs = [d1];
          for (var wp = 2; wp <= wbMeta.pages; wp++) {
            wbDocs.push(JSON.parse(new TextDecoder().decode((await fetchBytes(Object.assign({}, item, { url: AK.worldbankPageUrl(item.url, wp) }))).buf)));
          }
          csvText = PXc.columnsToCsv(AK.worldbankColumns(wbDocs));
        } else {
          var dj = JSON.parse(new TextDecoder().decode((await fetchBytes(Object.assign({}, item, { url: AK.dbnomicsDataUrl(item.url) }))).buf));
          var dcols = AK.dbnomicsColumns(dj);
          if (item.clientYears) {
            // years() for dbnomics: API-et har ikke tidsvindu-parametre —
            // filtrer klient-side (trygt: vi holder alle radene, spec §3).
            var cy = item.clientYears;
            var keep = dcols.period.map(function (p) {
              var yr = parseInt(String(p).slice(0, 4), 10);
              if (!isNaN(yr)) {
                if (cy.from && yr < parseInt(cy.from, 10)) return false;
                if (cy.to && yr > parseInt(cy.to, 10)) return false;
              }
              return true;
            });
            Object.keys(dcols).forEach(function (col) {
              dcols[col] = dcols[col].filter(function (_, i) { return keep[i]; });
            });
          }
          csvText = PXc.columnsToCsv(dcols);
        }
        return { alias: item.alias, bytes: new TextEncoder().encode(csvText),
                 format: 'csv', table: item.table, kind: item.kind };
      }
      var fetched = await fetchBytes(item);
      var format = sniffFormat(fetched.resp, item.url, item.kind);
      var dec = await maybeDecrypt(item, fetched.buf, format, deps);
      var out = { alias: item.alias, bytes: dec.bytes, format: dec.format };
      if (item.table) out.table = item.table;
      if (item.kind) out.kind = item.kind;
      if (dec.envelope) { out.envelope = dec.envelope; out.key = dec.key; }
      // out.level is exposed for ANY registered grant, not just strict — the
      // sidebar's click-to-view gating needs the real level even for a
      // protected/sensitive source whose local_mode happens to be "open"
      // (allowed to run in the ordinary non-strict path). l.strict (only true
      // for local_profile==='strict') still separately gates the actual
      // STRICT execution route; this is purely informational for the UI.
      if (item.grant && item.grant.level) out.level = item.grant.level;
      if (item.grant && item.grant.local_profile === 'strict') {
        // strict-grant (spec 2026-07-05-browser-strict-execution §2): rammen
        // får KUN gå inn i safepy-fasaden; nivået velger policy-tier lokalt.
        out.strict = true;
        out.level = item.grant.level || 'protected';
      }
      return out;
    }));
  }

  function fetchSourceAccess(item, deps, fetchImpl) {
    var base = (deps.apiBase || '').replace(/\/+$/, '');
    if (!base) return Promise.reject(new Error('ingen API-base konfigurert for kilden «' + item.anvil + '»'));
    var headers = deps.authToken ? { 'Authorization': 'Bearer ' + deps.authToken } : {};
    return fetchImpl(base + '/_/api/source_access?id=' + encodeURIComponent(item.anvil), { headers: headers })
      .then(function (r) {
        if (r.status === 404) {
          // roadmap §2a: tagged so the UI can offer "request access" instead
          // of a dead end (POST /access_request, apiBase-relative — see
          // index.html's renderAccessDeniedError). Same message either way —
          // 404 here already means "unknown OR denied", never leak which.
          var e = new Error('Fant ikke kilden «' + item.anvil + '» eller du mangler tilgang — logg inn, eller kontakt eieren.');
          e.accessDenied = true;
          e.sourceId = item.anvil;
          e.apiBase = base;
          throw e;
        }
        if (!r.ok) throw new Error('source_access ' + r.status + ' for «' + item.anvil + '»');
        return r.json();
      });
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
    if (item.grant && item.grant.fingerprint && computed !== item.grant.fingerprint)
      throw new Error('«' + item.alias + '»: filen er endret siden den ble registrert — kontakt eieren');
    var key;
    if (item.grant && item.grant.local_profile === 'strict') {
      // Strict: nøkkelen kommer fra per-kjørings-autorisasjonen (V3) eller et
      // eksplisitt key()-literal (mode 2). ALDRI promptKey/økt-cache — mangler
      // nøkkelen, nektes kjøringen.
      key = (item.grant && item.grant.key) || (item.key && item.key !== 'ask' ? item.key : null);
      if (!key) throw new Error('«' + item.alias + '»: kjøringen ble ikke autorisert med nøkkel — strict-kilder bruker aldri lagrede/spurte nøkler; prøv igjen eller bruk key(<nøkkel>)');
    } else {
      key = (item.key && item.key !== 'ask') ? item.key
          : (item.grant && item.grant.key) ? item.grant.key
          : deps.promptKey ? await deps.promptKey(item.alias)
          : null;
      if (!key) throw new Error('«' + item.alias + '» er kryptert og krever nøkkel — bruk key(...) eller key(ask)');
    }
    if (item.grant && item.grant.local_profile === 'strict') {
      // V4 (spec browser-strict): ingen klartekst i JS eller på Pyodide-FS for
      // strict — konvolutten og nøkkelen sendes videre og dekrypteres først
      // INNE i kjøringen (safepy.encfile); klartekst slippes etter kjøringen.
      return { bytes: null, format: env.payload_format || 'csv', envelope: env, key: key };
    }
    var plain = await EC.decryptEnvelope(env, key);
    return { bytes: plain, format: env.payload_format || 'csv' };
  }

  // Project A: fetch the SOURCES a spec needs (each connect alias as a whole
  // table), honoring grants/decrypt/remote routing exactly like load does, and
  // return the spec so the runtime can assemble. Same fetch layer as
  // resolveAndFetchLoads — only the shape of the request changes.
  // Monteringen bygger lastelisten DIREKTE (DD.makeLoad) i stedet for å skrive
  // et hjelpe-script og parse det tilbake. Tekstveien døde stille to ganger:
  // «# connect …»-filteret traff ingen linjer og «# load <a> as <a>» ble
  // ignorert av den nye grammatikken, så spec.sources ble aldri hentet —
  // montering i web-modus returnerte tomt uten én feilmelding. En streng som
  // skrives ett sted og leses av parseren et annet har ingen kobling mellom
  // seg; et objekt bygget på parserens egen form kan ikke drifte fra den.
  // Connect-listen tas rett fra parsetreet: DD.parse(<hele scriptet>).connects
  // er identisk med å parse et filtrert utvalg av connect-linjene.
  // srcKey er «<alias>» eller «<alias>__<tabell>» (se parseAssembly.noteSource).
  function synthSourceLoads(script, spec, DD) {
    var tables = spec.sourceTables || {};
    return {
      connects: DD.parse(script).connects,
      loads: spec.sources.map(function (a) {
        var t = tables[a];
        return DD.makeLoad({ alias: a, source: t ? t.source : a, table: t ? t.table : null });
      }),
      metas: [], errors: []
    };
  }

  async function resolveAndAssemble(script, deps) {
    deps = deps || {};
    var DD = global.DataDirectives;
    if (!DD) return { sources: [], remote: [], spec: { sources: [], datasets: [] } };
    var parsed = DD.parseAssembly(script);
    if (parsed.errors.length) throw new Error('Monteringsfeil: ' + parsed.errors.join('; '));
    var spec = parsed.spec;
    if (!spec.sources.length) return { sources: [], remote: [], spec: spec };

    // Én lesing per spec-kilde gjennom den vanlige lastepipelinen, så hver
    // kilde hentes nøyaktig én gang (scriptets egne read-linjer er ikke med).
    var loaded = await resolveAndFetchLoads(synthSourceLoads(script, spec, DD), deps);
    return { sources: loaded.loads, remote: loaded.remote, spec: spec };
  }

  // Phase 2: resolve connect/load/import/join into per-source {url, format,
  // table} WITHOUT fetching bytes — used to decide pushdown-eligibility and
  // to feed AssemblyDuckdb.compile() before any network request happens.
  async function resolveSourcesOnly(script, deps) {
    deps = deps || {};
    var DD = global.DataDirectives;
    if (!DD) return { spec: { sources: [], datasets: [] }, descriptors: {} };
    var parsed = DD.parseAssembly(script);
    if (parsed.errors.length) throw new Error('Monteringsfeil: ' + parsed.errors.join('; '));
    var spec = parsed.spec;
    var parsedLoads = synthSourceLoads(script, spec, DD);
    // Same registry-loading convention as resolveAndFetchLoads: use whatever
    // was passed in, or load+memoize the web registry on demand (a tiny JSON
    // manifest, not the large source itself — resolving named registry
    // sources correctly here matters more than avoiding this one small fetch).
    var fetchImpl = deps.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(global) : null);
    var registry = deps.registry || (fetchImpl ? await loadRegistry(fetchImpl) : []);
    var resolved = DD.resolve(parsedLoads, registry);
    var descriptors = {};
    resolved.forEach(function (r) {
      if (r.error || r.anvil || r.federated) return; // protected/anvil/error/federert er aldri pushdown-kandidater
      // .csv-sniff siden trinn B: bare .parquet/.csv-endelser gjenkjennes uten
      // eksplisitt kind() — alt annet er 'other' og aldri pushdown-kandidat.
      descriptors[r.alias] = { url: r.url,
        format: r.kind || (/\.parquet(\?|$)/.test(r.url) ? 'parquet' : /\.csv(\?|$)/.test(r.url) ? 'csv' : 'other'),
        table: r.table };
    });
    return { spec: spec, descriptors: descriptors };
  }

  global.DataLoader = { proxyHeaders: proxyHeaders, resolveAndFetchLoads: resolveAndFetchLoads, resolveAndAssemble: resolveAndAssemble,
    resolveSourcesOnly: resolveSourcesOnly, fetchResolvedItems: fetchResolvedItems, fetchRawUrl: fetchRawUrl, _sniffFormat: sniffFormat,
    _parseCacheTtl: parseCacheTtl,
    // Test-only: the cross-run fetch cache is module-scoped by design (see
    // _bufCache above), which is exactly wrong for a test file that evals
    // this module once and shares it across every Deno.test case — without
    // this, tests using the same placeholder URL leak cached bytes into
    // each other. Not used by index.html.
    _resetCacheForTests: function () { _bufCache = {}; } };
})(typeof window !== 'undefined' ? window : globalThis);
