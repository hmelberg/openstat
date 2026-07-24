import sys
from pathlib import Path

# Gjør repo-rotens moduler (duckdb_bridge, notebook_prose, statx_runner)
# importerbare fra tests/. Motoren (m2py m.fl.) er fjernet fra openstat
# (scope B, 2026-07-24) — motor-testene bor i safestat/microdata.
_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_root))
