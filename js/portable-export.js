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
    '# «# load»-direktivene er oversatt til frittstående lastekode.',
    '# Generert av appen — rediger fritt.',
  ];

  // key(<literal>)-maskering SKOPET til direktivlinjer (connect/load/require):
  // en helskript-scrub ødela legitim kode med key(...)-formede kall — f.eks.
  // ble «dt <- data.table::key(dt)» til «data.table::key(***)». Bare linjer
  // som ser ut som direktiv-kommentarer kan bære nøkkelliteraler.
  var DIRECTIVE_LINE_RE = /^[ \t]*(?:#|--|\/\/)[ \t]*(connect|load|require)\b/i;
  var MASK_WARNING = 'key(...)-verdier ble maskert i eksporten — bruk key(ask) eller egen nøkkelhåndtering utenfor appen';

  function scrubDirectiveLine(line, DD, state) {
    if (!DIRECTIVE_LINE_RE.test(line)) return line;
    var scrubbed = DD.scrubKeys(line);
    if (scrubbed !== line) state.masked = true;
    return scrubbed;
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
    if (typeof url === 'string' && url.indexOf('__URLVAR__') === 0) return '_url_' + item.alias;
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
            out.lines.push('_url_' + item.alias + ' <- paste0(' + rStr(url) + ', "' + (url.indexOf('?') >= 0 ? '&' : '?') + param + '=", ' + cname + ')');
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

  function emitR(item, url, body, fmt, out) {
    if (body !== null) {
      out.lines.push('# krever httr (+ jsonlite for JSON-svar):');
      out.lines.push('_resp <- httr::POST(' + urlExpr(url, item, 'r') + ', body = ' + rStr(body) + ', encode = "raw", httr::content_type_json())');
      if (fmt === 'json') {
        out.lines.push(item.alias + ' <- httr::content(_resp, as = "parsed")');
      } else {
        out.lines.push(item.alias + ' <- read.csv(text = httr::content(_resp, as = "text"))  # NB: sjekk skilletegn (sep=";")');
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

  function transpile(script, mode, registry) {
    if (mode !== 'python' && mode !== 'r') throw new Error('portabel eksport støtter python og r, ikke «' + mode + '»');
    var DD = global.DataDirectives;
    var parsed = DD.parse(script);
    if (parsed.errors.length) throw new Error('Direktivfeil: ' + parsed.errors.join('; '));
    if (!parsed.loads.length) {
      // Ingen direktiver i det hele tatt → byte-identisk passthrough (planens
      // garanti). Connect-linjer ER direktiver og kan bære key(<literal>) —
      // de linje-skopes gjennom samme scrub selv uten loads.
      if (!parsed.connects.length) return { code: script, warnings: [] };
      var st0 = { masked: false };
      var passthrough = String(script).split('\n').map(function (l) {
        return scrubDirectiveLine(l, DD, st0);
      }).join('\n');
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
    }
    if (maskState.masked) warnings.push(MASK_WARNING);

    var head = HEADER.slice();
    // Plassholder-konstanter øverst (etter header, før imports): NAVN = "..."
    // (python) / NAVN <- "..." (r) — én linje per oppdaget plassholder, i
    // rekkefølgen de ble oppdaget (needs.placeholders-nøkler er unike, så
    // samme kilde brukt flere ganger gir bare én konstant).
    var placeholders = Object.keys(needs.placeholders || {});
    placeholders.forEach(function (name) {
      head.push(mode === 'python' ? (name + ' = "SETT-INN-EGEN-NØKKEL"') : (name + ' <- "SETT-INN-EGEN-NØKKEL"'));
    });
    var imports = mode === 'python' ? pythonImports(needs, script) : rImports(needs, script); // rImports: Task 2
    var code = head.concat(imports.length ? imports : []).concat(['']).join('\n') + outLines.join('\n');
    return { code: code, warnings: warnings };
  }

  function rImports() { return []; }   // R: pakker refereres med :: — ingen import-blokk

  global.PortableExport = { transpile: transpile };
})(typeof window !== 'undefined' ? window : globalThis);
