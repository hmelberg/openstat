# R-factor-knippet — design (2026-07-29)

**Mål:** De fire R-oppfølgingene fra r-factor-rundens reviews.

## §1 rSource-evalen ut av pxweb-try-en (VIKTIGST)

index.html webR-boot: `evalRVoid(OstR.rSource())` ligger i samme try som
pxweb-lastingen — kaster writeFile/evalRString, hopper catch-en over hele
evalen og `ost_read_csv` FINNES IKKE («could not find function») i stedet
for å degradere. Fiks: to separate try/catch — pxweb-feil degraderer KUN
typing (console.warn), rSource-evalen kjører alltid.

## §2 PxWeb-mangler skilles fra ukjent kilde

`.ost_meta_url` returnerer '' for begge tilfeller i dag → `ost_read_csv` på
kjent kilde blir STILLE passthrough når PxWeb mangler i workeren (spec-en
lover «utypet + notat»). Fiks: eval_js-payloaden returnerer markøren
`"!NOPX"` når `globalThis.PxWeb`/metaUrlFor mangler; R-side:
- `ost_read_csv`-veien: `message("ost: PxWeb utilgjengelig i workeren —
  laster utypet.")` + passthrough UTEN attr (samme svar som mini-fiksen:
  px-borte = ikke gjenkjent).
- `ost_convert_dtypes`-URL-veien: egen ærlig stop («PxWeb utilgjengelig i
  workeren — kan ikke slå opp metadata nå») i stedet for misvisende
  «gjenkjente ikke kilden».

## §3 attrs fra ost_convert_dtypes (py-paritet)

URL-formen setter `attr(df, "ost_url") <- meta` på returrammen — håndbygde
rammer får dermed panelberikelse (som py-tvillingens attrs-setting).
Liste-formen har ingen URL — ingen attr.

## §4 Domenemelding for malformet meta-liste

Shape-sjekk før anvendelse: liste av `list(did=<chr1>, time=, codes=)`
(tom liste = no-op, lov); brudd → stop med klar melding («meta må være en
register-URL eller en typemeta-liste (list(did=, time=, codes=) per
dimensjon)») i stedet for dagens kryptiske R-feil.

## §5 Test/verifisering

node: kildetekst-asserter i tests/js/ost-r.test.js (markøren, meldingene,
attr-settingen, shape-sjekken); Rscript-parse + funksjonskjøring av de nye
R-veiene i review; lett live-smoke (R-kjøring: ost_read_csv typer fortsatt,
ost_convert_dtypes(df, meta=url) gir attr). Ingen prompt/TS-endringer —
ingen eval, deno urørt; ingen runtime-hentede .py-filer — ingen
M2PY_VERSION-bump nødvendig (js/ost-r.js er script-tag-lastet app-shell).

## §6 Utenfor scope

Mini-køen, .ost_bridge$fetched-tømming, øvrig kø.
