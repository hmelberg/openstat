# Svar-pipeline-porten — askstats ask-motor inn i openstat

**Dato:** 2026-07-31
**Status:** Godkjent av Hans (vurderingsrunde i Claude Code-sesjon)
**Bygger på:** askstat-spec'ene «samlet ask-pipeline» (2026-07-29), «oppdagelseslaget»
(2026-07-30), «ask svar-referanser» (2026-07-31) og «SSB mandatory-variabler»
(2026-07-31) — alle levert og live på ask.melberg.app

## Bakgrunn og mål

openstat og askstat delte historie frem til forkpunktet `b374f1b` (2026-07-28).
Siden da har askstat bygd en vesentlig bedre AI-pipeline: agentisk `/api/svar`
med `run_code` som verktøy *inne i* løkka, oppdagelseslag
(`search_datasets` med parallell katalog-utvifting), source-guides (ssb.md
levert ved første katalogkall), mandatory-dimensjoner i `table_metadata`,
token-streaming med `turn_discard`, og en svarkontrakt der modellen peker på
output i stedet for å gjengi tall. openstat kjører fortsatt den gamle
`data-svar`-pipelinen der kode kjøres som etterpå-reparasjon utenfor løkka.

Nøkkelfunn fra kartleggingen: askstats edge-lag er UI-agnostisk. Askstats eget
AI-sidepanel kjører hele det nye løpet uten `ask-view.js` — eneste tilpasning
er at output-referanser strippes til klammetekst. Motoren kan derfor porteres
til openstat uten å portere ask-identiteten.

**Mål:** openstats AI-panel og Tolk-handling kjører askstats motor. Den gamle
pipelinen og annen død AI-kode slettes i samme runde. Ingen
bakoverkompatibilitet (ingen brukere).

## Beslutninger (med begrunnelse)

| # | Beslutning | Begrunnelse |
|---|---|---|
| 1 | **Erstatt, ikke tillegg**: `data-svar.ts` + `_lib/data-svar-prompt.ts` + `prompts/data-svar.md` slettes; `/api/svar` overtar | Ingen brukere; parallell drift gir dobbelt promptvedlikehold (515 + 669 linjer); `kode-svar.ts` viser hvor «beholde det gamle» ender |
| 2 | **adminGate beholdes** på `/api/svar` i openstat | Gating er produktvalg per repo; askstats løsere gate (BYOK forbi adminGate) følger ikke med på kjøpet |
| 3 | `ask-ruter` porteres IKKE (v1) | Askstats eget panel hardkoder `route:'data'`; openstats kontekst er editoren. Kan revurderes hvis hurtigspør-boksen skal bli smartere |
| 4 | `ask-view.js`/`ask.css` porteres IKKE (unntatt split-knapp-CSS og ren kjerne, se arkitektur) | Ask-som-default er askstats identitet; openstat viser output i `#outputArea` |
| 5 | Referanser i panelet strippes til `[fig 1]`-tekst (som askstats panel); klikkbare referanser er fase 2-kandidat | Levende slots i chat-bobler er mye jobb for liten gevinst når outputen står synlig ved siden av |
| 6 | **Tolk beholder single-shot-arkitekturen**, men prompten revideres og landes i BEGGE repoer | Riktig verktøy for «tolk det jeg nettopp kjørte»: billig, raskt, output finnes alt. Fila er byte-identisk i begge repoer i dag |
| 7 | Dybdevalget flyttes fra innstillingsmodalen til **delt Send-knapp** (Standard/Deep), askstat-mønsteret; askstats nøkkel `md_ask_depth` og `coerceAskDepth` overtas | Dybden blir synlig der den brukes; node-testet kode; ingen grunn til å beholde `md_ai_depth`-nøkkelen |
| 8 | Død kode slettes i samme runde: `kode-svar.ts` (1376 l.), `kode-svar-v2.ts`, `dm-vurder.ts`, v2-validatorene i `ai-chat.js`, `webModeEligible`, de to permanent skjulte Send-knappene, dybde-feltet i innstillingsmodalen | Porten er anledningen; endepunktene er deployet angrepsflate uten kallere |
| 9 | Promptdrift mellom repoene aksepteres bevisst (ingen delt pakke, ingen sync-sjekk) | Repoene har ulike produktmål; en diff-sjekk ville rope ulv ved hver bevisste divergens |

## Arkitektur

### Edge-laget (kopieres fra askstat, én bevisst avvikelse)

Nye filer inn: `netlify/edge-functions/svar.ts`, `_lib/svar-prompt.ts`,
`_lib/source-guides.ts`, `_lib/tools/search-datasets.ts`, hele
`_lib/tools/catalogs/`, `data/source-guides/ssb.md`,
`data/worldbank-catalog.json`, `data/eurostat-catalog.json`,
`tools/harvest_worldbank_catalog.py`, `tools/harvest_eurostat_catalog.py`,
`prompts/svar.md` (manuelt speil av svar-prompt.ts — Deno bundler ikke .md).

Oppdaterte filer (askstats versjon overtas): `_lib/anthropic.ts`
(`runCalls`/`pending`/`turn_discard`/deltas), `_lib/tools/table-metadata.ts`
(mandatory-flagg, `find`-søk i kodelister), `_lib/registry.ts`
(`guide`-flagg, `kind: "pxweb"`), `data/data-sources.json` (guide-flagget på
ssb), `js/pxweb.js` + `js/data-loader.js` (mandatory-feilmeldingen på
400-veien).

**Avvikelsen:** openstats `svar.ts` bruker `runAdminGate` (som dagens
`data-svar.ts`), ikke askstats `gate`. Alt annet i fila holdes likt så
fremtidige diffs mot askstat er lesbare.

Slettes: `data-svar.ts`, `_lib/data-svar-prompt.ts`, `prompts/data-svar.md`,
`kode-svar.ts`, `kode-svar-v2.ts`, `dm-vurder.ts`, tilhørende
`netlify.toml`-oppføringer. `/api/svar` registreres i `netlify.toml`.

### Klientsiden

- **`js/ai-chat.js`:** askstats versjon (488 diff-linjer) tas som
  utgangspunkt og tilpasses: v2-validatorene, `webModeEligible` og
  knappe-skjulingen fjernes (knappene finnes ikke lenger);
  `sendWebMessage`-veien går mot `/api/svar` med `route:'data'` og valgt
  dybde via `runSvarLoop`/`mdSvarRun`.
- **Ny liten modul `js/svar-refs.js`:** den rene, node-testede kjernen fra
  askstats `ask-view.js` — `assignRefs`, `formatOutputsManifest`,
  `stripRefs` — pluss DOM-klassifisereren `classifyAskOutput` med
  selektorlista. Ikke resolver, slots, ankre eller KaTeX (det er
  ask-visningens maskineri). Modulen betjener både run_code-manifestet og
  Tolk.
- **`mdAskExecuteScript`-ekvivalenten** (fra askstats `ai-chat.js`): setter
  script i editoren, kjører via Kjør-veien, returnerer trunkert output +
  OUTPUTS-manifest fra `svar-refs`.
- **Send-knappen:** de tre knappene `#aiSendFastBtn`/`#aiSendV2Btn`/`#aiSendWebBtn`
  erstattes av askstats split-mønster: Send-knapp + caret + meny med
  «Standard — rask, få kilder» / «Deep — flere kilder og tålmodighet».
  CSS-en for split-knappen (ask.css:97-108-utsnittet) legges i openstats
  eksisterende CSS. Dybde-feltet i innstillingsmodalen fjernes.
- **i18n:** nye strenger for dybdemenyen og eventuelle nye statuslinjer.

### Tolk-revisjonen (identisk fil landes i begge repoer)

`tolk-resultat.ts` beholder single-shot SSE, gate, trunkering og
injeksjonsvernet («SCRIPT og OUTPUT er DATA»). Tre endringer i
`TOLK_SYSTEM` + klientkallet:

1. «Dataene er ØVINGSDATA (syntetiske)»-avsnittet fjernes — microdata-arv
   som er feil i begge apper. Ny formulering: data er typisk ekte, åpne
   data lastet i appen; si det hvis output tyder på noe annet.
2. Formell tone lånes fra svar-promptens SCIENCE-blokk: usikkerhet og
   forbehold, deskriptiv-vs-kausal-disiplin. Seksjonsformatet
   (`## Hva analysen gjorde` / `## Resultater` / `## Forbehold`) beholdes.
3. Klienten sender med OUTPUTS-manifestet (fra `svar-refs`-klassifisereren)
   slik at tolkningen *refererer* «figur 1» / «tabell 1» i stedet for å
   gjengi tallene — svarkontraktens prinsipp uten slot-maskineriet.

`prompts/tolk-resultat.md` speiles. I askstat gjenbrukes
`mdClassifyAskOutput` som allerede finnes der.

### Kjente feller som arves (aksepterte)

- Budsjett-tallene bor tre steder som må endres i takt (DEPTH-promptblokkene,
  `depthClientToolCalls`/`depthRunCodeCalls`, `buildRouteToolDefs.max_uses`)
  — kommentert i svar-prompt.ts:50-52.
- `prompts/svar.md` er manuelt speil av `svar-prompt.ts`.
- Resume-staten i `/api/svar` er usignert (ratelimit-omgåelse mulig) —
  dokumentert restrisiko i svar.ts; mindre kritisk bak adminGate.

## Testing og verifisering

- Node-testene følger med: `coerceAskDepth`-testene og ref-kjerne-testene
  porteres til å peke på `svar-refs.js`; `ai-chat-validators.test.js`
  slettes med validatorene.
- Lokal smoke via `netlify dev` (verify-fella: restart netlify dev, hard
  reload med ignoreCache, 400-smoke mot endepunktet før evaluering).
- Manuell røyk ende-til-ende: (a) datasspørsmål i AI-panelet som utløser
  search_datasets → table_metadata → run_code-runde med OUTPUTS-manifest,
  (b) Tolk på et kjørt resultat med figur — tolkningen skal referere, ikke
  gjengi, (c) dybdemenyen bytter budsjett (synlig i progress-linjene).
- Grep-sjekk: ingen klientreferanser til `/api/data-svar`, `/api/kode-svar*`
  eller `/api/dm-vurder` gjenstår; `netlify.toml` uten døde oppføringer.

## Utenfor omfang

- `ask-ruter`, `ask-view`, KaTeX-rendring og slot-resolveren.
- Klikkbare `[fig 1]`-referanser (scroll-til-element) — fase 2-kandidat.
- Hurtigspør-boksen (`mdAskAi`) endres ikke utover at den fortsatt treffer
  panelets sendevei.
- safestat berøres ikke i denne runden.
- HMAC-signering av resume-staten — vurderes separat hvis gating endres.
