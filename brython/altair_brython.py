# Tynn fasade over shared/altair_core.py (ui_core-presedensen): HELE
# API-et ligger i den dialektfrie kjernen. Registrert i js/brython-engine
# med alias 'altair'; deps sørger for at altair_core ligger i sys.modules
# før denne linjen kjører. Eksplisitte rebind-er (ikke stjerneimport) —
# samme liste som micropython/altair_mpy.py, se dens filhode for hvorfor.
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
