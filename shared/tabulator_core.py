"""tabulator_core — interaktive tabeller (Tabulator 6.3.1) for
brython/micropython/pyodide/CPython (spec 2026-07-24-tabulator-shim-
design.md). Dialektregler som de andre kjernene. Ren dict-bygging —
Tabulator-JS-en er statisk lastet i index.html, og opsjoner utover de
navngitte går uendret gjennom `options={...}` (Tabulator-dokumentasjonen
er referansen). Vises via show()/siste uttrykk (tabulator__-embedden)."""

import json

_PAGINATION_AUTO_THRESHOLD = 200
_PAGINATION_AUTO_SIZE = 20


def _is_nan(v):
    if v is None:
        return True
    if type(v).__name__ == 'NaN':
        return True
    return isinstance(v, float) and v != v


def _records_and_columns(data):
    """-> (kolonnenavn, liste av rad-dicts). Godtar DataFrame (duck-typet
    .columns + .to_dict() — BÅDE shim-formen {kol: [liste]} og ekte
    pandas' {kol: {idx: verdi}}), dict-av-lister og liste-av-records."""
    if hasattr(data, 'columns') and hasattr(data, 'to_dict'):
        cols = [str(c) for c in list(data.columns)]
        raw = data.to_dict()
        norm = {}
        for c0 in raw:
            v = raw[c0]
            if isinstance(v, dict):
                norm[str(c0)] = list(v.values())
            else:
                norm[str(c0)] = list(v)
        data = norm
        keys = cols
    elif isinstance(data, dict):
        keys = [str(k) for k in data.keys()]
        data = {str(k): list(data[k]) for k in data}
    elif isinstance(data, (list, tuple)):
        recs = []
        keys = []
        for r in data:
            row = {}
            for k in r:
                ks = str(k)
                if ks not in keys:
                    keys.append(ks)
                row[ks] = r[k]
            recs.append(row)
        return keys, recs
    else:
        raise ValueError('table(data): forventer DataFrame, dict av '
                         'lister eller liste av dicts')
    n = 0
    for k in keys:
        n = max(n, len(data.get(k, [])))
    recs = []
    for i in range(n):
        row = {}
        for k in keys:
            seq = data.get(k, [])
            row[k] = seq[i] if i < len(seq) else None
        recs.append(row)
    return keys, recs


def _json_safe_cell(v):
    if _is_nan(v):
        return None
    if isinstance(v, (bool, int, float, str)):
        return v
    return str(v)


def _check_no_callables(obj, path):
    if callable(obj):
        raise TypeError('options-verdien «' + path + '» er en funksjon — '
                        'kun JSON-serialiserbare verdier kan sendes til '
                        'Tabulator (bruk formatter-NAVN som streng, se '
                        'Tabulator-dokumentasjonen)')
    if isinstance(obj, dict):
        for k in obj:
            _check_no_callables(obj[k], path + '.' + str(k))
    elif isinstance(obj, (list, tuple)):
        i = 0
        for v in obj:
            _check_no_callables(v, path + '[' + str(i) + ']')
            i += 1


class Table:
    def __init__(self, data, pagination=None, height=None, filters=False,
                 sortable=True, title=None, options=None):
        keys, recs = _records_and_columns(data)
        recs = [{k: _json_safe_cell(r[k]) for k in r} for r in recs]
        numeric = {}
        for k in keys:
            saw = False
            ok = True
            for r in recs:
                v = r.get(k)
                if v is None:
                    continue
                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    ok = False
                    break
                saw = True
            numeric[k] = ok and saw
        colspecs = []
        for k in keys:
            c = {'title': k, 'field': k,
                 'sorter': 'number' if numeric[k] else 'string'}
            if numeric[k]:
                c['hozAlign'] = 'right'
            if filters:
                c['headerFilter'] = 'input'
            if not sortable:
                c['headerSort'] = False
            colspecs.append(c)
        opts = {}
        n = len(recs)
        if pagination is None or pagination is True:
            if n > _PAGINATION_AUTO_THRESHOLD:
                opts['pagination'] = 'local'
                opts['paginationSize'] = _PAGINATION_AUTO_SIZE
        elif pagination is not False:
            opts['pagination'] = 'local'
            opts['paginationSize'] = int(pagination)
        if height is not None:
            opts['height'] = height
        if options:
            _check_no_callables(options, 'options')
            for k in options:
                opts[k] = options[k]
        self._spec = {'columns': colspecs, 'data': recs, 'options': opts}
        if title is not None:
            self._spec['title'] = title

    def to_dict(self):
        return self._spec

    def to_tabulator_json_str(self):
        """Runner-protokollen (_fmt/show): hele spec-en som JSON-streng."""
        return json.dumps(self._spec)

    def show(self):
        return str(self)

    def __str__(self):
        return '<Table: use show() or leave as last expression>'

    def __repr__(self):
        return str(self)

    def _repr_html_(self):
        return str(self)


def table(data, pagination=None, height=None, filters=False,
          sortable=True, title=None, options=None):
    return Table(data, pagination=pagination, height=height,
                 filters=filters, sortable=sortable, title=title,
                 options=options)
