# Tynn fasade over shared/altair_core.py — se brython/altair_brython.py.
# Eksplisitte rebind-er (IKKE `from altair_core import *`): runnerens
# _Mod-proxy i sys.modules delegerer via __getattr__, og MicroPythons
# stjerneimport ser bare proxyens EGNE attributter — stjerneimport ga
# derfor en tom fasade (browser-funn 2026-07-24). Samme mønster som
# ui_mpy.py sin `import ui_core as _core`.
import altair_core as _core

VEGALITE_SCHEMA = _core.VEGALITE_SCHEMA
Undefined = _core.Undefined
Chart = _core.Chart
LayerChart = _core.LayerChart
Channel = _core.Channel
X = _core.X
Y = _core.Y
Color = _core.Color
Size = _core.Size
Opacity = _core.Opacity
Tooltip = _core.Tooltip
Column = _core.Column
Row = _core.Row
Scale = _core.Scale
Axis = _core.Axis
Legend = _core.Legend
Bin = _core.Bin
SortField = _core.SortField
value = _core.value
defaults = _core.defaults
hconcat = _core.hconcat
vconcat = _core.vconcat
selection_point = _core.selection_point
selection_interval = _core.selection_interval
condition = _core.condition
