const test = require('node:test');
const assert = require('node:assert');
const C = require('../../js/cells.js');

test('parseHeader: bare markør → ingen type/attrs', () => {
  const h = C.parseHeader('#%%');
  assert.strictEqual(h.type, null);
  assert.deepStrictEqual(h.attrs, {});
  assert.deepStrictEqual(h.warnings, []);
});

test('parseHeader: type, begge stavemåter, case-insensitiv', () => {
  assert.strictEqual(C.parseHeader('#%% python').type, 'python');
  assert.strictEqual(C.parseHeader('# %% r').type, 'r');
  assert.strictEqual(C.parseHeader('#%% PYTHON').type, 'python');
});

test('parseHeader: aliaser og VS Code-brakettform', () => {
  assert.strictEqual(C.parseHeader('#%% py').type, 'python');
  assert.strictEqual(C.parseHeader('#%% pyodide').type, 'python');
  assert.strictEqual(C.parseHeader('#%% markdown').type, 'md');
  assert.strictEqual(C.parseHeader('#%% text').type, 'md');
  assert.strictEqual(C.parseHeader('# %% [markdown]').type, 'md');
});

test('parseHeader: attrs — flagg, key=value, sitert verdi', () => {
  const h = C.parseHeader('#%% r id=plot hide-code style=card');
  assert.strictEqual(h.type, 'r');
  assert.deepStrictEqual(h.attrs, { id: 'plot', 'hide-code': true, style: 'card' });
  assert.deepStrictEqual(h.warnings, []);
  const s = C.parseHeader('#%% python speak="hei verden"');
  assert.strictEqual(s.attrs.speak, 'hei verden');
});

test('parseHeader: ulukket sitat → advarsel + degradert til mellomrom-splitt, ingen throw', () => {
  let h;
  assert.doesNotThrow(() => { h = C.parseHeader('#%% python speak="hei'); });
  assert.ok(h.warnings.some((w) => /ulukket "/.test(w)), 'advarsel om ulukket sitat mangler');
  // Degradert parsing: tokeniseringen faller til mellomrom-splitt, så typen
  // fanges fortsatt og attributtet får den rå (sitatledede) verdien.
  assert.strictEqual(h.type, 'python');
  assert.strictEqual(h.attrs.speak, '"hei');
});

test('parseHeader: advarsler — ukjent nøkkel/flagg/style, ugyldig id', () => {
  assert.match(C.parseHeader('#%% python foo=bar').warnings[0], /ukjent attributt/);
  assert.match(C.parseHeader('#%% python blah').warnings[0], /ukjent flagg/);
  assert.match(C.parseHeader('#%% python style=fancy').warnings[0], /ukjent style/);
  const bad = C.parseHeader('#%% python id=æøå');
  assert.match(bad.warnings[0], /ugyldig id/);
  assert.strictEqual(bad.attrs.id, undefined);
});

test('parseHeader: widgets — top/bottom/left gyldig, andre verdier advarer (widget-plassering-fasen)', () => {
  assert.deepStrictEqual(C.parseHeader('#%% python widgets=top').attrs, { widgets: 'top' });
  assert.deepStrictEqual(C.parseHeader('#%% python widgets=top').warnings, []);
  assert.deepStrictEqual(C.parseHeader('#%% python widgets=bottom').warnings, []);
  assert.deepStrictEqual(C.parseHeader('#%% python widgets=left').warnings, []);
  const bad = C.parseHeader('#%% python widgets=weird');
  assert.match(bad.warnings[0], /ukjent widgets-plassering/);
  assert.strictEqual(bad.attrs.widgets, 'weird', 'verdien beholdes selv om den advarer (samme filosofi som style)');
});

test('parseHeader: ukjent første token er attr, ikke type', () => {
  const h = C.parseHeader('#%% notatype');
  assert.strictEqual(h.type, null);
  assert.strictEqual(h.attrs.notatype, true);
  assert.strictEqual(h.warnings.length, 1);
});

test('isMarkerLine/hasMarkers', () => {
  assert.ok(C.isMarkerLine('#%%'));
  assert.ok(C.isMarkerLine('# %% python id=x'));
  assert.ok(!C.isMarkerLine('  #%%'));            // kun kolonne 0
  assert.ok(!C.isMarkerLine('#%%x'));
  assert.ok(C.hasMarkers('a\n#%% md\nb'));
  assert.ok(!C.hasMarkers('print(1)'));
  assert.ok(C.isMarkerLine('#%%\r'));             // CRLF-dokumenter
});

test('supportedMode / isCodeType / resolveType', () => {
  assert.ok(C.supportedMode('python') && C.supportedMode('r') &&
            C.supportedMode('duckdb') && C.supportedMode('microdata'));
  // Fase C (spec 2026-07-16): brython er nå en støttet modus — se egen
  // test lenger ned. jamovi er fortsatt ikke-støttet (ingen motor).
  assert.ok(!C.supportedMode('jamovi'));
  assert.ok(C.isCodeType('python') && !C.isCodeType('md') &&
            !C.isCodeType('html') && !C.isCodeType('skip'));
  assert.strictEqual(C.resolveType({ type: null }, 'r'), 'r');
  assert.strictEqual(C.resolveType({ type: 'md' }, 'r'), 'md');
});

test('parseCells: uten markører → én implisitt preambelcelle', () => {
  const p = C.parseCells('print(1)\nprint(2)');
  assert.strictEqual(p.cells.length, 1);
  assert.strictEqual(p.cells[0].headerRaw, null);
  assert.strictEqual(p.cells[0].source, 'print(1)\nprint(2)');
});

test('parseCells: preambel + to celler, spans og kilder', () => {
  const doc = '# load x\n\n#%% md\n# Tittel\n\n#%% python id=a\n1 + 1';
  const p = C.parseCells(doc);
  assert.strictEqual(p.cells.length, 3);
  assert.strictEqual(p.cells[0].headerRaw, null);
  assert.strictEqual(p.cells[0].source, '# load x\n');
  assert.strictEqual(p.cells[1].type, 'md');
  assert.strictEqual(p.cells[1].headerLine, 2);
  assert.strictEqual(p.cells[1].source, '# Tittel\n');
  assert.strictEqual(p.cells[2].attrs.id, 'a');
  assert.strictEqual(p.cells[2].source, '1 + 1');
  assert.strictEqual(p.cells[2].startLine, 5);
  assert.strictEqual(p.cells[2].endLine, 6);
});

test('parseCells: dokument som starter med markør har ingen preambel', () => {
  const p = C.parseCells('#%% python\nx = 1');
  assert.strictEqual(p.cells.length, 1);
  assert.strictEqual(p.cells[0].headerRaw, '#%% python');
});

test('parseCells: duplisert id gir advarsel', () => {
  const p = C.parseCells('#%% python id=a\n1\n#%% r id=a\n2');
  assert.ok(p.warnings.some(w => /duplisert id/.test(w)));
});

test('round-trip: serialize(parse(t)) === t — eksakt', () => {
  const docs = [
    'print(1)',
    'print(1)\n',
    '# pre\n#%% md\ntekst\n\n#%% python id=x hide-code\n1+1\n',
    '#%% r',                    // header-only, ingen body
    '#%% r\n',                  // header + én tom linje
    '#%%\n#%% python\n',        // to markører rett etter hverandre
    '\n\n#%% md\n',             // blank preambel bevares
    '',
  ];
  for (const d of docs) {
    assert.strictEqual(C.serializeCells(C.parseCells(d).cells), d, JSON.stringify(d));
  }
});

test('cellBlock: redigert celle serialiseres med header', () => {
  const p = C.parseCells('#%% python\nx = 1');
  p.cells[0].source = 'x = 2';
  p.cells[0].hasBody = true;
  assert.strictEqual(C.serializeCells(p.cells), '#%% python\nx = 2');
});

test('executableSource: uten markører → uendret', () => {
  assert.strictEqual(C.executableSource('x = 1\ny = 2', 'python'), 'x = 1\ny = 2');
});

test('executableSource: kodecelle-header → ## lang, md blankes, linjetall bevares', () => {
  const doc = '# pre\n#%% md\n# En **tittel**\nmer tekst\n#%% python\n1 + 1\n#%% r\nsummary(x)';
  const out = C.executableSource(doc, 'python');
  const inLines = doc.split('\n'), outLines = out.split('\n');
  assert.strictEqual(outLines.length, inLines.length);          // linjetall bevart
  assert.strictEqual(outLines[0], '# pre');                     // preambel urørt
  assert.strictEqual(outLines[1], '');                          // md-header blanket
  assert.strictEqual(outLines[2], '');                          // md-innhold blanket
  assert.strictEqual(outLines[3], '');
  assert.strictEqual(outLines[4], '## python');                 // header → segmentmarkør
  assert.strictEqual(outLines[5], '1 + 1');
  assert.strictEqual(outLines[6], '## r');
  assert.strictEqual(outLines[7], 'summary(x)');
});

test('executableSource: default-type følger docMode', () => {
  const out = C.executableSource('#%%\nsummary(x)', 'r');
  assert.strictEqual(out.split('\n')[0], '## r');
});

test('executableSource: skip og usegmenterbare språk blankes', () => {
  const doc = '#%% skip\nhemmelig()\n#%% brython\nalert(1)\n#%% python\n1';
  const out = C.executableSource(doc, 'python').split('\n');
  assert.deepStrictEqual(out.slice(0, 4), ['', '', '', '']);
  assert.strictEqual(out[4], '## python');
});

test('segmentPlan: preambel leder, deretter kjørbare celler i rekkefølge', () => {
  const doc = '# pre\n#%% md\ntekst\n#%% python\n1\n#%% r\n2';
  // celleindekser: 0=preambel, 1=md, 2=python, 3=r
  assert.deepStrictEqual(C.segmentPlan(doc, 'python'), [0, 2, 3]);
});

test('segmentPlan: md først (ingen preambel) blankes helt — ingen leder-segment', () => {
  // executableSource blanker HELE md-cellen (header+body); parseHybridScripts
  // flush() dropper et segment som trimmer til tomt, så det finnes ingen
  // reell segment 0 å tilskrive — kun python-cellen kjører (verifisert Task 6).
  const doc = '#%% md\ntekst\n#%% python\n1';
  assert.deepStrictEqual(C.segmentPlan(doc, 'python'), [1]);
});

test('segmentPlan: dokument som starter rett på kodecelle', () => {
  const doc = '#%% python\n1\n#%% python\n2';
  assert.deepStrictEqual(C.segmentPlan(doc, 'python'), [0, 1]);
});

// ---- alignPlan (Task 9 bug (a)-fiks) ----

test('alignPlan: eksakt kind-match → planen returneres uendret', () => {
  const doc = '# pre\n#%% python\n1\n#%% r\n2';
  const p = C.parseCells(doc);
  const plan = C.segmentPlan(doc, 'python'); // [0, 1, 2]
  const aligned = C.alignPlan(plan, p.cells, 'python', ['pyodide', 'pyodide', 'r']);
  assert.deepStrictEqual(aligned, plan);
});

test('alignPlan: preambel strippet bort (kun #options.*-linjer) → planen justeres uten leder', () => {
  // Speiler bug (a): en preambel som KUN inneholder direktivlinjer blir blank
  // etter effectiveScript-strippingen i index.html (~8541) og gir dermed
  // ALDRI et faktisk kjøretidssegment, selv om segmentPlan (som jobber på rå
  // kildetekst) fortsatt teller den som et lederssegment.
  const doc = '#options.mode = microdata\n#%% microdata\nrequire no.ssb.fdb:51 as db\n#%% microdata\nsummarize inntekt';
  const p = C.parseCells(doc);
  const plan = C.segmentPlan(doc, 'python'); // [0, 1, 2] — preambel + to celler
  assert.deepStrictEqual(plan, [0, 1, 2]);
  // Faktiske kjøretidssegmenter: preambelen forsvant, kun de to cellene kjørte.
  const aligned = C.alignPlan(plan, p.cells, 'python', ['microdata', 'microdata']);
  assert.deepStrictEqual(aligned, [1, 2]);
});

test('alignPlan: reelt avvik (ingen 1:1-mapping mulig) → null', () => {
  const doc = '#%% python\n1\n#%% r\n2';
  const p = C.parseCells(doc);
  const plan = C.segmentPlan(doc, 'python'); // [0, 1]
  // Verken uendret plan eller preambel-fjernet variant matcher denne kind-
  // sekvensen (feil rekkefølge/antall) — f.eks. en manuelt skrevet '## r'
  // midt inni en celle som splitter kjøretiden i tre reelle segmenter.
  const aligned = C.alignPlan(plan, p.cells, 'python', ['pyodide', 'r', 'r']);
  assert.strictEqual(aligned, null);
});

test('alignPlan: preambel finnes ikke (planen starter ikke med en ekte preambel) → null ved avvik', () => {
  const doc = '#%% python\n1\n#%% r\n2';
  const p = C.parseCells(doc);
  const plan = C.segmentPlan(doc, 'python'); // [0, 1] — begge ekte celler, ingen preambel
  const aligned = C.alignPlan(plan, p.cells, 'python', ['r']); // feil lengde/kind, og plan[0] er ikke preambel
  assert.strictEqual(aligned, null);
});

// ---- paramLangForType (spec 2 W4, Task 2): celletype → #@param-språk ------

test('paramLangForType: python-familien (python/brython/micropython) → "python"', () => {
  assert.strictEqual(C.paramLangForType('python'), 'python');
  assert.strictEqual(C.paramLangForType('brython'), 'python');
  assert.strictEqual(C.paramLangForType('micropython'), 'python');
});

test('paramLangForType: r → "r"', () => {
  assert.strictEqual(C.paramLangForType('r'), 'r');
});

test('paramLangForType: duckdb/microdata/statx/md/html/skip/ukjent → null (parse-gate, #@param inert)', () => {
  ['duckdb', 'microdata', 'statx', 'md', 'html', 'skip', 'nonsense', undefined, null].forEach((type) => {
    assert.strictEqual(C.paramLangForType(type), null, 'type=' + type);
  });
});

// ---- forklarCellSteps / mdNarrationText (fase B2 Task 2: skrittvis celleavspilling) ----

test('forklarCellSteps: kode-celler blir "code"-steg, md blir "md"-steg, skip/html utelates', () => {
  const doc = '#%% md\nHallo\n#%% python\n1+1\n#%% skip\nx = 1\n#%% html\n<b>hei</b>\n#%% python\n2+2';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.deepStrictEqual(steps.map(s => s.kind), ['md', 'code', 'code']);
  assert.strictEqual(steps[0].source, 'Hallo');
  assert.strictEqual(steps[1].source, '1+1');
  assert.strictEqual(steps[2].source, '2+2');
});

test('forklarCellSteps: ikke-kjørbar kodetype (uten SEG_MARKER, f.eks. brython) utelates helt — verken kjørt eller lest', () => {
  const doc = '#%% brython\nprint(1)\n#%% python\n1+1';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.deepStrictEqual(steps.map(s => s.kind), ['code']);
  assert.strictEqual(steps[0].source, '1+1');
});

test('forklarCellSteps: ikke-blank preambel er ETT "code"-steg (speiler segmentPlan)', () => {
  const doc = '# load noe\n#%% python\n1+1';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.deepStrictEqual(steps.map(s => s.kind), ['code', 'code']);
  assert.strictEqual(steps[0].source, '# load noe');
});

test('forklarCellSteps: blank/manglende preambel gir intet steg', () => {
  const doc = '#%% python\n1+1';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.strictEqual(steps.length, 1);
  assert.strictEqual(steps[0].kind, 'code');
});

test('forklarCellSteps: tom md-celle er fortsatt ETT "md"-steg (tomhet håndteres av mdNarrationText/blokkbygger, ikke her)', () => {
  const doc = '#%% md\n#%% python\n1';
  const steps = C.forklarCellSteps(doc, 'python');
  assert.deepStrictEqual(steps.map(s => s.kind), ['md', 'code']);
  assert.strictEqual(steps[0].source, '');
});

test('mdNarrationText: overskrifter, emphasis, lenker, inline-kode og lister strippes rimelig', () => {
  const src = '# Tittel\n\nDette er **fet** og *kursiv* tekst med `kode` og en [lenke](https://x.no).\n\n- punkt en\n- punkt to';
  const out = C.mdNarrationText(src);
  assert.ok(out.indexOf('#') === -1, 'ingen # igjen: ' + out);
  assert.ok(out.indexOf('*') === -1, 'ingen * igjen: ' + out);
  assert.ok(out.indexOf('`') === -1, 'ingen ` igjen: ' + out);
  assert.ok(out.indexOf('](') === -1, 'ingen markdown-lenkesyntaks igjen: ' + out);
  assert.ok(out.indexOf('Tittel') !== -1);
  assert.ok(out.indexOf('fet') !== -1 && out.indexOf('kursiv') !== -1);
  assert.ok(out.indexOf('lenke') !== -1 && out.indexOf('https://x.no') === -1);
  assert.ok(out.indexOf('punkt en') !== -1 && out.indexOf('punkt to') !== -1);
});

test('mdNarrationText: kodeblokk-gjerder fjernes, innhold beholdes; blockquote/hr strippes', () => {
  const src = '```python\nprint(1)\n```\n\n> et sitat\n\n---';
  const out = C.mdNarrationText(src);
  assert.ok(out.indexOf('```') === -1);
  assert.ok(out.indexOf('print(1)') !== -1);
  assert.ok(out.indexOf('et sitat') !== -1);
  assert.ok(out.indexOf('---') === -1);
});

test('mdNarrationText: tom/ren-whitespace kilde → tom streng', () => {
  assert.strictEqual(C.mdNarrationText(''), '');
  assert.strictEqual(C.mdNarrationText('   \n  \n'), '');
  assert.strictEqual(C.mdNarrationText(null), '');
});

// ---- celle-verktøylinje: strukturelle teksttransformer (fase B2 Task 1) ----
// Alle operasjoner returnerer { cells, warnings } og bygger sin nye tekst via
// eksisterende cellBlock/serializeCells + en full re-parse — round-trip-
// garantien (serializeCells(parseCells(t)) === t, testet over) gjør derfor
// "resultatets serialisering er den tiltenkte teksten" automatisk oppfylt:
// vi tester her at den KONSTRUERTE teksten er den vi forventer.

function ser(cells) { return C.serializeCells(cells); }

// -- insertCellAfter --

test('insertCellAfter: setter inn ny celle med header+blank kropp etter idx', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.insertCellAfter(cells, 0, 'md');
  assert.deepStrictEqual(r.warnings, []);
  assert.strictEqual(ser(r.cells), '#%% python\n1\n#%% md\n');
  assert.strictEqual(r.cells.length, 2);
  assert.strictEqual(r.cells[1].type, 'md');
  assert.strictEqual(r.cells[1].source, '');
});

test('insertCellAfter: idx=-1 setter inn FØRST (add over første celle)', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.insertCellAfter(cells, -1, 'r');
  assert.strictEqual(ser(r.cells), '#%% r\n\n#%% python\n1');
  assert.strictEqual(r.cells[0].type, 'r');
});

test('insertCellAfter: idx=-1 med implisitt preambel → klemmes til ETTER preambelen (preambel-vern)', () => {
  // B2-review Critical-repro: uten vernet ville '#%% python'-headeren
  // splices FORAN preambel-teksten, og '# load x\nprint(1)' bli den nye
  // cellens KROPP — dokumentet mister preambelen sin permanent.
  const doc = '# load x\nprint(1)\n#%% python\ny=2\n';
  const cells = C.parseCells(doc).cells;
  const r = C.insertCellAfter(cells, -1, 'python');
  assert.strictEqual(r.cells[0].headerRaw, null, 'preambelen står fortsatt FØRST');
  assert.strictEqual(r.cells[0].source, '# load x\nprint(1)', 'preambel-innholdet er intakt');
  assert.strictEqual(r.cells[1].headerRaw, '#%% python', 'den nye cellen landet rett ETTER preambelen');
  assert.strictEqual(r.cells[1].source, '');
  assert.strictEqual(C.serializeCells(r.cells), '# load x\nprint(1)\n#%% python\n\n#%% python\ny=2\n');
});

test('insertCellAfter: idx=-1 UTEN preambel setter fortsatt inn helt først (vernet er preambel-spesifikt)', () => {
  const cells = C.parseCells('#%% r\n1\n').cells;
  const r = C.insertCellAfter(cells, -1, 'md');
  assert.strictEqual(r.cells[0].headerRaw, '#%% md');
});

test('insertCellAfter: ukjent type → advarsel + fallback python', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.insertCellAfter(cells, 0, 'sprocket');
  assert.ok(r.warnings.some(w => /ukjent celletype/.test(w)));
  assert.strictEqual(r.cells[1].type, 'python');
});

// -- deleteCell --

test('deleteCell: fjerner cellens span, resten uendret', () => {
  const cells = C.parseCells('#%% md\ntekst\n#%% python\n1+1').cells;
  const r = C.deleteCell(cells, 0);
  assert.strictEqual(ser(r.cells), '#%% python\n1+1');
});

test('deleteCell: siste gjenværende celle → tom implisitt celle (ikke no-op)', () => {
  const cells = C.parseCells('#%% python\nx=1').cells;
  const r = C.deleteCell(cells, 0);
  assert.strictEqual(r.cells.length, 1);
  assert.strictEqual(r.cells[0].headerRaw, null);
  assert.strictEqual(ser(r.cells), '');
});

test('deleteCell: ugyldig indeks → no-op + advarsel', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.deleteCell(cells, 5);
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});

// -- moveCell --

test('moveCell: bytter to naboceller (dir=+1 og dir=-1 er symmetriske)', () => {
  const cells = C.parseCells('#%% python id=a\n1\n#%% r id=b\n2').cells;
  const down = C.moveCell(cells, 0, 1);
  assert.strictEqual(ser(down.cells), '#%% r id=b\n2\n#%% python id=a\n1');
  const up = C.moveCell(cells, 1, -1);
  assert.strictEqual(ser(up.cells), ser(down.cells));
});

test('moveCell: grense — første celle opp / siste celle ned er no-op', () => {
  const cells = C.parseCells('#%% python\n1\n#%% r\n2').cells;
  const up = C.moveCell(cells, 0, -1);
  assert.strictEqual(up.cells, cells);
  const down = C.moveCell(cells, 1, 1);
  assert.strictEqual(down.cells, cells);
});

test('moveCell: preambel kan aldri flyttes, og ingen celle kan bytte plass med den', () => {
  const cells = C.parseCells('# load x\n#%% python\n1').cells;
  const movePreamble = C.moveCell(cells, 0, 1);
  assert.strictEqual(ser(movePreamble.cells), ser(cells));
  assert.ok(movePreamble.warnings.length > 0);
  const swapIntoPreamble = C.moveCell(cells, 1, -1);
  assert.strictEqual(ser(swapIntoPreamble.cells), ser(cells));
  assert.ok(swapIntoPreamble.warnings.length > 0);
});

// -- changeCellType --

test('changeCellType: skriver om KUN typetoken, attrs bevares verbatim', () => {
  const cells = C.parseCells('#%% python id=x hide-code style=card\n1+1').cells;
  const r = C.changeCellType(cells, 0, 'r');
  assert.strictEqual(ser(r.cells), '#%% r id=x hide-code style=card\n1+1');
  assert.deepStrictEqual(r.cells[0].attrs, { id: 'x', 'hide-code': true, style: 'card' });
});

test('changeCellType: bar header uten type → setter inn type', () => {
  const cells = C.parseCells('#%%\n1+1').cells;
  const r = C.changeCellType(cells, 0, 'md');
  assert.strictEqual(ser(r.cells), '#%% md\n1+1');
});

test('changeCellType: header med kun attrs (ingen type) → type settes inn FØR attrs', () => {
  const cells = C.parseCells('#%% id=x\n1+1').cells;
  const r = C.changeCellType(cells, 0, 'r');
  assert.strictEqual(ser(r.cells), '#%% r id=x\n1+1');
});

test('changeCellType: preambel → no-op + advarsel', () => {
  const cells = C.parseCells('print(1)').cells;
  const r = C.changeCellType(cells, 0, 'md');
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});

test('changeCellType: ukjent type → no-op + advarsel', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.changeCellType(cells, 0, 'sprocket');
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});

test('changeCellType: alias normaliseres (py → python-header)', () => {
  const cells = C.parseCells('#%% r\n1').cells;
  const r = C.changeCellType(cells, 0, 'py');
  assert.strictEqual(ser(r.cells), '#%% python\n1');
});

// -- splitCell --

test('splitCell: deler kilden ved linjeoffset, ny celle arver samme (eksplisitte) type', () => {
  const cells = C.parseCells('#%% python\na\nb\nc').cells;
  const r = C.splitCell(cells, 0, 2);
  assert.strictEqual(ser(r.cells), '#%% python\na\nb\n#%% python\nc');
  assert.strictEqual(r.cells.length, 2);
});

test('splitCell: type null (arver docMode) → ny celle får bar #%%-header', () => {
  const cells = C.parseCells('#%%\na\nb').cells;
  const r = C.splitCell(cells, 0, 1);
  assert.strictEqual(ser(r.cells), '#%%\na\n#%%\nb');
  assert.strictEqual(r.cells[1].type, null);
});

test('splitCell: lineOffset 0 → no-op', () => {
  const cells = C.parseCells('#%% python\na\nb').cells;
  const r = C.splitCell(cells, 0, 0);
  assert.strictEqual(r.cells, cells);
});

test('splitCell: lineOffset forbi slutten (>= antall linjer) → no-op', () => {
  const cells = C.parseCells('#%% python\na\nb').cells;
  const r = C.splitCell(cells, 0, 2); // n=2 linjer, offset===n er "forbi slutten"
  assert.strictEqual(r.cells, cells);
  const r2 = C.splitCell(cells, 0, 99);
  assert.strictEqual(r2.cells, cells);
});

test('splitCell: siste linje-split er GYLDIG (ikke "forbi slutten")', () => {
  const cells = C.parseCells('#%% python\na\nb\nc').cells;
  const r = C.splitCell(cells, 0, 2); // n=3, offset=2 < n → gyldig, kun 'c' flyttes
  assert.strictEqual(ser(r.cells), '#%% python\na\nb\n#%% python\nc');
});

test('splitCell: celle uten kropp (n=0) → alltid no-op uansett offset', () => {
  const cells = C.parseCells('#%% python\n#%% r\n1').cells;
  const r = C.splitCell(cells, 0, 0);
  assert.strictEqual(r.cells, cells);
});

test('splitCell: preambelen kan splittes (blir stående som preambel, halen får ekte header)', () => {
  const cells = C.parseCells('a\nb\nc').cells;
  const r = C.splitCell(cells, 0, 1);
  assert.strictEqual(ser(r.cells), 'a\n#%%\nb\nc');
  assert.strictEqual(r.cells[0].headerRaw, null);
  assert.strictEqual(r.cells[1].headerRaw, '#%%');
});

// -- mergeWithPrevious --

test('mergeWithPrevious: sletter cellens headerlinje, kroppene smelter sammen', () => {
  const cells = C.parseCells('#%% python id=a\n1\n#%% r\n2').cells;
  const r = C.mergeWithPrevious(cells, 1);
  assert.strictEqual(ser(r.cells), '#%% python id=a\n1\n2');
  assert.strictEqual(r.cells.length, 1);
  assert.strictEqual(r.cells[0].attrs.id, 'a');
});

test('mergeWithPrevious: første celle (idx=0) → no-op + advarsel (ingen forrige)', () => {
  const cells = C.parseCells('#%% python\n1\n#%% r\n2').cells;
  const r = C.mergeWithPrevious(cells, 0);
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});

test('mergeWithPrevious: inn i preambelen fungerer (headerRaw null + attrs bevares ikke — preamblen har ingen)', () => {
  const cells = C.parseCells('# load x\n#%% python\n1+1').cells;
  const r = C.mergeWithPrevious(cells, 1);
  assert.strictEqual(ser(r.cells), '# load x\n1+1');
  assert.strictEqual(r.cells.length, 1);
  assert.strictEqual(r.cells[0].headerRaw, null);
});

test('mergeWithPrevious: bar header (ingen kropp) foran → kun cur sin kropp består', () => {
  const cells = C.parseCells('#%% md\n#%% python\n1').cells;
  const r = C.mergeWithPrevious(cells, 1);
  assert.strictEqual(ser(r.cells), '#%% md\n1');
});

test('mergeWithPrevious: ugyldig indeks (>= length) → no-op + advarsel', () => {
  const cells = C.parseCells('#%% python\n1').cells;
  const r = C.mergeWithPrevious(cells, 9);
  assert.strictEqual(r.cells, cells);
  assert.ok(r.warnings.length > 0);
});

// -- fase C: brython/micropython moduser + kinds --

test('fase C: brython/micropython er støttede notatbok-moduser', function () {
  assert.equal(C.supportedMode('brython'), true);
  assert.equal(C.supportedMode('micropython'), true);
  assert.equal(C.supportedMode('statx'), false);   // uendret
});

test('fase C: KIND_FOR_TYPE har brython/micropython, SEG_MARKER har dem IKKE', function () {
  assert.equal(C.KIND_FOR_TYPE.brython, 'brython');
  assert.equal(C.KIND_FOR_TYPE.micropython, 'micropython');
  assert.equal(C.SEG_MARKER.brython, undefined);
  assert.equal(C.SEG_MARKER.micropython, undefined);
});

// Review Minor 3: isRunnableType er ÉN kilde til sannhet for "kan denne
// cellen faktisk kjøres" — delt av C.runCell sin egen guard og index.html
// sin ▶-synlighetssjekk (mdSetActiveCellLine-kalleren, tverr-IIFE). Kode-
// type ALENE er ikke nok: statx er isCodeType men har ingen KIND_FOR_TYPE-
// mapping (parse-only, ingen runtime), og ville tidligere feilaktig vist ▶.
test('isRunnableType: kode-type OG en kjent KIND_FOR_TYPE-mapping kreves — statx er kode men IKKE kjørbar', function () {
  assert.equal(C.isRunnableType('python'), true);
  assert.equal(C.isRunnableType('r'), true);
  assert.equal(C.isRunnableType('duckdb'), true);
  assert.equal(C.isRunnableType('microdata'), true);
  assert.equal(C.isRunnableType('brython'), true);
  assert.equal(C.isRunnableType('micropython'), true);
  assert.equal(C.isRunnableType('statx'), false, 'statx er isCodeType men mangler KIND_FOR_TYPE');
  assert.equal(C.isRunnableType('md'), false);
  assert.equal(C.isRunnableType('html'), false);
  assert.equal(C.isRunnableType('skip'), false);
});

// Sluttreview Important (task ec4b-5): Shift+Enter-avanseringen i index.html
// (~5459-5470) plukket tidligere "neste celle" fra Cells.segmentPlan — som
// EKSKLUDERER motorceller med design (SEG_MARKER har ingen brython/
// micropython-oppføringer, se KIND_FOR_TYPE-testen over). I en ren
// motor-notatbok ga segmentPlan derfor [] (eller kun [0] via preambelen),
// så "neste kjørbare celle > gjeldende" fantes aldri — markøren stod stille
// og Shift+Enter kjørte samme celle om og om igjen. Fikset ved å skanne et
// FERSKT parseCells-resultat med isRunnableType∘resolveType — samme kilde
// til sannhet som ▶-pilen (nbUpdateActiveCellFromCursor) alt bruker. Denne
// testen speiler den rene uttrykket index.html sin advance() nå bruker.
test('fase C: segmentPlan ekskluderer motorceller i et micropython-dokument (regresjonsdokumentasjon for bug)', function () {
  var doc = '#%% micropython\nprint(1)\n#%% micropython\nprint(2)\n#%% micropython\nprint(3)';
  // Ren feil-demonstrasjon: segmentPlan ser INGEN kjørbare segmenter — dette
  // var roten til at Shift+Enter aldri fant "neste celle" i en motor-notatbok.
  assert.deepStrictEqual(C.segmentPlan(doc, 'micropython'), []);
});

test('advance-uttrykket (isRunnableType∘resolveType-skann) finner neste kjørbare celle i et micropython-dokument', function () {
  var doc = '#%% micropython\nprint(1)\n#%% micropython\nprint(2)\n#%% micropython\nprint(3)';
  var cells = C.parseCells(doc).cells;
  // Ekvivalent til index.html sin advance(): "neste celleindeks > gjeldende
  // hvis isRunnableType(resolveType(cell, docMode)) er sann".
  function nextRunnableIdx(fromIdx) {
    for (var i = fromIdx + 1; i < cells.length; i++) {
      if (C.isRunnableType(C.resolveType(cells[i], 'micropython'))) return i;
    }
    return null;
  }
  assert.strictEqual(nextRunnableIdx(0), 1);
  assert.strictEqual(nextRunnableIdx(1), 2);
  assert.strictEqual(nextRunnableIdx(2), null); // siste celle — markøren blir stående
});

test('advance-uttrykket (isRunnableType∘resolveType-skann) hopper over md-celler i et python-dokument (ingen regresjon)', function () {
  var doc = '#%% python\n1\n#%% md\nhei\n#%% python\n2';
  var cells = C.parseCells(doc).cells;
  function nextRunnableIdx(fromIdx) {
    for (var i = fromIdx + 1; i < cells.length; i++) {
      if (C.isRunnableType(C.resolveType(cells[i], 'python'))) return i;
    }
    return null;
  }
  assert.strictEqual(nextRunnableIdx(0), 2); // hopper over md-cellen (idx 1)
  assert.strictEqual(nextRunnableIdx(2), null);
});

test('fase C: executableSource blanker fortsatt brython-celler (invariant)', function () {
  var doc = '# load x as y\n#%% brython\nprint(1)\n#%% md\nhei';
  var out = C.executableSource(doc, 'brython');
  assert.ok(out.indexOf('print(1)') === -1);
  assert.equal(out.split('\n').length, doc.split('\n').length);  // linjetall bevart
});

// ---------- #tag-celledirektiver (spec 2026-07-16-tag-directives-design.md) ----------

test('scanTagBlock: enkel blokk — nøkler lowercases, verdier koerseres', () => {
  const s = C.scanTagBlock('#tag.ID = plot\n#tag.slide = 3\n#tag.hide-code = true\nx = 1', false);
  assert.deepStrictEqual(s.tags, { id: 'plot', slide: '3', 'hide-code': true });
  assert.deepStrictEqual(s.tagLines, [0, 1, 2]);
  assert.deepStrictEqual(s.warnings, []);
});

test('scanTagBlock: siterte verdier strippes, false koerseres, verdi-case bevares', () => {
  const s = C.scanTagBlock('#tag.speak = "Hei Du"\n#tag.style = \'note\'\n#tag.hide-output = false', false);
  assert.deepStrictEqual(s.tags, { speak: 'Hei Du', style: 'note', 'hide-output': false });
});

test('scanTagBlock: ledende blanklinjer tillatt; blank/innhold avslutter blokken', () => {
  const s = C.scanTagBlock('\n\n#tag.slide = 1\n\n#tag.slide = 2\nkode', false);
  assert.deepStrictEqual(s.tags, { slide: '1' });
  assert.deepStrictEqual(s.tagLines, [2]);
});

test('scanTagBlock: første innholdslinje → ingen blokk; senere tag-linje varsles og er inert', () => {
  const s = C.scanTagBlock('x = 1\n#tag.slide = 2', false);
  assert.deepStrictEqual(s.tags, {});
  assert.deepStrictEqual(s.tagLines, []);
  assert.strictEqual(s.warnings.length, 1);
  assert.strictEqual(s.warnings[0].line, 1);
  assert.ok(/utenfor tagg-blokken/.test(s.warnings[0].msg));
});

test('scanTagBlock: ugyldig tag-linje konsumeres inn i blokken med varsel — demoterer ikke resten', () => {
  const s = C.scanTagBlock('#tag.slide = 1\n#tag.oops\n#tag.speak = hei\nx', false);
  assert.deepStrictEqual(s.tags, { slide: '1', speak: 'hei' });
  assert.deepStrictEqual(s.tagLines, [0, 1, 2]);
  assert.strictEqual(s.warnings.length, 1);
  assert.ok(/ugyldig #tag-linje/.test(s.warnings[0].msg));
});

test('scanTagBlock: validering — ukjent nøkkel lagres med varsel (header-leniens); type normaliseres via alias', () => {
  const s = C.scanTagBlock('#tag.foo = bar\n#tag.type = py', false);
  assert.strictEqual(s.tags.foo, 'bar');
  assert.strictEqual(s.tags.type, 'python');
  assert.strictEqual(s.warnings.length, 1);
  assert.ok(/ukjent attributt: foo/.test(s.warnings[0].msg));
});

test('scanTagBlock: ugyldig type/id droppes med varsel; ukjent style lagres med varsel', () => {
  const s = C.scanTagBlock('#tag.type = klingon\n#tag.id = "a b"\n#tag.style = fancy', false);
  assert.strictEqual(s.tags.type, undefined);
  assert.strictEqual(s.tags.id, undefined);
  assert.strictEqual(s.tags.style, 'fancy');
  assert.strictEqual(s.warnings.length, 3);
});

test('scanTagBlock: duplisert nøkkel — siste vinner, varsel', () => {
  const s = C.scanTagBlock('#tag.slide = 1\n#tag.slide = 2', false);
  assert.strictEqual(s.tags.slide, '2');
  assert.strictEqual(s.warnings.length, 1);
  assert.ok(/duplisert/.test(s.warnings[0].msg));
});

test('scanTagBlock: fleksibel whitespace og "# tag."-variant', () => {
  const s = C.scanTagBlock('  # tag.slide=3\n#tag.speak =  hei du ', false);
  assert.deepStrictEqual(s.tags, { slide: '3', speak: 'hei du' });
});

test('scanTagBlock preambel: tags plukkes fra ledende #-kommentar-kjede, direktivlinjer urørt', () => {
  const src = '# label: Demo\n#options.mode = python\n#tag.type = r\n# load x.csv as x\n#tag.slide = 1\nx = 1\n#tag.speak = nei';
  const s = C.scanTagBlock(src, true);
  assert.deepStrictEqual(s.tags, { type: 'r', slide: '1' });
  assert.deepStrictEqual(s.tagLines, [2, 4]);
  // #tag etter første kodelinje: utenfor — varsles
  assert.strictEqual(s.warnings.length, 1);
  assert.strictEqual(s.warnings[0].line, 6);
});

test('scanTagBlock preambel: id kan ikke være dokument-default', () => {
  const s = C.scanTagBlock('#tag.id = plot', true);
  assert.strictEqual(s.tags.id, undefined);
  assert.strictEqual(s.warnings.length, 1);
  assert.ok(/dokument-default/.test(s.warnings[0].msg));
});

test('scanTagBlock: tom kropp og kropp uten tags → tomt resultat', () => {
  assert.deepStrictEqual(C.scanTagBlock('', false).tagLines, []);
  assert.deepStrictEqual(C.scanTagBlock('x = 1\ny = 2', false).tags, {});
});

test('scanTagBlock: tom/blank verdi er ugyldig linje — konsumeres med varsel, ingen tag lagres', () => {
  const s = C.scanTagBlock('#tag.foo =\n#tag.bar = \n#tag.ok = 1\nx', false);
  assert.deepStrictEqual(s.tags, { ok: '1' });
  assert.deepStrictEqual(s.tagLines, [0, 1, 2]);
  assert.strictEqual(s.warnings.length, 3);
  assert.ok(s.warnings.slice(0, 2).every((w) => /ugyldig #tag-linje/.test(w.msg)));
});

test('parseCells: cellens tags merges inn i attrs; tagLines/sniffed settes', () => {
  const p = C.parseCells('#%% python\n#tag.slide = 3\n#tag.hide-code = true\nx = 1');
  const c = p.cells[0];
  assert.strictEqual(c.attrs.slide, '3');
  assert.strictEqual(c.attrs['hide-code'], true);
  assert.deepStrictEqual(c.tags, { slide: '3', 'hide-code': true });
  assert.deepStrictEqual(c.tagLines, [0, 1]);
  assert.strictEqual(c.sniffed, null);
  assert.deepStrictEqual(p.warnings, []);
});

test('parseCells: #tag.type setter celletypen når headeren ikke har en', () => {
  const p = C.parseCells('#%%\n#tag.type = r\nx <- 1');
  assert.strictEqual(p.cells[0].type, 'r');
  assert.strictEqual(C.resolveType(p.cells[0], 'python'), 'r');
});

test('parseCells: header vinner over tag — verdi beholdes, varsel med absolutt linjetall', () => {
  const p = C.parseCells('#%% python slide=1\n#tag.slide = 2\n#tag.type = r\nx = 1');
  const c = p.cells[0];
  assert.strictEqual(c.attrs.slide, '1');
  assert.strictEqual(c.type, 'python');
  assert.strictEqual(p.warnings.length, 2);
  assert.ok(p.warnings.some((w) => /^linje 2: #tag\.slide overstyrt av #%%-attributt$/.test(w)));
  assert.ok(p.warnings.some((w) => /^linje 3: #tag\.type overstyrt av #%%-typen$/.test(w)));
});

test('parseCells: duplisert tag-nøkkel — siste vinner også i merge (ingen falskt overstyrt-varsel)', () => {
  const p = C.parseCells('#%%\n#tag.type = r\n#tag.type = md\nheisann');
  assert.strictEqual(p.cells[0].type, 'md');
  // kun duplikat-varselet fra skanneren, INGEN 'overstyrt av #%%-typen'
  assert.strictEqual(p.warnings.length, 1);
  assert.ok(/duplisert/.test(p.warnings[0]));
});

test('parseCells sniffing: lone-string """-celle → md; docstring + kode forblir kode', () => {
  const md = C.parseCells('#%%\n"""\n# Overskrift\ntekst\n"""');
  assert.strictEqual(md.cells[0].type, 'md');
  assert.strictEqual(md.cells[0].sniffed, 'md');
  const code = C.parseCells('#%%\n"""docstring"""\nx = 1');
  assert.strictEqual(code.cells[0].type, null);
  assert.strictEqual(code.cells[0].sniffed, null);
});

test('parseCells sniffing: enlinjes """x""" → md; """ midt i teksten etterfulgt av kode → kode', () => {
  assert.strictEqual(C.parseCells('#%%\n"""Hei **verden**"""').cells[0].sniffed, 'md');
  // første lukker etter 'a', deretter kode → IKKE sniffet (indexOf-regelen, ingen backtracking)
  assert.strictEqual(C.parseCells('#%%\n"""a""" b\nx = """s"""').cells[0].sniffed, null);
});

test('parseCells sniffing: """ må stå i kolonne 0; uavsluttet streng sniffes ikke', () => {
  assert.strictEqual(C.parseCells('#%%\n  """tekst"""').cells[0].sniffed, null);
  assert.strictEqual(C.parseCells('#%%\n"""aldri lukket').cells[0].sniffed, null);
});

test('parseCells sniffing: <-førstelinje → html; ledende blanklinjer og tag-blokk hoppes over', () => {
  const p = C.parseCells('#%%\n#tag.slide = 2\n\n  <div>hei</div>');
  assert.strictEqual(p.cells[0].type, 'html');
  assert.strictEqual(p.cells[0].sniffed, 'html');
  assert.strictEqual(p.cells[0].attrs.slide, '2');
});

test('parseCells sniffing: eksplisitt type (header eller tag) vinner over sniff', () => {
  assert.strictEqual(C.parseCells('#%% python\n"""bare en streng"""').cells[0].sniffed, null);
  const p = C.parseCells('#%%\n#tag.type = python\n"""bare en streng"""');
  assert.strictEqual(p.cells[0].type, 'python');
  assert.strictEqual(p.cells[0].sniffed, null);
});

test('parseCells preambel-defaults: type og attrs gjelder celler uten egen verdi', () => {
  const src = '#tag.type = r\n#tag.hide-code = true\n# load x\n\n#%%\ny <- 1\n#%% python slide=1\nz = 2\n#%%\n#tag.hide-code = false\nw <- 3';
  const p = C.parseCells(src);
  // preambelen selv røres ikke
  assert.strictEqual(p.cells[0].type, null);
  assert.deepStrictEqual(p.cells[0].attrs, {});
  // celle 1: arver begge defaults
  assert.strictEqual(p.cells[1].type, 'r');
  assert.strictEqual(p.cells[1].attrs['hide-code'], true);
  // celle 2: header-type vinner; attrs-default gjelder fortsatt
  assert.strictEqual(p.cells[2].type, 'python');
  assert.strictEqual(p.cells[2].attrs.slide, '1');
  assert.strictEqual(p.cells[2].attrs['hide-code'], true);
  // celle 3: egen tag overstyrer defaulten
  assert.strictEqual(p.cells[3].attrs['hide-code'], false);
  assert.strictEqual(p.cells[3].type, 'r');
});

test('parseCells: sniff vinner over preambel-default (umerket prosacelle i typet dokument)', () => {
  const p = C.parseCells('#tag.type = python\n\n#%%\n"""# Notat"""');
  assert.strictEqual(p.cells[1].type, 'md');
  assert.strictEqual(p.cells[1].sniffed, 'md');
});

test('parseCells: round-trip-garantien holder med tags og sniffede celler', () => {
  const src = '#tag.type = python\n# load x\n\n#%%\n#tag.slide = 3\n"""tekst"""\n#%% r id=a\n#tag.speak = hei\ny <- 1';
  assert.strictEqual(C.serializeCells(C.parseCells(src).cells), src);
});

test('parseCells: #tag.type = r gir r-segment i python-dokument (segmentPlan + executableSource)', () => {
  const src = '#%%\n#tag.type = r\ny <- 1\n#%% python\nx = 1';
  assert.deepStrictEqual(C.segmentPlan(src, 'python'), [0, 1]);
  const exec = C.executableSource(src, 'python');
  assert.ok(/^## r$/m.test(exec));
  assert.ok(/^## python$/m.test(exec));
});

test('parseCells: sniffet md-celle blankes av executableSource (ikke-kode)', () => {
  const src = '#%% python\nx = 1\n#%%\n"""tekst"""';
  const exec = C.executableSource(src, 'python');
  assert.strictEqual(exec.split('\n').length, src.split('\n').length);
  assert.ok(exec.indexOf('tekst') === -1);
  assert.deepStrictEqual(C.segmentPlan(src, 'python'), [0]);
});

test('parseCells: ingen #%% → ingen tag-maskineri påvirker dokumentet (paramount-invarianten)', () => {
  const src = '#tag.type = r\nx = 1';
  assert.strictEqual(C.executableSource(src, 'python'), src);
  // parseCells på ren tekst: preambel-cellen beholder type null/attrs {}
  const p = C.parseCells(src);
  assert.strictEqual(p.cells[0].type, null);
});

test('execCellSource: tag-linjer blankes PÅ PLASS — linjetall bevares', () => {
  const p = C.parseCells('#%% duckdb\n#tag.id = tab\n#tag.slide = 2\nselect 1');
  const out = C.execCellSource(p.cells[0]);
  assert.strictEqual(out, '\n\nselect 1');
  assert.strictEqual(out.split('\n').length, p.cells[0].source.split('\n').length);
});

test('execCellSource: celle uten tags returnerer kilden uendret; null-celle → tom streng', () => {
  const p = C.parseCells('#%% python\nx = 1');
  assert.strictEqual(C.execCellSource(p.cells[0]), 'x = 1');
  assert.strictEqual(C.execCellSource(null), '');
});

test('renderContent: tag-linjer fjernes; sniffet md → indre tekst uten delimitere', () => {
  assert.strictEqual(C.renderContent('#tag.slide = 1\n"""\n# Hei\n"""', 'md', 'md'), '# Hei');
  assert.strictEqual(C.renderContent('"""enlinjes **fet**"""', 'md', 'md'), 'enlinjes **fet**');
});

test('renderContent: eksplisitt md-celle beholder """ (kun sniffede strippes); html får tags fjernet', () => {
  assert.strictEqual(C.renderContent('"""x"""', 'md', null), '"""x"""');
  assert.strictEqual(C.renderContent('#tag.slide = 1\n<div>x</div>', 'html', 'html'), '<div>x</div>');
});

test('renderContent: fallback når lone-string-mønsteret ikke lenger holder etter redigering', () => {
  assert.strictEqual(C.renderContent('"""x"""\nkode()', 'md', 'md'), '"""x"""\nkode()');
});

test('executableSource: tag-blokken blankes i kodeceller OG preambel — linjetall eksakt bevart', () => {
  const src = '#tag.type = python\n# load x\n\n#%%\n#tag.slide = 1\nx = 1\n#%% duckdb\n#tag.id = t\nselect 1';
  const exec = C.executableSource(src, 'python');
  const lines = exec.split('\n');
  assert.strictEqual(lines.length, src.split('\n').length);
  assert.strictEqual(lines[0], '');            // preambel-tag blanket
  assert.strictEqual(lines[1], '# load x');    // direktivlinje urørt
  assert.strictEqual(lines[3], '## python');   // #tag.type-default → python-segment
  assert.strictEqual(lines[4], '');            // celle-tag blanket
  assert.strictEqual(lines[5], 'x = 1');
  assert.strictEqual(lines[7], '');            // duckdb-cellens tag blanket ('#' er ikke SQL)
  assert.strictEqual(lines[8], 'select 1');
});

test('executableSource: celle med KUN tag-blokk ≙ tom celle (kjent godartet plan/kjøretids-asymmetri)', () => {
  // Samme oppførsel som '#%% python' uten kropp: segmentPlan tar cellen med,
  // flush() dropper det tomme segmentet — alignPlan-fallbacken håndterer det
  // (ledger Task 9). Pinnes her: blankingen skal IKKE endre denne likheten.
  const tagOnly = '#%% python\n#tag.slide = 1\n#%% python\nx = 1';
  const empty = '#%% python\n\n#%% python\nx = 1';
  assert.strictEqual(C.executableSource(tagOnly, 'python'), C.executableSource(empty, 'python'));
  assert.deepStrictEqual(C.segmentPlan(tagOnly, 'python'), [0, 1]);
});

test('forklarCellSteps: md-steg bruker renderContent (sniffede celler taler uten delimitere), kode-steg blankes', () => {
  const src = '#%%\n"""\n# Hei\n"""\n#%% python\n#tag.slide = 1\nx = 1';
  const steps = C.forklarCellSteps(src, 'python');
  assert.strictEqual(steps.length, 2);
  const mdStep = steps.find((s) => s.kind === 'md');
  assert.strictEqual(mdStep.source, '# Hei');
  const codeStep = steps.find((s) => s.kind === 'code');
  assert.strictEqual(codeStep.source, '\nx = 1');
});

// ---------- presentasjon: slidePlan (spec 2026-07-16-presentation-design.md §1) ----------

test('slidePlan: eksplisitte numre + arv — unummererte følger forrige', () => {
  const p = C.parseCells('#%% md slide=1\na\n#%% python\nb\n#%% md slide=2\nc');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
  assert.deepStrictEqual(sp.slides[0].cellIdxs, [0, 1]);
  assert.deepStrictEqual(sp.slides[1].cellIdxs, [2]);
  assert.deepStrictEqual(sp.byCell, [0, 0, 1]);
});

test('slidePlan: bare slide-flagget auto-nummererer (høyeste sett + 1)', () => {
  const p = C.parseCells('#%% md slide=3\na\n#%% md slide\nb\n#%% md\nc');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [3, 4]);
  assert.deepStrictEqual(sp.byCell, [0, 1, 1]);
});

test('slidePlan: ikke-numerisk verdi behandles som flagget (auto), ingen varsler', () => {
  const p = C.parseCells('#%% md slide=intro\na\n#%% md slide=abc\nb');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
});

test('slidePlan: gruppering per nummer, ikke naboskap — gjentatt nummer samler celler', () => {
  const p = C.parseCells('#%% md slide=1\na\n#%% md slide=2\nb\n#%% md slide=1\nc');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
  assert.deepStrictEqual(sp.slides[0].cellIdxs, [0, 2]);
  assert.deepStrictEqual(sp.byCell, [0, 1, 0]);
});

test('slidePlan: ledende unummererte celler (inkl. preambel) → første eksplisitte slide', () => {
  const p = C.parseCells('# preamble\n\n#%% md\nintro\n#%% md slide=5\na');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [5]);
  assert.deepStrictEqual(sp.slides[0].cellIdxs, [0, 1, 2]);
  assert.deepStrictEqual(sp.byCell, [0, 0, 0]);
});

test('slidePlan: ingen slide-attrs → én slide med alt', () => {
  const p = C.parseCells('#%% md\na\n#%% python\nb');
  const sp = C.slidePlan(p.cells);
  assert.strictEqual(sp.slides.length, 1);
  assert.strictEqual(sp.slides[0].num, 1);
  assert.deepStrictEqual(sp.slides[0].cellIdxs, [0, 1]);
});

test('slidePlan: skip-celler utelates fra cellIdxs men driver arven (grensemarkør)', () => {
  const p = C.parseCells('#%% md slide=1\na\n#%% skip slide=2\nx\n#%% md\nb');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
  assert.deepStrictEqual(sp.slides[1].cellIdxs, [2]);
  assert.deepStrictEqual(sp.byCell, [0, 1, 1]);
});

test('slidePlan: #tag.slide og preambel-default mater planen via parseCells', () => {
  const p = C.parseCells('#tag.slide = 1\n# load x\n\n#%% md\n#tag.slide = 2\na\n#%% python\nb');
  const sp = C.slidePlan(p.cells);
  assert.deepStrictEqual(sp.slides.map((s) => s.num), [1, 2]);
  // preambelen (idx 0) er ledende-unummerert → FØRSTE EKSPLISITTE nummer i
  // dokumentrekkefølge (md-cellens 2, ikke laveste); md-cellen har egen
  // tag → 2; python-cellen får preambel-DEFAULTEN slide='1' (bakes i
  // attrs) → 1. slides sorteres stigende: pos 0 = nummer 1, pos 1 = nummer 2.
  assert.deepStrictEqual(sp.byCell, [1, 1, 0]);
});

test('slidePlan: tom celleliste → tom plan', () => {
  const sp = C.slidePlan([]);
  assert.deepStrictEqual(sp.slides, []);
  assert.deepStrictEqual(sp.byCell, []);
});

// ---------- editor-konvergens: rene hjelpere (spec 2026-07-17 §1/§2) ----------

test('cellAtLine: linje → celleindeks via startLine/endLine; utenfor → -1', () => {
  const p = C.parseCells('# pre\n\n#%% python\nx = 1\ny = 2\n#%% md\ntekst');
  assert.strictEqual(C.cellAtLine(p.cells, 0), 0);   // preambel
  assert.strictEqual(C.cellAtLine(p.cells, 1), 0);
  assert.strictEqual(C.cellAtLine(p.cells, 2), 1);   // #%%-linjen tilhører cellen
  assert.strictEqual(C.cellAtLine(p.cells, 4), 1);
  assert.strictEqual(C.cellAtLine(p.cells, 6), 2);
  assert.strictEqual(C.cellAtLine(p.cells, 99), -1);
  assert.strictEqual(C.cellAtLine([], 0), -1);
});

test('selectionCellSpan: spennet ligger helt i én kode-celles kropp → {idx}', () => {
  const p = C.parseCells('#%% python\nx = 1\ny = 2\n#%% md\ntekst');
  assert.deepStrictEqual(C.selectionCellSpan(p.cells, 1, 2, 'python'), { idx: 0 });
  // hele kroppen (én linje) markert
  assert.deepStrictEqual(C.selectionCellSpan(p.cells, 1, 1, 'python'), { idx: 0 });
});

test('selectionCellSpan: spennet inkluderer header-linjen → outside', () => {
  const p = C.parseCells('#%% python\nx = 1\ny = 2\n#%% md\ntekst');
  // startLine 0 er selve '#%% python'-header-linjen — ikke kropp.
  assert.deepStrictEqual(C.selectionCellSpan(p.cells, 0, 1, 'python'), { error: 'outside' });
});

test('selectionCellSpan: spennet krysser to celler → span', () => {
  const p = C.parseCells('#%% python\nx = 1\n#%% python\ny = 2\n');
  // linje 1 (siste kroppslinje celle 0) → linje 3 (kroppslinje celle 1):
  // header-linjen (2) mellom dem beviser krysningen.
  assert.deepStrictEqual(C.selectionCellSpan(p.cells, 1, 3, 'python'), { error: 'span' });
});

test('selectionCellSpan: hele spennet i én md-celle → noncode', () => {
  const p = C.parseCells('#%% md\nHei\nDu\n');
  assert.deepStrictEqual(C.selectionCellSpan(p.cells, 1, 2, 'python'), { error: 'noncode' });
});

test('selectionCellSpan: preambel-kropp ok når preambelen resolver til kode', () => {
  const p = C.parseCells('x = 1\ny = 2\n#%% md\ntekst');
  assert.deepStrictEqual(C.selectionCellSpan(p.cells, 0, 1, 'python'), { idx: 0 });
});

test('selectionCellSpan: linje utenfor ethvert celle-spenn → outside', () => {
  const p = C.parseCells('#%% python\nx = 1\n');
  assert.deepStrictEqual(C.selectionCellSpan(p.cells, 5, 5, 'python'), { error: 'outside' });
  assert.deepStrictEqual(C.selectionCellSpan([], 0, 0, 'python'), { error: 'outside' });
});

test('sameStructure: samme headerRaw-sekvens → true; endret antall/markør → false', () => {
  const a = C.parseCells('#%% python\nx = 1\n#%% md\nA').cells;
  const b = C.parseCells('#%% python\ny = 2\n#%% md\nB endret').cells;
  const c = C.parseCells('#%% python\nx = 1\n#%% html\nA').cells;
  const d = C.parseCells('#%% python\nx = 1').cells;
  assert.strictEqual(C.sameStructure(a, b), true);   // kun kropper endret
  assert.strictEqual(C.sameStructure(a, c), false);  // markørlinje endret
  assert.strictEqual(C.sameStructure(a, d), false);  // antall endret
});
