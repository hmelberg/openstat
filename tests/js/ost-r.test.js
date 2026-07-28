// tests/js/ost-r.test.js — R-typing-kilden (r-factor-runden §3).
// Kildetekst-asserter (pyPatchSource-presedensen): R kjøres ikke i CI —
// kontraktsbærende uttrykk sjekkes tekstlig, semantikken bevises i smoke.
const test = require('node:test');
const assert = require('node:assert');
require('../../js/ost-r.js');
const src = globalThis.OstR.rSource();

test('rSource: definerer begge funksjonene med riktige signaturer', () => {
  assert.match(src, /ost_read_csv <- function\(url, convert = TRUE, \.\.\.\)/);
  assert.match(src, /ost_convert_dtypes <- function\(df, meta\)/);
});

test('rSource: best-effort-paritet — koder-vakt, intlike-time, kildens orden, ordered', () => {
  assert.match(src, /all\(vals %in% cats\)/);                       // kun KODER typles
  assert.match(src, /grepl\("\^-\?\[0-9\]\+\$", cats\)/);           // intlike-regelen
  assert.match(src, /factor\(as\.character\(df\[\[did\]\]\), levels = cats, ordered = isTRUE\(e\$time\)\)/);
  assert.match(src, /as\.integer/);
});

test('rSource: aldri-kast for metadata + hoylytt melding + colClasses-vern', () => {
  assert.match(src, /tryCatch/);
  assert.match(src, /laster utypet/);
  assert.match(src, /colClasses/);
  assert.match(src, /'ost_convert_dtypes krever meta='|"ost_convert_dtypes krever meta="/);
});

test('rSource: attr settes for gjenkjent kilde uansett convert', () => {
  assert.match(src, /attr\(df, "ost_url"\) <- url/);
});

// r-factor-knippet §2-4 (docs/superpowers/specs/2026-07-29-r-factor-knippet-design.md)

test('rSource: !NOPX-markøren skiller PxWeb-mangler fra ukjent kilde', () => {
  assert.match(src, /!NOPX/);
});

test('rSource: ost_read_csv melder PxWeb-mangel og laster utypet uten kast', () => {
  assert.match(src, /message\("ost: PxWeb utilgjengelig i workeren/);
});

test('rSource: ost_convert_dtypes stopper høylytt med domenemelding når PxWeb mangler', () => {
  assert.match(src, /PxWeb utilgjengelig i workeren \\u2014 kan ikke sl\\u00e5 opp metadata n\\u00e5/);
});

test('rSource: attr settes fra ost_convert_dtypes sin URL-vei (py-paritet)', () => {
  assert.match(src, /attr\(out, "ost_url"\) <- meta/);
});

test('rSource: shape-sjekk gir domenemelding for malformet meta-liste', () => {
  assert.match(src, /meta m\\u00e5 v\\u00e6re en register-URL eller en typemeta-liste \(list\(did=, time=, codes=\) per dimensjon\)/);
});

test('index.html-boot: pxweb-lasting og rSource-eval i ATSKILTE try/catch (r-factor-knippet §1)', () => {
  // Regresjonsvern for rundens viktigste fiks: slås de sammen igjen, blir
  // ost_read_csv udefinert når pxweb-lastingen kaster (i stedet for å
  // degradere til utypet). Kildetekst-assert etter husets index.html-mønster.
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  assert.ok(html.includes("console.warn('ost-r: pxweb-lasting:', e)"), 'pxweb-warn finnes');
  assert.ok(html.includes("console.warn('ost-r: rSource-eval:', e)"), 'rSource-warn finnes');
  const seg = html.slice(html.indexOf("ost-r: pxweb-lasting"), html.indexOf("ost-r: rSource-eval"));
  assert.ok(seg.includes('try {'), 'rSource-evalen har EGEN try etter pxweb-catch-en');
});
