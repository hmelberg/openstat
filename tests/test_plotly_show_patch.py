"""TDD for _m2py_patch_plotly_show (bug reprodusert live: fig.show() på en
ekte plotly go.Figure i pyodide-modus kaster
'ValueError: Mime type rendering requires ipython but it is not installed'
fordi plotly sin innebygde .show()/pio.show()-sti prøver en IPython-mime-
rendering som ikke finnes i pyodide. Appens visningsmaskineri rendrer
plotly-figurer fint NÅR OBJEKTET vises (_show_one, index.html ~L7726:
figure__-embed via pio.to_json) — men .show()-kallet var det upatchede
hullet (plt.show() er patchet, fig.show() var det ikke). Fikset ved å
monkey-patche go.Figure.show/pio.show til å emitte samme figure__-embed.

Følger extraction-mønsteret fra test_display_policy.py: henter selve
funksjonsdefinisjonen _m2py_patch_plotly_show ut av index.html (uten
selv-kallet '_m2py_patch_plotly_show()' rett under definisjonen — testen
styrer selv når patch-funksjonen kalles, slik at idempotens kan sjekkes
eksplisitt med to kall)."""
import pathlib
import sys
import types

INDEX = pathlib.Path(__file__).resolve().parents[1] / "index.html"

_EMBED_S = "__micro_transform_start_"
_EMBED_E = "__micro_transform_end__"


def _load_patch_src():
    text = INDEX.read_text(encoding="utf-8")
    start = text.index("def _m2py_patch_plotly_show(")
    end = text.index("\n_m2py_patch_plotly_show()\n", start)
    src = text[start:end]
    # Samme literal-unescaping som test_display_policy.py._load_core_src():
    # index.html sin Python-kilde ligger i en JS-template-literal, der '\\'
    # i filen tilsvarer '\' når Pyodide får koden. No-op her (denne
    # funksjonen har ingen backslash-escapes), men holdt for konsistens.
    return src.replace("\\\\", "\\")


def make_patch_fn():
    ns = {"_EMBED_S": _EMBED_S, "_EMBED_E": _EMBED_E}
    exec(compile(_load_patch_src(), "<index.html:_m2py_patch_plotly_show>", "exec"), ns)
    return ns["_m2py_patch_plotly_show"]


def _install_fake_plotly(monkeypatch, to_json_return='{"data": [], "layout": {}}'):
    # Fersk klasse PER kall (ikke en delt modulnivå-klasse) — patchen setter
    # go.Figure.show som et KLASSE-attributt, som ellers ville lekket over
    # til neste test siden monkeypatch bare rydder opp sys.modules, ikke
    # attributter satt på en gjenbrukt klasse.
    fake_figure_cls = type("_FakeFigure", (), {})
    go_mod = types.ModuleType("plotly.graph_objects")
    go_mod.Figure = fake_figure_cls
    pio_mod = types.ModuleType("plotly.io")
    pio_mod.to_json = lambda fig, *a, **k: to_json_return
    plotly_mod = types.ModuleType("plotly")
    plotly_mod.graph_objects = go_mod
    plotly_mod.io = pio_mod
    monkeypatch.setitem(sys.modules, "plotly", plotly_mod)
    monkeypatch.setitem(sys.modules, "plotly.graph_objects", go_mod)
    monkeypatch.setitem(sys.modules, "plotly.io", pio_mod)
    return go_mod, pio_mod


def test_fig_show_prints_figure_embed(monkeypatch, capsys):
    go_mod, _pio_mod = _install_fake_plotly(monkeypatch)
    patch = make_patch_fn()
    patch()
    fig = go_mod.Figure()
    fig.show()  # dette er nøyaktig kallet som krasjet i appen
    out = capsys.readouterr().out
    assert _EMBED_S + "figure__" in out
    assert '{"data": [], "layout": {}}' in out
    assert _EMBED_E in out


def test_pio_show_also_patched(monkeypatch, capsys):
    go_mod, pio_mod = _install_fake_plotly(monkeypatch)
    patch = make_patch_fn()
    patch()
    fig = go_mod.Figure()
    pio_mod.show(fig)
    out = capsys.readouterr().out
    assert _EMBED_S + "figure__" in out
    assert '{"data": [], "layout": {}}' in out


def test_patch_application_is_idempotent(monkeypatch, capsys):
    go_mod, _pio_mod = _install_fake_plotly(monkeypatch)
    patch = make_patch_fn()
    patch()
    first_show = go_mod.Figure.show
    patch()  # andre gangs kall (f.eks. fra toppen av _exec_pyodide_block)
    assert go_mod.Figure.show is first_show
    # og den fungerer fortsatt normalt etter dobbel patching
    fig = go_mod.Figure()
    fig.show()
    out = capsys.readouterr().out
    assert out.count(_EMBED_S + "figure__") == 1


def test_patch_without_plotly_available_is_silent_noop(monkeypatch):
    # plotly ikke (ennå) installert — typisk tilstand FØR micropip sin lat
    # installasjon (index.html ~L10314) har rukket å kjøre. sys.modules
    # sin None-konvensjon tvinger 'import plotly...' til å kaste
    # ImportError uten å røre ekte plotly (6.8.0) i test-miljøet.
    monkeypatch.setitem(sys.modules, "plotly", None)
    patch = make_patch_fn()
    patch()  # skal IKKE kaste
