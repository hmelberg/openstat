/* ipywidgets-bridge.js — ekte ipywidgets i pyodide-notatbøker (spek:
   docs/superpowers/specs/2026-07-15-notebook-widgets-design.md, plan:
   docs/superpowers/plans/2026-07-15-notebook-widgets-w3.md).

   Ren halvdel (øverst): comm-shim-registeret — åpne/rute/lukke bokføring +
   callback-fan-out. Node-testet (tests/js/ipywidgets-bridge.test.js), ingen
   DOM, ingen require()-avhengighet.

   DOM/require-halvdel (nederst): lat, memoisert injeksjon av de pinnede AMD-
   bundlene (require.min.js + @jupyter-widgets/html-manager sin embed-amd.js),
   LiveManager (en ManagerBase-subklasse med ekte _create_comm/_get_comm_info),
   fromKernel-inngangen Python kaller inn på, og render/reset. Kun browser.

   Isolasjonsgaranti (spek): ingen kode delt med js/ui.js — dette er et helt
   annet spor (ekte ipywidgets-protokoll, ikke ui.*-stripe-widgets). Ingenting
   her laster noe før IpwBridge.ensure()/fromKernel() faktisk kalles (gated i
   index.html av regex-sjekken på dokumentkilden — se Task 2). */
(function (global) {
  'use strict';
  var IpwBridge = {};

  // ---------- ren halvdel: comm-shim-register ----------
  // Speiler IClassicComm-kontraktflaten (comm_id/target_name/on_msg/on_close/
  // send/close) uten noen ekte Jupyter-transportkanal: Python-siden kaller
  // rett inn via IpwBridge.fromKernel (DOM-halvdelen under), og shimmen
  // sender tilbake via IpwBridge._toKernel (satt av pyodide/ipw_setup.py,
  // Task 2). Registeret her holder KUN bokføringen for hvilke comm_id-er som
  // er åpne og hvilke on_msg/on_close-lyttere hver har — ingen kjennskap til
  // DOM, require() eller den ekte ManagerBase.
  //
  // Fan-out, ikke bare siste-vinner: on_msg/on_close PUSHER til en liste per
  // comm_id; route()/close() kaller ALLE registrerte lyttere. Ekte
  // WidgetModel registrerer typisk nøyaktig én av hver i konstruktøren, men
  // fan-out gjør registeret robust for flere lyttere på samme comm_id uten
  // en egen spesialkonstruksjon.
  function createRegistry() {
    var shims = {}; // commId -> { targetName, onMsgCbs: [fn], onCloseCbs: [fn] }

    // pending: commId -> [msg, msg, ...] — comm_msg-bufring for race'et der en
    // comm_msg (kernel→frontend) treffer FØR on_msg er registrert for den
    // comm_id-en (Task 3-review carry-over, Task 4 Part 0: ett-celle
    // create-mutate-display, f.eks. `s = w.IntSlider(5); s.value = 2; s` —
    // `s.value = 2` sin comm_msg kan komme mens comm_open-håndteringen
    // fortsatt er inni ensure().then(...) (mikrotask) og FØR
    // handle_comm_open rekker å kalle shim.on_msg). Nøkkelen finnes UANSETT
    // om comm_id er ukjent (open() ikke kjørt ennå) ELLER kjent men uten
    // on_msg-lytter ennå (open() kjørt, handle_comm_open ikke ferdig) — se
    // route() under. Meldinger REPLAYES i rekkefølge FØRSTE gang on_msg
    // registreres for comm_id-en, deretter tømmes køen (se onMsg/_replay
    // under). Uavhengig struktur fra shims — overlever selv om shims[commId]
    // ikke finnes ennå.
    var pending = {};
    var PENDING_CAP = 100; // vern mot ubegrenset minnevekst hvis on_msg aldri kommer

    function open(commId, targetName) {
      if (Object.prototype.hasOwnProperty.call(shims, commId)) {
        console.warn('IpwBridge: comm ' + commId + ' er allerede åpen — erstatter');
      }
      shims[commId] = { targetName: targetName, onMsgCbs: [], onCloseCbs: [] };
      return shims[commId];
    }

    function has(commId) {
      return Object.prototype.hasOwnProperty.call(shims, commId);
    }

    // _replayPending(commId) — kalles av onMsg RETT ETTER en ny on_msg-lytter
    // er lagt til. Leverer eventuelle bufrede meldinger (i rekkefølge) til
    // ALLE nåværende onMsgCbs for comm_id-en (i praksis kun den ene som nettopp
    // registrerte seg — ekte WidgetModel har nøyaktig én on_msg-lytter), så
    // tømmer køen. No-op hvis ingenting er bufret.
    function _replayPending(commId) {
      var queued = pending[commId];
      if (!queued || !queued.length) return;
      delete pending[commId];
      var s = shims[commId];
      if (!s) return; // bør aldri skje (onMsg krever shims[commId] over) — defensivt
      queued.forEach(function (msg) {
        s.onMsgCbs.forEach(function (cb) {
          cb(msg);
        });
      });
    }

    // _bufferMsg(commId, msg) — legger msg bakerst i comm_id-ens kø. Fullt
    // (>= PENDING_CAP) → advar og DROPP denne ene meldingen (køen for øvrig
    // urørt) i stedet for ubegrenset vekst; returnerer false. Ellers push +
    // true.
    function _bufferMsg(commId, msg) {
      if (!pending[commId]) pending[commId] = [];
      var queued = pending[commId];
      if (queued.length >= PENDING_CAP) {
        console.warn('IpwBridge: comm_msg-buffer for ' + commId + ' er full (cap ' +
          PENDING_CAP + ') — melding droppes');
        return false;
      }
      queued.push(msg);
      return true;
    }

    function onMsg(commId, cb) {
      if (!shims[commId]) {
        console.warn('IpwBridge: on_msg registrert for ukjent comm_id: ' + commId);
        return;
      }
      shims[commId].onMsgCbs.push(cb);
      _replayPending(commId);
    }

    function onClose(commId, cb) {
      if (!shims[commId]) {
        console.warn('IpwBridge: on_close registrert for ukjent comm_id: ' + commId);
        return;
      }
      shims[commId].onCloseCbs.push(cb);
    }

    // route(commId, msg) — comm_msg (kernel→frontend). Leverer STRAKS hvis
    // comm_id-en både finnes OG har minst én on_msg-lytter (normalflyten,
    // uendret); ellers (ukjent comm_id ELLER kjent uten lytter ennå) BUFRES
    // meldingen (se _bufferMsg over) i stedet for å advares/droppes — dette
    // ER Task 4 Part 0-fiksen. Returnerer true hvis meldingen ble
    // levert/lagt i køen, false kun ved bufferoverløp (se _bufferMsg).
    function route(commId, msg) {
      var s = shims[commId];
      if (s && s.onMsgCbs.length > 0) {
        s.onMsgCbs.forEach(function (cb) {
          cb(msg);
        });
        return true;
      }
      return _bufferMsg(commId, msg);
    }

    // close(commId, msg) — comm_close (kernel→frontend). comm_id ukjent for
    // shims (aldri åpnet, ELLER kun bufrede comm_msg venter på den) advarer
    // FORTSATT (uendret oppførsel — spek: "keep the unknown-id warn for
    // closes") OG tømmer i tillegg en eventuell bufret kø stille (en lukket
    // comm skal aldri replayes senere).
    function close(commId, msg) {
      var s = shims[commId];
      if (!s) {
        if (pending[commId]) delete pending[commId];
        console.warn('IpwBridge: comm_close for ukjent comm_id: ' + commId);
        return false;
      }
      s.onCloseCbs.forEach(function (cb) {
        cb(msg);
      });
      delete shims[commId];
      if (pending[commId]) delete pending[commId];
      return true;
    }

    function reset() {
      shims = {};
      pending = {};
    }

    function targetOf(commId) {
      return shims[commId] ? shims[commId].targetName : undefined;
    }

    function ids() {
      return Object.keys(shims);
    }

    return {
      open: open,
      has: has,
      onMsg: onMsg,
      onClose: onClose,
      route: route,
      close: close,
      reset: reset,
      targetOf: targetOf,
      ids: ids
    };
  }

  IpwBridge._createRegistry = createRegistry; // fabrikk: friske instanser til testing
  IpwBridge._registry = createRegistry(); // den levende singletonen broen selv bruker

  // _closeAllComms(registry) — brann on_close for HVER åpen comm og tøm
  // registeret (via registry.close, som selv sletter oppføringen). Dette er
  // reset() sin eksplisitte modell-disponering (Task 1-review carry-over):
  // en ekte WidgetModel registrerer _handle_comm_closed som on_close-lytter
  // i konstruktøren sin, så å fyre on_close her får modellen til å rydde
  // seg selv (close(true) — comm_live av, views destrueres) FØR manageren
  // kastes. Meldingsformen ({content: {comm_id, data: {}}}) speiler en ekte
  // kernel-initiert comm_close. Ren og node-testbar (ingen DOM/manager) —
  // dette er den stub-testbare sømmen reset() (DOM-halvdelen) bygger på.
  function closeAllComms(registry) {
    registry.ids().forEach(function (commId) {
      registry.close(commId, { content: { comm_id: commId, data: {} } });
    });
  }

  IpwBridge._closeAllComms = closeAllComms;

  // IpwBridge._toKernel(commId, dataJson, buffers) — Python→JS-dispatch-
  // funksjonen, bundet av pyodide/ipw_setup.py sitt oppsett (Task 2). Satt
  // til null her (ingen Python koblet ennå); shim.send() advarer og dropper
  // meldingen i stedet for å kaste hvis den kalles før oppsettet er klart.
  IpwBridge._toKernel = null;

  global.IpwBridge = IpwBridge;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = IpwBridge;
  }

  // ---------- DOM/require-halvdel (kun browser) ----------
  // Kjøres kun når det finnes et `document` — node:test-suiten for den rene
  // halvdelen over (tests/js/ipywidgets-bridge.test.js) har ingen DOM og skal
  // aldri nå hit.
  if (typeof document !== 'undefined') {
    // Versjonspinner — ÉN plass (spek: "Version pins are law"). Se
    // docs/superpowers/plans/2026-07-15-notebook-widgets-w3.md "Global
    // Constraints" for lockstep-tabellen disse hører til. Verifisert
    // empirisk (curl + sha256, 2026-07-15): begge URL-ene over gir NØYAKTIG
    // disse SRI-hashene — IKKE endre uten å re-verifisere begge deler.
    var REQUIRE_JS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/require.js/2.3.4/require.min.js';
    var REQUIRE_JS_SRI = 'sha256-Ae2Vz/4ePdIu6ZyI/5ZGsYnb+m0JlOmKPjt6XZ9JJkA=';
    var EMBED_AMD_URL = 'https://cdn.jsdelivr.net/npm/@jupyter-widgets/html-manager@1.0.14/dist/embed-amd.js';
    var EMBED_AMD_SRI = 'sha256-wVnYFUr/gmgTB+SmzVXY1d5HFbS034aMlD6CueTCjuA=';

    // _loadPromise: memoiserer KUN nettverksdelen (script-injeksjon +
    // require(['@jupyter-widgets/html-manager'])) → { HTMLManager, LiveManager,
    // requireLoader }. Skilt fra _manager (selve singleton-instansen) slik at
    // reset() (dokumentbytte/økt-restart) kan kaste den GAMLE manager-
    // instansen (med sine _models/views) uten å injisere bundlene på nytt —
    // gjentatt define() av samme AMD-modul-id-er er unødvendig og kan feile.
    var _loadPromise = null;
    var _manager = null;

    function _injectScript(src, integrity) {
      return new Promise(function (resolve, reject) {
        var el = document.createElement('script');
        el.src = src;
        el.integrity = integrity;
        el.crossOrigin = 'anonymous';
        el.async = false;
        el.onload = function () {
          resolve();
        };
        el.onerror = function () {
          reject(new Error('IpwBridge: kunne ikke laste ' + src));
        };
        document.head.appendChild(el);
      });
    }

    function _requireAmd(moduleId) {
      return new Promise(function (resolve, reject) {
        if (typeof global.require !== 'function') {
          reject(new Error('IpwBridge: require() er ikke tilgjengelig etter injeksjon av ' + REQUIRE_JS_URL));
          return;
        }
        try {
          global.require([moduleId], function (mod) {
            resolve(mod);
          }, function (err) {
            reject(err);
          });
        } catch (e) {
          reject(e);
        }
      });
    }

    function _genId() {
      return 'ipw-frontend-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    // Bygger en IClassicComm-lik shim + registrerer den i den rene
    // halvdelens register (samme registerinstans DOM- og pure-halvdelen
    // deler via IpwBridge._registry).
    function _makeShim(commId, targetName) {
      IpwBridge._registry.open(commId, targetName);
      return {
        comm_id: commId,
        target_name: targetName,
        on_msg: function (cb) {
          IpwBridge._registry.onMsg(commId, cb);
        },
        on_close: function (cb) {
          IpwBridge._registry.onClose(commId, cb);
        },
        // frontend → kernel: protokollen kaller send(data, callbacks,
        // metadata, buffers) — se ManagerBase/WidgetModel.send/close i den
        // pinnede html-manager-bundlen.
        send: function (data, callbacks, metadata, buffers) {
          if (typeof IpwBridge._toKernel !== 'function') {
            console.warn('IpwBridge: send() før Python-siden er koblet til (_toKernel mangler) — meldingen droppes for ' + commId);
          } else {
            try {
              IpwBridge._toKernel(commId, JSON.stringify(data || {}), buffers || []);
            } catch (e) {
              console.warn('IpwBridge: send() til kernel feilet for ' + commId, e);
            }
          }
          // Task 3-funn (browser-verifisert): WidgetModel.send_sync_message
          // (i den pinnede html-manager-bundlen) inkrementerer sin egen
          // _pending_msgs FØRST ETTER at comm.send() (denne funksjonen)
          // returnerer (`this.comm.send(...); ...; return this._pending_msgs
          // ++`) — og bufrer (_msg_buffer) ALLE senere endringer helt til
          // callbacks.iopub.status mottar execution_state:"idle". En ekte
          // Jupyter-kjerne sender "idle" naturlig over IOPub-kanalen, alltid
          // ETTER at kjernens (asynkrone, over en ekte sokkel) svar er
          // mottatt av frontend — dvs. garantert etter increment-linjen der.
          // Vi har INGEN slik kanal (synkront funksjonskall) — kalte vi
          // status-callbacken HER (synkront, inni send()), ville den kjøre
          // FØR increment-linjen over i send_sync_message rekker å kjøre
          // (siden send() selv kalles FRA MIDT I den linjen), og dekrementere
          // en verdi som ennå ikke er inkrementert (0 → -1, fanget opp av
          // bibliotekets egen "Pending messages < 0"-konsoll-feil og
          // nullstilt — men nettoresultatet blir likevel _pending_msgs low
          // hengende på 1, PRESIS samme fastlåsing som uten denne fiksen:
          // kun den aller første endringen av en gitt widget når noensinne
          // frem, alt senere bufres stille og går tapt). Utsett derfor til
          // en mikrotask (Promise.resolve().then) — då har increment-linjen
          // GARANTERT kjørt (den er synkron kode rett etter comm.send() i
          // samme funksjon), og dekrementeringen treffer riktig verdi.
          // Uansett utfall over (en feilet send skal ikke blokkere alle
          // senere forsøk for godt).
          if (callbacks && callbacks.iopub && typeof callbacks.iopub.status === 'function') {
            Promise.resolve().then(function () {
              try {
                callbacks.iopub.status({ content: { execution_state: 'idle' } });
              } catch (e) {
                console.warn('IpwBridge: syntetisk iopub-status feilet for ' + commId, e);
              }
            });
          }
        },
        open: function () {
          // no-op: shimmen regnes som åpen fra konstruksjon (kernel-initiert
          // åpning har allerede skjedd før _makeShim kalles; frontend-
          // initiert åpning, se LiveManager._create_comm, kaller aldri
          // denne — den varsler Python direkte).
        },
        close: function (data, callbacks, metadata, buffers) {
          IpwBridge._registry.close(commId, { content: { data: data || {} }, buffers: buffers || [] });
        }
      };
    }

    function _toDataViews(buffersArr) {
      if (!buffersArr) return [];
      return Array.prototype.map.call(buffersArr, function (b) {
        if (typeof DataView !== 'undefined' && b instanceof DataView) return b;
        if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) return new DataView(b);
        if (b && b.buffer instanceof ArrayBuffer) return new DataView(b.buffer, b.byteOffset || 0, b.byteLength);
        return b;
      });
    }

    function _buildLiveManager(HTMLManager) {
      // HTMLManager er en ekte (native) ES6-klasse i den pinnede bundlen —
      // subklassing MÅ bruke ekte `class...extends` (prototype-patching med
      // .call(this,...) feiler for native klasser: "Class constructor cannot
      // be invoked without 'new'"). Dette er den ene bevisste unntaket fra
      // ui.js sin ES5/var-stil i denne filen.
      class LiveManager extends HTMLManager {
        // Frontend-initiert comm (sjelden i v1 — stock-kontroller åpner
        // alltid fra Python-siden). Implementert minimalt: registrer shim,
        // varsle Python-siden hvis koblet, ellers advar og fortsett (aldri
        // kaste — en feilet frontend-comm skal ikke ta ned resten av broen).
        _create_comm(targetName, modelId, data, metadata, buffers) {
          var commId = modelId || _genId();
          var shim = _makeShim(commId, targetName);
          if (typeof IpwBridge._toKernelOpen === 'function') {
            try {
              IpwBridge._toKernelOpen(commId, targetName, JSON.stringify(data || {}), JSON.stringify(metadata || {}));
            } catch (e) {
              console.warn('IpwBridge: _create_comm-varsling til kernel feilet for ' + commId, e);
            }
          } else {
            console.warn('IpwBridge: frontend-initiert comm (' + commId + ') men ingen _toKernelOpen er koblet — kernel varsles ikke');
          }
          return Promise.resolve(shim);
        }

        // Vi kaller aldri restoreWidgets() (spek: ingen forhåndseksisterende
        // widgets ved sideinnlasting) — tom info holder.
        _get_comm_info() {
          return Promise.resolve({});
        }
      }
      return LiveManager;
    }

    // IpwBridge.ensure() → Promise<manager>. Memoisert nettverkslast +
    // gjenbrukt singleton-manager (bygget på nytt kun etter reset()).
    IpwBridge.ensure = function () {
      if (!_loadPromise) {
        _loadPromise = _injectScript(REQUIRE_JS_URL, REQUIRE_JS_SRI)
          .then(function () {
            return _injectScript(EMBED_AMD_URL, EMBED_AMD_SRI);
          })
          .then(function () {
            return _requireAmd('@jupyter-widgets/html-manager');
          })
          .then(function (mod) {
            if (!mod || typeof mod.HTMLManager !== 'function') {
              throw new Error('IpwBridge: @jupyter-widgets/html-manager eksporterte ikke HTMLManager');
            }
            return {
              LiveManager: _buildLiveManager(mod.HTMLManager),
              requireLoader: typeof mod.requireLoader === 'function' ? mod.requireLoader : null
            };
          })
          .catch(function (err) {
            _loadPromise = null; // la et senere forsøk prøve nettverkslasten på nytt
            console.warn('IpwBridge: ensure() feilet under lasting av bundlene', err);
            throw err;
          });
      }
      return _loadPromise.then(function (built) {
        if (!_manager) {
          var opts = {};
          if (built.requireLoader) {
            opts.loader = built.requireLoader; // best-effort CDN-lasting av tredjeparts kontroll-AMD-moduler, på som standard
          }
          _manager = new built.LiveManager(opts);
        }
        return _manager;
      });
    };

    // fromKernel(msgType, contentJson, metadataJson, buffersArr) — kalt AV
    // PYTHON (pyodide/ipw_setup.py sin _ipw_dispatch, Task 2) for hver
    // comm_open/comm_msg/comm_close som treffer comm-target `jupyter.widget`.
    IpwBridge.fromKernel = function (msgType, contentJson, metadataJson, buffersArr) {
      var content;
      var metadata;
      try {
        content = contentJson ? JSON.parse(contentJson) : {};
        metadata = metadataJson ? JSON.parse(metadataJson) : {};
      } catch (e) {
        console.warn('IpwBridge: fromKernel fikk ugyldig JSON', e);
        return;
      }
      var buffers = _toDataViews(buffersArr);

      if (msgType === 'comm_open') {
        var commId = content.comm_id;
        if (!commId) {
          console.warn('IpwBridge: comm_open uten comm_id — ignorerer');
          return;
        }
        IpwBridge.ensure().then(function (manager) {
          var shim = _makeShim(commId, content.target_name);
          return manager.handle_comm_open(shim, { content: content, metadata: metadata, buffers: buffers });
        }).catch(function (err) {
          console.warn('IpwBridge: handle_comm_open feilet for ' + commId, err);
        });
      } else if (msgType === 'comm_msg') {
        IpwBridge._registry.route(content.comm_id, { content: content, buffers: buffers });
      } else if (msgType === 'comm_close') {
        IpwBridge._registry.close(content.comm_id, { content: content, buffers: buffers });
      } else {
        console.warn('IpwBridge: ukjent msgType fra kernel: ' + msgType);
      }
    };

    // renderView(modelId, el) → Promise. get_model → create_view →
    // display_view; ukjent modell/feil → vennlig feiltekst i el (aldri kast
    // — dette kalles fra visningsstien for en celle, en feilende widget skal
    // ikke ta ned resten av notatboken).
    IpwBridge.renderView = function (modelId, el) {
      return IpwBridge.ensure().then(function (manager) {
        var modelPromise = manager.get_model(modelId);
        if (!modelPromise) {
          el.textContent = 'ipywidget: ukjent modell ' + modelId;
          return;
        }
        return modelPromise
          .then(function (model) {
            return manager.create_view(model);
          })
          .then(function (view) {
            return manager.display_view(view, el);
          })
          .catch(function (err) {
            console.warn('IpwBridge: renderView feilet for ' + modelId, err);
            el.textContent = 'ipywidget: kunne ikke vise ' + modelId;
          });
      }).catch(function (err) {
        console.warn('IpwBridge: renderView — broen kunne ikke lastes', err);
        el.textContent = 'ipywidget: broen kunne ikke lastes';
      });
    };

    // reset() — dokumentbytte/økt-restart (mdNotebookSession restart/
    // invalidate, Cells.contentLoaded — se Task 2). Tre trinn (Task 1-review
    // carry-over: eksplisitt disponering, ikke bare null-setting):
    //   (1) _closeAllComms (den rene, node-testede sømmen over): fyr
    //       on_close for hver åpen comm — ekte WidgetModel-er rydder seg
    //       selv (close(true): comm_live av, views destrueres) og
    //       registeret tømmes underveis (close sletter oppføringen).
    //   (2) manager-side belte-og-bukser: clear_state() (ManagerBase sin
    //       egen walk-alle-modeller-og-close — async, fire-and-forget med
    //       .catch) hvis den finnes; ellers get_model(id).close(true) for
    //       id-ene som VAR åpne (fanget før trinn 1). Modeller som alt
    //       lukket seg i trinn 1 er idempotente (close returnerer cached
    //       promise; comm_live er alt av, så ingen ny shim.close-runde).
    //   (3) registry.reset() som sikkerhetsnett + _manager = null, slik at
    //       gamle model_id-er fra en død økt aldri kan route'es eller
    //       renderes ved et uhell (neste ensure() bygger en frisk manager).
    // Nettverkslasten (_loadPromise) beholdes — bundlene er allerede lastet
    // og gjentatt define() av samme AMD-modul-id-er er unødvendig/fragilt.
    IpwBridge.reset = function () {
      var mgr = _manager;
      _manager = null;
      var staleIds = IpwBridge._registry.ids();
      try {
        IpwBridge._closeAllComms(IpwBridge._registry);
      } catch (e) {
        console.warn('IpwBridge: reset — comm-lukking feilet', e);
      }
      if (mgr) {
        try {
          if (typeof mgr.clear_state === 'function') {
            var p = mgr.clear_state();
            if (p && typeof p.catch === 'function') {
              p.catch(function (e) {
                console.warn('IpwBridge: reset — clear_state feilet', e);
              });
            }
          } else if (typeof mgr.get_model === 'function') {
            staleIds.forEach(function (id) {
              var mp = mgr.get_model(id);
              if (mp && typeof mp.then === 'function') {
                mp.then(function (m) {
                  if (m && typeof m.close === 'function') m.close(true);
                }).catch(function (e) {
                  console.warn('IpwBridge: reset — modell-lukking feilet for ' + id, e);
                });
              }
            });
          }
        } catch (e) {
          console.warn('IpwBridge: reset — manager-opprydding feilet', e);
        }
      }
      IpwBridge._registry.reset();
    };
  }
})(typeof window !== 'undefined' ? window : global);
