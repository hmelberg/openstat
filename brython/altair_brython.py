# Tynn fasade over shared/altair_core.py (ui_core-presedensen): HELE
# API-et ligger i den dialektfrie kjernen. Registrert i js/brython-engine
# med alias 'altair'; deps sørger for at altair_core ligger i sys.modules
# før denne linjen kjører.
from altair_core import *          # noqa: F401,F403
