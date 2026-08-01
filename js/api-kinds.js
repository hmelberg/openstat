// js/api-kinds.js — protokoll-adaptere for API-kilder (økt 2026-07-25,
// spec docs/superpowers/specs/2026-07-25-api-kinds-design.md §1):
// sdmx (OECD/ECB/Norges Bank/IMF …), dbnomics (~80 kilder), worldbank.
// Brukeren skriver KILDEN (kind(oecd)) — kindAlias mapper til protokollen.
// Ren modul uten nett/DOM: kjører under node --test. CSV-serialisering
// gjenbrukes fra js/pxweb.js (columnsToCsv) der flatenere trengs.
// SDMX-fellen (spec §0): 2.1-API-ene ignorerer ukjente parametre STILLE —
// send aldri noe kilden ikke garantert forstår; oversett verifiserbart
// eller feil høyt.
(function (global) {
  'use strict';

  // Kildenavn → protokoll-kind. Protokollnavnene er gyldige selv (for kilder
  // utenfor registeret); ukjente navn → null (ikke vår kind).
  var ALIAS = { oecd: 'sdmx', ecb: 'sdmx', norgesbank: 'sdmx', imf: 'sdmx',
                sdmx: 'sdmx', dbnomics: 'dbnomics', worldbank: 'worldbank' };
  function kindAlias(name) { return ALIAS[String(name || '').toLowerCase()] || null; }

  // Forsøk 1 for sdmx-datahenting (spec §0: virker hos OECD og NB; labels=id
  // gir rene koder — NBs default er labels=both). CORS-safelistet header
  // (ingen kolon i verdien → ingen preflight).
  var SDMX_ACCEPT = 'application/vnd.sdmx.data+csv;labels=id';

  // ECB 406-er på Accept-veien men tar format=csvdata (spec §0). 404/422 er
  // ekte feil (ukjent flow/nøkkel) — IKKE formatproblem, ingen fallback.
  function sdmxNeedsFallback(status, contentType) {
    if (status === 406) return true;
    if (status >= 400) return false;
    return String(contentType || '').toLowerCase().indexOf('csv') < 0;
  }

  function stripParam(query, name) {
    return (query ? query.split('&') : []).filter(function (p) {
      return p && p.split('=')[0].toLowerCase() !== name;
    });
  }
  function splitUrl(url) {
    var s = String(url || '');
    var q = s.indexOf('?');
    return { base: q >= 0 ? s.slice(0, q) : s, query: q >= 0 ? s.slice(q + 1) : '' };
  }

  function sdmxFallbackUrl(url) {
    var u = splitUrl(url);
    var parts = stripParam(u.query, 'format');
    parts.push('format=csvdata');
    return u.base + '?' + parts.join('&');
  }

  // ── worldbank (spec §1): enkel JSON [meta, [rader]], per_page-default 50
  // er en felle → 20000 når brukeren ikke velger; meta.pages driver
  // sideløkken i lastelaget. Feilformen er [{message:[{value: …}]}].
  function worldbankDataUrl(url) {
    var u = splitUrl(url);
    var parts = stripParam(u.query, 'format');
    if (!parts.some(function (p) { return p.split('=')[0].toLowerCase() === 'per_page'; })) {
      parts.push('per_page=20000');
    }
    parts.push('format=json');
    return u.base + '?' + parts.join('&');
  }
  function worldbankPageUrl(url, n) {
    var u = splitUrl(worldbankDataUrl(url));
    var parts = stripParam(u.query, 'page');
    parts.push('page=' + n);
    return u.base + '?' + parts.join('&');
  }
  function worldbankMeta(doc) {
    if (Array.isArray(doc) && doc.length && doc[0] && doc[0].message) {
      var msgs = doc[0].message.map(function (m) { return m.value || m.key || ''; }).join('; ');
      throw new Error('Verdensbanken avviste spørringen: ' + msgs);
    }
    if (!Array.isArray(doc) || doc.length < 2 || !doc[0]) {
      throw new Error('Uventet svar fra Verdensbanken (ikke [meta, rader])');
    }
    return { pages: Number(doc[0].pages || 1), total: Number(doc[0].total || 0) };
  }
  function worldbankColumns(docs) {
    var cols = { indicator: [], country: [], countryiso3code: [], date: [], value: [] };
    docs.forEach(function (doc) {
      (doc[1] || []).forEach(function (r) {
        cols.indicator.push(((r || {}).indicator || {}).id || '');
        cols.country.push(((r || {}).country || {}).id || '');
        cols.countryiso3code.push((r || {}).countryiso3code || '');
        cols.date.push((r || {}).date || '');
        var v = (r || {}).value;
        cols.value.push(v === undefined || v === null ? null : v);
      });
    });
    return cols;
  }

  // ── sdmx CSV-header-introspeksjon (spec §3, fase 2): nøkkeldimensjonene
  // er kolonnene mellom prefikset (DATAFLOW hos OECD, STRUCTURE,
  // STRUCTURE_ID,ACTION hos NB, KEY hos ECB) og TIME_PERIOD — én liten
  // lastNObservations=1-probe gir dem uten XML/DSD-parsing (pandasdmx-
  // tyngden vi bevisst unngår).
  function sdmxKeyDims(headerLine) {
    var cols = String(headerLine || '').replace(/\r$/, '').split(',');
    var t = cols.indexOf('TIME_PERIOD');
    if (t < 0) return [];
    var start = 0;
    if (cols[0] === 'STRUCTURE' && cols[1] === 'STRUCTURE_ID') start = (cols[2] === 'ACTION') ? 3 : 2;
    else if (cols[0] === 'DATAFLOW' || cols[0] === 'KEY') start = 1;
    return cols.slice(start, t);
  }

  // Kanoniske felt → punktumdelt nøkkelsti. countries → REF_AREA,
  // indicators → MEASURE, filters → navngitt dimensjon; flere verdier
  // skilles med + (SDMX-ELLER). Ukjent dimensjon → norsk feil som lister
  // gyldige (hard-feil-regelen: aldri stille passthrough).
  function sdmxKeyPath(dims, canonical) {
    var want = {};
    function put(dimId, values, label) {
      var i = dims.indexOf(dimId);
      if (i < 0) throw new Error(label + ': dataflowen har ingen ' + dimId + '-dimensjon — dimensjonene er ' + dims.join(', '));
      want[i] = values.join('+');
    }
    if (canonical.countries) put('REF_AREA', canonical.countries, 'countries()');
    if (canonical.indicators) put('MEASURE', canonical.indicators, 'indicators()');
    Object.keys(canonical.filters || {}).forEach(function (k) {
      put(k, [canonical.filters[k]], 'filters(' + k + '=…)');
    });
    return dims.map(function (_, i) { return want[i] || ''; }).join('.');
  }

  // ── dbnomics (spec §1): series.docs[] med period/value-arrayer;
  // observations=1 må tvinges (uten den kommer bare metadata). CSV-varianten
  // deres er BRED med avsnitts-lange kolonnenavn — derfor JSON + flatener.
  function dbnomicsDataUrl(url) {
    var u = splitUrl(url);
    var parts = stripParam(u.query, 'observations');
    parts.push('observations=1');
    return u.base + '?' + parts.join('&');
  }
  function dbnomicsColumns(doc) {
    var series = (doc || {}).series || {};
    var docs = series.docs || [];
    if (series.num_found > docs.length) {
      throw new Error('DBnomics-spørringen traff ' + series.num_found + ' serier, men API-et ' +
        'leverer maks ' + (series.limit || docs.length) + ' — snevre inn med ' +
        'filters={"<dimensjon>": "<kode>"} (table_metadata gir dimensjonskodene)');
    }
    // dimensjonskolonner: union over docs, sortert for stabil orden på tvers
    // av JS/Python (objektnøkkel-orden er ellers innsettingsavhengig)
    var dimNames = [];
    docs.forEach(function (d) {
      Object.keys(d.dimensions || {}).forEach(function (k) {
        if (dimNames.indexOf(k) < 0) dimNames.push(k);
      });
    });
    dimNames.sort();
    var cols = { series_code: [] };
    dimNames.forEach(function (k) { cols[k] = []; });
    cols.period = []; cols.value = [];
    docs.forEach(function (d) {
      var periods = d.period || [], values = d.value || [];
      for (var i = 0; i < periods.length; i++) {
        cols.series_code.push(d.series_code || '');
        dimNames.forEach(function (k) { cols[k].push(String((d.dimensions || {})[k] || '')); });
        cols.period.push(String(periods[i]));
        var v = values[i];
        cols.value.push(v === undefined || v === null || v === 'NA' ? null : v);
      }
    });
    return cols;
  }

  var api = { kindAlias: kindAlias, SDMX_ACCEPT: SDMX_ACCEPT,
              sdmxKeyDims: sdmxKeyDims, sdmxKeyPath: sdmxKeyPath,
              dbnomicsDataUrl: dbnomicsDataUrl, dbnomicsColumns: dbnomicsColumns,
              sdmxNeedsFallback: sdmxNeedsFallback, sdmxFallbackUrl: sdmxFallbackUrl,
              worldbankDataUrl: worldbankDataUrl, worldbankPageUrl: worldbankPageUrl,
              worldbankMeta: worldbankMeta, worldbankColumns: worldbankColumns };
  global.ApiKinds = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
