# Portabel eksport — eksempler

Tre eksporter generert med **Fil → Kopier portabelt script** (spec
2026-07-23-portable-export-design), verifisert kjørbare utenfor appen
2026-07-23 (lokal python3 med pandas/requests, og Rscript):

| Fil | Viser | Kjørt lokalt |
|---|---|---|
| `eksempel1_ssb_owid.py` | Proxy-utpakking (`/api/hent?url=` → direkte SSB-URL — ingen CORS utenfor nettleseren) + direkte OWID-csv + import-tillegg | ✅ ekte tall (nyfødte 2000/2005/2009; levealder NOR) |
| `eksempel2_fhi_fred.py` | POST-reversering (FHI json-stat2, GET-innpakket body → ekte `requests.post`) + nøkkelkilde-plassholder (`FRED_API_KEY = "SETT-INN-EGEN-NØKKEL"` — verdier eksporteres aldri) | ✅ FHI-delen (dødsrate 188.9/197.7); FRED krever egen nøkkel |
| `eksempel3_owid.R` | R-emisjon (`read.csv` m/ separator-kommentar) | ✅ maks levealder per nordisk land |

Merknader fra testen:
- Uten `kind(json)` gjetter eksporten csv og varsler («Eksportert med N
  merknader») — bruk `kind(json)` i direktivet for `.json()`-emisjon.
- R's `read.csv` omdøper kolonner med mellomrom (`Life expectancy` →
  `Life.expectancy`) — gjelder brukerens analysekode, ikke eksporten.
