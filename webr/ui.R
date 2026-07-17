# ui - widget-fasade for webR (R-modus notatbøker, spec 2 ui-widgets, W2).
# Offentlig API: ui_slider, ui_dropdown, ui_checkbox, ui_switch, ui_number,
# ui_text, ui_button, ui_play (funksjonerer; W5.1 on_change=/on_click=-
# aliaser; ui_play: dash-absorpsjon 5a Task 3 - registry-spec only, INGEN
# payload-byggere (kpi/markdown/image) i R - se ui_play sin egen docstring),
# ui_html/ui_sl/ui_pico/ui_widget (høflige notiser), ui_value
# (per-run-snapshot-leser).
#
# Speiler pyodide/ui.py sitt vokabular og fallback-semantikk, men bruker
# DEKLARER-OG-INJISER-MODELLEN i stedet for pyodide sin PULL-modell:
#
#   webR kjører R-koden i en egen worker (PostMessage-kanal, ingen COOP/COEP
#   i dette oppsettet, eval_js ubrukt) - det finnes altså INGEN synkron vei
#   for ui_slider() etc. til å spørre JS-siden om gjeldende verdi midt i
#   kjøringen slik pyodide/ui.py sin window.Ui.registerControl()-kall gjør.
#
#   I stedet: ui_*() DEKLARERER en spec inn i .ui$registry (nøyaktig samme
#   mønster som webr/dash.R sin dashboard()/add()-deklarering) og returnerer
#   verdien fra en FORHÅNDS-INJISERT liste `.ui_values` (satt av index.html
#   FØR cellen kjøres, via `.ui_values <- jsonlite::fromJSON(...)`) hvis
#   nøkkelen finnes der, ellers spec sin egen default. Etter kjøringen leser
#   index.html `.ui_registry_json()` (returnerer OG TØMMER registeret) og
#   bygger/oppdaterer kontrollstripa via window.Ui.registerFromRegistry - se
#   index.html sin runNotebookRCell (declare-og-injiser-integrasjonen).
#
# Robusthet (kritisk, spec-krav): denne fila kan bli sourced og kjørt UTEN at
# `.ui_values`/`.ui_begin()` noensinne er injisert/kalt - t.d. Forklar sin
# per-blokk-sti (forklarRunOneRBlock) kaller aldri index.html sin
# injeksjonsbrakett. Hver ui_*() må derfor virke med KUN default-fallback i
# et slikt tilfelle - exists()-vakter rundt `.ui_values`, ALDRI en antagelse
# om at den er satt. Selve `.ui`-miljøet og ordinal-telleren er derimot
# ALLTID tilgjengelige - de opprettes av denne fila selv idet den sources,
# uavhengig av om `.ui_begin()` noensinne blir kalt.
#
# Integrasjonspunkter i index.html (BEGGE bruker samme .ui_begin()+fromJSON-
# injeksjon FØR kjøring og samme .ui_registry_json()-lesing ETTER, kun
# celleindeksen skiller dem): runNotebookRCell (notatbok, per-celle-kjøring)
# og runHybridR (R "Kjør alle" — per r-segment mot en justert celleplan når
# notatboken er aktiv OG planen justerer, ELLERS ÉN GANG mot dokument-
# konteksten (cellIdx null) for rene R-skript med ui_*-kall, se dens egen
# "Fase 3"/"Dokument-sti"-kommentarer).
#
# sync_to (fase 3, spec §3, alle kontroller UNNTATT ui_button): valgfritt
# navn på en sesjonsvariabel widgeten sin verdi skal PUSHES til ved endring
# (js/ui.js sin normalizeSpec validerer navnet og ruter pushen - se dens
# kommentar). Rent gjennomstrøms i denne fila, samme mønster som `placement`:
# NULL som standard, sendes uendret inn i spec-listen, og fjernes av
# .ui_register hvis ikke satt.

.ui <- new.env(parent = emptyenv())
.ui$registry <- list()
.ui$ordinal <- 0

# Kalles av index.html FØR en celle kjøres (per-celle-integrasjonen) for å
# nullstille ordinal-telleren, slik at navnløse kontroller (w0, w1, ...) får
# STABILE nøkler fra kjøring til kjøring for SAMME celle. Nullstiller også
# registeret defensivt: `.ui_registry_json()` tømmer normalt registeret ved
# HVER lesing (post-run), men hvis en tidligere kjøring feilet FØR den
# lesingen (f.eks. en R-feil midt i cellen forhindret post-run-steget i
# index.html), ville gamle deklarasjoner ellers blitt liggende igjen og
# dukket opp sammen med denne kjøringens - `.ui_begin()` kjøres UBETINGET
# rett før hver cellekjøring (samme idiom som webr/dash.R sin `.dash_reset()`
# kalt fra runHybridR før scriptet kjører), så dette er alltid trygt.
.ui_begin <- function() {
  .ui$ordinal <- 0
  .ui$registry <- list()
  invisible(NULL)
}

# name (eksplisitt navngitt kontroll) eller "w<ordinal>" (posisjonsbasert) -
# ordinalen øker for HVER kontroll uansett om den er navngitt (speiler
# js/ui.js sin _registerInto: `var ordinal = run.ordinal++;` skjer ubetinget,
# før navn-fallback vurderes).
.ui_next_key <- function(name) {
  ord <- .ui$ordinal
  .ui$ordinal <- ord + 1
  if (!is.null(name)) return(as.character(name))
  paste0("w", ord)
}

# Fjern NULL-verdier fra en spec (samme oppskrift som webr/dash.R sin
# .dash_widget) og legg den til i registeret.
.ui_register <- function(spec) {
  spec <- spec[!vapply(spec, is.null, logical(1))]
  .ui$registry[[length(.ui$registry) + 1]] <- spec
  invisible(NULL)
}

# Gjeldende lagrede verdi for `key`, eller NULL hvis `.ui_values` ikke finnes
# (aldri injisert - plain script/Kjør alle), ikke er en liste, eller mangler
# nøkkelen. `exists(..., inherits = FALSE)` i det globale miljøet: `.ui_values`
# injiseres alltid som en topplassert variabel (evalRVoid kjører på
# .GlobalEnv), aldri som en lokal - å slå opp med `inherits = TRUE` herfra
# ville uansett funnet den samme variabelen (funksjonene her er selv
# definert i .GlobalEnv via `source()`), men eksplisitt `envir = globalenv()`
# gjør avhengigheten synlig og unngår enhver tvetydighet om lookup-kjeden.
.ui_get_value <- function(key) {
  if (!exists(".ui_values", envir = globalenv(), inherits = FALSE)) return(NULL)
  vals <- get(".ui_values", envir = globalenv())
  if (!is.list(vals)) return(NULL)
  vals[[key]]
}

# ---- offentlig API (samme vokabular som pyodide/ui.py) ----

# W5.1 (spec 2026-07-16-notebook-widget-events): on_click=/on_change= er
# kanoniske aliaser for rerun= - aliaset vinner naar begge er satt
# (dokumentert kontrakt, ingen advarselskanal i v1). R-motoren har ingen
# _alias_rerun-funksjon slik de tre Python-fasadene faar (ingen delt
# hjelpefunksjon i R-filen fra foer) - hver ui_*() gjoer i stedet
# `if (!is.null(alias)) rerun <- alias` foer specen bygges, som er det
# R-idiomatiske ekvivalentet.

#' Glidebryter. Fallback (ingen notatbok/verdi ikke injisert): value hvis
#' gitt, ellers min - samme regel som pyodide/ui.py sin slider(). `placement`
#' (Task 3, per-kontroll plassering: "top"/"bottom"/"left") er en ren
#' gjennomstrøms-kwarg - valideringen skjer på JS-siden (js/ui.js sin
#' normalizeSpec); NULL droppes av .ui_register som vanlig og kontrollen
#' faller da tilbake til cellens widgets=-default. `on_change` er kanonisk
#' alias for `rerun` (W5.1) - aliaset vinner naar begge er satt.
ui_slider <- function(min = 0, max = 100, value = NULL, step = 1, label = NULL,
                      name = NULL, rerun = "self", on_change = NULL, placement = NULL,
                      sync_to = NULL) {
  if (!is.null(on_change)) rerun <- on_change
  key <- .ui_next_key(name)
  default <- if (is.null(value)) min else value
  .ui_register(list(type = "slider", name = key, label = label, min = min,
                    max = max, step = step, value = default, rerun = rerun,
                    placement = placement, sync_to = sync_to))
  raw <- .ui_get_value(key)
  if (is.null(raw)) return(default)
  as.numeric(raw)
}

#' Nedtrekksmeny. Fallback: value hvis gitt, ellers første valg. Tom
#' options-liste er en programmeringsfeil og skal feile HØYT (samme som
#' pyodide/ui.py sin ValueError), ikke stille falle tilbake til noe.
#' `on_change` er kanonisk alias for `rerun` (W5.1) - aliaset vinner naar
#' begge er satt.
ui_dropdown <- function(options, value = NULL, label = NULL, name = NULL,
                        rerun = "self", on_change = NULL, placement = NULL,
                        sync_to = NULL) {
  if (!is.null(on_change)) rerun <- on_change
  key <- .ui_next_key(name)
  options <- as.character(options)
  if (length(options) == 0) {
    stop("ui_dropdown: options kan ikke være en tom liste.")
  }
  default <- if (!is.null(value)) as.character(value)[1] else options[1]
  # I() paa options: jsonlite auto_unbox maa ikke kollapse en en-elements
  # meny til skalar - js/ui.js sin normalizeSpec venter alltid et array
  # (samme begrunnelse som webr/dash.R sin dropdown()).
  .ui_register(list(type = "dropdown", name = key, label = label,
                    options = I(options), value = default, rerun = rerun,
                    placement = placement, sync_to = sync_to))
  raw <- .ui_get_value(key)
  if (is.null(raw)) return(default)
  as.character(raw)
}

#' Avkrysningsboks. Fallback: value. `on_change` er kanonisk alias for
#' `rerun` (W5.1) - aliaset vinner naar begge er satt.
ui_checkbox <- function(label = NULL, value = FALSE, name = NULL, rerun = "self",
                        on_change = NULL, placement = NULL, sync_to = NULL) {
  if (!is.null(on_change)) rerun <- on_change
  key <- .ui_next_key(name)
  default <- isTRUE(value)
  .ui_register(list(type = "checkbox", name = key, label = label,
                    value = default, rerun = rerun, placement = placement,
                    sync_to = sync_to))
  raw <- .ui_get_value(key)
  if (is.null(raw)) return(default)
  isTRUE(raw)
}

#' Bryter (samme semantikk som ui_checkbox, annen visning). Fallback: value.
#' `on_change` er kanonisk alias for `rerun` (W5.1) - aliaset vinner naar
#' begge er satt.
ui_switch <- function(label = NULL, value = FALSE, name = NULL, rerun = "self",
                      on_change = NULL, placement = NULL, sync_to = NULL) {
  if (!is.null(on_change)) rerun <- on_change
  key <- .ui_next_key(name)
  default <- isTRUE(value)
  .ui_register(list(type = "switch", name = key, label = label,
                    value = default, rerun = rerun, placement = placement,
                    sync_to = sync_to))
  raw <- .ui_get_value(key)
  if (is.null(raw)) return(default)
  isTRUE(raw)
}

#' Tallfelt. Fallback: value. min/max/step er valgfrie (i motsetning til
#' ui_slider, som krever dem) - speiler pyodide/ui.py sin number()-signatur.
#' `on_change` er kanonisk alias for `rerun` (W5.1) - aliaset vinner naar
#' begge er satt.
ui_number <- function(value = 0, min = NULL, max = NULL, step = NULL,
                      label = NULL, name = NULL, rerun = "self", on_change = NULL,
                      placement = NULL, sync_to = NULL) {
  if (!is.null(on_change)) rerun <- on_change
  key <- .ui_next_key(name)
  default <- value
  .ui_register(list(type = "number", name = key, label = label, min = min,
                    max = max, step = step, value = default, rerun = rerun,
                    placement = placement, sync_to = sync_to))
  raw <- .ui_get_value(key)
  if (is.null(raw)) return(default)
  as.numeric(raw)
}

#' Tekstfelt. Fallback: as.character(value) - returtypen er alltid character
#' (speiler pyodide/ui.py sin text()). `on_change` er kanonisk alias for
#' `rerun` (W5.1) - aliaset vinner naar begge er satt.
ui_text <- function(value = "", label = NULL, name = NULL, rerun = "self",
                    on_change = NULL, placement = NULL, sync_to = NULL) {
  if (!is.null(on_change)) rerun <- on_change
  key <- .ui_next_key(name)
  default <- as.character(value)
  .ui_register(list(type = "text", name = key, label = label,
                    value = default, rerun = rerun, placement = placement,
                    sync_to = sync_to))
  raw <- .ui_get_value(key)
  if (is.null(raw)) return(default)
  as.character(raw)
}

#' Trykknapp. Returnerer alltid usynlig NULL - selve klikket trigger en
#' rerun av målcellen (js/ui.js), ikke en verdi å lese ut (speiler
#' pyodide/ui.py sin button()). `on_click` er kanonisk alias for `rerun`
#' (W5.1) - aliaset vinner naar begge er satt.
ui_button <- function(label, rerun = "self", on_click = NULL, name = NULL,
                      placement = NULL) {
  if (!is.null(on_click)) rerun <- on_click
  key <- .ui_next_key(name)
  .ui_register(list(type = "button", name = key, label = label, rerun = rerun,
                    placement = placement))
  invisible(NULL)
}

#' Avspillings-glidebryter (dash-absorpsjon 5a Task 3, spec §3 - dash sin
#' play()-widget, absorbert): som ui_slider, men med en innebygd play/pause-
#' knapp (js/ui.js sin _buildPlay) som stepper verdien med `step` per
#' `interval` ms, med dash sin EKSAKTE tre-veis timerhygiene (pause-klikk/
#' manuell slider-endring/frakoblet-i-selve-tick-en). `interval` gulves til
#' 200ms (js/ui.js sin normalizeSpec); `loop = TRUE` wrapper til `min` ved
#' `max` i stedet for å stoppe. R-motoren har INGEN payload-byggere (kpi/
#' markdown/image) - dokumentert (spec §3): R-eksemplene bruker plots/
#' tabeller nativt i stedet. Fallback (ingen notatbok/verdi ikke injisert):
#' value hvis gitt, ellers min - samme regel som ui_slider. `on_change` er
#' kanonisk alias for `rerun` (W5.1) - aliaset vinner naar begge er satt.
ui_play <- function(min, max, value = NULL, step = 1, interval = 600,
                    loop = FALSE, label = NULL, name = NULL, rerun = "self",
                    on_change = NULL, placement = NULL, sync_to = NULL) {
  if (!is.null(on_change)) rerun <- on_change
  key <- .ui_next_key(name)
  default <- if (is.null(value)) min else value
  .ui_register(list(type = "play", name = key, label = label, min = min,
                    max = max, step = step, value = default,
                    interval = interval, loop = isTRUE(loop), rerun = rerun,
                    placement = placement, sync_to = sync_to))
  raw <- .ui_get_value(key)
  if (is.null(raw)) return(default)
  as.numeric(raw)
}

#' HTML-elementer. Task 5: Ikke støttet i R-modus ennå - bruk python-modusene.
#' Høflig melding, ikke krasj (spec 2026-07-17).
ui_html <- function(...) {
  stop("ui.html støttes ikke i R ennå — bruk python-modusene (pyodide/brython/micropython)", call. = FALSE)
}

#' Shoelace-komponenter. Task 5: Ikke støttet i R-modus ennå - bruk python-modusene.
#' Høflig melding, ikke krasj (spec 2026-07-17).
ui_sl <- function(...) {
  stop("ui.html støttes ikke i R ennå — bruk python-modusene (pyodide/brython/micropython)", call. = FALSE)
}

#' Pico-komponenter. Task 5: Ikke støttet i R-modus ennå - bruk python-modusene.
#' Høflig melding, ikke krasj (spec 2026-07-17).
ui_pico <- function(...) {
  stop("ui.html støttes ikke i R ennå — bruk python-modusene (pyodide/brython/micropython)", call. = FALSE)
}

#' ui.widget("navn")-håndtak. IKKE støttet i R (dash-absorpsjon 5a Task 2,
#' spec §1): webR kjører R-koden i en egen worker (declare-og-injiser-
#' modellen, se filhodet) - et LEVENDE håndtak (.set()/.on()/.hide()/
#' .element/.input, en direkte referanse til en JS-eid DOM-node/binding)
#' kan strukturelt ikke krysse worker-grensen slik pyodide/brython/
#' micropython sitt synkrone window.Ui-oppslag gjør. Høflig melding, ikke
#' krasj (mirrorer ui_html-notisen over).
ui_widget <- function(...) {
  stop("ui.widget støttes ikke i R — håndtak kan ikke krysse worker-grensen", call. = FALSE)
}

#' Gjeldende verdi for en kontroll. Leser fra det injiserte `.ui_values`-snapshots
#' (satt av index.html FØR cellekjøring); per-kjøring-snapshot, ikke live-oppdatering.
#' Hvis `name` finnes i `.ui_values`, returneres verdien; ellers NULL.
#' Speiler pyodide/ui.py sin ui.value(name), men R-versjonen leser fra preinjisert
#' liste i stedet for synkron JS-spørring (W2 declare-og-injiser-modellen).
ui_value <- function(name) {
  if (!exists(".ui_values", envir = globalenv(), inherits = FALSE)) return(NULL)
  vals <- get(".ui_values", envir = globalenv())
  if (!is.list(vals)) return(NULL)
  vals[[name]]
}

# ---- grensesnittet index.html bruker (post-run, speiler .dash_registry_json) ----

# Returner registeret som et JSON-ARRAY av specs og TØM det (neste kjørings
# `.ui_begin()` nullstiller det uansett også, men å tømme HER - rett etter
# lesing - er selve kontrakten index.html sin runNotebookRCell forventer,
# nøyaktig som webr/dash.R sin `.dash_registry_json()`). MÅ returnere "[]",
# ikke "{}", når registeret er tomt - jsonlite::toJSON av en tom, unavngitt
# liste er tvetydig og gir "{}" som default (samme fallgruve som
# .dash_registry_json() unngår ved alltid å pakke inn i et navngitt objekt -
# her er selve toppnivå-verdien pr. kontrakt et array, så vi må gi det
# spesialtilfellet eksplisitt).
.ui_registry_json <- function() {
  reg <- .ui$registry
  .ui$registry <- list()
  if (length(reg) == 0) return("[]")
  as.character(jsonlite::toJSON(reg, auto_unbox = TRUE, na = "null",
                                null = "null", digits = NA))
}
