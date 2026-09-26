// js/read-bridge.js — pandas-URL-broen (plan 2026-07-27-pandas-url-bro).
// «pd.read_csv("https://…")» i motorene ruter hit: skann-og-prefetch mens
// motoren booter (HINT — en bom koster ventetid, aldri korrekthet), byte-
// cache, og synkrone fasader for motorer som ikke kan vente (Pyodide kjører
// på main thread; Brython/MicroPython bruker replay-broen i sine motorfiler).
(function (global) {
  'use strict';

  var cache = Object.create(null);   // url -> {bytes, contentType} | {error}
  var inflight = Object.create(null);

  // S5: /api/hent er auth-portet — broen må sende samme headere som
  // direktiv-veien. depsFn settes av index.html (configure() eller den
  // lastrekkefølge-uavhengige window.__readBridgeDeps-kroken) og kalles ved
  // HVER henting, så en nøkkel lagt inn midt i økten plukkes opp.
  var depsFn = null;
  function currentDeps() {
    if (depsFn) return depsFn();
    var g = global.__readBridgeDeps;
    return typeof g === 'function' ? g() : undefined;
  }

  // Testbar henter — produksjon bruker DataLoader.fetchRawUrl (proxy-fallback
  // + høylytte HTTP-feil bor DER, ikke her). Default holdes ved navn så
  // _reset() kan gjenopprette den — uten det lekker en tests _setFetcher inn
  // i neste (funnet da configure-testen aldri nådde DataLoader).
  function defaultFetcher(url) { return global.DataLoader.fetchRawUrl(url, currentDeps()); }
  var fetcher = defaultFetcher;

  // Rene string-literaler i leserne — python/duckdb-formene (read_csv m.fl.)
  // OG R-formene (read.csv/read.csv2/fromJSON; readr::read_csv dekkes av
  // read_csv). BEVISST enkel: variabler og uttrykk dekkes av runtime-veiene.
  var SCAN_RE = /\b(?:read_(?:csv|json|parquet)|read\.csv2?|fromJSON)\(\s*(['"])((?:https?:\/\/|\/api\/hent\?)[^'"\n]+)\1/g;

  function scanUrls(script) {
    var out = [], seen = Object.create(null), m;
    SCAN_RE.lastIndex = 0;
    while ((m = SCAN_RE.exec(String(script || ''))) !== null) {
      if (!seen[m[2]]) { seen[m[2]] = true; out.push(m[2]); }
    }
    return out;
  }

  function ensure(url) {
    var c = cache[url];
    // Bytes er autoritative; en cachet FEIL er retrybar — en transient 500
    // under prefetch skal ikke forgifte økten (hint-prinsippet: en mislykket
    // prefetch koster tid, aldri korrekthet).
    if (c && !c.error) return Promise.resolve(c);
    if (inflight[url]) return inflight[url];
    inflight[url] = fetcher(url).then(function (r) {
      cache[url] = { bytes: r.bytes, contentType: r.contentType };
      return cache[url];
    }, function (e) {
      // Feil CACHES — et kast her ville forsvunnet i fire-and-forget-
      // prefetchen, og sync-oppslaget etterpå må kunne rapportere den.
      cache[url] = { error: (e && e.message) || String(e) };
      return cache[url];
    }).finally(function () { delete inflight[url]; });
    return inflight[url];
  }

  // M2: dekod med charset fra Content-Type (SSB serverer iso-8859-1!), og
  // FATAL utf-8 som fallback — TextDecoder uten fatal gjør norske etiketter
  // til stille U+FFFD-mojibake, som er verre enn en høylytt feil. Teksten
  // memoiseres på entryen (dekoding per replay-pass er bortkastet).
  function decodeEntry(entry, url) {
    if (entry.error) return { error: entry.error };
    if (entry.text !== undefined) return { text: entry.text };
    var m = /charset=([\w-]+)/i.exec(entry.contentType || '');
    var enc = m ? m[1].toLowerCase() : 'utf-8';
    try {
      entry.text = new TextDecoder(enc, { fatal: true }).decode(entry.bytes);
      return { text: entry.text };
    } catch (e) {
      return { error: 'kunne ikke dekode svaret fra ' + url + ' som ' + enc +
                      (m ? '' : ' (ingen charset i Content-Type — er kilden utf-8?)') };
    }
  }

  // Tekstfasaden brython/mpy-flushene bruker: deler cache, deps (auth) og
  // retry-semantikk med resten av broen — unifiseringen fra Task 10-vurderingen.
  function ensureText(url) {
    return ensure(url).then(function (entry) { return decodeEntry(entry, url); });
  }

  function prefetchScript(script) {
    scanUrls(script).forEach(function (u) {
      ensure(u);
      // Metadata-hint (metadata-runden Task 3; premisset snudd i runtime-
      // ost-runden): gjenkjent registerkilde -> prefetch json-stat2-formen
      // av SAMME spørring. Fødsels-annoteringen i Pyodide (_ost_annotate_read
      // -> openstat._typemeta_for -> _fetch_bytes) ruter nå via
      // forPyodideSync, så hinten varmer NETTOPP den cachen Python leser —
      // treff = null ventetid under read_csv-kallet. Ren hint fortsatt: en
      // bom (f.eks. avvik mellom dataUrlFor og py-tvillingens data_url)
      // koster ventetid, aldri korrekthet — sync-veien henter selv.
      var rec = global.PxWeb && global.PxWeb.recognizeUrl ? global.PxWeb.recognizeUrl(u) : null;
      if (rec && global.PxWeb.dataUrlFor) {
        var t = rec.base + '/' + rec.table + (rec.query ? '?' + rec.query : '');
        ensure(global.PxWeb.dataUrlFor(rec.kind, t));
      }
    });
  }

  function getCached(url) { return cache[url] || null; }

  // Synkron XHR for cache-miss i Pyodide (dynamisk bygde URL-er). Kun
  // main thread — og sync XHR kan ikke bruke responseType, så binærdata
  // hentes med x-user-defined-trikset (charCode & 0xff per byte).
  function syncXhr(url, headers) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    for (var h in (headers || {})) xhr.setRequestHeader(h, headers[h]);
    try { xhr.send(null); } catch (e) { return { status: 0, bytes: null }; }
    if (xhr.status === 0 || xhr.status >= 400) return { status: xhr.status, bytes: null };
    var t = xhr.responseText, u8 = new Uint8Array(t.length);
    for (var i = 0; i < t.length; i++) u8[i] = t.charCodeAt(i) & 0xff;
    return { status: xhr.status, bytes: u8,
             truncated: xhr.getResponseHeader('x-hent-truncated') === '1' };
  }

  // Test-hook (_setXhr) av samme grunn som _setFetcher: sync-XHR-veien er
  // den mest risikable koden i modulen og skal ikke være usett av CI.
  var xhrImpl = null;
  function xhr(url, headers) { return (xhrImpl || syncXhr)(url, headers); }

  // Auth-headere for /api/hent, flettet over evt. custom-headere (auth vinner).
  function proxyAuthHeaders(hdrs) {
    var d = currentDeps() || {};
    var ph = (global.DataLoader && global.DataLoader.proxyHeaders)
      ? global.DataLoader.proxyHeaders(d.authToken, d.anthropicKey) : {};
    return hdrs ? Object.assign({}, hdrs, ph) : ph;
  }

  function forPyodideSync(url, headersJson) {
    // Runtime-ost (plan 2026-07-28): valgfri headers-JSON fra openstat.py
    // (_fetch_bytes, SDMX-Accept). JSON-streng, ikke objekt — en Python-dict
    // blir PyProxy på JS-siden og for..in enumererer den ikke. Ikke-tomme
    // headere BYPASSER cachen (les OG skriv): den er URL-nøklet, og en
    // Accept-header endrer svaret (SDMX: csv vs xml) — delt oppføring ville
    // vært stille feil data. Ugyldig JSON returneres som error (aldri kast —
    // kalleren er synkron Python).
    var hdrs = null;
    if (headersJson) {
      try { hdrs = JSON.parse(headersJson); }
      catch (e) { return { bytes: null, error: 'ugyldig headers-JSON for ' + url + ': ' + e.message }; }
      // Shape-vakt (slutt-review): '"hello"'/[1] er gyldig JSON men ikke
      // headere — for..in over dem gir nonsens-headernavn i syncXhr.
      if (!hdrs || typeof hdrs !== 'object' || Array.isArray(hdrs) || Object.keys(hdrs).length === 0) hdrs = null;
    }
    var c = hdrs ? null : cache[url];
    if (c && !c.error) return { bytes: c.bytes, error: null };
    // En cachet FEIL behandles som miss: sync-veien får prøve selv.
    var canXhr = xhrImpl || typeof XMLHttpRequest !== 'undefined';
    if (!canXhr) {
      return { bytes: null, error: (c && c.error) || ('ingen cache-oppføring og ingen XHR for ' + url) };
    }
    // En URL som ALLEREDE går via proxyen (/api/hent?url=…) er auth-portet —
    // send auth-headerne på første forsøk (retry-grenen under hopper over
    // slike URL-er, så de fikk ellers alltid 401).
    var isProxyUrl = url.indexOf('/api/hent?') === 0;
    var r = xhr(url, isProxyUrl ? proxyAuthHeaders(hdrs) : (hdrs || undefined));
    // Proxy KUN ved status 0 (CORS/nettverk) — samme konvensjon som
    // fetchRawUrl/fetchLoadTarget. En ekte 404 er like ekte via proxyen,
    // og «HTTP 404» er en klarere melding enn «proxy 404».
    if (r.bytes === null && r.status === 0 && url.indexOf('/api/hent?') !== 0) {
      // S5: samme auth-headere som direktiv-veien — proxyen er auth-portet.
      // Custom-headere flettes inn (hent-core videresender accept oppstrøms,
      // api-kinds-spec §4.4 — andre custom-headere dør i proxyen, dokumentert
      // i runtime-ost-spec §1). Auth VINNER kollisjoner (slutt-review): en
      // caller-«Authorization» skal aldri stille slå ut nøkkelen mot porten.
      r = xhr('/api/hent?url=' + encodeURIComponent(url), proxyAuthHeaders(hdrs));
    }
    // x-hent-truncated (R-URL-bro-oppfølging §2): dekker begge legg
    // (direkte OG proxy-retry) — en avkortet CSV er feil data og skal
    // feile høylytt, ALDRI caches (samme aldri-stille-kontrakt som
    // fetchRawUrl/fetchLoadTarget i data-loader.js).
    if (r.bytes !== null && r.truncated) {
      return { bytes: null, error: 'avkortet ved proxyens 50MB-grense (x-hent-truncated) for ' + url };
    }
    if (r.bytes === null) {
      return { bytes: null, error: (r.status ? 'HTTP ' + r.status : 'CORS/nettverksfeil') + ' for ' + url };
    }
    if (!hdrs) cache[url] = { bytes: r.bytes, contentType: '' };
    return { bytes: r.bytes, error: null };
  }

  // R-factor-runden §2: typemeta for en data-URL, til panelberikelse av
  // R-rammer (main thread — sveipen er async). Deler bro-cachen: prefetch-
  // hinten og runtime-hentinger gjenbrukes gratis. null ved ukjent/feil —
  // panelet viser da bare det rammen selv kan fortelle. Aldri reject.
  function typemetaForUrl(url) {
    var px = global.PxWeb;
    if (!px || !px.metaUrlFor) return Promise.resolve(null);
    // Aldri-reject-kontrakten gjelder også SYNKRONE kast: et uventet unntak
    // fra metaUrlFor skal bli null + warn, ikke smelle ut av panelet.
    var mu;
    try { mu = px.metaUrlFor(url); }
    catch (e) { console.warn('typemetaForUrl:', url, (e && e.message) || e); return Promise.resolve(null); }
    if (!mu) return Promise.resolve(null);
    return ensureText(mu).then(function (r) {
      if (r.error) { console.warn('typemetaForUrl:', url, r.error); return null; }
      try { return px.typeMetaFromJsonStat(JSON.parse(r.text)); }
      catch (e) { console.warn('typemetaForUrl:', url, (e && e.message) || e); return null; }
    });
  }

  // Python-kilden for Pyodide-wrapperne. Ligger HER (ikke inline i
  // index.html) så node-testene kan asserte på den. Kontrakt: URL-argument →
  // bro; alt annet → original uendret (standalone-paritet). HTTP-feil →
  // ValueError med status og URL, FØR parsing.
  function pyPatchSource() {
    return [
      'import io as _ost_io',
      'def _ost_url_buf(_p):',
      '    from js import window as _ost_w',
      '    _r = _ost_w.ReadBridge.forPyodideSync(str(_p))',
      '    if _r.error:',
      '        raise ValueError(str(_r.error))',
      '    return _ost_io.BytesIO(bytes(_r.bytes.to_py()))',
      'def _ost_annotate_read(_orig, _url, _a, _kw):',
      '    # Fødsels-ANNOTERING (eksplisitt-dtypes-kirurgien 2026-07-28, jf.',
      '    # Hans sitt overraskelsesprinsipp): pd.read_csv i appen skal ALDRI',
      '    # magisk endre dtyper — den skal være byte-lik naken pandas i',
      '    # verdier OG dtyper for BRUKERENS EGNE kwargs. Denne funksjonen gjør',
      '    # ETT eneste ekstra steg for en gjenkjent register-URL: setter',
      '    # df.attrs["ost_typemeta"] (metadata hentet best-effort, ALDRI',
      '    # blokkerende) — så panelet fortsatt kan vise etiketter/nivåer/',
      '    # enheter automatisk. Typing (dtype=str-vern/category/Int64) flyttet',
      '    # til de eksplisitte funksjonene i openstat.py: read_csv(url,',
      '    # convert=True) (default) og convert_dtypes(df, meta=...). ALDRI',
      '    # dupliser typereglene her — kun recognize_url/_typemeta_for brukes.',
      '    try:',
      '        import openstat as _ost',
      '    except Exception as _e:',
      '        print("fødsels-annotering: openstat.py utilgjengelig (", _e, ") — fortsetter uten metadata")',
      '        return _orig(_ost_url_buf(_url), *_a, **_kw)',
      '    _rec = _ost.recognize_url(_url)',
      '    _buf = _ost_url_buf(_url)',
      '    if _rec is None:',
      '        return _orig(_buf, *_a, **_kw)',
      '    _tm = None',
      '    try:',
      '        _tm = _ost._typemeta_for(_rec["kind"], _rec["base"], _rec["table"], _rec["query"])',
      '    except Exception as _e:',
      '        print("fødsels-annotering: metadata utilgjengelig for", _rec["table"], "(", _e, ") — fortsetter uten")',
      '    _df = _orig(_buf, *_a, **_kw)',
      '    if _tm is not None:',
      '        _df.attrs["ost_typemeta"] = _tm',
      '    return _df',
      'def _ost_wrap_reader(_orig, _annotate):',
      '    # Idempotens-vakt: kjerne-preamblet re-kjøres per kjøring, og uten',
      '    # denne stables wrapperne én per run (målt: _w x4 i en traceback).',
      '    if getattr(_orig, "_ost_url_wrapped", False):',
      '        return _orig',
      '    def _w(*a, **kw):',
      '        if not a:',
      '            return _orig(*a, **kw)',
      '        _fp = a[0]',
      '        if isinstance(_fp, str) and (_fp.startswith("http://") or _fp.startswith("https://") or _fp.startswith("/api/hent?")):',
      '            if _annotate:',
      '                return _ost_annotate_read(_orig, _fp, a[1:], kw)',
      '            return _orig(_ost_url_buf(_fp), *a[1:], **kw)',
      '        return _orig(*a, **kw)',
      '    _w._ost_url_wrapped = True',
      '    return _w',
      '# KUN read_csv annoteres ved fødsel — json/parquet bærer allerede egen struktur (ingen CSV-parsefelle).',
      'pd.read_csv = _ost_wrap_reader(pd.read_csv, True)',
      'pd.read_json = _ost_wrap_reader(pd.read_json, False)',
      'pd.read_parquet = _ost_wrap_reader(pd.read_parquet, False)',
      ''
    ].join('\n');
  }

  // R-kilden for webR-patchene (plan 2026-07-28-r-url-bro). Ligger HER så
  // node-testene kan asserte på den (pyPatchSource-presedensen). Kjøres én
  // gang ved webR-boot (evalRVoid) — all idempotens håndteres R-side.
  // Mekanikken er fase 0-verifisert: eval_js kjører worker-lokalt på
  // PostMessage-kanalen, workerens origin = sidens origin, Module.FS er
  // tilgjengelig fra eval_js, og utils krever unlockBinding (assignInNamespace
  // nekter på låst base-binding).
  function rPatchSource() {
    return [
      'if (!exists(".ost_bridge", envir = globalenv(), inherits = FALSE)) {',
      '  .ost_bridge <- new.env(parent = emptyenv())',
      '  .ost_bridge$paths   <- new.env(parent = emptyenv())',
      '  .ost_bridge$fetched <- new.env(parent = emptyenv())',
      '  .ost_bridge$origin  <- ""',
      '  .ost_bridge$headers <- "{}"',
      '  .ost_bridge$n       <- 0L',
      '}',
      // Kontrolltegn i input knakk den genererte JS-strengen (R-URL-bro-
      // oppfølging §3): \n/\r/\t escapes til gyldig JS-strengliteral-form,
      // øvrige C0-tegn (\x01-\x1f) droppes (ugyldige i URL/sti uansett).
      // fixed=TRUE overalt unntatt C0-klassen (som nødvendigvis er regex).
      '.ost_json_str <- function(s) {',
      '  s <- gsub("\\\\", "\\\\\\\\", s, fixed = TRUE)',
      '  s <- gsub("\\"", "\\\\\\"", s, fixed = TRUE)',
      '  s <- gsub("\\n", "\\\\n", s, fixed = TRUE)',
      '  s <- gsub("\\r", "\\\\r", s, fixed = TRUE)',
      '  s <- gsub("\\t", "\\\\t", s, fixed = TRUE)',
      '  s <- gsub("[\\x01-\\x1f]", "", s)',
      '  paste0("\\"", s, "\\"")',
      '}',
      '.ost_bridge_config <- function(origin, headers_json) {',
      '  .ost_bridge$origin <- origin; .ost_bridge$headers <- headers_json; invisible(NULL)',
      '}',
      '.ost_bridge_seed <- function(url, path) { assign(url, path, envir = .ost_bridge$paths); invisible(NULL) }',
      '.ost_bridge_fetched_json <- function() {',
      '  us <- ls(.ost_bridge$fetched)',
      '  if (!length(us)) return("[]")',
      '  es <- vapply(us, function(u) { e <- get(u, envir = .ost_bridge$fetched)',
      '    paste0("{\\"url\\":", .ost_json_str(u), ",\\"path\\":", .ost_json_str(e$path),',
      '           ",\\"contentType\\":", .ost_json_str(e$ct), "}") }, character(1))',
      '  paste0("[", paste(es, collapse = ","), "]")',
      '}',
      '.ost_is_bridge_url <- function(x) is.character(x) && length(x) == 1L && !is.na(x) &&',
      '  grepl("^(https?://|/api/hent\\\\?)", x)',
      // Henteren: manifest-treff -> lokal sti; ellers worker-XHR (direkte, så
      // proxy-retry ved status 0) -> bytes til FS -> sti. Høylytt ved feil.
      '.ost_fetch <- function(url) {',
      '  hit <- mget(url, envir = .ost_bridge$paths, ifnotfound = list(NULL))[[1]]',
      '  if (!is.null(hit)) return(hit)',
      '  .ost_bridge$n <- .ost_bridge$n + 1L',
      '  path <- paste0("/ost_cache/rt_", .ost_bridge$n, ".bin")',
      '  abs_url <- if (startsWith(url, "/api/hent?")) paste0(.ost_bridge$origin, url) else url',
      '  proxy_url <- paste0(.ost_bridge$origin, "/api/hent?url=", utils::URLencode(url, reserved = TRUE))',
      '  js <- paste0(',
      '    "(function(){",',
      '    "  function go(u, withHeaders){",',
      '    "    var x = new XMLHttpRequest();",',
      '    "    x.open(\\"GET\\", u, false);",',
      '    "    x.overrideMimeType(\\"text/plain; charset=x-user-defined\\");",',
      '    "    if (withHeaders) { var H = ", .ost_bridge$headers, "; for (var k in H) x.setRequestHeader(k, H[k]); }",',
      '    "    try { x.send(null); } catch (e) { return { status: 0 }; }",',
      '    "    return x;",',
      '    "  }",',
      '    "  try {",',
      '    "    var direct = ", if (startsWith(url, "/api/hent?")) "true" else "false", ";",',
      '    "    var x = go(", .ost_json_str(abs_url), ", direct);",',
      '    "    if (x.status === 0 && !direct) x = go(", .ost_json_str(proxy_url), ", true);",',
      '    "    if (x.status === 0 || x.status >= 400) return \\"ERR:HTTP \\" + x.status;",',
      '    "    if (x.getResponseHeader(\\"x-hent-truncated\\")) return \\"ERR:avkortet ved proxyens 50MB-grense (x-hent-truncated)\\";",',
      '    "    var t = x.responseText, u8 = new Uint8Array(t.length);",',
      '    "    for (var i = 0; i < t.length; i++) u8[i] = t.charCodeAt(i) & 0xff;",',
      '    "    try { Module.FS.mkdir(\\"/ost_cache\\"); } catch (e) {}",',
      '    "    Module.FS.writeFile(", .ost_json_str(path), ", u8);",',
      '    "    return \\"OK:\\" + (x.getResponseHeader(\\"Content-Type\\") || \\"\\");",',
      '    "  } catch (e) { return \\"ERR:\\" + String(e).slice(0, 200); }",',
      '    "})()")',
      '  res <- as.character(webr::eval_js(js))',
      '  if (!startsWith(res, "OK:")) {',
      '    code <- sub("^ERR:", "", res)',
      '    stop("kunne ikke hente ", url, " (", if (nzchar(code)) code else "ukjent feil",',
      '         "). CORS-stengte kilder krever /api/hent-proxy og n\\u00f8kkel/innlogging i AI-innstillingene.")',
      '  }',
      '  assign(url, list(path = path, ct = sub("^OK:", "", res)), envir = .ost_bridge$fetched)',
      '  path',
      '}',
      // Wrapper: posisjonelt ELLER navngitt fil-argument (M1-pariteten).
      '.ost_wrap_reader <- function(orig, argname) {',
      '  if (isTRUE(attr(orig, ".ost_wrapped"))) return(orig)',
      '  w <- function(...) {',
      '    a <- list(...); nm <- names(a); if (is.null(nm)) nm <- rep("", length(a))',
      '    idx <- match(argname, nm)',
      '    if (is.na(idx) && length(a) && nm[1] == "") idx <- 1L',
      '    u <- NULL',
      '    if (!is.na(idx) && .ost_is_bridge_url(a[[idx]])) { u <- a[[idx]]; a[[idx]] <- .ost_fetch(u) }',
      '    res <- do.call(orig, a)',
      '    # R-factor §1: proveniens for panelberikelsen — KUN et attributt,',
      '    # verdiene er byte-like (overraskelsesprinsippet). Gjenkjenning',
      '    # (registerkilde eller ei) avgjøres JS-side i sveipen.',
      '    if (!is.null(u) && is.data.frame(res)) attr(res, "ost_url") <- u',
      '    res',
      '  }',
      '  attr(w, ".ost_wrapped") <- TRUE',
      '  w',
      '}',
      // utils er base: assignInNamespace NEKTER (låst binding) — unlockBinding
      // på BÅDE namespacet og package-env (verifisert i fase 0-spiken).
      '.ost_patch_binding <- function(env, name, argname) {',
      '  if (!exists(name, envir = env, inherits = FALSE)) return(invisible(NULL))',
      '  cur <- get(name, envir = env)',
      '  patched <- .ost_wrap_reader(cur, argname)',
      '  if (identical(patched, cur)) return(invisible(NULL))',
      '  if (bindingIsLocked(name, env)) { unlockBinding(name, env); on.exit(lockBinding(name, env), add = TRUE) }',
      '  assign(name, patched, envir = env)',
      '  invisible(NULL)',
      '}',
      '.ost_patch_pkg <- function(pkg, funs, argname) {',
      '  if (!requireNamespace(pkg, quietly = TRUE)) return(invisible(NULL))',
      '  for (f in funs) {',
      '    .ost_patch_binding(asNamespace(pkg), f, argname)',
      '    pe <- paste0("package:", pkg)',
      '    if (pe %in% search()) .ost_patch_binding(as.environment(pe), f, argname)',
      '  }',
      '  invisible(NULL)',
      '}',
      '.ost_install_bridge <- function() {',
      '  .ost_patch_pkg("utils", c("read.csv", "read.csv2"), "file")',
      '  .ost_patch_pkg("jsonlite", "fromJSON", "txt")',
      '  .ost_patch_pkg("readr", c("read_csv", "read_csv2"), "file")',
      // Sen-lastede pakker (webr::install midt i økten): onLoad-krok.
      '  setHook(packageEvent("jsonlite", "onLoad"), function(...) .ost_patch_pkg("jsonlite", "fromJSON", "txt"))',
      '  setHook(packageEvent("readr", "onLoad"), function(...) .ost_patch_pkg("readr", c("read_csv", "read_csv2"), "file"))',
      '  invisible(NULL)',
      '}',
      '.ost_install_bridge()',
      ''
    ].join('\n');
  }

  // ── S4: publiserings-sømmen ───────────────────────────────────────────────
  // Publiserte dokumenter er appens egen index.html med injiserte tags.
  // I stedet for å skrive om brukerens read_csv-linjer bakes BRO-CACHEN som
  // tags ved publisering (exportTags), og leses tilbake ved sidelast
  // (seedFromDocument) — read_csv(url) treffer da cachen i ALLE motorene
  // (Pyodide via forPyodideSync, brython/mpy via ensureText) uten nett.
  // b64 hele veien: parquet er binært, og tekst tåler rundturen uansett.
  // Dynamisk bygde URL-er bakes ikke (hint-prinsippet: publisert side henter
  // dem live, CORS tillatende).
  function b64FromBytes(u8) {
    var s2 = '';
    for (var i = 0; i < u8.length; i++) s2 += String.fromCharCode(u8[i]);
    return (typeof btoa !== 'undefined') ? btoa(s2) : Buffer.from(u8).toString('base64');
  }
  function bytesFromB64(b64) {
    if (typeof atob !== 'undefined') {
      var bin = atob(b64), u8 = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  function exportTags(script) {
    var out = [];
    scanUrls(script).forEach(function (u) {
      var c = cache[u];
      if (c && c.bytes) out.push({ url: u, contentType: c.contentType || '', b64: b64FromBytes(c.bytes) });
    });
    return out;
  }

  // Post-run-import fra webR-FS (R-URL-broen): runtime-hentede bytes inn i
  // cachen så exportTags baker dem ved publisering (S4b) uten ny henting.
  function insertBytes(url, bytes, contentType) {
    if (!(bytes instanceof Uint8Array)) throw new Error('insertBytes krever Uint8Array');
    cache[url] = { bytes: bytes, contentType: contentType || '' };
  }

  function _seedEntries(list) {
    (list || []).forEach(function (e) {
      if (!e || typeof e.url !== 'string' || typeof e.b64 !== 'string') return;
      try { cache[e.url] = { bytes: bytesFromB64(e.b64), contentType: e.contentType || '' }; }
      catch (err) { /* én råtten tag skal ikke velte resten */ }
    });
  }

  function seedFromDocument() {
    if (typeof document === 'undefined') return;
    var nodes = document.querySelectorAll('script[type="application/json"][id^="ostbridgedata_"]');
    for (var i = 0; i < nodes.length; i++) {
      try { _seedEntries([JSON.parse(nodes[i].textContent)]); } catch (e) { /* som over */ }
    }
  }

  global.ReadBridge = {
    configure: function (f) { depsFn = f; },
    scanUrls: scanUrls, prefetchScript: prefetchScript, ensure: ensure, ensureText: ensureText,
    getCached: getCached, forPyodideSync: forPyodideSync, typemetaForUrl: typemetaForUrl, pyPatchSource: pyPatchSource,
    rPatchSource: rPatchSource,
    exportTags: exportTags, seedFromDocument: seedFromDocument, _seedEntries: _seedEntries,
    insertBytes: insertBytes,
    _reset: function () { cache = Object.create(null); inflight = Object.create(null); xhrImpl = null; fetcher = defaultFetcher; depsFn = null; },
    _setFetcher: function (f) { fetcher = f; },
    _setXhr: function (f) { xhrImpl = f; },
  };
  // Publisert side: les bakte tags med én gang modulen laster (DOM-en med
  // tags ligger FØR denne script-taggen i dokumentet, så den finnes nå).
  seedFromDocument();
})(typeof window !== 'undefined' ? window : globalThis);
