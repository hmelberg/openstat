#!/usr/bin/env python3
"""Engangskonvertering fra gammel direktivsyntaks til den pythonske.

    python3 tools/migrate_directives.py <fil eller katalog>…

Spec: docs/superpowers/specs/2026-07-26-pythonsk-direktivsyntaks-design.md.
Fasit: oversettelsesorakelet i .superpowers/sdd/task-8-brief.md — 17 par kjørt
gjennom både den gamle parseren (45306c3~1) og den nye med samme registerstubb.

Tre ting skriptet gjør som en naiv linje-for-linje-erstatter IKKE gjør:

1.  «# meta <mål> <tekst>» blir ALLTID .note, aldri .label. Den gamle parseren
    hadde ingen label-kind: alt ikke-URL-innhold ble kind:'text', på både
    datasett- og variabelnivå. .label rendres som OVERSKRIFTEN i variabel-
    panelet (js/meta-info.js:104,191), så en «forfremmelse» ville byttet ut
    variabelnavnet og slettet notatet.

2.  Lenke med etikett blir en DICT, ikke et tuppel. Parseren representerer
    (…) og […] likt, så «link = "url", "etikett"» gir TO lenker — den andre
    med url «etikett».

3.  Gjentatte «# meta <samme mål>»-linjer AKKUMULERTE i gammel syntaks. Den
    nye modellen kjører dropPrevious(mål, variabel, kind), så to
    «meta.iris.note»-linjer etterlater ÉTT notat. Derfor samler skriptet alle
    meta-linjer per (mål, variabel, kind) FØR det skriver, og emitterer én
    linje per gruppe — liste for flere notater, dict/liste for flere lenker —
    på plassen der den FØRSTE av dem sto.

Skriptet rører bare linjer det kjenner igjen. Alt annet står. Det er
idempotent: ny syntaks matcher ingen av mønstrene under.
"""
from __future__ import annotations

import os
import re
import sys

# ---------------------------------------------------------------- grammatikk
# Regexene er de gamle fra js/data-directives.js (45306c3~1), med kommentar-
# markøren løftet ut. Opsjonshalen deles derfor på «,» som følges av
# «<ord>(» — aldri på komma generelt. Det er den regelen som redder
# «# read oecd/OECD.ELS.HD,DSD_HEALTH_STAT@DF_LE/all?startPeriod=2020 as le».
OPTS = r'((?:[ \t]*,[ \t]*\w+\([^)]*\))*)'

CONNECT_RE = re.compile(
    r'^connect[ \t]+(\S+)(?:[ \t]+as[ \t]+([A-Za-z_]\w*))?' + OPTS + r'[ \t]*$', re.I)
LOAD_RE = re.compile(
    r'^(read|load|require)[ \t]+(\S+)[ \t]+as[ \t]+([A-Za-z_]\w*)' + OPTS + r'[ \t]*$', re.I)
CREATE_RE = re.compile(
    r'^create(?:[-_]dataset)?[ \t]+([A-Za-z_]\w*)[ \t]*,[ \t]*key\(\s*'
    r'([A-Za-z_]\w*(?:[ \t,]+[A-Za-z_]\w*)*)\s*\)'
    r'(?:[ \t]*,[ \t]*format\(\s*([A-Za-z_.]+)\s*\))?[ \t]*$', re.I)
IMPORT_RE = re.compile(
    r'^(?:add|import)[ \t]+(\S+(?:[ \t]*,[ \t]*\S+)*)[ \t]+into[ \t]+([A-Za-z_]\w*)'
    r'(?:[ \t]+(left|inner|outer))?[ \t]*$', re.I)
JOIN_RE = re.compile(
    r'^join[ \t]+([A-Za-z_]\w*)[ \t]+into[ \t]+([A-Za-z_]\w*)[ \t]+on[ \t]+'
    r'([A-Za-z_]\w*(?:[ \t]*,[ \t]*[A-Za-z_]\w*)*)(?:[ \t]+(left|inner|outer))?[ \t]*$', re.I)
USE_RE = re.compile(r'^use[ \t]+(\S+)(?:[ \t]+from[ \t]+(\S+))?[ \t]*$', re.I)
META_RE = re.compile(r'^meta[ \t]+([A-Za-z_]\w*(?:\.\S+)?)[ \t]+(\S.*)$', re.I)

MARKER_RE = re.compile(r'^([ \t]*)(#|--|//)([ \t]*)(.*)$')
URL_RE = re.compile(r'^(https?://\S+)(?:[ \t]+(.*))?$', re.I)

# Ny syntaks: «<navn> = <mottaker>.<verb>(…)» eller «meta.<sti> = …». Ingen av
# de gamle mønstrene kan treffe dem, men vakten gjør idempotensen eksplisitt
# i stedet for tilfeldig.
NEW_RE = re.compile(r'^(?:[A-Za-z_]\w*[ \t]*=[ \t]*)?[A-Za-z_]\w*[ \t]*\.[ \t]*[A-Za-z_]\w*[ \t]*[(=]')

# docs/directive-language-examples.html har direktivene inni <pre><code>-blokker:
# FØRSTE linje bærer starttaggene, SISTE bærer sluttaggene. De settes til side
# og limes på igjen, ellers ville halvparten av blokkene stått uendret.
HTML_PREFIXES = ('<pre><code>', '<code>', '<pre>')
HTML_SUFFIXES = ('</code></pre>', '</code>', '</pre>')

OPT_RE = re.compile(r'(\w+)\(([^)]*)\)')
LISTY = ('countries', 'regions', 'indicators')


def is_urlish(target: str) -> bool:
    return bool(re.match(r'^https?://', target, re.I)) or target.startswith('/api/hent?')


def q(s: str) -> str:
    """Python-streng slik js/directive-parser.js parseString leser den:
    «\\X» er literal X, så «\\"» virker og en backslash må dobles."""
    return '"' + str(s).replace('\\', '\\\\').replace('"', '\\"') + '"'


def qlist(items) -> str:
    return '[' + ', '.join(q(x) for x in items) + ']'


def qdict(pairs) -> str:
    return '{' + ', '.join(q(k) + ': ' + q(v) for k, v in pairs) + '}'


class Skip(Exception):
    """Linja er gammel syntaks, men skriptet tør ikke oversette den."""


def convert_options(tail: str, *, on_create: bool) -> list[str]:
    """Opsjonshale -> kwargs, i den rekkefølgen de sto.

    key( betyr to helt ulike ting i gammel syntaks: på create er det et
    KOLONNENAVN (forblir key=), på connect/read/load/require er det en
    HEMMELIGHET (blir secret_key=). Det var nettopp den tvetydigheten
    omdøpingen fjernet — den skal ikke gjenskapes her.
    """
    out: list[str] = []
    for m in OPT_RE.finditer(tail or ''):
        name, val = m.group(1).lower(), m.group(2).strip()
        if name == 'key':
            # Gammel parser: opts.key = val || 'ask'.
            out.append(('key=' if on_create else 'secret_key=') + q(val or 'ask'))
        elif name in ('exec', 'kind', 'cache', 'format'):
            out.append(name + '=' + q(val.lower()))
        elif name == 'years':
            out.append('years=' + q(val))
        elif name in LISTY:
            out.append(name + '=' + qlist([p for p in re.split(r'[\s,]+', val) if p]))
        elif name == 'filters':
            pairs = []
            for pair in val.split():
                eq = pair.find('=')
                if eq > 0:
                    pairs.append((pair[:eq], pair[eq + 1:]))
            out.append('filters=' + qdict(pairs))
        elif name == 'all':
            out.append('all=True')
        else:
            # Gammel parser ignorerte ukjente opsjoner stille. Her nekter vi
            # heller å konvertere, slik at grep-sjekken i Step 5 finner linja.
            raise Skip('ukjent opsjon «%s(...)»' % name)
    return out


def call(target: str | None, recv: str, verb: str, args: list[str]) -> str:
    head = (target + ' = ') if target else ''
    return '%s%s.%s(%s)' % (head, recv, verb, ', '.join(a for a in args if a))


def convert_connect(m) -> list[str]:
    target, alias, tail = m.group(1), m.group(2), m.group(3)
    if not alias:
        if is_urlish(target):
            raise Skip('connect med URL uten «as <alias>»')
        alias = target                      # register-id/anvil-navn: alias = id
    return [call(alias, 'ost', 'connect', [q(target)] + convert_options(tail, on_create=False))]


def convert_load(m) -> list[str]:
    target, name, tail = m.group(2), m.group(3), m.group(4)
    opts = convert_options(tail, on_create=False)
    if is_urlish(target):
        return [call(name, 'ost', 'read', [q(target)] + opts)]
    slash = target.find('/')
    if slash > 0:
        return [call(name, target[:slash], 'read', [q(target[slash + 1:])] + opts)]
    return [call(name, target, 'read', opts)]


def convert_create(m) -> list[str]:
    name, keys, fmt = m.group(1), m.group(2), m.group(3)
    cols = [c for c in re.split(r'[\s,]+', keys) if c]
    args = ['key=' + (q(cols[0]) if len(cols) == 1 else qlist(cols))]
    if fmt:
        args.append('format=' + q(fmt.lower()))
    return [call(name, 'ost', 'create', args)]


def convert_import(m) -> list[str]:
    refs, dest, how = m.group(1), m.group(2), m.group(3)
    # Gammel parser grupperte per (kilde, tabell) og la ÉN import-step per
    # gruppe. Én add()-linje per gruppe gir samme spec.
    groups: dict[tuple[str, str | None], list[str]] = {}
    order: list[tuple[str, str | None]] = []
    for ref in refs.split(','):
        parts = ref.strip().split('/')
        if len(parts) != 2:
            raise Skip('add/import krever <kilde>/<kolonne>: «%s»' % ref.strip())
        alias, path = parts[0].strip(), parts[1].strip()
        dot = path.find('.')
        table = path[:dot] if dot > 0 else None
        col = path[dot + 1:] if dot > 0 else path
        key = (alias, table)
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(col)
    lines = []
    for alias, table in order:
        args = [alias, qlist(groups[(alias, table)])]
        if table:
            args.append('table=' + q(table))
        if how:
            args.append('how=' + q(how.lower()))
        lines.append(call(None, dest, 'add', args))
    return lines


def convert_join(m) -> list[str]:
    src, dest, on, how = m.group(1), m.group(2), m.group(3), m.group(4)
    keys = [k for k in re.split(r'[\s,]+', on) if k]
    args = [src, 'on=' + (q(keys[0]) if len(keys) == 1 else qlist(keys))]
    if how:
        args.append('how=' + q(how.lower()))
    return [call(None, dest, 'join', args)]


def convert_use(m) -> list[str]:
    name, src = m.group(1), m.group(2)
    if not re.match(r'^[A-Za-z_]\w*$', name):
        raise Skip('ugyldig datasettnavn i use: «%s»' % name)
    args = [q(name)]
    if src:
        if src.lower() not in ('r', 'python', 'duckdb'):
            raise Skip('ukjent use-kilde «%s»' % src)
        args.append('source=' + q(src.lower()))
    return [call(name, 'ost', 'use', args)]


def parse_meta(m):
    """-> (mål, variabel|None, 'link'|'note', nyttelast)."""
    ref, content = m.group(1), m.group(2).strip()
    dot = ref.find('.')
    target = ref[:dot] if dot > 0 else ref
    variable = ref[dot + 1:] if dot > 0 else None
    um = URL_RE.match(content)
    if um:
        return target, variable, 'link', (um.group(1), (um.group(2) or '').strip())
    # K1: ikke-URL-innhold ble ALLTID kind:'text' i gammel syntaks — uansett
    # nivå og lengde. Ingen label-heuristikk.
    return target, variable, 'note', content


def emit_meta(path: str, kind: str, payload: list) -> str:
    if kind == 'note':
        value = q(payload[0]) if len(payload) == 1 else qlist(payload)
        return 'meta.%s.note = %s' % (path, value)
    if any(label for _, label in payload):
        value = qdict(payload)
    elif len(payload) == 1:
        value = q(payload[0][0])
    else:
        value = qlist([u for u, _ in payload])
    return 'meta.%s.link = %s' % (path, value)


CONVERTERS = (
    (CONNECT_RE, convert_connect),
    (LOAD_RE, convert_load),
    (CREATE_RE, convert_create),
    (IMPORT_RE, convert_import),
    (JOIN_RE, convert_join),
    (USE_RE, convert_use),
)


def split_line(line: str):
    """-> (prefiks, kropp, suffiks) eller None når linja ikke er en kommentar."""
    html_open = ''
    for pre in HTML_PREFIXES:
        if line.startswith(pre):
            html_open, line = pre, line[len(pre):]
            break
    m = MARKER_RE.match(line)
    if not m:
        return None
    indent, marker, gap, rest = m.groups()
    indent = html_open + indent
    trail = ''
    while rest and rest[-1] in ' \t\r':
        trail = rest[-1] + trail
        rest = rest[:-1]
    for suf in HTML_SUFFIXES:
        if rest.endswith(suf):
            rest = rest[:-len(suf)]
            trail = suf + trail
            break
    return indent + marker + gap, rest.rstrip(' \t'), trail


def migrate_text(text: str, warn) -> tuple[str, int]:
    lines = text.split('\n')
    out: list[str | None] = list(lines)
    changed = 0

    # Runde 1: alt bortsett fra meta, som må slås sammen på tvers av linjer —
    # men bare innenfor SAMME scriptblokk. .md/.html-dokumenter har mange
    # uavhengige eksempler; å slå sammen på tvers av dem flyttet notater til
    # feil eksempel og slettet de senere linjene (med <pre><code>-taggene).
    meta_groups: dict[tuple[int, str, str | None, str], list] = {}
    meta_first: dict[tuple[int, str, str | None, str], int] = {}
    meta_order: list[tuple[int, str, str | None, str]] = []

    block = 0
    for i, line in enumerate(lines):
        low = line.lower()
        fence = line.lstrip().startswith(('```', '~~~'))
        if fence or '<pre' in low or '<code' in low:
            block += 1
        cur_block = block
        if fence or '</pre>' in low or '</code>' in low:
            block += 1
        parts = split_line(line)
        if not parts:
            continue
        prefix, body, trail = parts
        if not body or NEW_RE.match(body):
            continue

        mm = META_RE.match(body)
        if mm:
            target, variable, kind, payload = parse_meta(mm)
            key = (cur_block, target, variable, kind)
            if key not in meta_groups:
                meta_groups[key] = []
                meta_first[key] = i
                meta_order.append(key)
            meta_groups[key].append(payload)
            out[i] = None                 # fylles under (eller slettes)
            continue

        for regex, fn in CONVERTERS:
            m = regex.match(body)
            if not m:
                continue
            try:
                new_bodies = fn(m)
            except Skip as e:
                warn('%s  («%s»)' % (e, body))
                break
            out[i] = '\n'.join(prefix + b + trail for b in new_bodies)
            changed += 1
            break

    # Runde 2: én meta-linje per (mål, variabel, kind), der den første sto.
    for key in meta_order:
        _, target, variable, kind = key
        i = meta_first[key]
        prefix, _, trail = split_line(lines[i])
        path = target if variable is None else '%s.%s' % (target, variable)
        out[i] = prefix + emit_meta(path, kind, meta_groups[key]) + trail
        changed += len(meta_groups[key])

    return '\n'.join(x for x in out if x is not None), changed


EXTS = ('.txt', '.md', '.html', '.htm', '.py', '.r', '.js', '.ts', '.sql', '.jl')
SKIP_DIRS = {'.git', '__pycache__', 'node_modules', '.venv'}


def iter_files(paths):
    for p in paths:
        if os.path.isdir(p):
            for root, dirs, names in os.walk(p):
                dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                for n in sorted(names):
                    if n.lower().endswith(EXTS):
                        yield os.path.join(root, n)
        else:
            yield p


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    total_files = total_lines = 0
    warnings: list[str] = []
    for path in iter_files(argv[1:]):
        try:
            with open(path, encoding='utf-8') as fh:
                text = fh.read()
        except (UnicodeDecodeError, IsADirectoryError, FileNotFoundError) as e:
            warnings.append('%s: kunne ikke leses (%s)' % (path, e))
            continue

        def warn(msg, _p=path):
            warnings.append('%s: %s' % (_p, msg))

        new_text, changed = migrate_text(text, warn)
        if changed and new_text != text:
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write(new_text)
            print('%-60s %3d linjer' % (path, changed))
            total_files += 1
            total_lines += changed
    print('--\n%d filer, %d linjer konvertert' % (total_files, total_lines))
    if warnings:
        print('\nIKKE konvertert (%d) — se over dem for hånd:' % len(warnings), file=sys.stderr)
        for w in warnings:
            print('  ' + w, file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
