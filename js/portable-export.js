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

  // Emisjon for én kilde i python-modus. out.lines fylles; out.needs merkes.
  function emitPython(item, url, body, fmt, out) {
    if (body !== null) {
      out.needs.requests = true;
      out.needs.json = true;
      if (fmt === 'json') {
        out.lines.push(item.alias + ' = requests.post(' + pyStr(url) + ", json=json.loads(r'''" + body + "''')).json()");
      } else {
        out.needs.io = true;
        out.needs.pandas = true;
        out.lines.push('_resp = requests.post(' + pyStr(url) + ", json=json.loads(r'''" + body + "'''))");
        out.lines.push(item.alias + ' = pd.read_csv(io.StringIO(_resp.text), sep=None, engine="python")');
      }
      return;
    }
    if (fmt === 'json') {
      out.needs.requests = true;
      out.lines.push(item.alias + ' = requests.get(' + pyStr(url) + ').json()  # rå JSON — appens binding kan avvike');
      return;
    }
    if (fmt === 'parquet') {
      out.needs.pandas = true;
      out.lines.push(item.alias + ' = pd.read_parquet(' + pyStr(url) + ')  # krever pyarrow');
      return;
    }
    out.needs.pandas = true;
    out.lines.push(item.alias + ' = pd.read_csv(' + pyStr(url) + ', sep=None, engine="python")');
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
    var fmt = formatFor(item, url, warnings);
    if (mode === 'python') emitPython(item, url, body, fmt, out);
    else emitR(item, url, body, fmt, out);   // Task 2
    return out.lines;
  }

  function rStr(s) { return JSON.stringify(s); }

  function emitR(item, url, body, fmt, out) {
    if (body !== null) {
      out.lines.push('# krever httr (+ jsonlite for JSON-svar):');
      out.lines.push('_resp <- httr::POST(' + rStr(url) + ', body = ' + rStr(body) + ', encode = "raw", httr::content_type_json())');
      if (fmt === 'json') {
        out.lines.push(item.alias + ' <- httr::content(_resp, as = "parsed")');
      } else {
        out.lines.push(item.alias + ' <- read.csv(text = httr::content(_resp, as = "text"))  # NB: sjekk skilletegn (sep=";")');
      }
      return;
    }
    if (fmt === 'json') {
      out.lines.push(item.alias + ' <- jsonlite::fromJSON(' + rStr(url) + ')  # krever jsonlite');
      return;
    }
    if (fmt === 'parquet') {
      var tmp = '"' + item.alias + '.parquet"';
      out.lines.push('download.file(' + rStr(url) + ', ' + tmp + ', mode = "wb")');
      out.lines.push(item.alias + ' <- arrow::read_parquet(' + tmp + ')  # krever arrow');
      return;
    }
    out.lines.push(item.alias + ' <- read.csv(' + rStr(url) + ')  # NB: sjekk skilletegn — nordiske CSV-er bruker ofte sep=";"');
  }

  function transpile(script, mode, registry) {
    if (mode !== 'python' && mode !== 'r') throw new Error('portabel eksport støtter python og r, ikke «' + mode + '»');
    var DD = global.DataDirectives;
    var parsed = DD.parse(script);
    if (parsed.errors.length) throw new Error('Direktivfeil: ' + parsed.errors.join('; '));
    if (!parsed.loads.length) return { code: script, warnings: [] };
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
    var lines = String(script).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      var qi = -1;
      for (var q = 0; q < queue.length; q++) {
        if (queue[q] && queue[q].line === trimmed) { qi = q; break; }
      }
      if (qi >= 0) {
        outLines.push(lines[i]);                 // originaldirektivet som kommentar
        outLines.push.apply(outLines, queue[qi].emitted);
        queue[qi] = null;                        // konsumert (duplikatlinjer i rekkefølge)
      } else {
        outLines.push(lines[i]);
      }
    }

    var head = HEADER.slice();
    var imports = mode === 'python' ? pythonImports(needs, script) : rImports(needs, script); // rImports: Task 2
    var code = head.concat(imports.length ? imports : []).concat(['']).join('\n') + outLines.join('\n');
    return { code: code, warnings: warnings };
  }

  function rImports() { return []; }   // R: pakker refereres med :: — ingen import-blokk

  global.PortableExport = { transpile: transpile };
})(typeof window !== 'undefined' ? window : globalThis);
