# Tynn fasade over shared/tabulator_core.py — eksplisitte rebind-er
# (aldri stjerneimport, _Mod-fellen). Samme liste som
# micropython/tabulator_mpy.py.
import tabulator_core as _core

Table = _core.Table
table = _core.table
