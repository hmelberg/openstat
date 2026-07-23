"""altair_core — delt Vega-Lite-spec-bygger (altair-API-subset) for
brython/micropython/CPython (spec 2026-07-23-altair-shim-design.md).
Samme rolle som plotly_express_*, men ÉN delt fil (ui_core-presedensen):
KUN dialektfri kode — ingen browser/js-import, ingen `**` i dict-
LITERALER, ingen str.capitalize()/re/setdefault/partition, datetime
guardet (fellelisten: micropython/plotly_express_mpy.py-filhodet).
Spec-paritet verifiseres mot ekte altair (6.2.2) i
brython/tests/test_altair_core_diff.py."""

import json

try:
    import datetime as _datetime
except ImportError:          # unix-micropython mangler datetime helt
    _datetime = None

VEGALITE_SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json'


class _UndefinedType:
    """Skiller 'ikke oppgitt' fra None — None er MENINGSBÆRENDE i altair
    (axis=None -> "axis": null -> aksen skjules)."""
    def __repr__(self):
        return 'Undefined'


Undefined = _UndefinedType()


def _is_nan(v):
    """True for None, float-nan og pandas-shimenes NaN-sentinel
    (duck-typet på klassenavn — samme grep som plotly-shimet)."""
    if v is None:
        return True
    if type(v).__name__ == 'NaN':
        return True
    return isinstance(v, float) and v != v


def _json_safe(obj):
    """Rekursivt JSON-trygt: nan->None (vega-lite håndterer null),
    tupler->lister, datetime->isoformat, ukjente objekter->str."""
    if _is_nan(obj):
        return None
    if isinstance(obj, dict):
        out = {}
        for k in obj:
            out[str(k)] = _json_safe(obj[k])
        return out
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if _datetime is not None and isinstance(obj, (_datetime.datetime, _datetime.date)):
        return obj.isoformat()
    if isinstance(obj, (bool, int, float, str)):
        return obj
    return str(obj)


def _records_from_data(data):
    """Chart-data -> liste av rad-dicts (vega-lite 'values'-form).
    Godtar DataFrame (duck-typet: .columns + .to_dict() -> {kol: sekvens},
    slik pandas_brython/pandas_mpy sin to_dict() faktisk oppfører seg),
    dict-av-lister og liste-av-dicts."""
    if data is None:
        return []
    if isinstance(data, (list, tuple)):
        return [dict(r) for r in data]
    if hasattr(data, 'columns') and hasattr(data, 'to_dict'):
        data = data.to_dict()
    if isinstance(data, dict):
        if not data:
            return []
        cols = list(data.keys())
        first = data[cols[0]]
        if not isinstance(first, (list, tuple)):
            raise ValueError('Chart(data): dict-input må være {kolonne: liste}')
        out = []
        for i in range(len(first)):
            row = {}
            for c in cols:
                row[c] = data[c][i]
            out.append(row)
        return out
    raise ValueError('Chart(data): forventer DataFrame, dict av lister '
                     'eller liste av dicts, fikk ' + type(data).__name__)


_TYPECODES = {'Q': 'quantitative', 'O': 'ordinal', 'N': 'nominal', 'T': 'temporal'}
_AGGREGATES = ('count', 'sum', 'mean', 'median', 'min', 'max',
               'stdev', 'variance', 'distinct')


def _infer_type(field, records):
    """altair-lik typeinferens for bar 'kol'-shorthand: numerisk -> Q,
    datetime -> T, ellers N (bool er N — bool er subklasse av int, sjekkes
    derfor FØR tallgrenen)."""
    saw_num = False
    for r in records:
        v = r.get(field) if isinstance(r, dict) else None
        if _is_nan(v):
            continue
        if isinstance(v, bool):
            return 'nominal'
        if isinstance(v, (int, float)):
            saw_num = True
            continue
        if _datetime is not None and isinstance(v, (_datetime.datetime, _datetime.date)):
            return 'temporal'
        return 'nominal'
    if saw_num:
        return 'quantitative'
    return 'nominal'


def _parse_shorthand(sh, records):
    """'kol' | 'kol:Q' | 'agg(kol)' | 'agg(kol):T' | 'count()' -> kanal-dict.
    rfind-basert (ikke rpartition — MicroPython-byggavhengig)."""
    s = str(sh)
    typ = None
    i = s.rfind(':')
    if i >= 0 and s[i + 1:] in _TYPECODES:
        typ = _TYPECODES[s[i + 1:]]
        s = s[:i]
    out = {}
    if s.endswith(')'):
        j = s.find('(')
        if j > 0:
            agg = s[:j]
            fld = s[j + 1:-1]
            if agg not in _AGGREGATES:
                raise ValueError('Ukjent aggregat: ' + agg)
            out['aggregate'] = agg
            if fld:
                out['field'] = fld
            out['type'] = typ if typ is not None else 'quantitative'
            return out
    out['field'] = s
    out['type'] = typ if typ is not None else _infer_type(s, records)
    return out


class _Options:
    """Generisk kwargs->dict-holder for Scale/Axis/Legend/Bin/SortField.
    None-verdier beholdes IKKE (None brukes aldri meningsbærende inni
    disse under-objektene i v1)."""
    def __init__(self, **kwargs):
        self._kw = {}
        for k in kwargs:
            if kwargs[k] is not None:
                self._kw[k] = kwargs[k]

    def _to_channel_dict(self):
        return dict(self._kw)


class Scale(_Options):
    pass


class Axis(_Options):
    pass


class Legend(_Options):
    pass


class Bin(_Options):
    pass


class SortField(_Options):
    pass


class Channel:
    """Felles kanalklasse (X/Y/Color/... er navnesubklasser). Kanalnøkkelen
    bestemmes av encode()-kwargen, ikke av klassen — som i altair-praksis."""
    def __init__(self, shorthand=Undefined, type=Undefined, aggregate=Undefined,
                 field=Undefined, bin=Undefined, scale=Undefined, sort=Undefined,
                 title=Undefined, axis=Undefined, legend=Undefined,
                 timeUnit=Undefined, format=Undefined):
        self._shorthand = shorthand
        self._opts = {}
        if type is not Undefined:
            self._opts['type'] = type
        if aggregate is not Undefined:
            self._opts['aggregate'] = aggregate
        if field is not Undefined:
            self._opts['field'] = field
        if bin is not Undefined:
            self._opts['bin'] = bin
        if scale is not Undefined:
            self._opts['scale'] = scale
        if sort is not Undefined:
            self._opts['sort'] = sort
        if title is not Undefined:
            self._opts['title'] = title
        if axis is not Undefined:
            self._opts['axis'] = axis
        if legend is not Undefined:
            self._opts['legend'] = legend
        if timeUnit is not Undefined:
            self._opts['timeUnit'] = timeUnit
        if format is not Undefined:
            self._opts['format'] = format

    def _channel_dict(self, records):
        out = {}
        if self._shorthand is not Undefined and self._shorthand is not None:
            out = _parse_shorthand(self._shorthand, records)
        for k in self._opts:
            v = self._opts[k]
            if hasattr(v, '_to_channel_dict'):
                v = v._to_channel_dict()
            out[k] = v
        # field= som kwarg (uten shorthand): infer type som altair
        if 'field' in out and 'type' not in out and out.get('aggregate') != 'count':
            out['type'] = _infer_type(out['field'], records)
        return out


class X(Channel):
    pass


class Y(Channel):
    pass


class Color(Channel):
    pass


class Size(Channel):
    pass


class Opacity(Channel):
    pass


class Tooltip(Channel):
    pass


class Column(Channel):
    pass


class Row(Channel):
    pass


def value(v):
    """alt.value: literal kanalverdi (encode(color=alt.value('red')))."""
    return {'value': v}
