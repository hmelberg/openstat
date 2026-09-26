// tests/js/read-bridge.test.js — pandas-URL-broen (plan 2026-07-27).
const test = require('node:test');
const assert = require('node:assert');
require('../../js/data-loader.js');
require('../../js/read-bridge.js');
const PX = require('../../js/pxweb.js');
const RB = globalThis.ReadBridge;

test('scanUrls: finner literaler i read_csv/read_json/read_parquet', () => {
  const s = [
    'import pandas as pd',
    'iris = pd.read_csv("https://x.example/iris.csv")',
    "j = pd.read_json('https://x.example/d.json')",
    'p = pd.read_parquet("/api/hent?url=https%3A%2F%2Fy%2Fd.parquet")',
    'lokal = pd.read_csv("data/lokal.csv")',        // ikke URL — ignoreres
    'dyn = pd.read_csv(url)',                        // variabel — ignoreres (hint-prinsippet)
  ].join('\n');
  assert.deepEqual(RB.scanUrls(s), [
    'https://x.example/iris.csv',
    'https://x.example/d.json',
    '/api/hent?url=https%3A%2F%2Fy%2Fd.parquet',
  ]);
});

test('scanUrls: duplikater én gang, tom skript tom liste', () => {
  const s = 'a = pd.read_csv("https://x/a.csv")\nb = pd.read_csv("https://x/a.csv")';
  assert.deepEqual(RB.scanUrls(s), ['https://x/a.csv']);
  assert.deepEqual(RB.scanUrls(''), []);
});

test('ensure: cacher bytes; andre kall henter ikke på nytt', async () => {
  RB._reset();
  let calls = 0;
  RB._setFetcher(async (url) => { calls++; return { bytes: new Uint8Array([97]), contentType: 'text/csv' }; });
  const e1 = await RB.ensure('https://x/a.csv');
  const e2 = await RB.ensure('https://x/a.csv');
  assert.equal(calls, 1);
  assert.deepEqual(Array.from(e1.bytes), [97]);
  assert.equal(e2, RB.getCached('https://x/a.csv'));
});

test('ensure: feil caches som {error} — aldri et kast som forsvinner', async () => {
  RB._reset();
  RB._setFetcher(async () => { throw new Error('HTTP 404 for https://x/borte.csv'); });
  const e = await RB.ensure('https://x/borte.csv');
  assert.match(e.error, /HTTP 404/);
  assert.equal(RB.getCached('https://x/borte.csv').error, e.error);
});

test('forPyodideSync: cache-treff gir bytes; feil-entry gir error', async () => {
  RB._reset();
  RB._setFetcher(async () => ({ bytes: new Uint8Array([98]), contentType: 'text/csv' }));
  await RB.ensure('https://x/b.csv');
  assert.deepEqual(Array.from(RB.forPyodideSync('https://x/b.csv').bytes), [98]);
  RB._setFetcher(async () => { throw new Error('HTTP 500 for x'); });
  await RB.ensure('https://x/feil.csv');
  assert.match(RB.forPyodideSync('https://x/feil.csv').error, /HTTP 500/);
});

test('pyPatchSource: wrapper alle tre leserne og feiler høylytt', () => {
  const src = RB.pyPatchSource();
  ['read_csv', 'read_json', 'read_parquet'].forEach((n) => assert.ok(src.includes(n), n));
  assert.ok(src.includes('ValueError'));
  assert.ok(src.includes('/api/hent?'));
});

test('ensure: cachet feil er retrybar — neste ensure henter på nytt', async () => {
  RB._reset();
  let calls = 0;
  RB._setFetcher(async () => { calls++; if (calls === 1) throw new Error('HTTP 500 for x'); return { bytes: new Uint8Array([99]), contentType: 'text/csv' }; });
  const e1 = await RB.ensure('https://x/flaky.csv');
  assert.match(e1.error, /HTTP 500/);
  const e2 = await RB.ensure('https://x/flaky.csv');
  assert.equal(calls, 2);
  assert.deepEqual(Array.from(e2.bytes), [99]);
});

test('forPyodideSync: miss går til XHR og cacher suksess', () => {
  RB._reset();
  const urls = [];
  RB._setXhr((u) => { urls.push(u); return { status: 200, bytes: new Uint8Array([100]) }; });
  const r = RB.forPyodideSync('https://x/miss.csv');
  assert.deepEqual(Array.from(r.bytes), [100]);
  assert.deepEqual(urls, ['https://x/miss.csv']);
  assert.deepEqual(Array.from(RB.getCached('https://x/miss.csv').bytes), [100]);
});

test('forPyodideSync: status 0 (CORS) prøver proxy; 404 gjør IKKE', () => {
  RB._reset();
  let urls = [];
  RB._setXhr((u) => { urls.push(u); return u.indexOf('/api/hent?') === 0 ? { status: 200, bytes: new Uint8Array([1]) } : { status: 0, bytes: null }; });
  const ok = RB.forPyodideSync('https://cors.example/d.csv');
  assert.equal(ok.error, null);
  assert.equal(urls[1].indexOf('/api/hent?url='), 0);

  urls = [];
  RB._setXhr((u) => { urls.push(u); return { status: 404, bytes: null }; });
  const nope = RB.forPyodideSync('https://x/borte.csv');
  assert.equal(nope.bytes, null);
  assert.match(nope.error, /HTTP 404 for https:\/\/x\/borte\.csv/);
  assert.equal(urls.length, 1, 'ingen proxy-retry på ekte HTTP-status');
});

test('forPyodideSync: cachet prefetch-feil forgifter ikke — sync-veien prøver selv', async () => {
  RB._reset();
  RB._setFetcher(async () => { throw new Error('HTTP 503 for x (transient)'); });
  await RB.ensure('https://x/transient.csv');
  RB._setXhr(() => ({ status: 200, bytes: new Uint8Array([7]) }));
  const r = RB.forPyodideSync('https://x/transient.csv');
  assert.equal(r.error, null);
  assert.deepEqual(Array.from(r.bytes), [7]);
});

// ── smoke-revisjon (S5 + M2 + S3b) ──────────────────────────────────────────
const DL = globalThis.DataLoader;

test('S5 configure: deps når fetchRawUrl', async () => {
  RB._reset();
  const orig = DL.fetchRawUrl; const calls = [];
  DL.fetchRawUrl = async (url, deps) => { calls.push(deps); return { bytes: new Uint8Array([1]), contentType: '' }; };
  try {
    RB.configure(() => ({ anthropicKey: 'K' }));
    await RB.ensure('https://x/k.csv');
  } finally { DL.fetchRawUrl = orig; RB.configure(null); }
  assert.equal(calls[0].anthropicKey, 'K');
});

test('S5 syncXhr: proxy-retryen bærer auth-headere', () => {
  RB._reset();
  RB.configure(() => ({ anthropicKey: 'K2' }));
  const seen = [];
  RB._setXhr((u, headers) => {
    seen.push([u, headers || {}]);
    return u.indexOf('/api/hent?') === 0 ? { status: 200, bytes: new Uint8Array([2]) } : { status: 0, bytes: null };
  });
  const r = RB.forPyodideSync('https://cors.example/d.csv');
  RB.configure(null);
  assert.equal(r.error, null);
  assert.equal(seen[1][1]['X-Anthropic-Key'], 'K2');
});

test('syncXhr: en URL som allerede er /api/hent? bærer auth på første forsøk', () => {
  RB._reset();
  RB.configure(() => ({ anthropicKey: 'K3' }));
  const seen = [];
  RB._setXhr((u, headers) => { seen.push([u, headers || {}]); return { status: 200, bytes: new Uint8Array([3]) }; });
  const r = RB.forPyodideSync('/api/hent?url=' + encodeURIComponent('https://x/d.csv'));
  RB.configure(null);
  assert.equal(r.error, null);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1]['X-Anthropic-Key'], 'K3');
});

test('M2 ensureText: charset fra Content-Type respekteres (latin-1-fella)', async () => {
  RB._reset();
  // «kjønn» i iso-8859-1: ø = 0xF8 — ugyldig som utf-8
  RB._setFetcher(async () => ({ bytes: new Uint8Array([0x6b, 0x6a, 0xf8, 0x6e, 0x6e]),
                                contentType: 'text/csv; charset=iso-8859-1' }));
  const r = await RB.ensureText('https://x/l1.csv');
  assert.equal(r.error, undefined);
  assert.equal(r.text, 'kjønn');
});

test('M2 ensureText: udeklarert charset + ugyldig utf-8 feiler HØYLYTT, ikke mojibake', async () => {
  RB._reset();
  RB._setFetcher(async () => ({ bytes: new Uint8Array([0x6b, 0xf8]), contentType: 'text/csv' }));
  const r = await RB.ensureText('https://x/m.csv');
  assert.equal(r.text, undefined);
  assert.match(r.error, /dekode.*utf-8|charset/i);
});

test('M2 ensureText: hentefeil gir error videre', async () => {
  RB._reset();
  RB._setFetcher(async () => { throw new Error('HTTP 404 for https://x/b.csv'); });
  const r = await RB.ensureText('https://x/b.csv');
  assert.match(r.error, /HTTP 404/);
});

test('S3b pyPatchSource: idempotens-vakt mot wrapper-stabling', () => {
  assert.ok(RB.pyPatchSource().includes('_ost_url_wrapped'));
});

// ── S4: tag-baking + seeding (publiserings-sømmen) ──────────────────────────

test('S4 exportTags: scanUrls ∩ cache, b64-rundtur byte-nøyaktig', async () => {
  RB._reset();
  const bytes = new Uint8Array([0x6b, 0x6a, 0xf8, 0x6e, 0x6e, 0x00, 0xff]);  // «kjønn» i latin-1 + binærhale
  RB._setFetcher(async () => ({ bytes, contentType: 'text/csv; charset=iso-8859-1' }));
  await RB.ensure('https://x/l1.csv');
  const script = 'df = pd.read_csv("https://x/l1.csv")\nannen = pd.read_csv("https://x/ikke-hentet.csv")';
  const tags = RB.exportTags(script);
  assert.equal(tags.length, 1, 'kun cachede URL-er bakes');
  assert.equal(tags[0].url, 'https://x/l1.csv');
  assert.equal(tags[0].contentType, 'text/csv; charset=iso-8859-1');
  const back = Buffer.from(tags[0].b64, 'base64');
  assert.deepEqual(Array.from(back), Array.from(bytes));
});

test('S4 exportTags: feil-entries og tomme script gir tom liste', async () => {
  RB._reset();
  RB._setFetcher(async () => { throw new Error('HTTP 404 for x'); });
  await RB.ensure('https://x/borte.csv');
  assert.deepEqual(RB.exportTags('pd.read_csv("https://x/borte.csv")'), []);
  assert.deepEqual(RB.exportTags(''), []);
});

test('S4 _seedEntries: publisert side treffer cachen uten nett', () => {
  RB._reset();
  RB._seedEntries([{ url: 'https://x/baked.csv', contentType: 'text/csv; charset=iso-8859-1',
                     b64: Buffer.from([0x6b, 0xf8]).toString('base64') }]);
  const c = RB.getCached('https://x/baked.csv');
  assert.deepEqual(Array.from(c.bytes), [0x6b, 0xf8]);
  assert.equal(c.contentType, 'text/csv; charset=iso-8859-1');
  // og ensureText dekoder med den bakte charset-en
  return RB.ensureText('https://x/baked.csv').then((r) => assert.equal(r.text, 'kø'));
});

test('S4 _seedEntries: ugyldige entries hoppes over, velter ikke', () => {
  RB._reset();
  RB._seedEntries([null, {}, { url: 'https://x/ok.csv', b64: Buffer.from('a,b').toString('base64') }]);
  assert.ok(RB.getCached('https://x/ok.csv'));
});

// ── Task 1: R-URL-broen ───────────────────────────────────────────────────────

test('scanUrls fanger R-formene read.csv/read.csv2/fromJSON', () => {
  RB._reset();
  const script = [
    'df <- read.csv("https://a.example/x.csv")',
    'df2 <- utils::read.csv2("/api/hent?url=y")',
    'j <- jsonlite::fromJSON("https://api.worldbank.org/v2/x?format=json")',
    'r <- readr::read_csv("https://b.example/z.csv")',
    'lokal <- read.csv("/tmp/lokal.csv")',           // IKKE med (filsti)
    'prosa <- les.csv("https://c.example/nei.csv")', // IKKE med (ukjent navn)
  ].join('\n');
  assert.deepStrictEqual(RB.scanUrls(script), [
    'https://a.example/x.csv', '/api/hent?url=y',
    'https://api.worldbank.org/v2/x?format=json', 'https://b.example/z.csv',
  ]);
});

test('insertBytes legger i cache og exportTags baker den', () => {
  RB._reset();
  const bytes = new Uint8Array([104, 101, 105]); // "hei"
  RB.insertBytes('https://a.example/x.csv', bytes, 'text/csv');
  const c = RB.getCached('https://a.example/x.csv');
  assert.strictEqual(c.contentType, 'text/csv');
  assert.deepStrictEqual(Array.from(c.bytes), [104, 101, 105]);
  const tags = RB.exportTags('df <- read.csv("https://a.example/x.csv")');
  assert.strictEqual(tags.length, 1);
  assert.strictEqual(tags[0].url, 'https://a.example/x.csv');
});

test('insertBytes avviser rått søppel stille-fritt', () => {
  RB._reset();
  assert.throws(() => RB.insertBytes('https://a.example/x', 'ikke-bytes', ''), /Uint8Array/);
});

// ── Task 2: rPatchSource — R-kilden til broen ──────────────────────────────

test('rPatchSource: bærer kontraktens byggesteiner', () => {
  const src = RB.rPatchSource();
  for (const needle of [
    '.ost_bridge_config', '.ost_bridge_seed', '.ost_bridge_fetched_json',
    'unlockBinding', 'lockBinding', '.ost_patch_pkg("utils"', 'package:',
    'webr::eval_js', 'x-user-defined',           // binærtrygg sync-XHR (husets trikset)
    '/api/hent?url=',                            // proxy-retry-formen
    'setRequestHeader',                          // S5: auth-headere på proxyen
    'packageEvent("jsonlite"', 'packageEvent("readr"',
    '.ost_wrapped',                              // idempotens-vakt
    'HTTP ',                                     // høylytt feil m/ status
  ]) assert.ok(src.includes(needle), 'mangler: ' + needle);
  // Aldri stille: ingen tom catch rundt selve hentingen
  assert.ok(!/tryCatch\([^)]*error\s*=\s*function\(e\)\s*NULL/.test(src), 'stille sluking');
});

test('rPatchSource: R-kilden parser som gyldig R (strukturell sjekk)', () => {
  const src = RB.rPatchSource();
  // Balanserte klammer — fanger transkripsjonsfeil uten R-runtime i CI.
  let depth = 0;
  for (const ch of src) { if (ch === '{') depth++; if (ch === '}') depth--; assert.ok(depth >= 0); }
  assert.strictEqual(depth, 0);
});

// ── Task 3, omgjort i eksplisitt-dtypes-kirurgien (2026-07-28, Hans' over-
// raskelsesprinsipp): fødselstyping -> fødsels-ANNOTERING. pyPatchSource skal
// ALDRI lenger påvirke dtyper — pd.read_csv i appen skal være byte-lik naken
// pandas i verdier/dtyper. Det eneste birth-steget som gjenstår er å sette
// df.attrs["ost_typemeta"] for gjenkjente registerkilder (panelet leser den).
// Typing flytter til de eksplisitte funksjonene i openstat.py:
// read_csv(url, convert=True) (default) og convert_dtypes(df, meta=...). ───

test('pyPatchSource: fødsels-annotering — recognize + typemeta + attrs, ALDRI dtype-påvirkning', () => {
  const src = RB.pyPatchSource();
  for (const needle of ['recognize_url', '_typemeta_for', 'ost_typemeta', 'fortsetter uten']) {
    assert.ok(src.includes(needle), 'mangler: ' + needle);
  }
  assert.ok(!src.includes('"dtype"'),
    'skal IKKE lenger injisere dtype — typing er eksplisitt-only nå (read_csv(convert=True)/convert_dtypes)');
  assert.ok(!src.includes('_apply_best_effort'),
    'skal IKKE lenger kalle _apply_best_effort fra fødsel — kun attrs settes');
});

test('pyPatchSource: KUN read_csv rutes gjennom fødsels-annoteringen, json/parquet uendret', () => {
  const src = RB.pyPatchSource();
  assert.ok(src.includes('pd.read_csv = _ost_wrap_reader(pd.read_csv, True)'));
  assert.ok(src.includes('pd.read_json = _ost_wrap_reader(pd.read_json, False)'));
  assert.ok(src.includes('pd.read_parquet = _ost_wrap_reader(pd.read_parquet, False)'));
});

test('pyPatchSource: openstat-import feiler høylytt-fritt (try/except rundt import, aldri kast)', () => {
  const src = RB.pyPatchSource();
  assert.ok(src.includes('import openstat as _ost'));
  assert.ok(/try:\s*\n\s*import openstat as _ost\s*\n\s*except Exception as _e:/.test(src));
});

test('prefetchScript: gjenkjent registerkilde prefetcher metadata-json-stat2 (SAMME spørring) via PxWeb.dataUrlFor', () => {
  RB._reset();
  const calls = [];
  RB._setFetcher(async (url) => { calls.push(url); return { bytes: new Uint8Array([1]), contentType: 'text/csv' }; });
  const u = 'https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?valueCodes[Region]=*';
  RB.prefetchScript('df = pd.read_csv("' + u + '")');
  const rec = PX.recognizeUrl(u);
  const expected = PX.dataUrlFor(rec.kind, rec.base + '/' + rec.table + '?' + rec.query);
  assert.ok(calls.includes(u), 'CSV-URL-en selv prefetches (uendret oppførsel)');
  assert.ok(calls.includes(expected), 'metadata-URL-en prefetches som hint: ' + expected);
});

test('prefetchScript: ugjenkjent URL prefetcher KUN seg selv (ingen gjetting)', () => {
  RB._reset();
  const calls = [];
  RB._setFetcher(async (url) => { calls.push(url); return { bytes: new Uint8Array([1]), contentType: '' }; });
  RB.prefetchScript('df = pd.read_csv("https://example.org/ikke-et-register.csv")');
  assert.deepStrictEqual(calls, ['https://example.org/ikke-et-register.csv']);
});

// ── Task 1 (runtime-ost): forPyodideSync med valgfri headers-JSON ───────────

test('runtime-ost forPyodideSync: headers bypasser cachen (les OG skriv)', () => {
  RB._reset();
  const calls = [];
  RB._setXhr((u, headers) => { calls.push([u, headers || null]); return { status: 200, bytes: new Uint8Array([9]) }; });
  // Seedet headerløs oppføring skal IGNORERES av headers-kallet …
  RB.insertBytes('https://sdmx.example/EXR', new Uint8Array([1]), 'text/csv');
  const r = RB.forPyodideSync('https://sdmx.example/EXR', '{"Accept":"application/vnd.sdmx.data+csv"}');
  assert.equal(r.error, null);
  assert.deepEqual(Array.from(r.bytes), [9]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].Accept, 'application/vnd.sdmx.data+csv');
  // … og suksessen skal IKKE ha overskrevet den headerløse oppføringen.
  assert.deepEqual(Array.from(RB.getCached('https://sdmx.example/EXR').bytes), [1]);
});

test('runtime-ost forPyodideSync: proxylegg fletter auth- og custom-headere', () => {
  RB._reset();
  RB.configure(() => ({ anthropicKey: 'K3' }));
  const seen = [];
  RB._setXhr((u, headers) => {
    seen.push([u, headers || {}]);
    return u.indexOf('/api/hent?') === 0 ? { status: 200, bytes: new Uint8Array([2]) } : { status: 0, bytes: null };
  });
  const r = RB.forPyodideSync('https://cors.sdmx/EXR', '{"Accept":"text/csv"}');
  RB.configure(null);
  assert.equal(r.error, null);
  assert.equal(seen[0][1].Accept, 'text/csv');            // direktelegget bærer headerne
  assert.equal(seen[1][1]['X-Anthropic-Key'], 'K3');      // proxylegget: auth …
  assert.equal(seen[1][1].Accept, 'text/csv');            // … OG custom flettet inn
  assert.equal(RB.getCached('https://cors.sdmx/EXR'), null); // headers → aldri cache-skriv
});

test('runtime-ost forPyodideSync: tomme headere ≡ headerløst, ugyldig JSON er høylytt-i-retur', () => {
  RB._reset();
  RB._setXhr(() => ({ status: 200, bytes: new Uint8Array([5]) }));
  const r1 = RB.forPyodideSync('https://x/h.csv', '{}');
  assert.equal(r1.error, null);
  // '{}' ≡ dagens kall: suksessen CACHES som før.
  assert.deepEqual(Array.from(RB.getCached('https://x/h.csv').bytes), [5]);
  const r2 = RB.forPyodideSync('https://x/h2.csv', 'ikke json');
  assert.equal(r2.bytes, null);
  assert.match(r2.error, /headers-JSON/);
});

// ── Task 2: typemetaForUrl — typemeta via broen for panelberikelse ────────

test('typemetaForUrl: gjenkjent URL -> tm via bro-cachen; ukjent -> null', async () => {
  RB._reset();
  const fixture = require('fs').readFileSync(require('path').join(__dirname, '..', 'fixtures', 'pxweb_dataset.json'), 'utf8');
  const calls = [];
  RB._setFetcher(async (url) => { calls.push(url); return { bytes: Buffer.from(fixture), contentType: 'application/json; charset=utf-8' }; });
  const dataUrl = 'https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?outputFormat=csv';
  const tm = await RB.typemetaForUrl(dataUrl);
  assert.deepEqual(tm, PX.typeMetaFromJsonStat(JSON.parse(fixture)));
  // Beviset for RUTINGEN: det er METADATA-URL-en (metaUrlFor-utdata) som
  // hentes — ikke data-URL-en selv (prefetchScript-testens calls-mønster).
  assert.equal(calls.length, 1);
  assert.equal(calls[0], PX.metaUrlFor(dataUrl));
  assert.equal(await RB.typemetaForUrl('https://ourworldindata.org/grapher/co2.csv'), null);
});

test('typemetaForUrl: hentefeil og søppel-JSON -> null, aldri reject', async () => {
  RB._reset();
  RB._setFetcher(async () => { throw new Error('HTTP 500 for x'); });
  assert.equal(await RB.typemetaForUrl('https://data.ssb.no/api/pxwebapi/v2/tables/05839/data'), null);
  RB._reset();
  RB._setFetcher(async () => ({ bytes: Buffer.from('ikke json'), contentType: 'text/plain' }));
  assert.equal(await RB.typemetaForUrl('https://data.ssb.no/api/pxwebapi/v2/tables/05839/data'), null);
});

// ── Task 3: R-annotering (attr) + panelsveip-berikelse ─────────────────────

test('rPatchSource: wrapperen stempler ost_url-attributt (annotering, aldri typing)', () => {
  const src = RB.rPatchSource();
  assert.match(src, /attr\(res, "ost_url"\) <- u/);
  assert.match(src, /is\.data\.frame\(res\)/);
});

// ── R-URL-bro-oppfølging §2/§3: x-hent-truncated håndheves høylytt i ALLE
// proxy-konsumenter (data-loader.js sine tre + rPatchSource sin egen worker-
// XHR) + .ost_json_str tåler kontrolltegn (skulle ha knekt den genererte
// JS-strengen tidligere). Trunkering = FEIL DATA, aldri stille — se
// data-loader.js sin assertNotTruncated-kommentar. ───────────────────────────

test('fetchRawUrl: x-hent-truncated → høylytt feil, aldri stille avkortet data', async () => {
  const resp = { ok: true, headers: { get: (h) => h === 'x-hent-truncated' ? '1' : (h === 'content-type' ? 'text/csv' : null) },
                 arrayBuffer: async () => new ArrayBuffer(8) };
  await assert.rejects(
    () => DL.fetchRawUrl('/api/hent?url=x', { fetchImpl: async () => resp }),
    /50MB-grense/);
});

test('fetchLoadTarget (proxy-gren, via fetchResolvedItems): x-hent-truncated → høylytt feil', async () => {
  DL._resetCacheForTests();
  const resp = { ok: true, headers: { get: (h) => h === 'x-hent-truncated' ? '1' : (h === 'content-type' ? 'text/csv' : null) },
                 arrayBuffer: async () => new ArrayBuffer(8) };
  await assert.rejects(
    () => DL.fetchResolvedItems(
      [{ alias: 'big', url: 'https://x.example/big.csv', viaProxy: true }],
      { fetchImpl: async () => resp, registry: [] }),
    /50MB-grense/);
});

test('fetchLoadTarget (r0-gren, direkte /api/hent?-URL): x-hent-truncated → høylytt feil', async () => {
  DL._resetCacheForTests();
  const resp = { ok: true, headers: { get: (h) => h === 'x-hent-truncated' ? '1' : null },
                 arrayBuffer: async () => new ArrayBuffer(8) };
  await assert.rejects(
    () => DL.fetchResolvedItems(
      [{ alias: 'big', url: '/api/hent?url=https%3A%2F%2Fx.example%2Fbig.csv' }],
      { fetchImpl: async () => resp, registry: [] }),
    /50MB-grense/);
});

// L2-disk-cache-treffet (Cache API) er dekket av samme try/catch som resten
// av disk-cache-lesingen (linjen over var allerede der FØR denne oppgaven —
// enhver feil derfra behandles som «disk-cachen er utilgjengelig», og faller
// igjennom til et vanlig live-nettkall). assertNotTruncated der «renser»
// altså en stale truncated oppføring (aldri returnerer den) i stedet for å
// selv kaste helt ut av fetchResolvedItems — men treffer den STILL avkortede
// live-kilden etterpå, kaster DEN høylytt via samme vakt i fetchLoadTarget
// (den andre testen under). Aldri stille i noen av grenene.
test('fetchResolvedItems: stale L2-cache-treff (x-hent-truncated) renses — faller igjennom til frisk live-henting, aldri de cachede byte-ne', async () => {
  DL._resetCacheForTests();
  const fakeHit = {
    headers: {
      get: (h) => {
        if (h === 'x-hent-truncated') return '1';
        if (h === 'x-m2py-fetched-at') return String(Date.now());
        return null;
      },
    },
    arrayBuffer: async () => new ArrayBuffer(4),   // skal ALDRI leveres
  };
  global.caches = {
    open: async () => ({ match: async () => fakeHit, delete: async () => {}, put: async () => {} }),
  };
  const liveResp = { ok: true, headers: { get: (h) => h === 'content-type' ? 'text/csv' : null },
                     arrayBuffer: async () => new TextEncoder().encode('a,b\n1,2').buffer };
  try {
    const out = await DL.fetchResolvedItems(
      [{ alias: 'x', url: 'https://x.example/cached.csv', cache: '1h' }],
      { fetchImpl: async () => liveResp, registry: [] });
    assert.equal(new TextDecoder().decode(out[0].bytes), 'a,b\n1,2',
      'live-svaret vant — de 4 stale cache-bytene ble aldri returnert');
  } finally { delete global.caches; }
});

test('fetchResolvedItems: stale L2-cache-treff RENSET, men live-kilden er STILL avkortet → høylytt feil (aldri stille i noen av grenene)', async () => {
  DL._resetCacheForTests();
  const fakeHit = {
    headers: { get: (h) => {
      if (h === 'x-hent-truncated') return '1';
      if (h === 'x-m2py-fetched-at') return String(Date.now());
      return null;
    } },
    arrayBuffer: async () => new ArrayBuffer(4),
  };
  global.caches = { open: async () => ({ match: async () => fakeHit, delete: async () => {}, put: async () => {} }) };
  const stillTruncatedResp = { ok: true, headers: { get: (h) => h === 'x-hent-truncated' ? '1' : null },
                                arrayBuffer: async () => new ArrayBuffer(8) };
  try {
    // Direkte /api/hent?-URL (r0-grenen) — den grenen ER sjekket (til
    // forskjell fra r1-direkte mot fremmede verter, som aldri får headeren).
    await assert.rejects(
      () => DL.fetchResolvedItems(
        [{ alias: 'x', url: '/api/hent?url=https%3A%2F%2Fx.example%2Fcached2.csv', cache: '1h' }],
        { fetchImpl: async () => stillTruncatedResp, registry: [] }),
      /50MB-grense/);
  } finally { delete global.caches; }
});

test('forPyodideSync: truncated-flagg fra XHR → error-retur, ingen cache-skriv', () => {
  RB._reset();
  RB._setXhr(() => ({ status: 200, bytes: new Uint8Array([1]), truncated: true }));
  const r = RB.forPyodideSync('/api/hent?url=stor');
  assert.equal(r.bytes, null);
  assert.match(r.error, /50MB-grense/);
  assert.equal(RB.getCached('/api/hent?url=stor'), null);
});

test('forPyodideSync: truncated-flagg fra PROXY-RETRY-legget (status 0 → proxy) → error, ingen cache-skriv', () => {
  RB._reset();
  const seen = [];
  RB._setXhr((u) => {
    seen.push(u);
    return u.indexOf('/api/hent?') === 0
      ? { status: 200, bytes: new Uint8Array([1]), truncated: true }
      : { status: 0, bytes: null };
  });
  const r = RB.forPyodideSync('https://cors.example/stor.csv');
  assert.equal(r.bytes, null);
  assert.match(r.error, /50MB-grense/);
  assert.equal(RB.getCached('https://cors.example/stor.csv'), null);
  assert.equal(seen.length, 2, 'direkte forsøk + proxy-retry');
});

test('forPyodideSync: truncated-flagg med headers-JSON (bypass-legget) → error uendret', () => {
  RB._reset();
  RB._setXhr(() => ({ status: 200, bytes: new Uint8Array([1]), truncated: true }));
  const r = RB.forPyodideSync('https://sdmx.example/EXR', '{"Accept":"text/csv"}');
  assert.equal(r.bytes, null);
  assert.match(r.error, /50MB-grense/);
  assert.equal(RB.getCached('https://sdmx.example/EXR'), null);
});

test('rPatchSource: .ost_fetch-payloaden håndhever x-hent-truncated høylytt (R-URL-bro-oppfølging §2)', () => {
  const src = RB.rPatchSource();
  assert.ok(src.includes('x-hent-truncated'), 'mangler x-hent-truncated-sjekk i .ost_fetch-payloaden');
  assert.ok(src.includes('50MB-grense'), 'mangler høylytt 50MB-melding i JS-payloaden');
});

test('rPatchSource: .ost_json_str tåler kontrolltegn (\\n/\\r/\\t escapes + C0-stripping, R-URL-bro-oppfølging §3)', () => {
  const src = RB.rPatchSource();
  assert.ok(src.includes('  s <- gsub("\\n", "\\\\n", s, fixed = TRUE)'), 'mangler \\n-escaping');
  assert.ok(src.includes('  s <- gsub("\\r", "\\\\r", s, fixed = TRUE)'), 'mangler \\r-escaping');
  assert.ok(src.includes('  s <- gsub("\\t", "\\\\t", s, fixed = TRUE)'), 'mangler \\t-escaping');
  assert.ok(src.includes('[\\x01-\\x1f]'), 'mangler C0-stripping (\\x01-\\x1f droppes)');
  assert.ok(src.includes('fixed = TRUE'), 'skal bruke fixed=TRUE — ingen regex-metatolkning av mønster/erstatning');
});
