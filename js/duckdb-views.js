// js/duckdb-views.js — view-registeret for format(duckdb)-monterte assembly-
// datasett (økt 2026-07-24): {navn: sql} + ATTACH-listen fra
// AssemblyDuckdb.compile. DuckDB-wasm-øktene er ferske per kjøring
// (__duck.begin() dropper hele katalogen) — index.html replayer derfor
// registrationStatements() ved hver øktstart. Registeret erstattes i sin
// helhet av hver kjøring med monteringsdirektiver: scriptet er sannheten,
// og et script uten format(duckdb)-datasett tømmer det.
// Ren modul uten duckdb/DOM-avhengighet: kjører under node --test.
(function (global) {
  'use strict';

  var state = { views: {}, attaches: [] };

  function quoteIdent(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }

  function set(next) {
    state = { views: (next && next.views) || {}, attaches: (next && next.attaches) || [] };
  }

  function isEmpty() { return !Object.keys(state.views).length; }
  function names() { return Object.keys(state.views); }

  // Statement-liste for montering/replay. DETACH-ene er idempotens-vern
  // (ATTACH-er overlever øktbytte i samme wasm-instans, og alias-navnene
  // att_N er per-kompilering) og skal svelges ved feil; resten skal feile
  // hørbart hos kalleren.
  function statementsFor(reg) {
    var out = [];
    ((reg && reg.attaches) || []).forEach(function (a) {
      out.push({ sql: 'DETACH ' + quoteIdent(a.alias), ignoreError: true });
      out.push({ sql: a.sql, ignoreError: false });
    });
    var views = (reg && reg.views) || {};
    Object.keys(views).forEach(function (n) {
      out.push({ sql: 'CREATE OR REPLACE VIEW ' + quoteIdent(n) + ' AS ' + views[n], ignoreError: false });
    });
    return out;
  }

  // Øktstart-replay: uten views er attachene dødvekt — tom liste.
  function registrationStatements() {
    return isEmpty() ? [] : statementsFor(state);
  }

  var api = { set: set, isEmpty: isEmpty, names: names,
              statementsFor: statementsFor, registrationStatements: registrationStatements };
  global.DuckdbViews = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
