// Felles klient-side nøkkellager (spec 2026-07-23-user-keys-and-source-registry).
// Én localStorage-post (md_keys, JSON-objekt type→verdi). Bevisst uten
// kryptering: trusselvurderingen (akseptert risiko, klient-only) står i
// spec-ens Decision log — nøkler holdes utenfor genererte script og prompter,
// men er lesbare for kode som kjører i siden, som før.
(function (global) {
  'use strict';
  var LS = 'md_keys';

  function readAll() {
    try { return JSON.parse(global.localStorage.getItem(LS) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function writeAll(all) { global.localStorage.setItem(LS, JSON.stringify(all)); }

  function get(type) { return readAll()[type] || ''; }
  function set(type, value) {
    var all = readAll();
    if (value) all[type] = value; else delete all[type];
    writeAll(all);
  }
  function remove(type) { set(type, ''); }
  function registered() {
    var all = readAll();
    return Object.keys(all).filter(function (k) { return !!all[k]; });
  }

  // Engangsmigrering fra md_anthropic_key (før 2026-07-23).
  var legacy = global.localStorage.getItem('md_anthropic_key');
  if (legacy) {
    if (!get('anthropic')) set('anthropic', legacy);
    global.localStorage.removeItem('md_anthropic_key');
  }

  global.Keys = { get: get, set: set, remove: remove, registered: registered };
})(typeof window !== 'undefined' ? window : globalThis);
