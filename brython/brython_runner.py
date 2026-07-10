# Persistent Brython execution environment for openstat/safestat.
# Pattern from code2web's brython_shared_module.py; output uses the app's
# stdout embed-marker protocol so buildOutputNodes() renders it unchanged.
import sys, json, traceback
from io import StringIO

_EMBED_S = '__micro_transform_start_'
_EMBED_E = '__micro_transform_end__'

_shared_vars = {}
_last_error = ''

def _fmt(obj):
    """Format one object as output text (embed markers for figures/frames)."""
    if obj is None:
        return ''
    if hasattr(obj, 'to_plotly_json_str'):
        return _EMBED_S + 'figure__' + '\n' + obj.to_plotly_json_str() + '\n' + _EMBED_E
    if hasattr(obj, 'to_html'):
        html = obj.to_html()
        if '<table class=' not in html:
            html = html.replace('<table', '<table class="output-table"', 1)
        return _EMBED_S + 'tablehtml__' + '\n' + html + '\n' + _EMBED_E
    if isinstance(obj, str):
        return obj
    return repr(obj)

def _show(*objs):
    """User-facing show(): print each object in its rendered form."""
    for o in objs:
        print(_fmt(o))

_shared_vars['show'] = _show

def _execute_code(code):
    """Run code in the persistent globals; return output text ('' on error)."""
    global _last_error
    _last_error = ''
    buf = StringIO()
    old = sys.stdout
    sys.stdout = buf
    try:
        # Statement-aware trailing-expression detection (no `ast` — must run
        # under Brython 3.12 too). REPL semantics: if the code's final
        # top-level statement is itself an expression, display its value.
        # A top-level statement always starts at column 0 (no leading
        # space/tab); continuation lines of a wrapped call/expression are
        # indented (or at least never mistaken for a *new* top-level
        # statement start under normal formatting). So: find the LAST
        # physical line that starts at column 0 — that's where the final
        # top-level statement begins — and take everything from there to
        # the end as the "tail". If the tail compiles in 'eval' mode it's
        # an expression: exec everything before it, then eval+display the
        # tail (this also covers multi-line trailing expressions, e.g. a
        # call whose arguments wrap across lines). If the tail is a
        # statement (for/if/def/assignment/...), compiling it as 'eval'
        # raises SyntaxError and we fall back to plain-exec of the whole
        # code with no display — identical to today's behavior. This also
        # keeps indented-last-line-inside-a-block safe: the nearest
        # column-0 line is the block header, whose tail (header + body)
        # cannot compile as 'eval' either, so it plain-execs instead of
        # evaling the inner line out of context.
        lines = code.split(chr(10))
        while lines and lines[-1].strip() == '':
            lines.pop()
        result = None
        displayed = False
        if lines:
            last_idx = None
            for i in range(len(lines) - 1, -1, -1):
                line = lines[i]
                if line and line[:1] not in (' ', chr(9)):
                    last_idx = i
                    break
            if last_idx is not None:
                tail_src = chr(10).join(lines[last_idx:])
                tail_stripped = tail_src.strip()
                if tail_stripped and not tail_stripped.startswith('#'):
                    try:
                        tail_code = compile(tail_src, '<brython>', 'eval')
                        head_src = chr(10).join(lines[:last_idx]) or 'pass'
                        exec(compile(head_src, '<brython>', 'exec'), _shared_vars)
                        result = eval(tail_code, _shared_vars)
                        displayed = True
                    except SyntaxError:
                        pass
        if not displayed:
            exec(compile(code, '<brython>', 'exec'), _shared_vars)
        out = buf.getvalue()
        shown = _fmt(result)
        if shown:
            out = out + ('' if not out or out.endswith(chr(10)) else chr(10)) + shown
        return out
    except Exception:
        _last_error = traceback.format_exc()
        return buf.getvalue()
    finally:
        sys.stdout = old

def _get_last_error():
    return _last_error

def _bind_datasets(spec_json):
    """Bind datasets from JS into user globals. spec: {name: {kind, payload}}.
    kind 'csv' → payload is CSV text; kind 'columns' → payload is {col: [values]}."""
    try:
        import pandas_brython as _pd
        spec = json.loads(spec_json) if isinstance(spec_json, str) else spec_json
        for name, d in spec.items():
            if d['kind'] == 'csv':
                _shared_vars[name] = _pd.read_csv(StringIO(d['payload']))
            else:
                _shared_vars[name] = _pd.DataFrame(d['payload'])
        return ''
    except Exception:
        return traceback.format_exc()
