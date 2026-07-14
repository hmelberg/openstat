"""ui - pyodide-fasade for notebook-widgets (spec 2, W1).

Plassholder (Task 2 i planen docs/superpowers/plans/2026-07-15-notebook-widgets-w1.md):
den fulle fasaden (ui.slider/dropdown/checkbox/switch/number/text/button)
bygges i Task 4. Denne fila finnes kun slik at __ensureUi-ledningen i
index.html (lazy-lasting av `import ui` mot window.Ui, samme mønster som
pyodide/dash.py) er ende-til-ende-testbar før DOM-halvdelen er ferdig.

`import ui` i en celle vil altså kjøre helt frem til `ui.<noe>`-kallet, som
da feiler med en tydelig ImportError - ALDRI en rå AttributeError/krasj i
selve importen.
"""


def __getattr__(name):
    raise ImportError("ui er ikke ferdig - Task 4")
