// Portabel eksport (spec 2026-07-23-portable-export-design): transpilerer
// # connect/# load-direktiver til frittstående lastekode. Nøkkelinnsikt:
// utenfor nettleseren finnes ikke CORS, så /api/hent-innpakkede URL-er
// pakkes UT til direkte kilde-URL-er. Direktivlinjene erstattes på stedet
// (original beholdt som kommentar over); alt annet passerer uendret.
// Testes i deno via eval (portable-export.test.ts).
(function (global) {
  'use strict';

  var HEADER = [
    '# ── Portabel eksport fra OpenStat ──',
    '# «# read»-direktivene er oversatt til frittstående lastekode.',
    '# Generert av appen — rediger fritt.',
  ];

  // Nøkkelmaskering SKOPET til direktivlinjer: en helskript-scrub ødela
  // legitim kode med key(...)-formede kall — f.eks. ble
  // «dt <- data.table::key(dt)» til «data.table::key(***)». Bare linjer som
  // ser ut som direktiv-kommentarer kan bære nøkkelliteraler.
  //
  // Den nye syntaksen dekkes av DD.isDirectiveLine (parsetreet). Legacy-halen
  // står IGJEN med vilje og må ikke fjernes: «# load https://x/d.enc.json
  // key(hemmelig)» (uten «as») er malformert, så ingen grammatikk kjenner den
  // igjen — isDirectiveLine er false — og linja ville gått umaskert ut i
  // eksporten. Halen er altså en nøkkellekkasje-vakt, ikke en verbliste.
  var LEGACY_DIRECTIVE_RE = /^[ \t]*(?:#|--|\/\/)[ \t]*(?:connect|read|load|require)\b/i;
  var LEGACY_KEY_RE = /\bkey\(\s*(?!ask\s*\))[^)]*\)/gi;
  var MASK_WARNING = 'nøkkelverdier ble maskert i eksporten — bruk secret_key="ask" eller egen nøkkelhåndtering utenfor appen';

  // Editor-argumenter (spec §4.5c) har ingen mening utenfor appen, og
  // openstat.py avviser dem nå høylytt (Task 11). Fjern dem fra den
  // kommenterte direktivlinja, så et innlimt script ikke feiler.
  //
  // TO pass, ikke ett: «# df = h.read(secret_key="ask")» — den dokumenterte
  // formen for en beskyttet kilde — har INGEN ledende komma, og et
  // komma-mønster alene ville latt nøkkelargumentet stå igjen.
  // Verdimønsteret er [^,)\s]+, ikke \S+. Det er DEFENSIVT: grammatikken avviser
  // usiterte verdier i dag («cache=30m» gir parsefeil, og transpile kaster før
  // den kommer hit), men med \S+ ville et framtidig usitert argument slukt det
  // etterfølgende kommaet og etterlatt «ost.read("url" kind="csv")».
  // «source» er BEVISST utelatt: parseren avviser det allerede på read/connect
  // («ukjent argument «source»»), så det kan ikke stå i et gyldig script — og
  // på «ost.use(navn, source=…)» er HELE linja editor-only, så å fjerne bare
  // argumentet ville gjort kommentaren mindre sann, ikke mer.
  var _EO_VAL = '(?:"[^"]*"|\'[^\']*\'|[^,)\\s]+)';
  var EDITOR_ONLY_COMMA_RE = new RegExp(',[ \\t]*(?:secret_key|exec|cache)[ \\t]*=[ \\t]*' + _EO_VAL, 'gi');
  var EDITOR_ONLY_PAREN_RE = new RegExp('\\([ \\t]*(?:secret_key|exec|cache)[ \\t]*=[ \\t]*' + _EO_VAL + '[ \\t]*,?[ \\t]*', 'gi');
  var EDITOR_ONLY_NOTE = '# editor-argumenter (secret_key/exec/cache) er fjernet — de virker bare i OpenStat';

  function scrubDirectiveLine(line, DD, state) {
    if (!DD.isDirectiveLine(line) && !LEGACY_DIRECTIVE_RE.test(line)) return line;
    var scrubbed = DD.scrubKeys(line).replace(LEGACY_KEY_RE, 'key(***)');
    if (scrubbed !== line) state.masked = true;
    var stripped = scrubbed.replace(EDITOR_ONLY_COMMA_RE, '').replace(EDITOR_ONLY_PAREN_RE, '(');
    if (stripped !== scrubbed) state.strippedEditorOnly = true;
    return stripped;
  }

  // /api/hent?url=<enc>[&body=<enc-json>] → {url, body|null}; ellers null.
  function decodeHentUrl(target) {
    if (target.indexOf('/api/hent?') !== 0) return null;
    var mUrl = /[?&]url=([^&]+)/.exec(target);
    if (!mUrl) return null;
    var mBody = /[?&]body=([^&]+)/.exec(target);
    try {
      return {
        url: decodeURIComponent(mUrl[1]),
        body: mBody ? decodeURIComponent(mBody[1]) : null,
      };
    } catch (e) { return null; }
  }

  // kind() vinner; ellers URL-endelse; ellers csv (som kjøretidens default) + warn.
  function formatFor(item, url, warnings) {
    if (item.kind) return item.kind;
    if (/\.parquet(\?|$)/.test(url)) return 'parquet';
    if (/\.json(\?|$)/.test(url)) return 'json';
    if (/\.csv(\?|$)/.test(url)) return 'csv';
    warnings.push('«' + item.alias + '»: ukjent format — antar csv (bruk kind(...) i direktivet for å styre)');
    return 'csv';
  }

  function pyStr(s) { return JSON.stringify(s); }

  // Registerkilder med auth (spec §2): finn registeroppføringen for URL-ens
  // vert, uansett auth-type (i motsetning til js/data-loader.js sin
  // userAuthSourceFor, som bare ser etter auth.user). Samme defensive
  // try/catch rundt URL-parsing.
  function findAuthSource(url, registry) {
    var target = url;
    if (typeof target === 'string' && target.indexOf('/api/hent?') === 0) {
      var m = /[?&]url=([^&]+)/.exec(target);
      if (!m) return null;
      try { target = decodeURIComponent(m[1]); } catch (e) { return null; }
    }
    var host;
    try { host = new URL(target).host; } catch (e) { return null; }
    var reg = registry || [];
    for (var i = 0; i < reg.length; i++) {
      var s = reg[i];
      if (!s.auth) continue;
      try { if (new URL(s.base_url).host === host) return s; } catch (e2) {}
    }
    return null;
  }

  // Marker satt av den nøkkel-plassering-grenen i emitFor når URL-en må
  // bygges i koden (variabel), ikke som strenglitteral — se emitFor. Denne
  // markøren skal ALDRI ende opp bokstavelig i emittert kode; urlExpr()
  // er eneste sted som leser den, og alle emisjonsfunksjoner går via den.
  function urlExpr(url, item, mode) {
    if (typeof url === 'string' && url.indexOf('__URLVAR__') === 0) {
      return mode === 'python' ? '_url_' + item.alias : 'url_' + item.alias + '_';
    }
    return mode === 'python' ? pyStr(url) : rStr(url);
  }

  // Emisjon for én kilde i python-modus. out.lines fylles; out.needs merkes.
  function emitPython(item, url, body, fmt, out) {
    if (body !== null) {
      out.needs.requests = true;
      out.needs.json = true;
      // Body inlines som vanlig (escapet) strenglitteral — IKKE r'''...''',
      // som knekker/korrumperer stille dersom bodyen inneholder ''' selv.
      if (fmt === 'json') {
        out.lines.push(item.alias + ' = requests.post(' + urlExpr(url, item, 'python') + ', json=json.loads(' + pyStr(body) + ')).json()');
      } else {
        out.needs.io = true;
        out.needs.pandas = true;
        out.lines.push('_resp = requests.post(' + urlExpr(url, item, 'python') + ', json=json.loads(' + pyStr(body) + '))');
        out.lines.push(item.alias + ' = pd.read_csv(io.StringIO(_resp.text), sep=None, engine="python")');
      }
      return;
    }
    if (fmt === 'json') {
      out.needs.requests = true;
      out.lines.push(item.alias + ' = requests.get(' + urlExpr(url, item, 'python') + ').json()  # rå JSON — appens binding kan avvike');
      return;
    }
    if (fmt === 'parquet') {
      out.needs.pandas = true;
      out.lines.push(item.alias + ' = pd.read_parquet(' + urlExpr(url, item, 'python') + ')  # krever pyarrow');
      return;
    }
    out.needs.pandas = true;
    out.lines.push(item.alias + ' = pd.read_csv(' + urlExpr(url, item, 'python') + ', sep=None, engine="python")');
  }

  // Importblokk for python — bare det som trengs og ikke alt finnes i scriptet.
  function pythonImports(needs, script) {
    var want = [];
    if (needs.pandas && !/^\s*import pandas as pd\b/m.test(script)) want.push('import pandas as pd');
    if (needs.requests && !/^\s*import requests\b/m.test(script)) want.push('import requests');
    if (needs.io && !/^\s*import io\b/m.test(script)) want.push('import io');
    if (needs.json && !/^\s*import json\b/m.test(script)) want.push('import json');
    return want;
  }

  // Én kilde → linjer. Task 3 legger nøkkel/ikke-portabel-grener FØRST her.
  function emitFor(item, mode, registry, warnings, needs) {
    var out = { lines: [], needs: needs };
    // Federert kilde (spec 2026-07-31-federert-pull-design §3-4): item har
    // .federated (en liste), ikke .url — MÅ sjekkes FØR item.url leses, av
    // samme grunn som anvil-vakten under (decodeHentUrl(undefined) ville
    // kastet TypeError). Full transpilering (pd.concat av medlemmene) er
    // bevisst utsatt (v1) — ikke forsøk det her.
    if (item.federated) {
      out.lines.push('# federert kilde «' + item.alias + '» støttes ikke i portabel eksport ennå — last ned medlemmene manuelt');
      warnings.push('«' + item.alias + '»: federert kilde støttes ikke i portabel eksport ennå — last ned medlemmene manuelt');
      return out.lines;
    }
    // Ikke-portable kilder (spec §2): krypterte (key), Anvil/SafeStat, remote.
    // MÅ kjøre FØR noe forsøk på å lese item.url — anvil-oppløste items har
    // ikke noe .url-felt i det hele tatt (se DataDirectives.resolve), så en
    // decodeHentUrl(undefined) lenger ned ville kastet TypeError.
    if (item.anvil || item.exec === 'remote' || item.key) {
      out.lines.push('# (denne kilden krever OpenStat-appen — hopp over eller erstatt manuelt: «' + item.alias + '»)');
      warnings.push('«' + item.alias + '»: kilden krever appen (kryptert/registrert/remote) og ble ikke transpilert');
      return out.lines;
    }
    var url = item.url, body = null;
    var hent = decodeHentUrl(url);
    if (hent) { url = hent.url; body = hent.body; }
    if (url.indexOf('/') === 0) {
      out.lines.push('# (ikke portabel: app-intern URL «' + url + '» — hopp over eller erstatt manuelt)');
      warnings.push('«' + item.alias + '»: app-intern URL kan ikke gjøres portabel');
      return out.lines;
    }
    if (item.kind === 'duckdb' || item.kind === 'sqlite') {
      out.lines.push('# (ikke portabel i v1: ' + item.kind + '-kilde med tabellen «' + (item.table || '') + '» — last ned fila og spør den manuelt)');
      warnings.push('«' + item.alias + '»: ' + item.kind + '-kilder eksporteres ikke i v1');
      return out.lines;
    }
    // pxweb (plan 2026-07-25 Task 2): data-URL-en bygges på transpile-tid
    // (js/pxweb.js), konverteringen json-stat2 → langt format emitteres som
    // hjelpefunksjon én gang (needs.pxHelperPy/R) — selvforsynt eksport.
    if (item.kind === 'pxweb' || item.kind === 'eurostat') {
      var PX = global.PxWeb;
      if (!PX) {
        out.lines.push('# (' + item.kind + '-kilde «' + item.alias + '»: intern feil — js/pxweb.js er ikke lastet)');
        warnings.push('«' + item.alias + '»: ' + item.kind + '-transpilering utilgjengelig (js/pxweb.js mangler)');
        return out.lines;
      }
      var du = PX.dataUrlFor(item.kind, url);
      if (mode === 'python') {
        needs.requests = true;
        needs.pandas = true;
        needs.pxHelperPy = true;
        out.lines.push(item.alias + ' = _px_frame(requests.get(' + pyStr(du) + ').json())');
      } else {
        needs.pxHelperR = true;
        out.lines.push(item.alias + ' <- px_frame_(jsonlite::fromJSON(' + rStr(du) + ', simplifyVector = FALSE))  # krever jsonlite');
      }
      return out.lines;
    }
    // api-kinds (spec 2026-07-25-api-kinds-design §4.7): sdmx = SAMME
    // Accept-header som appen (urllib/download.file med headers=) så rammen
    // blir byte-identisk — format-param duger ikke (navnet varierer per
    // kilde, og NBs format=csv gir semikolon+labels). worldbank/dbnomics =
    // URL på transpile-tid + emittert flatener som speiler js/api-kinds.js.
    if (item.kind === 'sdmx' || item.kind === 'worldbank' || item.kind === 'dbnomics') {
      var AK = global.ApiKinds;
      if (!AK) {
        out.lines.push('# (' + item.kind + '-kilde «' + item.alias + '»: intern feil — js/api-kinds.js er ikke lastet)');
        warnings.push('«' + item.alias + '»: ' + item.kind + '-transpilering utilgjengelig (js/api-kinds.js mangler)');
        return out.lines;
      }
      if (item.kind === 'sdmx') {
        var nk = item.needsSdmxKey;
        if (nk) {
          // Kanonisk countries()/indicators()/filters() (spec §3): nøkkelen
          // bygges ved KJØRING fra CSV-headeren til en lastNObservations=1-
          // probe — samme introspeksjon som appen gjør, selvforsynt.
          var want = {};
          if (nk.countries) want.REF_AREA = nk.countries.join('+');
          if (nk.indicators) want.MEASURE = nk.indicators.join('+');
          Object.keys(nk.filters || {}).forEach(function (fk) { want[fk] = String(nk.filters[fk]); });
          var sq = url.indexOf('?');
          var sBase = (sq >= 0 ? url.slice(0, sq) : url).replace(/\/+$/, '');
          var sQuery = sq >= 0 ? url.slice(sq) : '';
          if (mode === 'python') {
            needs.pandas = true; needs.io = true; needs.sdmxHelperPy = true; needs.sdmxKeyHelperPy = true;
            out.lines.push('_dims_' + item.alias + ' = _sdmx_key_dims(_sdmx_frame(' + pyStr(sBase + '/all?lastNObservations=1') + ').columns)');
            out.lines.push(item.alias + ' = _sdmx_frame(' + pyStr(sBase + '/') + ' + _sdmx_key(_dims_' + item.alias + ', ' + JSON.stringify(want) + ')' + (sQuery ? ' + ' + pyStr(sQuery) : '') + ')');
          } else {
            needs.sdmxHelperR = true; needs.sdmxKeyHelperR = true;
            var wantR = 'c(' + Object.keys(want).map(function (wk) { return wk + ' = ' + rStr(want[wk]); }).join(', ') + ')';
            out.lines.push('dims_' + item.alias + '_ <- sdmx_key_dims_(names(sdmx_frame_(' + rStr(sBase + '/all?lastNObservations=1') + ')))');
            out.lines.push(item.alias + ' <- sdmx_frame_(paste0(' + rStr(sBase + '/') + ', sdmx_key_(dims_' + item.alias + '_, ' + wantR + ')' + (sQuery ? ', ' + rStr(sQuery) : '') + '))');
          }
        } else if (mode === 'python') {
          needs.pandas = true; needs.io = true; needs.sdmxHelperPy = true;
          out.lines.push(item.alias + ' = _sdmx_frame(' + pyStr(url) + ')');
        } else {
          needs.sdmxHelperR = true;
          out.lines.push(item.alias + ' <- sdmx_frame_(' + rStr(url) + ')');
        }
      } else if (item.kind === 'worldbank') {
        var wu = AK.worldbankDataUrl(url);
        if (mode === 'python') {
          needs.requests = true; needs.pandas = true; needs.wbHelperPy = true;
          out.lines.push(item.alias + ' = _wb_frame(' + pyStr(wu) + ')');
        } else {
          needs.wbHelperR = true;
          out.lines.push(item.alias + ' <- wb_frame_(' + rStr(wu) + ')  # krever jsonlite');
        }
      } else {
        var dbu = AK.dbnomicsDataUrl(url);
        if (mode === 'python') {
          needs.requests = true; needs.pandas = true; needs.dbnHelperPy = true;
          out.lines.push(item.alias + ' = _dbn_frame(' + pyStr(dbu) + ')');
        } else {
          needs.dbnHelperR = true;
          out.lines.push(item.alias + ' <- dbn_frame_(' + rStr(dbu) + ')  # krever jsonlite');
        }
        if (item.clientYears) {
          // years() for dbnomics filtreres klient-side i appen — speil det,
          // ellers avviker eksportert ramme (parity-garantien).
          var cyF = item.clientYears.from, cyT = item.clientYears.to;
          if (mode === 'python') {
            out.lines.push('_yr = pd.to_numeric(' + item.alias + '["period"].astype(str).str[:4], errors="coerce")');
            var conds = [];
            if (cyF) conds.push('(_yr.isna() | (_yr >= ' + parseInt(cyF, 10) + '))');
            if (cyT) conds.push('(_yr.isna() | (_yr <= ' + parseInt(cyT, 10) + '))');
            out.lines.push(item.alias + ' = ' + item.alias + '[' + conds.join(' & ') + '].reset_index(drop=True)');
          } else {
            out.lines.push('yr_ <- suppressWarnings(as.numeric(substr(as.character(' + item.alias + '$period), 1, 4)))');
            var condsR = [];
            if (cyF) condsR.push('(is.na(yr_) | yr_ >= ' + parseInt(cyF, 10) + ')');
            if (cyT) condsR.push('(is.na(yr_) | yr_ <= ' + parseInt(cyT, 10) + ')');
            out.lines.push(item.alias + ' <- ' + item.alias + '[' + condsR.join(' & ') + ', ]');
          }
        }
      }
      return out.lines;
    }
    // fmt regnes ut FØR ev. nøkkel-plassering markerer url som variabel
    // (__URLVAR__), slik at endelsesniffing i formatFor fortsatt ser den
    // ekte URL-en.
    var fmt = formatFor(item, url, warnings);

    // Registerkilder med auth: plassholder-nøkkel (aldri verdier) — spec §2.
    var authSrc = findAuthSource(url, registry);
    if (authSrc && authSrc.auth) {
      if (authSrc.auth.valgfri) {
        out.lines.push('# nøkkel er valgfri for ' + authSrc.id + ' — åpne datasett virker uten; privat-/konkurransedata krever egen nøkkel');
      } else {
        var cname = authSrc.id.toUpperCase() + '_API_KEY';
        needs.placeholders = needs.placeholders || {};
        needs.placeholders[cname] = true;
        warnings.push('«' + item.alias + '»: ' + authSrc.id + ' krever egen nøkkel — sett inn verdien i ' + cname);
        var plass = authSrc.auth.plassering || '';
        if (plass.indexOf('query:') === 0) {
          var param = plass.slice(6);
          // URL-en bygges i koden med nøkkelen limt på:
          if (mode === 'python') {
            out.lines.push('_url_' + item.alias + ' = ' + pyStr(url) + ' + "' + (url.indexOf('?') >= 0 ? '&' : '?') + param + '=" + ' + cname);
          } else {
            out.lines.push('url_' + item.alias + '_ <- paste0(' + rStr(url) + ', "' + (url.indexOf('?') >= 0 ? '&' : '?') + param + '=", ' + cname + ')');
          }
          url = '__URLVAR__' + item.alias;   // marker: emisjonen bruker variabelen (urlExpr)
        } else {
          out.lines.push('# ' + authSrc.id + ' bruker ' + plass + '-autentisering — legg nøkkelen i ' + cname + ' og send den som beskrevet i API-dokumentasjonen');
        }
      }
    }

    if (mode === 'python') emitPython(item, url, body, fmt, out);
    else emitR(item, url, body, fmt, out);   // Task 2
    return out.lines;
  }

  function rStr(s) { return JSON.stringify(s); }

  // json-stat2 → langt format (koder + value) — speiler js/pxweb.js
  // columnsFromJsonStat: koder i posisjonsorden (index som objekt ELLER
  // array), row-major-ekspansjon etter id/size, sparse value-objekt → NA.
  var PX_HELPER_PY = [
    '',
    'def _px_frame(ds):',
    '    ids = ds.get("id") or []',
    '    size = ds.get("size") or []',
    '    def _codes(dim):',
    '        idx = (dim.get("category") or {}).get("index")',
    '        if isinstance(idx, list):',
    '            return [str(c) for c in idx]',
    '        return [c for c, _ in sorted((idx or {}).items(), key=lambda kv: kv[1])]',
    '    dims = [_codes((ds.get("dimension") or {}).get(i) or {}) for i in ids]',
    '    total = 1',
    '    for s in size:',
    '        total *= s',
    '    val = ds.get("value")',
    '    cols = {i: [] for i in ids}',
    '    vals = []',
    '    for flat in range(total):',
    '        rest = flat',
    '        for d in range(len(ids) - 1, -1, -1):',
    '            cols[ids[d]].append(dims[d][rest % size[d]])',
    '            rest //= size[d]',
    '        v = val[flat] if isinstance(val, list) else (val or {}).get(str(flat))',
    '        vals.append(v)',
    '    cols["value"] = vals',
    '    return pd.DataFrame(cols)',
  ];
  var PX_HELPER_R = [
    '',
    'px_frame_ <- function(ds) {',
    '  ids <- unlist(ds$id); size <- unlist(ds$size)',
    '  codes_ <- function(dim) {',
    '    idx <- dim$category$index',
    '    if (is.null(names(idx))) as.character(unlist(idx)) else names(sort(unlist(idx)))',
    '  }',
    '  dims <- lapply(ids, function(i) codes_(ds$dimension[[i]]))',
    '  grid <- rev(expand.grid(rev(setNames(dims, ids)), stringsAsFactors = FALSE))',
    '  v <- ds$value',
    '  if (!is.null(names(v))) {',
    '    vals <- rep(NA, prod(size))',
    '    vals[as.integer(names(v)) + 1] <- unlist(v)',
    '  } else {',
    '    vals <- unlist(lapply(v, function(x) if (is.null(x)) NA else x))',
    '  }',
    '  grid$value <- vals',
    '  grid',
    '}',
  ];
  // api-kinds-hjelpere (spec 2026-07-25-api-kinds-design §4.7) — speiler
  // js/api-kinds.js-flatenerne 1:1 (paritetskontrakten: samme fixtures gir
  // samme rammer i JS-testene og pytest).
  var SDMX_HELPER_PY = [
    '',
    'def _sdmx_frame(url):',
    '    # samme Accept som appen (labels=id gir rene koder; NBs format=csv',
    '    # ville gitt semikolon+labels, Accept text/csv gir XML). User-Agent',
    '    # kreves: OECD 403-er urllibs default (verifisert 2026-07-25).',
    '    import urllib.request',
    '    def _get(u, hdr):',
    '        hdr = dict(hdr, **{"User-Agent": "openstat"})',
    '        return urllib.request.urlopen(urllib.request.Request(u, headers=hdr)).read()',
    '    try:',
    '        raw = _get(url, {"Accept": "application/vnd.sdmx.data+csv;labels=id"})',
    '    except Exception:',
    '        sep = "&" if "?" in url else "?"',
    '        raw = _get(url + sep + "format=csvdata", {})  # ECB-veien',
    '    return pd.read_csv(io.BytesIO(raw))',
  ];
  var SDMX_HELPER_R = [
    '',
    'sdmx_frame_ <- function(url) {',
    '  tf <- tempfile(fileext = ".csv")',
    '  ok <- tryCatch({',
    '    download.file(url, tf, quiet = TRUE, headers = c(Accept = "application/vnd.sdmx.data+csv;labels=id"))',
    '    TRUE',
    '  }, error = function(e) FALSE)',
    '  if (!ok) {  # ECB-veien: format=csvdata-param i stedet for Accept',
    '    sep <- if (grepl("\\\\?", url)) "&" else "?"',
    '    download.file(paste0(url, sep, "format=csvdata"), tf, quiet = TRUE)',
    '  }',
    '  read.csv(tf)',
    '}',
  ];
  var WB_HELPER_PY = [
    '',
    'def _wb_frame(url):',
    '    # Verdensbanken: [meta, rader] med sideløkke (meta["pages"])',
    '    docs = [requests.get(url).json()]',
    '    if docs[0] and isinstance(docs[0][0], dict) and "message" in docs[0][0]:',
    '        raise ValueError("Verdensbanken avviste spørringen: " + str(docs[0][0]["message"]))',
    '    for p in range(2, int(docs[0][0].get("pages", 1)) + 1):',
    '        docs.append(requests.get(url + "&page=" + str(p)).json())',
    '    cols = {"indicator": [], "country": [], "countryiso3code": [], "date": [], "value": []}',
    '    for doc in docs:',
    '        for r in (doc[1] or []):',
    '            cols["indicator"].append((r.get("indicator") or {}).get("id", ""))',
    '            cols["country"].append((r.get("country") or {}).get("id", ""))',
    '            cols["countryiso3code"].append(r.get("countryiso3code", ""))',
    '            cols["date"].append(r.get("date", ""))',
    '            cols["value"].append(r.get("value"))',
    '    return pd.DataFrame(cols)',
  ];
  var WB_HELPER_R = [
    '',
    'wb_frame_ <- function(url) {',
    '  doc <- jsonlite::fromJSON(url, simplifyVector = FALSE)',
    '  if (!is.null(doc[[1]]$message)) stop("Verdensbanken avviste spørringen")',
    '  docs <- list(doc)',
    '  pages <- as.integer(doc[[1]]$pages %||% 1)',
    '  if (length(pages) && pages > 1) for (p in 2:pages) {',
    '    docs[[p]] <- jsonlite::fromJSON(paste0(url, "&page=", p), simplifyVector = FALSE)',
    '  }',
    '  rows <- do.call(c, lapply(docs, function(d) d[[2]]))',
    '  data.frame(',
    '    indicator = vapply(rows, function(r) r$indicator$id %||% "", ""),',
    '    country = vapply(rows, function(r) r$country$id %||% "", ""),',
    '    countryiso3code = vapply(rows, function(r) r$countryiso3code %||% "", ""),',
    '    date = vapply(rows, function(r) r$date %||% "", ""),',
    '    value = vapply(rows, function(r) if (is.null(r$value)) NA_real_ else as.numeric(r$value), 0),',
    '    stringsAsFactors = FALSE)',
    '}',
    'if (!exists("%||%")) `%||%` <- function(a, b) if (is.null(a)) b else a',
  ];
  var DBN_HELPER_PY = [
    '',
    'def _dbn_frame(url):',
    '    # DBnomics: series.docs[] med period/value-arrayer → langt format',
    '    series = (requests.get(url).json() or {}).get("series") or {}',
    '    docs = series.get("docs") or []',
    '    if series.get("num_found", 0) > len(docs):',
    '        raise ValueError("DBnomics-spørringen traff " + str(series["num_found"]) +',
    '                         " serier (maks " + str(series.get("limit")) + ") — snevre inn")',
    '    dim_names = sorted({k for d in docs for k in (d.get("dimensions") or {})})',
    '    cols = {"series_code": []}',
    '    for k in dim_names:',
    '        cols[k] = []',
    '    cols["period"] = []; cols["value"] = []',
    '    for d in docs:',
    '        for i, per in enumerate(d.get("period") or []):',
    '            cols["series_code"].append(d.get("series_code", ""))',
    '            for k in dim_names:',
    '                cols[k].append(str((d.get("dimensions") or {}).get(k, "")))',
    '            cols["period"].append(str(per))',
    '            v = (d.get("value") or [None] * (i + 1))[i]',
    '            cols["value"].append(None if v in (None, "NA") else v)',
    '    return pd.DataFrame(cols)',
  ];
  var DBN_HELPER_R = [
    '',
    'dbn_frame_ <- function(url) {',
    '  s <- jsonlite::fromJSON(url, simplifyVector = FALSE)$series',
    '  docs <- s$docs',
    '  if (!is.null(s$num_found) && s$num_found > length(docs)) stop("DBnomics: for mange serier — snevre inn")',
    '  dims <- sort(unique(unlist(lapply(docs, function(d) names(d$dimensions)))))',
    '  do.call(rbind, lapply(docs, function(d) {',
    '    n <- length(d$period)',
    '    row <- data.frame(series_code = rep(d$series_code, n),',
    '      period = vapply(d$period, as.character, ""),',
    '      value = vapply(d$value, function(v) if (is.null(v) || identical(v, "NA")) NA_real_ else as.numeric(v), 0),',
    '      stringsAsFactors = FALSE)',
    '    for (k in dims) row[[k]] <- as.character(d$dimensions[[k]] %||% "")',
    '    row[, c("series_code", dims, "period", "value")]',
    '  }))',
    '}',
    'if (!exists("%||%")) `%||%` <- function(a, b) if (is.null(a)) b else a',
  ];
  // Nøkkelbygging fra CSV-header (speiler js/api-kinds.js sdmxKeyDims/
  // sdmxKeyPath — brukes av kanonisk countries()/indicators()/filters()).
  var SDMX_KEY_HELPER_PY = [
    '',
    'def _sdmx_key_dims(cols):',
    '    cols = list(cols)',
    '    t = cols.index("TIME_PERIOD")',
    '    start = 3 if cols[:3] == ["STRUCTURE", "STRUCTURE_ID", "ACTION"] else (1 if cols[0] in ("DATAFLOW", "KEY") else 0)',
    '    return cols[start:t]',
    '',
    'def _sdmx_key(dims, want):',
    '    for k in want:',
    '        if k not in dims:',
    '            raise ValueError(k + " finnes ikke i dataflowen — dimensjonene er " + ", ".join(dims))',
    '    return ".".join(want.get(d, "") for d in dims)',
  ];
  var SDMX_KEY_HELPER_R = [
    '',
    'sdmx_key_dims_ <- function(cols) {',
    '  t <- match("TIME_PERIOD", cols)',
    '  start <- if (length(cols) >= 3 && identical(cols[1:3], c("STRUCTURE", "STRUCTURE_ID", "ACTION"))) 4',
    '           else if (cols[1] %in% c("DATAFLOW", "KEY")) 2 else 1',
    '  cols[start:(t - 1)]',
    '}',
    '',
    'sdmx_key_ <- function(dims, want) {',
    '  mangler <- setdiff(names(want), dims)',
    '  if (length(mangler)) stop(paste0(mangler[1], " finnes ikke i dataflowen — dimensjonene er ", paste(dims, collapse = ", ")))',
    '  paste(ifelse(dims %in% names(want), want[dims], ""), collapse = ".")',
    '}',
  ];
  function pxHelperLines(mode, needs) {
    var lines = [];
    if (mode === 'python') {
      if (needs.pxHelperPy) lines = lines.concat(PX_HELPER_PY);
      if (needs.sdmxHelperPy) lines = lines.concat(SDMX_HELPER_PY);
      if (needs.sdmxKeyHelperPy) lines = lines.concat(SDMX_KEY_HELPER_PY);
      if (needs.wbHelperPy) lines = lines.concat(WB_HELPER_PY);
      if (needs.dbnHelperPy) lines = lines.concat(DBN_HELPER_PY);
    } else {
      if (needs.pxHelperR) lines = lines.concat(PX_HELPER_R);
      if (needs.sdmxHelperR) lines = lines.concat(SDMX_HELPER_R);
      if (needs.sdmxKeyHelperR) lines = lines.concat(SDMX_KEY_HELPER_R);
      if (needs.wbHelperR) lines = lines.concat(WB_HELPER_R);
      if (needs.dbnHelperR) lines = lines.concat(DBN_HELPER_R);
    }
    return lines;
  }

  function emitR(item, url, body, fmt, out) {
    if (body !== null) {
      out.lines.push('# krever httr (+ jsonlite for JSON-svar):');
      out.lines.push('resp_ <- httr::POST(' + urlExpr(url, item, 'r') + ', body = ' + rStr(body) + ', encode = "raw", httr::content_type_json())');
      if (fmt === 'json') {
        out.lines.push(item.alias + ' <- httr::content(resp_, as = "parsed")');
      } else {
        out.lines.push(item.alias + ' <- read.csv(text = httr::content(resp_, as = "text"))  # NB: sjekk skilletegn (sep=";")');
      }
      return;
    }
    if (fmt === 'json') {
      out.lines.push(item.alias + ' <- jsonlite::fromJSON(' + urlExpr(url, item, 'r') + ')  # krever jsonlite');
      return;
    }
    if (fmt === 'parquet') {
      var tmp = '"' + item.alias + '.parquet"';
      out.lines.push('download.file(' + urlExpr(url, item, 'r') + ', ' + tmp + ', mode = "wb")');
      out.lines.push(item.alias + ' <- arrow::read_parquet(' + tmp + ')  # krever arrow');
      return;
    }
    out.lines.push(item.alias + ' <- read.csv(' + urlExpr(url, item, 'r') + ')  # NB: sjekk skilletegn — nordiske CSV-er bruker ofte sep=";"');
  }

  // Montering i eksporten (plan 2026-07-25 Task 3): create-dataset/import/
  // join → kildelesing (src_<key>-variabler via emitFor) + merge-kjeder.
  // Datasett med .load er alt emittert av sine egne load-linjer; kilder som
  // ikke kan gjøres portable (duckdb/sqlite/kryptert/uløselig) gjør at
  // datasettet hoppes over med kommentar + warning i stedet for knekt kode.
  // Parsetre-sjekk, ikke verbliste: den gamle listen sluttet å matche da
  // grammatikken ble pythonsk, lastAsmIdx ble stående på -1 og
  // monteringsblokken havnet NEDERST — etter koden som bruker datasettet
  // (NameError i den eksporterte fila, uten én advarsel).
  function isAssemblyLine(ln) {
    var p = global.DirectiveParser.parseLine(ln);
    return !!(p && p.form === 'call' &&
              ((p.recv === 'ost' && p.verb === 'create') || p.verb === 'add' || p.verb === 'join' || p.verb === 'filter'));
  }

  function mergeLine(name, rightExpr, keys, how, mode) {
    if (mode === 'python') {
      return name + ' = ' + name + '.merge(' + rightExpr + ', on=[' + keys.map(pyStr).join(', ') + '], how=' + pyStr(how) + ')';
    }
    var tail = how === 'left' ? ', all.x = TRUE' : how === 'outer' ? ', all = TRUE' : '';
    return name + ' <- merge(' + name + ', ' + rightExpr + ', by = c(' + keys.map(rStr).join(', ') + ')' + tail + ')';
  }

  // where/filter-emisjon (spec 2026-07-29-row-filter-montering §5).
  // NA-regler er SQL-kanoniske (spec §4): pandas trenger .notna()-vern ved
  // != (NaN != v er ellers True); R-siden bruker which(), som dropper NA.
  function pyLit(v) { return typeof v === 'number' ? String(v) : pyStr(v); }
  function rLit(v) { return typeof v === 'number' ? String(v) : rStr(v); }
  function pyMask(varName, conds) {
    return conds.map(function (c) {
      var s = varName + '[' + pyStr(c.col) + ']';
      if (c.op === 'in') return s + '.isin([' + c.value.map(pyLit).join(', ') + '])';
      if (c.op === '!=') return '(' + s + ' != ' + pyLit(c.value) + ') & ' + s + '.notna()';
      return '(' + s + ' ' + c.op + ' ' + pyLit(c.value) + ')';
    }).join(' & ');
  }
  function rWhich(varName, conds) {
    return 'which(' + conds.map(function (c) {
      var s = varName + '[[' + rStr(c.col) + ']]';
      if (c.op === 'in') return s + ' %in% c(' + c.value.map(rLit).join(', ') + ')';
      return s + ' ' + c.op + ' ' + rLit(c.value);
    }).join(' & ') + ')';
  }

  function emitAssembly(script, mode, registry, warnings, needs, DD) {
    var asm = DD.parseAssembly(script);
    if (asm.errors.length) return null;   // monteringsfeil rapporteres av kjøretiden, ikke eksporten
    var all = asm.spec.datasets || [];
    var withSteps = all.filter(function (d) { return !('load' in d) && (d.steps || []).length; });
    if (!withSteps.length) return null;

    var srcKeys = [], seen = {};
    withSteps.forEach(function (d) {
      (d.steps || []).forEach(function (st) {
        if (st.op === 'import' && !seen[st.source]) { seen[st.source] = true; srcKeys.push(st.source); }
      });
    });
    var tables = asm.spec.sourceTables || {};
    // Lastelisten bygges DIREKTE (DD.makeLoad), ikke som en direktivstreng som
    // parses tilbake. Tekstveien døde stille: «# connect»-filteret traff ingen
    // linjer og «# load <k> as src_<k>» ble ignorert av den nye grammatikken,
    // så resolvedSynth ble tom og eksporten mistet ALLE kildelesingene i en
    // montering — uten feilmelding. Connect-listen tas rett fra parsetreet.
    var resolvedSynth = DD.resolve({
      connects: DD.parse(script).connects,
      loads: srcKeys.map(function (k) {
        var t = tables[k];
        return DD.makeLoad({ alias: 'src_' + k, source: t ? t.source : k, table: t ? t.table : null });
      }),
      metas: [], errors: []
    }, registry);

    var lines = [], failed = {};
    resolvedSynth.forEach(function (item, i) {
      var key = srcKeys[i];
      if (item.error) {
        failed[key] = true;
        warnings.push('montering: ' + item.error);
        lines.push('# (kilden «' + key + '» kunne ikke løses: ' + item.error + ')');
        return;
      }
      if (item.anvil || item.key || item.exec === 'remote' || item.federated ||
          item.kind === 'duckdb' || item.kind === 'sqlite') failed[key] = true;
      lines.push.apply(lines, emitFor(item, mode, registry, warnings, needs));
    });

    var ordered = (global.AssemblyDuckdb && global.AssemblyDuckdb._topoSort)
      ? global.AssemblyDuckdb._topoSort(all) : all;
    var built = {};
    all.forEach(function (d) { if ('load' in d) built[d.name] = true; });
    ordered.forEach(function (d) {
      if ('load' in d || !(d.steps || []).length) return;
      var keys = d.key || [];
      var bad = d.steps.some(function (st) { return st.op === 'import' && failed[st.source]; })
        || d.steps.some(function (st) { return st.op === 'join' && !built[st.from]; })
        || (d.steps[0] || {}).op !== 'import';
      if (bad) {
        lines.push('# (datasettet «' + d.name + '» kunne ikke eksporteres — se advarslene)');
        warnings.push('montering: datasettet «' + d.name + '» ble ikke eksportert (utilgjengelig kilde eller join-avhengighet)');
        return;
      }
      d.steps.forEach(function (st, si) {
        if (st.op === 'import') {
          var cols = keys.concat(st.columns.filter(function (c) { return keys.indexOf(c) < 0; }));
          var srcVar = 'src_' + st.source;
          var subset;
          if (mode === 'python') {
            var base = st.where ? srcVar + '[' + pyMask(srcVar, st.where) + ']' : srcVar;
            subset = base + '[[' + cols.map(pyStr).join(', ') + ']]';
          } else {
            var rows = st.where ? rWhich(srcVar, st.where) : '';
            subset = srcVar + '[' + rows + ', c(' + cols.map(rStr).join(', ') + ')]';
          }
          if (si === 0) lines.push(mode === 'python' ? (d.name + ' = ' + subset) : (d.name + ' <- ' + subset));
          else lines.push(mergeLine(d.name, subset, keys, st.how, mode));
        } else if (st.op === 'join') {
          lines.push(mergeLine(d.name, st.from, st.on, st.how, mode));
        } else {   // filter (spec 2026-07-29 §2: alltid etter add/join)
          lines.push(mode === 'python'
            ? d.name + ' = ' + d.name + '[' + pyMask(d.name, st.where) + ']'
            : d.name + ' <- ' + d.name + '[' + rWhich(d.name, st.where) + ', ]');
        }
      });
      if (mode === 'r' && d.format === 'data.table') lines.push(d.name + ' <- data.table::as.data.table(' + d.name + ')  # krever data.table');
      else if (mode === 'r' && d.format === 'tibble') lines.push(d.name + ' <- tibble::as_tibble(' + d.name + ')  # krever tibble');
      else if (d.format && d.format !== 'pandas' && d.format !== 'data.frame') lines.push('# format(' + d.format + ') er editor-spesifikk — «' + d.name + '» leveres som vanlig ramme');
      built[d.name] = true;
    });
    if (mode === 'python') needs.pandas = true;
    return lines;
  }

  function transpile(script, mode, registry) {
    if (mode !== 'python' && mode !== 'r') throw new Error('portabel eksport støtter python og r, ikke «' + mode + '»');
    var DD = global.DataDirectives;
    var parsed = DD.parse(script);
    if (parsed.errors.length) throw new Error('Direktivfeil: ' + parsed.errors.join('; '));
    // Montering uten load-linjer skal OGSÅ transpileres — sjekken speiler
    // emitAssembly sin (datasett med steg).
    var _asmProbe = DD.parseAssembly(script);
    var _hasAsm = !_asmProbe.errors.length && (_asmProbe.spec.datasets || []).some(function (d) { return !('load' in d) && (d.steps || []).length; });
    if (!parsed.loads.length && !_hasAsm) {
      // Ingen (parsebare) loads → ingen emisjon å gjøre, men linjer som SER UT
      // som direktiver (også malformerte, f.eks. «# load … key(secret)» uten
      // «as») kan likevel bære nøkkelliteraler. Kjør derfor alltid den
      // linje-skopede scrubben — output blir byte-identisk når ingen linje
      // matcher direktivformen, så passthrough-testen holder uendret.
      var st0 = { masked: false };
      var passthrough = String(script).split('\n').map(function (l) {
        return scrubDirectiveLine(l, DD, st0);
      }).join('\n');
      if (st0.strippedEditorOnly) passthrough = EDITOR_ONLY_NOTE + '\n' + passthrough;
      return { code: passthrough, warnings: st0.masked ? [MASK_WARNING] : [] };
    }
    var resolved = DD.resolve(parsed, registry || []);
    var bad = resolved.filter(function (r) { return r.error; });
    if (bad.length) throw new Error('Direktivfeil: ' + bad.map(function (b) { return b.error; }).join('; '));

    var warnings = [];
    var needs = {};
    // load-linje (trimmet tekst) → emitterte linjer, konsumert i rekkefølge.
    var queue = parsed.loads.map(function (l, i) {
      return { line: l.line, emitted: emitFor(resolved[i], mode, registry || [], warnings, needs) };
    });

    var outLines = [];
    var maskState = { masked: false };
    var lines = String(script).split('\n');
    var lastAsmIdx = -1;
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      var qi = -1;
      for (var q = 0; q < queue.length; q++) {
        if (queue[q] && queue[q].line === trimmed) { qi = q; break; }
      }
      if (qi >= 0) {
        // originaldirektivet som kommentar — key(<literal>) maskeres
        outLines.push(scrubDirectiveLine(lines[i], DD, maskState));
        outLines.push.apply(outLines, queue[qi].emitted);
        queue[qi] = null;                        // konsumert (duplikatlinjer i rekkefølge)
      } else {
        // passthrough — connect-linjer (også direktiver) linje-skopes
        outLines.push(scrubDirectiveLine(lines[i], DD, maskState));
      }
      if (isAssemblyLine(lines[i])) lastAsmIdx = outLines.length;
    }
    // Monteringsblokken settes inn rett etter siste monteringsdirektiv-linje.
    var asmBlock = _hasAsm ? emitAssembly(script, mode, registry || [], warnings, needs, DD) : null;
    if (asmBlock && asmBlock.length) {
      Array.prototype.splice.apply(outLines, [lastAsmIdx < 0 ? outLines.length : lastAsmIdx, 0].concat(asmBlock));
    }
    if (maskState.masked) warnings.push(MASK_WARNING);

    var head = HEADER.slice();
    if (maskState.strippedEditorOnly) head.push(EDITOR_ONLY_NOTE);
    // Plassholder-konstanter øverst (etter header, før imports): NAVN = "..."
    // (python) / NAVN <- "..." (r) — én linje per oppdaget plassholder, i
    // rekkefølgen de ble oppdaget (needs.placeholders-nøkler er unike, så
    // samme kilde brukt flere ganger gir bare én konstant).
    var placeholders = Object.keys(needs.placeholders || {});
    placeholders.forEach(function (name) {
      head.push(mode === 'python' ? (name + ' = "SETT-INN-EGEN-NØKKEL"') : (name + ' <- "SETT-INN-EGEN-NØKKEL"'));
    });
    var imports = mode === 'python' ? pythonImports(needs, script) : rImports(needs, script); // rImports: Task 2
    var code = head.concat(imports.length ? imports : []).concat(pxHelperLines(mode, needs)).concat(['']).join('\n') + outLines.join('\n');
    return { code: code, warnings: warnings };
  }

  function rImports() { return []; }   // R: pakker refereres med :: — ingen import-blokk

  global.PortableExport = { transpile: transpile };
})(typeof window !== 'undefined' ? window : globalThis);
