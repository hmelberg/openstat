# ── Portabel eksport fra OpenStat ──
# «# load»-direktivene er oversatt til frittstående lastekode.
# Generert av appen — rediger fritt.
FRED_API_KEY = "SETT-INN-EGEN-NØKKEL"
import pandas as pd
import requests
import io
import json
# Hjertekar-dødelighet (FHI, json-stat2 via POST) + USA-ledighet (FRED, nøkkelkilde)
# connect fred
# load /api/hent?url=...FHI-url...&body=...json-stat2-body... as hjertekar  (se full eksport i appen)
_resp = requests.post("https://statistikk-data.fhi.no/api/open/v1/daar/table/754/data", json=json.loads("{\"dimensions\":[{\"code\":\"DAAR\",\"filter\":\"item\",\"values\":[\"2020\",\"2021\"]},{\"code\":\"KJONN\",\"filter\":\"item\",\"values\":[\"Total\"]},{\"code\":\"HJERTEKAR\",\"filter\":\"item\",\"values\":[\"Total\"]},{\"code\":\"MEASURE_TYPE\",\"filter\":\"item\",\"values\":[\"RATE_NO\"]}],\"response\":{\"format\":\"json-stat2\"}}"))
hjertekar = _resp.json()   # json-stat2 — bruk kind(json) i direktivet for å få denne automatisk
# load fred/series/observations?series_id=UNRATE&file_type=json as usa_ledighet, kind(json)
_url_usa_ledighet = "https://api.stlouisfed.org/fred/series/observations?series_id=UNRATE&file_type=json" + "&api_key=" + FRED_API_KEY
usa_ledighet = requests.get(_url_usa_ledighet).json()  # rå JSON — appens binding kan avvike
print(hjertekar['value'])
