// js/pxweb.js — PxWeb-hjelpere for kind(pxweb)-kilder (økt 2026-07-24,
// spec docs/superpowers/specs/2026-07-24-pxweb-sources-design.md §2).
// Data hentes som json-stat2 (alltid lang-format, UTF-8 — default-CSV-en fra
// PxWeb er pivotert og iso-8859-1, verifisert mot SSB 2026-07-24) og
// konverteres til én kolonne per dimensjon (KODENE som verdier) + `value`.
// Ren modul uten nett/DOM-avhengighet: kjører under node --test. Formatet er
// også Eurostats — modulen er base-URL-nøytral for senere gjenbruk.
(function (global) {
  'use strict';

  // <tabell-url>[?query] -> <tabell-url>/<endepunkt>?<query> med lang=no som
  // default; på data-endepunktet tvinges outputFormat=json-stat2 (brukerens
  // øvrige valueCodes-/parametervalg bevares urørt).
  function buildUrl(url, endpoint, forceJsonStat) {
    var s = String(url || '');
    var q = s.indexOf('?');
    var base = q >= 0 ? s.slice(0, q) : s;
    var query = q >= 0 ? s.slice(q + 1) : '';
    var parts = query ? query.split('&').filter(Boolean) : [];
    if (forceJsonStat) {
      // outputFormatParams (f.eks. UseTexts) er CSV-visningsparametre —
      // sendt sammen med json-stat2 400-er SSB (maalt i metadata-runden).
      parts = parts.filter(function (p) {
        var k = p.split('=')[0].toLowerCase();
        return k !== 'outputformat' && k !== 'outputformatparams';
      });
    }
    var hasLang = parts.some(function (p) { return p.split('=')[0].toLowerCase() === 'lang'; });
    if (!hasLang) parts.unshift('lang=no');
    if (forceJsonStat) parts.push('outputFormat=json-stat2');
    return base.replace(/\/+$/, '') + '/' + endpoint + '?' + parts.join('&');
  }

  function dataUrl(url) { return buildUrl(url, 'data', true); }
  function metadataUrl(url) { return buildUrl(url, 'metadata', false); }

  // Eurostat (2026-07-25, verifisert live: json-stat2 + CORS *): URL-formen
  // er <base>/<kode>?format=JSON&lang=en&<dimensjon>=<verdi>-filtre — ingen
  // /data-suffiks, direkte dimensjonsparametre (ikke valueCodes[...]), og
  // lang=en som default (Eurostat har en/fr/de, ikke no). Konverteringen
  // (columnsFromJsonStat) er identisk — det VAR poenget med json-stat2-valget.
  function eurostatDataUrl(url) {
    var s = String(url || '');
    var q = s.indexOf('?');
    var base = q >= 0 ? s.slice(0, q) : s;
    var query = q >= 0 ? s.slice(q + 1) : '';
    var parts = (query ? query.split('&').filter(Boolean) : [])
      .filter(function (p) { return p.split('=')[0].toLowerCase() !== 'format'; });
    if (!parts.some(function (p) { return p.split('=')[0].toLowerCase() === 'lang'; })) {
      parts.unshift('lang=en');
    }
    parts.push('format=JSON');
    return base.replace(/\/+$/, '') + '?' + parts.join('&');
  }

  // Felles inngang for lastelag/eksport/montering: data-URL per kind.
  function dataUrlFor(kind, url) {
    return kind === 'eurostat' ? eurostatDataUrl(url) : dataUrl(url);
  }

  // Kategorikodene i posisjonsorden — category.index kan være objekt
  // {kode: posisjon} eller array [koder] (begge er lovlig json-stat2).
  function categoryCodes(dim) {
    var idx = ((dim || {}).category || {}).index;
    if (Array.isArray(idx)) return idx.map(String);
    var codes = Object.keys(idx || {});
    codes.sort(function (a, b) { return idx[a] - idx[b]; });
    return codes;
  }

  // json-stat2-dataset -> {DimId: [koder...], ..., value: [tall|null]}.
  // value-arrayen er row-major over size-listen i id-orden (json-stat2 §value);
  // sparse objekt-form ({flatIndeks: verdi}) gir null i hullene.
  function columnsFromJsonStat(ds) {
    var ids = ds.id || [];
    var size = ds.size || [];
    var codes = ids.map(function (id) { return categoryCodes((ds.dimension || {})[id]); });
    var total = size.reduce(function (a, b) { return a * b; }, 1);
    var cols = {};
    ids.forEach(function (id) { cols[id] = new Array(total); });
    var values = new Array(total);
    var sparse = ds.value && !Array.isArray(ds.value) ? ds.value : null;
    for (var flat = 0; flat < total; flat++) {
      var rest = flat;
      for (var d = ids.length - 1; d >= 0; d--) {
        cols[ids[d]][flat] = codes[d][rest % size[d]];
        rest = Math.floor(rest / size[d]);
      }
      var v = sparse ? sparse[flat] : (ds.value || [])[flat];
      values[flat] = (v === undefined || v === null) ? null : v;
    }
    cols.value = values;
    return cols;
  }

  // Kolonner -> UTF-8-vennlig CSV-tekst. null/NaN -> tom celle (read_csv-
  // nullstr og pandas ser den som NA).
  function columnsToCsv(cols) {
    var names = Object.keys(cols);
    var n = names.length ? (cols[names[0]] || []).length : 0;
    function cell(v) {
      if (v === null || v === undefined || (typeof v === 'number' && isNaN(v))) return '';
      var st = String(v);
      return /[",\n]/.test(st) ? '"' + st.replace(/"/g, '""') + '"' : st;
    }
    var lines = [names.map(cell).join(',')];
    for (var r = 0; r < n; r++) {
      lines.push(names.map(function (c) { return cell(cols[c][r]); }).join(','));
    }
    return lines.join('\n');
  }

  // all()-direktivet (Task 2 av "all()-direktiv for pxweb", spec §2): ekspander
  // en base-data-URL til å velge ALLE verdier for hver dimensjon som ikke
  // allerede er eksplisitt satt via valueCodes[...], med en cellevakt så vi
  // aldri stille ber om en for stor tabell. Ren funksjon — ingen nett/DOM;
  // Task 3 (async lastelag) henter metadata og kaller denne.
  var PXWEB_ALL_MAX_CELLS = 800000; // verifisert SSB-grense — IKKE endre tallet

  // Dimensjons-id-er + fullt antall verdier fra json-stat2-metadata. .size er
  // parallell til .id; fallback til .dimension[id].category.index.length hvis
  // .size mangler (f.eks. håndbygde fixtures).
  function dimSizesFromMeta(meta) {
    var ids = (meta && meta.id) || [];
    var size = (meta && meta.size) || null;
    var out = {};
    ids.forEach(function (id, i) {
      if (size && typeof size[i] === 'number') {
        out[id] = size[i];
      } else {
        out[id] = categoryCodes((meta.dimension || {})[id]).length;
      }
    });
    return out;
  }

  function expandAllUrl(url, meta, maxCells) {
    var s = String(url || '');
    var q = s.indexOf('?');
    var base = q >= 0 ? s.slice(0, q) : s;
    var query = q >= 0 ? s.slice(q + 1) : '';

    var explicit = {}; // Dim -> rå valueCodes-verdi (som satt i URL-en)
    var re = /valueCodes\[([^\]]+)\]=([^&]*)/g;
    var m;
    while ((m = re.exec(query))) { explicit[m[1]] = m[2]; }

    var sizes = dimSizesFromMeta(meta);
    var ids = (meta && meta.id) || [];

    var n = 1;
    ids.forEach(function (id) {
      var v = explicit[id];
      if (v === undefined) {
        n *= sizes[id]; // usatt -> fullt antall
      } else if (v.indexOf('(') < 0 && v.indexOf('*') < 0) {
        n *= v.split(',').length; // eksplisitt komma-liste -> listelengde
      } else {
        n *= sizes[id]; // uttrykk (from(/top(/range() eller *) -> fullt antall
      }
    });

    if (n > maxCells) {
      var table = null;
      var tm = base.match(/\/tables\/([^/?]+)/);
      if (tm) table = tm[1];
      return {
        error: 'all(): tabellen har for mange celler (' + n + ' > ' + maxCells +
          ') — begrens med filters()/years()/regions()',
        tooManyCells: { n: n, max: maxCells, table: table }
      };
    }

    var parts = query ? query.split('&').filter(Boolean) : [];
    ids.forEach(function (id) {
      if (explicit[id] === undefined) parts.push('valueCodes[' + id + ']=*');
    });
    return { url: base + '?' + parts.join('&') };
  }


  // ── Typet kanonisk vei (plan 2026-07-27) ──────────────────────────────────
  // json-stat2 bærer typesystemet (roller, kategoriorden, etiketter, enheter)
  // — CSV-leveransen kastet alt. Kontrakten DELES med openstat.py
  // (typemeta_from_jsonstat) via tests/fixtures/pxweb_dataset.json.
  function typeMetaFromJsonStat(ds) {
    var role = ds.role || {};
    var dims = {}, units = {};
    (ds.id || []).forEach(function (did) {
      var dim = (ds.dimension || {})[did] || {};
      var cat = dim.category || {};
      dims[did] = { categories: categoryCodes(dim),
                    labels: Object.assign({}, cat.label || {}) };
      var u = cat.unit || {};
      for (var k in u) units[k] = { base: u[k].base, decimals: u[k].decimals };
    });
    return { dims: dims, time: (role.time || []).slice(),
             metric: (role.metric || []).slice(), units: units };
  }

  // R-factor-runden §5: strengflaten R-workeren og mini-motorene konsumerer.
  // Strenger krysser alle broene (webr::eval_js, Brython/mpy-interop)
  // trivielt — objektformen gjør ikke det. Én kilde: gjenbruker recognize/
  // dataUrlFor/typeMetaFromJsonStat, aldri egen logikk.
  function metaUrlFor(url) {
    var rec = recognizeUrl(url);
    if (!rec) return '';
    var t = rec.base + '/' + rec.table + (rec.query ? '?' + rec.query : '');
    return dataUrlFor(rec.kind, t);
  }

  // Linjeprotokoll: «did \x1f time|dim \x1f code1 \x1f …» per dimensjon.
  // ERR:-prefiks i stedet for kast — kallerne er synkron R/python som skal
  // falle til utypet + notat, aldri velte. Separator-tegn i navn/koder er
  // teoretisk (register-koder), men stille korrupsjon er verre enn ERR.
  // Linjeorden = `order` (ds.id, kildens fasit) — for..in over dims ville
  // reordnet heltallslignende dim-id-er numerisk (ES2015-regelen, samme
  // felle som sidebar-typemeta i metadata-runden).
  function typemetaTsv(tm, order) {
    var lines = [];
    var dims = (tm && tm.dims) || {};
    var time = (tm && tm.time) || [];
    var dids;
    if (order && order.length) {
      dids = [];
      for (var i = 0; i < order.length; i++) {
        if (dims[order[i]]) dids.push(order[i]);
      }
    } else {
      dids = Object.keys(dims);
    }
    for (var d = 0; d < dids.length; d++) {
      var did = dids[d];
      var cats = (dims[did].categories || []).map(String);
      var all = [did].concat(cats).join('');
      if (all.indexOf('\x1f') !== -1 || all.indexOf('\n') !== -1) return 'ERR:separator-tegn i dimensjonsnavn/kode';
      lines.push([did, time.indexOf(did) !== -1 ? 'time' : 'dim'].concat(cats).join('\x1f'));
    }
    return lines.join('\n');
  }

  function typemetaTsvFromText(jsonText) {
    try {
      var ds = JSON.parse(jsonText);
      return typemetaTsv(typeMetaFromJsonStat(ds), ds.id || []);
    } catch (e) {
      // Saner kontrolltegn — V8s JSON.parse-meldinger siterer input og kan
      // bære \x1f/\n som ville korrumpert linjeprotokollen hos mottaker.
      return 'ERR:' + String((e && e.message) || e).replace(/[\x00-\x1f]/g, ' ').slice(0, 200);
    }
  }

  // Python-kilden som typer rammen ETTER pd.read_csv i Pyodide-preamblet.
  // Bor her (node-testbar streng, samme mønster som ReadBridge.pyPatchSource);
  // SEMANTIKKEN håndheves mot openstat.py sin apply_typemeta av pytest
  // (test_js_apply_source_paritet leser denne strengen og kjører den).
  // NB dtype-vernet: CSV-rundturen gjør «0301» til 301 — preamblet leser
  // derfor dimensjonskolonner som str FØR denne kjører.
  function pyApplyTypemetaSource() {
    return [
      'def _ost_all_intlike(_codes):',
      '    if not _codes:',
      '        return False',
      '    for _c in _codes:',
      '        try:',
      '            int(str(_c))',
      '        except (TypeError, ValueError):',
      '            return False',
      '    return True',
      'def _ost_apply_typemeta(_df, _tm):',
      '    for _did, _d in (_tm.get("dims") or {}).items():',
      '        if _did not in _df.columns:',
      '            continue',
      '        _cats = _d.get("categories") or []',
      '        if _did in (_tm.get("time") or []) and _ost_all_intlike(_cats):',
      '            _df[_did] = _df[_did].astype("int64")',
      '        else:',
      '            _df[_did] = pd.Categorical(_df[_did].astype(str), categories=[str(_c) for _c in _cats],',
      '                                       ordered=_did in (_tm.get("time") or []))',
      '    if "value" in _df.columns:',
      '        _df["value"] = pd.to_numeric(_df["value"], errors="coerce")',
      '    _df.attrs["ost_typemeta"] = _tm',
      '    return _df',
      ''
    ].join('\n');
  }

  // ── URL-gjenkjenning (paritet med openstat.py recognize_url — endres den
  // ene, endres den andre; delt fixture tests/fixtures/recognize_urls.json) ──
  var RECOGNIZE_PATTERNS = [
    ['pxweb', /^(https?:\/\/[^\/]+.*?\/tables)\/([A-Za-z0-9_]+)\/data$/],
    ['eurostat', /^(https?:\/\/ec\.europa\.eu\/eurostat\/api\/dissemination\/statistics\/1\.0\/data)\/([A-Za-z0-9_]+)$/],
  ];

  function recognizeUrl(url) {
    var s = String(url || '');
    if (s.indexOf('/api/hent?') === 0) {
      var q = s.split('?')[1] || '';
      var parts = q.split('&');
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].indexOf('url=') === 0) {
          // py-paritet: urllib.parse.unquote KASTER ALDRI (ugyldig %-koding
          // beholdes literal — unquote('%zz') -> '%zz'). decodeURIComponent
          // kaster URIError på samme input og ville veltet HELE kjøringen
          // (prefetchScript kaller recognizeUrl per literal-treff). Fallback
          // til udekodet streng: matcher aldri et gjenkjennelsesmønster,
          // altså samme observerbare utfall (null) som py-siden.
          var _raw = parts[i].slice(4);
          try { s = decodeURIComponent(_raw); } catch (e) { s = _raw; }
          break;
        }
      }
    }
    var qi = s.indexOf('?');
    var base = qi >= 0 ? s.slice(0, qi) : s;
    var query = qi >= 0 ? s.slice(qi + 1) : '';
    // Ingen verts-vakt — se py-tvillingens kommentar (paritet).
    for (var p = 0; p < RECOGNIZE_PATTERNS.length; p++) {
      var m = RECOGNIZE_PATTERNS[p][1].exec(base);
      if (m) return { kind: RECOGNIZE_PATTERNS[p][0], base: m[1], table: m[2], query: query };
    }
    return null;
  }

  // Obligatoriske dimensjoner (spec 2026-07-31-ssb-mandatory-variabler):
  // PxWeb v2 400-er på filtrerte spørringer uten valg for alle
  // elimination=false-dimensjoner. Ren analyse av tabell-URL + metadata —
  // node-testet; data-loader bruker den KUN på 400-feilveien.
  function missingMandatory(url, meta) {
    var q = String(url || '');
    var chosen = {};
    var re = /[?&]valueCodes\[([^\]]+)\]=/g;
    var m;
    while ((m = re.exec(q))) chosen[m[1]] = true;
    var timeDims = ((meta || {}).role || {}).time || [];
    var dims = (meta || {}).dimension || {};
    var out = [];
    Object.keys(dims).forEach(function (id) {
      if (chosen[id]) return;
      var d = dims[id] || {};
      var elim = (d.extension || {}).elimination;
      var mandatory = elim === undefined
        ? (id === 'ContentsCode' || timeDims.indexOf(id) >= 0)
        : elim === false;
      if (!mandatory) return;
      var labels = (d.category || {}).label || {};
      var codes = categoryCodes(d).slice(0, 10).map(function (c) {
        return { code: c, label: labels[c] || c };
      });
      out.push({ dim: id, label: d.label || id, codes: codes });
    });
    return out;
  }

  function mandatoryErrorMessage(table, missing) {
    var deler = (missing || []).map(function (mm) {
      var syntaks = mm.dim === 'ContentsCode' ? 'indicators=["<kode>"]'
        : mm.dim === 'Tid' ? 'years="<fra:til>"'
        : 'filters={"' + mm.dim + '": "<kode>"}';
      var koder = mm.codes.map(function (c) {
        return c.code === c.label ? c.code : c.code + ' (' + c.label + ')';
      }).join(', ');
      return mm.dim + ' [' + mm.label + '] — bruk ' + syntaks + '; gyldige koder: ' + koder;
    });
    return 'PxWeb-tabell ' + table + ' krever valg for obligatoriske dimensjoner ' +
      '(400 Missing selection). Legg til i read-linjen: ' + deler.join(' | ');
  }

  var api = { dataUrl: dataUrl, metadataUrl: metadataUrl,
              eurostatDataUrl: eurostatDataUrl, dataUrlFor: dataUrlFor,
              columnsFromJsonStat: columnsFromJsonStat, columnsToCsv: columnsToCsv,
              PXWEB_ALL_MAX_CELLS: PXWEB_ALL_MAX_CELLS, expandAllUrl: expandAllUrl,
              typeMetaFromJsonStat: typeMetaFromJsonStat, pyApplyTypemetaSource: pyApplyTypemetaSource,
              metaUrlFor: metaUrlFor, typemetaTsvFromText: typemetaTsvFromText,
              recognizeUrl: recognizeUrl,
              missingMandatory: missingMandatory, mandatoryErrorMessage: mandatoryErrorMessage };
  global.PxWeb = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
