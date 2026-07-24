# Tynn fasade over shared/tabulator_core.py — se brython/tabulator_brython.py
# (eksplisitte rebind-er; stjerneimport er tom gjennom _Mod-proxyen).
import tabulator_core as _core

Table = _core.Table
table = _core.table
