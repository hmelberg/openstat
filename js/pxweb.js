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
      parts = parts.filter(function (p) { return p.split('=')[0].toLowerCase() !== 'outputformat'; });
    }
    var hasLang = parts.some(function (p) { return p.split('=')[0].toLowerCase() === 'lang'; });
    if (!hasLang) parts.unshift('lang=no');
    if (forceJsonStat) parts.push('outputFormat=json-stat2');
    return base.replace(/\/+$/, '') + '/' + endpoint + '?' + parts.join('&');
  }

  function dataUrl(url) { return buildUrl(url, 'data', true); }
  function metadataUrl(url) { return buildUrl(url, 'metadata', false); }

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

  var api = { dataUrl: dataUrl, metadataUrl: metadataUrl,
              columnsFromJsonStat: columnsFromJsonStat, columnsToCsv: columnsToCsv };
  global.PxWeb = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
