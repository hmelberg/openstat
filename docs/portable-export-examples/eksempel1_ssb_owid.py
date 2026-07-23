# ── Portabel eksport fra OpenStat ──
# «# load»-direktivene er oversatt til frittstående lastekode.
# Generert av appen — rediger fritt.
import pandas as pd
# Nyfødte i Norge (SSB, historisk serie) og levealder (OWID)
# load /api/hent?url=https%3A%2F%2Fdata.ssb.no%2Fapi%2Fpxwebapi%2Fv2%2Ftables%2F05839%2Fdata%3FvalueCodes%5BKjonn%5D%3D0%26valueCodes%5BAlder%5D%3D000%26valueCodes%5BContentsCode%5D%3DPersoner%26valueCodes%5BTid%5D%3D2000%2C2005%2C2009%26outputFormat%3Dcsv as nyfodte
nyfodte = pd.read_csv("https://data.ssb.no/api/pxwebapi/v2/tables/05839/data?valueCodes[Kjonn]=0&valueCodes[Alder]=000&valueCodes[ContentsCode]=Personer&valueCodes[Tid]=2000,2005,2009&outputFormat=csv", sep=None, engine="python")
# load https://ourworldindata.org/grapher/life-expectancy.csv as levealder
levealder = pd.read_csv("https://ourworldindata.org/grapher/life-expectancy.csv", sep=None, engine="python")
print(nyfodte)
norge = levealder[levealder['Code'] == 'NOR']
print(norge.tail(3))
