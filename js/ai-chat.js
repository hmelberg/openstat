    /* ===================================================================
       AI assistant — sidebar wiring + API calls
       =================================================================== */
    (function aiModule() {
      var T = window.t || function (s, p) { return p ? s.replace(/\{(\w+)\}/g, function (m, k) { return k in p ? p[k] : m; }) : s; };
      // BYOK-nøkkelen bor i det felles nøkkellageret (js/keys.js, type 'anthropic').

      // key(<literal>) i scriptet er en hemmelighet — maskeres før scriptet
      // sendes til AI-endepunkter (spec 2026-07-05 §5). key(ask) beholdes.
      function scrubScript(s) {
        return (window.DataDirectives && window.DataDirectives.scrubKeys)
          ? window.DataDirectives.scrubKeys(s || '') : (s || '');
      }

      const state = {
        sending: false,
        history: [],   // {role, html|text, raw}
        get anthropicKey() { return (window.Keys && window.Keys.get('anthropic')) || ''; },
      };

      // Web mode requires a user-supplied Anthropic key (BYOK — the agentic
      // search then runs on the user's own account), and only makes sense in
      // python/r/duckdb editor modes (no `# connect`/`# load` story for
      // microdata). Surfaced only via its own send button
      // (syncWebBtnVisibility() shows/hides #aiSendWebBtn).
      function webModeEligible() {
        const hasByok = !!state.anthropicKey;
        const mode = (typeof activeEditorMode !== 'undefined' && activeEditorMode) ? activeEditorMode : 'microdata';
        return hasByok && (mode === 'python' || mode === 'r' || mode === 'duckdb');
      }

      const md = (window.markdownit ? window.markdownit({ breaks: true, linkify: true }) : null);

      const $ = (id) => document.getElementById(id);
      const dom = {};
      function cacheDom() {
        ['aiToggleBtn','aiSidebar','aiCloseBtn','aiSettingsBtn','aiClearBtn',
         'aiThread','aiInput','aiSendFastBtn','aiSendV2Btn','aiSendWebBtn','aiAbortBtn',
         'aiIncludeScript',
         'aiSettingsBackdrop','aiCfgAnthropicKey','aiCfgSave','aiCfgCancel',
         'aiCfgByokStored','aiCfgByokRemove','aiCfgSourceKeys',
         'aiCfgProviderType','aiCfgProviderFields','aiCfgProviderUrl','aiCfgProviderModel','aiCfgLlmKey',
         'sidebarRight','sidebarOpenTab','scriptInput'
        ].forEach(id => { dom[id] = $(id); });
        dom.containers = document.querySelectorAll('.container');
      }

      function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
          '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        }[c]));
      }

      function setOpen(open) {
        if (open) {
          // Mutually exclusive with Datasett sidebar
          if (dom.sidebarRight && !dom.sidebarRight.classList.contains('collapsed')) {
            dom.sidebarRight.classList.add('collapsed');
            dom.containers.forEach(c => c.classList.remove('sidebar-open'));
          }
          // Always make sure the Datasett open-tab is reachable; the original
          // code uses a `.hidden` class to hide it while Datasett is open.
          if (dom.sidebarOpenTab) dom.sidebarOpenTab.classList.remove('hidden');
          dom.aiSidebar.classList.add('open');
          dom.aiSidebar.setAttribute('aria-hidden', 'false');
          dom.containers.forEach(c => c.classList.add('ai-open'));
          dom.aiToggleBtn.classList.add('active');
          if (state.history.length === 0) renderEmpty();
          setTimeout(() => dom.aiInput.focus(), 60);
        } else {
          dom.aiSidebar.classList.remove('open');
          dom.aiSidebar.setAttribute('aria-hidden', 'true');
          dom.containers.forEach(c => c.classList.remove('ai-open'));
          dom.aiToggleBtn.classList.remove('active');
          // Make sure the Datasett tab is reachable after the AI panel goes away.
          if (dom.sidebarOpenTab && dom.sidebarRight && dom.sidebarRight.classList.contains('collapsed')) {
            dom.sidebarOpenTab.classList.remove('hidden');
          }
        }
      }
      function toggleOpen() { setOpen(!dom.aiSidebar.classList.contains('open')); }

      function renderEmpty() {
        dom.aiThread.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'ai-empty';
        wrap.innerHTML = '<div class="ai-empty-title">' + T('Hei! Hva kan jeg hjelpe med?') + '</div>' +
          '<div>' + T('Spør om en analyse, et skript, eller hva en kommando gjør.') + '</div>' +
          '<div class="ai-empty-examples">' +
            '<button type="button" class="ai-empty-example" data-q="' + T('Vis sammendragsstatistikk for inntekt og kjønn') + '">' + T('Vis sammendragsstatistikk for inntekt og kjønn') + '</button>' +
            '<button type="button" class="ai-empty-example" data-q="What does reshape long do?">What does reshape long do?</button>' +
            '<button type="button" class="ai-empty-example" data-q="' + T('Hvilke variabler finnes for utdanning?') + '">' + T('Hvilke variabler finnes for utdanning?') + '</button>' +
          '</div>';
        dom.aiThread.appendChild(wrap);
        wrap.querySelectorAll('.ai-empty-example').forEach(btn => {
          btn.addEventListener('click', () => {
            dom.aiInput.value = btn.dataset.q;
            autoresize();
            sendMessage();
          });
        });
      }

      function appendUserMessage(text) {
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg ai-msg-user';
        wrap.innerHTML = '<div class="ai-bubble"></div>';
        wrap.querySelector('.ai-bubble').textContent = text;
        dom.aiThread.appendChild(wrap);
        scrollToBottom();
      }

      function appendThinking() {
        const wrap = document.createElement('div');
        wrap.className = 'ai-msg ai-msg-assistant';
        wrap.innerHTML = '<div class="ai-thinking"><span class="ai-thinking-dot"></span><span class="ai-thinking-dot"></span><span class="ai-thinking-dot"></span><span style="margin-left:4px">' + T('Tenker…') + '</span></div>';
        dom.aiThread.appendChild(wrap);
        scrollToBottom();
        return wrap;
      }

      function appendError(node, msg) {
        node.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'ai-error';
        err.textContent = msg;
        node.appendChild(err);
        scrollToBottom();
      }

      function appendAssistantText(node, text, meta) {
        node.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        bubble.innerHTML = md ? md.render(text || '') : escapeHtml(text || '').replace(/\n/g, '<br>');
        bubble._rawMd = text || '';
        node.appendChild(bubble);
        if (meta) appendMeta(node, meta);
        attachCodeBlockActions(bubble);
        attachResponseInsertBar(node, text || '');
        scrollToBottom();
      }

      function appendAssistantScript(node, script, rationale, meta) {
        node.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        if (rationale) {
          const rationaleHtml = md ? md.render(rationale) : '<p>' + escapeHtml(rationale) + '</p>';
          bubble.innerHTML += rationaleHtml;
        }
        // Custom code-block markup with action buttons
        const cbWrap = document.createElement('div');
        cbWrap.className = 'ai-codeblock-wrap';
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = script;
        pre.appendChild(code);
        cbWrap.appendChild(pre);
        const actions = document.createElement('div');
        actions.className = 'ai-codeblock-actions';
        actions.innerHTML =
          '<button type="button" class="ai-codeblock-btn" data-act="copy">📋 ' + T('Kopier') + '</button>';
        cbWrap.appendChild(actions);
        bubble.appendChild(cbWrap);
        actions.addEventListener('click', (e) => {
          const btn = e.target.closest('.ai-codeblock-btn');
          if (!btn) return;
          handleCodeAction(btn.dataset.act, script, btn);
        });
        // Validation warnings (unknown variables / commands / parse errors)
        const warning = renderValidationWarnings(meta && meta.validation);
        if (warning) bubble.appendChild(warning);
        node.appendChild(bubble);
        if (meta) appendMeta(node, meta);
        // Response-level "Sett inn" bar (synthesize markdown from rationale + code)
        const rawMd = (rationale ? rationale + '\n\n' : '') + '```microdata\n' + script + '\n```';
        bubble._rawMd = rawMd;
        attachResponseInsertBar(node, rawMd);
        scrollToBottom();
      }

      function renderValidationWarnings(validation) {
        if (!validation || validation.passed || !validation.errors || !validation.errors.length) {
          return null;
        }
        const wrap = document.createElement('div');
        wrap.className = 'ai-validation-warning';
        const title = document.createElement('div');
        title.className = 'ai-validation-warning-title';
        title.textContent = T('⚠ Valideringsadvarsler');
        wrap.appendChild(title);

        const groups = { unknown_variable: [], unknown_command: [], parse: [], runtime: [], other: [] };
        for (const e of validation.errors) {
          const k = e.kind in groups ? e.kind : 'other';
          groups[k].push(e);
        }

        const renderChips = (label, errs, suggestionTemplate) => {
          if (!errs.length) return;
          const sec = document.createElement('div');
          sec.className = 'ai-validation-section';
          const lab = document.createElement('div');
          lab.className = 'ai-validation-section-label';
          lab.textContent = label;
          sec.appendChild(lab);
          const chips = document.createElement('div');
          chips.className = 'ai-validation-chips';
          errs.forEach(e => {
            const chip = document.createElement('span');
            chip.className = 'ai-chip';
            chip.textContent = e.token || e.message || '?';
            chip.title = T('{msg} — klikk for å foreslå alternativ', { msg: e.message || '' });
            chip.addEventListener('click', () => {
              if (!dom.aiInput) return;
              dom.aiInput.value = suggestionTemplate.replace('{token}', e.token || '');
              autoresize();
              dom.aiInput.focus();
            });
            chips.appendChild(chip);
          });
          sec.appendChild(chips);
          wrap.appendChild(sec);
        };

        renderChips(T('Ukjente variabler'), groups.unknown_variable, T('Bruk en annen variabel for {token}'));
        renderChips(T('Ukjente kommandoer'), groups.unknown_command, T('Skriv om uten å bruke {token}'));

        const others = [...groups.parse, ...groups.runtime, ...groups.other];
        if (others.length) {
          const sec = document.createElement('div');
          sec.className = 'ai-validation-section';
          const lab = document.createElement('div');
          lab.className = 'ai-validation-section-label';
          lab.textContent = T('Andre advarsler');
          sec.appendChild(lab);
          const ul = document.createElement('ul');
          ul.className = 'ai-validation-bullets';
          others.forEach(e => {
            const li = document.createElement('li');
            const lineHint = e.line_no ? T('linje {n}: ', { n: e.line_no }) : '';
            li.textContent = lineHint + (e.message || e.kind);
            ul.appendChild(li);
          });
          sec.appendChild(ul);
          wrap.appendChild(sec);
        }

        return wrap;
      }

      function appendAssistantVariableList(node, variables, meta) {
        node.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        if (!variables || !variables.length) {
          bubble.textContent = T('Ingen variabler funnet.');
        } else {
          const intro = document.createElement('p');
          intro.textContent = T('Fant {n} variabler:', { n: variables.length });
          bubble.appendChild(intro);
          const list = document.createElement('ul');
          list.style.margin = '0'; list.style.paddingLeft = '18px';
          variables.forEach(v => {
            const li = document.createElement('li');
            li.style.marginBottom = '4px';
            li.innerHTML = '<code>' + escapeHtml(v.name) + '</code> — ' + escapeHtml(v.short_title || '');
            list.appendChild(li);
          });
          bubble.appendChild(list);
        }
        node.appendChild(bubble);
        if (meta) appendMeta(node, meta);
        scrollToBottom();
      }

      function appendMeta(node, meta) {
        // Meta-linja (intent · modell · tid · tokens · cache) er støy for brukeren — vises ikke.
      }

      function commentize(text) {
        return String(text).split('\n').map(l => '// ' + l).join('\n');
      }

      // Build editor content from a full markdown response, preserving document
      // order ("legg de etter hverandre"). includeComments=false → only the code
      // blocks; true → prose rendered as // comments interleaved with the code.
      function buildInsertContent(rawMd, includeComments) {
        if (!rawMd) return '';
        const re = /```[^\n]*\r?\n([\s\S]*?)```/g;
        const parts = [];
        let last = 0, m;
        while ((m = re.exec(rawMd)) !== null) {
          if (includeComments) {
            const prose = rawMd.slice(last, m.index).trim();
            if (prose) parts.push(commentize(prose));
          }
          const code = (m[1] || '').replace(/\s+$/, '');
          if (code.trim()) parts.push(code);
          last = re.lastIndex;
        }
        if (includeComments) {
          const tail = rawMd.slice(last).trim();
          if (tail) parts.push(commentize(tail));
        }
        // No fenced code at all: comment the whole thing when asked, else nothing.
        if (parts.length === 0 && includeComments) {
          const all = rawMd.trim();
          if (all) parts.push(commentize(all));
        }
        return parts.join('\n\n');
      }

      function hasCodeBlock(rawMd) {
        return !!rawMd && /```[\s\S]*?```/.test(rawMd);
      }

      // Response-level action bar shown under the whole answer: an "include
      // explanation as comment" checkbox and a single "Sett inn" button that
      // replaces the editor content.
      function attachResponseInsertBar(node, rawMd) {
        if (!dom.scriptInput || !hasCodeBlock(rawMd)) return;
        const bar = document.createElement('div');
        bar.className = 'ai-response-actions';

        const lbl = document.createElement('label');
        lbl.className = 'ai-include-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' ' + T('Inkluder forklaring som kommentar')));

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-response-insert-btn';
        btn.textContent = T('Sett inn');
        btn.title = T('Sett svaret inn i editoren (erstatter innholdet)');
        btn.addEventListener('click', () => {
          const content = buildInsertContent(rawMd, cb.checked);
          if (!content) return;
          dom.scriptInput.value = content;
          dom.scriptInput.dispatchEvent(new Event('input', { bubbles: true }));
          flash(btn, T('✓ Satt inn'));
        });

        // Knapp før checkbox (horisontalt).
        bar.appendChild(btn);
        bar.appendChild(lbl);
        node.appendChild(bar);
      }

      function handleCodeAction(act, script, btn) {
        if (act === 'copy') {
          navigator.clipboard.writeText(script).then(() => flash(btn, T('✓ Kopiert')));
        }
      }

      function flash(btn, label) {
        const original = btn.textContent;
        btn.textContent = label;
        btn.classList.add('flash');
        setTimeout(() => { btn.textContent = original; btn.classList.remove('flash'); }, 1200);
      }

      function attachCodeBlockActions(bubble) {
        // For markdown-rendered code blocks, attach a small copy button
        bubble.querySelectorAll('pre').forEach(pre => {
          if (pre.parentElement.classList.contains('ai-codeblock-wrap')) return;
          const codeEl = pre.querySelector('code') || pre;
          const text = codeEl.textContent;
          if (!text || text.length < 12) return;
          const wrap = document.createElement('div');
          wrap.className = 'ai-codeblock-wrap';
          pre.parentElement.insertBefore(wrap, pre);
          wrap.appendChild(pre);
          const actions = document.createElement('div');
          actions.className = 'ai-codeblock-actions';
          actions.innerHTML =
            '<button type="button" class="ai-codeblock-btn" data-act="copy">📋 ' + T('Kopier') + '</button>';
          wrap.appendChild(actions);
          actions.addEventListener('click', (e) => {
            const btn = e.target.closest('.ai-codeblock-btn');
            if (!btn) return;
            handleCodeAction(btn.dataset.act, text, btn);
          });
        });
      }

      function scrollToBottom() {
        dom.aiThread.scrollTop = dom.aiThread.scrollHeight;
      }

      // Headers for edge-funksjonene (/api/*): kun BYOK Anthropic-nøkkel.
      function edgeAuthHeaders() {
        if (state.anthropicKey) return { 'X-Anthropic-Key': state.anthropicKey, 'Content-Type': 'application/json' };
        return { 'Content-Type': 'application/json' };
      }

      function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

      function detectLang(text) {
        // Crude: if it has Norwegian chars or common NO words, treat as 'no', else 'en'.
        if (/[æøåÆØÅ]/.test(text)) return 'no';
        const noWords = /\b(hva|hvordan|kjør|skript|gjør|finnes|vis|inntekt|kjønn|kommune|alder)\b/i;
        if (noWords.test(text)) return 'no';
        const enWords = /\b(what|how|show|run|script|does|find|income|gender|age)\b/i;
        if (enWords.test(text)) return 'en';
        return (window.M2PY_LANG === 'en') ? 'en' : 'no';
      }

      async function sendMessage(useV2) {
        if (state.sending) return;
        const text = dom.aiInput.value.trim();
        if (!text) return;
        // Gate on BYOK: no Anthropic key configured yet → open Settings to add one.
        if (!state.anthropicKey) {
          openSettings();
          return;
        }
        state.sending = true;
        if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = true;
        if (dom.aiSendWebBtn) dom.aiSendWebBtn.disabled = true;

        // Clear empty state on first message
        if (state.history.length === 0) dom.aiThread.innerHTML = '';

        appendUserMessage(text);
        state.history.push({ role: 'user', text });
        dom.aiInput.value = '';
        autoresize();

        const thinkingNode = appendThinking();
        const lang = detectLang(text);

        const includeScript = dom.aiIncludeScript.checked && dom.scriptInput && dom.scriptInput.value.trim();

        // Single-shot, no-repair edge function. Streams markdown; the result
        // is validated locally via Pyodide+m2py (see runFastQuery).
        const ctrl = new AbortController();
        state.abortCtrl = ctrl;
        if (dom.aiAbortBtn) dom.aiAbortBtn.style.display = '';
        try {
          const meta = useV2
            ? await runFastQueryV2(text, lang, includeScript ? scrubScript(dom.scriptInput.value) : '', thinkingNode, ctrl.signal)
            : await runFastQuery(text, lang, includeScript ? scrubScript(dom.scriptInput.value) : '', thinkingNode, ctrl.signal);
          state.history.push({ role: 'assistant', meta });
        } catch (e) {
          if (e.name !== 'AbortError') appendError(thinkingNode, '✗ ' + e.message);
        } finally {
          state.abortCtrl = null;
          if (dom.aiAbortBtn) dom.aiAbortBtn.style.display = 'none';
          state.sending = false;
          if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = false;
          if (dom.aiSendWebBtn) dom.aiSendWebBtn.disabled = false;
          dom.aiInput.focus();
        }
      }

      // ── Fast path: stream from the /api/kode-svar edge function (single-shot,
      //    no repair), render markdown live, then validate the emitted script
      //    locally in Pyodide+m2py and show a pass/⚠ badge. Returns meta.
      // Render markdown inn i boblen under streaming (faller tilbake til ren
      // tekst hvis markdown-it mangler eller parsing feiler på ufullstendig md).
      function streamRenderMd(bubble, textMd) {
        if (md) {
          try { bubble.innerHTML = md.render(textMd || ''); return; }
          catch (_) { /* fall through */ }
        }
        bubble.textContent = textMd || '';
      }

      async function runFastQuery(text, lang, scriptContext, thinkingNode, signal) {
        const headers = edgeAuthHeaders();
        const t0 = Date.now();
        const resp = await fetch('/api/kode-svar', {
          method: 'POST',
          headers,
          body: JSON.stringify({ question: text, lang, script: scriptContext || '' }),
          signal,
        });
        if (resp.status === 401) {
          throw new Error(T('Ugyldig Anthropic-nøkkel. Sjekk nøkkelen i AI-innstillingene.'));
        }
        if (!resp.ok || !resp.body) {
          throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        }

        // Render incrementally into an assistant bubble.
        thinkingNode.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        thinkingNode.appendChild(bubble);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let _lastRender = 0;
        let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = event.split('\n').find(l => l.startsWith('data:'));
            if (!dataLine) continue;
            let obj;
            try { obj = JSON.parse(dataLine.slice(5).trim()); }
            catch (_) { continue; }   // ignore non-JSON keep-alive lines
            if (obj.type === 'text') {
              accumulated += obj.text;
              // Render markdown live (lett strupet) i stedet for rå tekst.
              const _now = Date.now();
              if (_now - _lastRender > 70) {
                _lastRender = _now;
                streamRenderMd(bubble, accumulated);
                scrollToBottom();
              }
            } else if (obj.type === 'done') {
              inputTokens = obj.inputTokens || 0;
              outputTokens = obj.outputTokens || 0;
              cacheRead = obj.cacheReadTokens || 0;
              cacheCreate = obj.cacheCreationTokens || 0;
            } else if (obj.type === 'error') {
              throw new Error(obj.message || T('Ukjent feil fra server'));
            }
          }
        }

        // Final markdown render + code-block action buttons (reuse existing).
        if (md) {
          try { bubble.innerHTML = md.render(accumulated || ''); }
          catch (_) { bubble.textContent = accumulated; }
        } else {
          bubble.textContent = accumulated;
        }
        attachCodeBlockActions(bubble);
        bubble._rawMd = accumulated;

        const meta = {
          intent: 'raskt',
          model: 'kode-svar',
          latency_ms: Date.now() - t0,
          tokens: { input: inputTokens, output: outputTokens, cacheRead, cacheCreate },
        };
        appendMeta(thinkingNode, meta);
        attachResponseInsertBar(thinkingNode, accumulated);

        // Valider første microdata-kodeblokk lokalt (ikke-blokkerende).
        // Vi viser ingen «validert»-tekst ved suksess (støy) — kun advarsler ved feil.
        const script = extractFirstMicrodataBlock(accumulated);
        if (script) {
          validateMicrodataLocal(script).then(vr => {
            if (vr.skipped || vr.passed) return;
            const warn = renderValidationWarnings(vr);
            if (warn) bubble.appendChild(warn);
          }).catch(() => {});
        }
        return meta;
      }

      // One streaming request to /api/kode-svar-v2. Renders markdown live into
      // `bubble`. Returns { accumulated, tokens }. Mirrors runFastQuery's stream
      // parsing; factored out so the repair round can call it again.
      async function streamKodeSvarV2(payload, bubble, signal) {
        const headers = edgeAuthHeaders();
        const resp = await fetch('/api/kode-svar-v2', {
          method: 'POST', headers, body: JSON.stringify(payload), signal,
        });
        if (resp.status === 401) {
          throw new Error(T('Ugyldig Anthropic-nøkkel. Sjekk nøkkelen i AI-innstillingene.'));
        }
        if (!resp.ok || !resp.body) {
          throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', accumulated = '', _lastRender = 0;
        let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0;
        let firstByte = false;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = event.split('\n').find(l => l.startsWith('data:'));
            if (!dataLine) continue;
            let obj;
            try { obj = JSON.parse(dataLine.slice(5).trim()); } catch (_) { continue; }
            if (obj.type === 'text') {
              if (!firstByte) { firstByte = true; bubble.textContent = ''; }
              accumulated += obj.text;
              const _now = Date.now();
              if (_now - _lastRender > 70) {
                _lastRender = _now;
                streamRenderMd(bubble, accumulated);
                scrollToBottom();
              }
            } else if (obj.type === 'done') {
              inputTokens = obj.inputTokens || 0;
              outputTokens = obj.outputTokens || 0;
              cacheRead = obj.cacheReadTokens || 0;
              cacheCreate = obj.cacheCreationTokens || 0;
            } else if (obj.type === 'error') {
              throw new Error(obj.message || T('Ukjent feil fra server'));
            }
          }
        }
        return { accumulated, tokens: { input: inputTokens, output: outputTokens, cacheRead, cacheCreate } };
      }

      // Concatenate all fenced code-block bodies (any language) so name-grounding
      // can scan the #micro import inside a python/r answer without prose noise.
      function extractAllCode(md) {
        if (!md) return '';
        const re = /```\w*\s*\n([\s\S]*?)```/g;
        let m, out = [];
        while ((m = re.exec(md)) !== null) out.push(m[1]);
        return out.join('\n');
      }

      // Generalizes extractFirstMicrodataBlock's fence-scanning for a single,
      // explicitly-tagged language (used by the python/r nivå 1-validatorer,
      // see docs/ROADMAP.md §AI-assistenten). Unlike extractFirstMicrodataBlock
      // (which sniffs untagged fences for microdata-looking syntax),
      // kode-svar-v2's python/r svarformat ALWAYS tags its one code fence with
      // the language (see netlify/edge-functions/kode-svar.ts OUTPUT_PY/OUTPUT_R)
      // — so a plain tag match is enough, no sniffing needed.
      const CODE_FENCE_LANGS = { python: ['python', 'py'], r: ['r'] };
      function extractFirstCodeBlock(textMd, lang) {
        if (!textMd) return '';
        const wanted = CODE_FENCE_LANGS[lang] || [lang];
        const re = /```(\w*)\s*\n([\s\S]*?)```/g;
        let m;
        while ((m = re.exec(textMd)) !== null) {
          const l = (m[1] || '').toLowerCase();
          if (wanted.indexOf(l) < 0) continue;
          const body = (m[2] || '').trim();
          if (body) return body;
        }
        return '';
      }

      // Collect db/NAME (or alias/NAME) tokens whose NAME is not in the loaded
      // catalog — the cheapest, most damaging failure (invented variable names).
      function findUnknownVarNames(script) {
        if (!script || typeof microdataVariableNames === 'undefined' || !microdataVariableNames.length) return [];
        const known = new Set(microdataVariableNames);
        const re = /\b[a-zA-Z_]\w*\/([A-Z][A-Z0-9_]+)\b/g;
        const bad = new Set();
        let m;
        while ((m = re.exec(script)) !== null) {
          if (!known.has(m[1])) bad.add(m[1]);
        }
        return Array.from(bad);
      }

      // Turn a validation result + unknown-name list into a compact error string
      // for the repair prompt. Returns '' when there is nothing to fix.
      function buildRepairErrors(vr, unknownNames) {
        const parts = [];
        if (unknownNames && unknownNames.length) {
          parts.push('Ukjente variabelnavn (finnes ikke i katalogen): ' + unknownNames.join(', '));
        }
        if (vr && !vr.skipped && !vr.passed && Array.isArray(vr.errors)) {
          for (const e of vr.errors) {
            const tok = e.token ? (e.token + ': ') : '';
            parts.push('- ' + tok + (e.message || e.kind || 'feil'));
          }
        }
        return parts.join('\n');
      }

      // Nivå 1 auto-retting (docs/ROADMAP.md §AI-assistenten): modus-dispatch
      // for kode-svar-v2-reparasjonssløyfen i runFastQueryV2. Hver oppføring
      // gir (a) extract(mdText) → kandidatscript eller '' (ingen kodeblokk
      // funnet — sløyfen kjører da ikke), (b) validate(script) → Promise som
      // løser til {passed,errors[]} eller {skipped:true}, (c)
      // unknownNames(mdText, script) → liste over ukjente katalog-variabelnavn.
      // microdata-oppføringen kaller EKSAKT de samme funksjonene, i samme
      // rekkefølge, som før refaktoreringen (validateMicrodataLocal/
      // extractFirstMicrodataBlock/findUnknownVarNames er uendret) — dette
      // holder microdata-veien byte-frosset selv om løkka rundt er blitt generisk.
      const _v2Validators = {
        microdata: {
          extract: extractFirstMicrodataBlock,
          validate: validateMicrodataLocal,
          unknownNames: function (_mdText, script) { return findUnknownVarNames(script); },
        },
        // Syntaks-sjekk kjører KUN mot en allerede lastet/lastende Pyodide-økt
        // (validatePythonSyntax under) — den booter aldri en ny 30s-runtime
        // bare for å validere ett AI-svar. Kolonnenavn-sjekk (df["kol"]) er
        // BEVISST utelatt her — se rapporten for begrunnelsen (lastDatasetInfo
        // reflekterer forrige kjørings tilstand, ikke aliasene DENNE
        // kandidatscripten selv definerer i sin egen #micro-blokk, så en sjekk
        // mot den ville gitt falske "ukjent kolonne"-feil på gyldige script).
        // unknownNames scans ONLY the #micro header segment of the candidate
        // script (via extractLangSegment(script, 'microdata') — a plain reuse
        // of the same parseHybridScript segmenter the syntax-checks below use,
        // just asking for the 'microdata' kind instead of 'pyodide'/'r').
        // import/require statements only legally occur there; scanning the
        // whole markdown answer (as extractAllCode(mdText) did before) let
        // ordinary analysis-code tokens like `total/N_OBS` divisions or
        // `"data/GDP.csv"` path strings false-positive as "unknown variables".
        python: {
          extract: function (mdText) { return extractFirstCodeBlock(mdText, 'python'); },
          validate: validatePythonSyntax,
          unknownNames: function (_mdText, script) { return findUnknownVarNames(extractLangSegment(script, 'microdata')); },
        },
        r: {
          extract: function (mdText) { return extractFirstCodeBlock(mdText, 'r'); },
          validate: validateRSyntax,
          unknownNames: function (_mdText, script) { return findUnknownVarNames(extractLangSegment(script, 'microdata')); },
        },
      };

      async function runFastQueryV2(text, lang, scriptContext, thinkingNode, signal) {
        const t0 = Date.now();
        thinkingNode.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        bubble.textContent = T('Finner relevante variabler…');
        thinkingNode.appendChild(bubble);

        const mode = (typeof activeEditorMode !== 'undefined' && activeEditorMode) ? activeEditorMode : 'microdata';
        const payload = { question: text, lang, script: scriptContext || '', mode };
        const { accumulated, tokens } = await streamKodeSvarV2(payload, bubble, signal);

        // Final render + actions (reuse v1 helpers).
        if (md) { try { bubble.innerHTML = md.render(accumulated || ''); } catch (_) { bubble.textContent = accumulated; } }
        else { bubble.textContent = accumulated; }
        attachCodeBlockActions(bubble);
        bubble._rawMd = accumulated;

        const meta = { intent: 'raskt-v2', model: 'kode-svar-v2', latency_ms: Date.now() - t0, tokens };
        appendMeta(thinkingNode, meta);
        attachResponseInsertBar(thinkingNode, accumulated);

        const dispatch = _v2Validators[mode];
        let currentMd = accumulated;
        let script = dispatch ? dispatch.extract(currentMd) : '';
        // python/r whose answer didn't follow the fenced-code svarformat at all
        // (dispatch.extract found no ```python/py/r fence) has nothing to feed
        // the repair loop — route it to the old passive-warning path below
        // instead of silently skipping validation for that answer entirely.
        // mode==='microdata' keeps its pre-refactor behavior: an empty extract
        // there just means "nothing to validate yet" and stays silent.
        const useRepairLoop = dispatch && (script || mode === 'microdata');
        if (useRepairLoop) {
          // Validate; on failure, attempt ONE repair round, then badge.
          // (Generic over mode — see _v2Validators above. For mode==='microdata'
          // this is call-for-call identical to the pre-refactor code.)
          let repaired = false;
          let finalBubble = bubble;
          while (script) {
            let vr;
            try { vr = await dispatch.validate(script); } catch (_) { vr = { skipped: true }; }
            const unknown = dispatch.unknownNames(currentMd, script);
            const hasErrors = (!vr.skipped && !vr.passed) || unknown.length > 0;
            if (!hasErrors || repaired) {
              if (hasErrors) {
                const warn = renderValidationWarnings(
                  vr.skipped ? { passed: false, errors: unknown.map(n => ({ kind: 'unknown_variable', token: n, message: 'finnes ikke i katalogen' })) } : vr
                );
                if (warn) finalBubble.appendChild(warn);
              }
              break;
            }
            // One repair round: new bubble, re-call with prior script + errors.
            repaired = true;
            const note = document.createElement('div');
            note.className = 'ai-thinking';
            note.textContent = T('Retter feil og prøver på nytt…');
            thinkingNode.appendChild(note);
            const repairBubble = document.createElement('div');
            repairBubble.className = 'ai-bubble';
            thinkingNode.appendChild(repairBubble);
            const errStr = buildRepairErrors(vr, unknown);
            let r2;
            try {
              r2 = await streamKodeSvarV2(
                { question: text, lang, script: scriptContext || '', mode, prior_script: script, errors: errStr },
                repairBubble, signal,
              );
            } catch (e) {
              note.remove();
              repairBubble.textContent = '✗ ' + (e && e.message ? e.message : String(e));
              break;
            }
            note.remove();
            if (md) { try { repairBubble.innerHTML = md.render(r2.accumulated || ''); } catch (_) { repairBubble.textContent = r2.accumulated; } }
            else { repairBubble.textContent = r2.accumulated; }
            attachCodeBlockActions(repairBubble);
            repairBubble._rawMd = r2.accumulated;
            attachResponseInsertBar(thinkingNode, r2.accumulated);
            finalBubble = repairBubble;
            meta.tokens.input += r2.tokens.input; meta.tokens.output += r2.tokens.output;
            meta.tokens.cacheRead += r2.tokens.cacheRead; meta.tokens.cacheCreate += r2.tokens.cacheCreate;
            currentMd = r2.accumulated;
            script = dispatch.extract(currentMd);
          }
        } else {
          // Andre moduser uten nivå 1-validator ennå (javascript, duckdb, …) —
          // OG python/r-svar som ikke fulgte svarformatet (dispatch.extract fant
          // ingen ```python/py/r-fence i det hele tatt, f.eks. en ren prosetekst-
          // avvisning): behold den opprinnelige, ikke-reparerende oppførselen
          // uendret — kun en advarsel om ukjente katalogvariabler i svaret.
          // (mode==='microdata' uten treff i extract er UENDRET fra før: den
          // faller IKKE hit — dette er kun nivå 1-reparasjonsløkkas eget stille
          // "ingenting å validere ennå"-tilfelle, samme som pre-refactor.)
          const unknown = findUnknownVarNames(extractAllCode(accumulated));
          if (unknown.length) {
            const warn = renderValidationWarnings({
              passed: false,
              errors: unknown.map(n => ({ kind: 'unknown_variable', token: n, message: 'finnes ikke i katalogen' })),
            });
            if (warn) bubble.appendChild(warn);
          }
        }
        return meta;
      }

      // Tolk resultater: strøm en tolkning av output (kommandoer + resultater)
      // inn i en assistent-boble. Speiler runFastQuery, men mot /api/tolk-resultat.
      async function runInterpretQuery(payload, thinkingNode, signal) {
        const headers = edgeAuthHeaders();
        const resp = await fetch('/api/tolk-resultat', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            script: payload.script || '',
            output: payload.output || '',
            språk: payload.lang || 'auto',
            ui_lang: (window.M2PY_LANG === 'en') ? 'en' : 'no',
          }),
          signal,
        });
        if (resp.status === 401) {
          throw new Error(T('Ugyldig Anthropic-nøkkel. Sjekk nøkkelen i AI-innstillingene.'));
        }
        if (!resp.ok || !resp.body) {
          throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));
        }
        thinkingNode.innerHTML = '';
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        thinkingNode.appendChild(bubble);
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', accumulated = '', _lastRender = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = event.split('\n').find(l => l.startsWith('data:'));
            if (!dataLine) continue;
            let obj;
            try { obj = JSON.parse(dataLine.slice(5).trim()); } catch (_) { continue; }
            if (obj.type === 'text') {
              accumulated += obj.text;
              const _now = Date.now();
              if (_now - _lastRender > 70) {
                _lastRender = _now;
                streamRenderMd(bubble, accumulated);
                scrollToBottom();
              }
            } else if (obj.type === 'error') {
              throw new Error(obj.message || T('Ukjent feil fra server'));
            }
          }
        }
        if (md) {
          try { bubble.innerHTML = md.render(accumulated || ''); }
          catch (_) { bubble.textContent = accumulated; }
        } else {
          bubble.textContent = accumulated;
        }
        bubble._rawMd = accumulated;
        // Kopier-knapp for tolkningen.
        const actions = document.createElement('div');
        actions.className = 'ai-codeblock-actions';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'ai-codeblock-btn';
        copyBtn.textContent = '📋 ' + T('Kopier tolkning');
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(accumulated).then(() => flash(copyBtn, T('✓ Kopiert'))).catch(() => {});
        });
        actions.appendChild(copyBtn);
        thinkingNode.appendChild(actions);
        state.history.push({ role: 'assistant', meta: { intent: 'tolkning' } });
      }

      // ── Web mode: /api/data-svar (agentic web search + generation, admin-only) ──
      // SSE contract (netlify/edge-functions/data-svar.ts):
      //   {type:'progress', text, replace?}  — live tool-call/phase labels; replace:true
      //     means "update the previous replaceable line in place" (heartbeat ticks
      //     with a seconds counter while a long API turn is in flight)
      //   {type:'text', text}      — markdown chunks (explanation + one fenced script)
      //   {type:'sources', sources:[{url, ok, cors, viaProxy}]} — deterministic probe manifest
      //   {type:'continue', state, probed} — invocation's turn budget spent; re-POST
      //     with resume:{state, probed} to keep going (Netlify CPU cap per request)
      //   {type:'error', message}
      // Consume one SSE response, dispatching parsed events to onEvent. Mirrors the
      // inline reader loops in runFastQuery/streamKodeSvarV2/runInterpretQuery above
      // (not factored out into a shared helper there, to avoid touching working code);
      // this is the equivalent for the new Web-mode path.
      async function consumeSse(resp, onEvent) {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf('\n\n')) >= 0) {
            const event = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const dataLine = event.split('\n').find(l => l.startsWith('data:'));
            if (!dataLine) continue;
            let obj;
            try { obj = JSON.parse(dataLine.slice(5).trim()); }
            catch (_) { continue; }   // ignore non-JSON keep-alive lines
            onEvent(obj);
          }
        }
      }

      // One question/repair round-trip to /api/data-svar. Renders progress lines
      // live, streams markdown into a bubble (reusing streamRenderMd — the same
      // throttled live-markdown renderer runFastQuery/runFastQueryV2 use), and
      // appends a ✅/⚠️ source list once the `sources` event arrives. thinkingNode
      // is the wrap created by appendThinking() — the "assistant bubble" container
      // pattern already used everywhere else in this file (see runFastQuery et al.).
      async function runWebAnswer(question, thinkingNode, repair, round) {
        const t0 = Date.now();
        thinkingNode.innerHTML = '';
        const progressBox = document.createElement('div');
        progressBox.className = 'ai-progress';
        thinkingNode.appendChild(progressBox);
        const bubble = document.createElement('div');
        bubble.className = 'ai-bubble';
        thinkingNode.appendChild(bubble);

        if (!state.anthropicKey) throw new Error(T('Web-modus krever egen Anthropic-nøkkel.'));
        const mode = (typeof activeEditorMode !== 'undefined' && activeEditorMode) ? activeEditorMode : 'python';

        // Continuation protocol: Netlify caps CPU per edge invocation, so the
        // server runs ONE API turn per POST and hands back
        // {type:'continue', state, probed} when it isn't finished; we
        // immediately re-POST with `resume` until the final answer arrives.
        // The progress box lives across hops, so the user sees one seamless run.
        let markdown = '';
        let sources = null;
        let _lastRender = 0;
        let resume = null;
        for (let hop = 0; ; hop++) {
          if (hop > 40) throw new Error(T('Avbrutt: svaret ble ikke ferdig etter 40 fortsettelses-runder.'));
          const resp = await fetch('/api/data-svar', {
            method: 'POST',
            headers: edgeAuthHeaders(),
            body: JSON.stringify({
              question,
              mode,
              available_keys: (window.Keys ? window.Keys.registered() : []),
              script: scrubScript((dom.scriptInput && dom.scriptInput.value) || ''),
              repair: repair ? { script: repair.script, error: repair.error, round } : undefined,
              resume: resume || undefined,
            }),
          });
          if (resp.status === 401) {
            throw new Error(T('Ugyldig Anthropic-nøkkel. Sjekk nøkkelen i AI-innstillingene.'));
          }
          if (resp.status === 403) throw new Error(T('Web-modus krever egen Anthropic-nøkkel.'));
          if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status + ' ' + (await resp.text()));

          let cont = null;
          await consumeSse(resp, (ev) => {
            if (ev.type === 'continue') { cont = { state: ev.state, probed: ev.probed }; return; }
            handleWebEvent(ev);
          });
          if (!cont) break;
          resume = cont;
        }

        function handleWebEvent(ev) {
          if (ev.type === 'progress') {
            const last = progressBox.lastElementChild;
            if (ev.replace && last && last.dataset.replace === '1') {
              last.textContent = '⏳ ' + ev.text;
            } else {
              const line = document.createElement('div');
              line.className = 'ai-progress-line';
              if (ev.replace) line.dataset.replace = '1';
              line.textContent = '⏳ ' + ev.text;
              progressBox.appendChild(line);
            }
            scrollToBottom();
          } else if (ev.type === 'text') {
            markdown += ev.text;
            const _now = Date.now();
            if (_now - _lastRender > 70) {
              _lastRender = _now;
              streamRenderMd(bubble, markdown);   // existing live markdown renderer
              scrollToBottom();
            }
          } else if (ev.type === 'sources') {
            sources = ev.sources;
          } else if (ev.type === 'error') {
            let msg = ev.message || 'ukjent feil';
            if (state.anthropicKey && msg.indexOf('Anthropic API error 401') !== -1) {
              msg = T('Ugyldig Anthropic-nøkkel. Sjekk nøkkelen i AI-innstillingene.');
            }
            throw new Error(msg);
          }
        }

        streamRenderMd(bubble, markdown);
        attachCodeBlockActions(bubble);
        bubble._rawMd = markdown;
        attachResponseInsertBar(thinkingNode, markdown);

        if (sources && sources.length) {
          const list = document.createElement('div');
          list.className = 'ai-sources';
          list.innerHTML = '<b>' + T('Kilder:') + '</b> ' + sources.map(s =>
            (s.ok ? '✅ ' : '⚠️ ') +
            '<a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener">' +
            escapeHtml(s.url.replace(/^https?:\/\//, '').slice(0, 60)) + '</a>' +
            (s.viaProxy ? ' (via proxy)' : '')
          ).join(' · ');
          thinkingNode.appendChild(list);
        }
        return { markdown, latency: Date.now() - t0 };
      }

      // Pull the first fenced code block matching the current editor mode's
      // language out of a Web-mode answer (```python / ```r / ```sql — see
      // MODE_PY/MODE_R/MODE_DUCK svarformat in data-svar-prompt.ts). Falls back
      // to the first fenced block of any language so an odd/missing tag doesn't
      // silently drop a real script.
      const WEB_FENCE_LANGS = { python: ['python', 'py'], r: ['r'], duckdb: ['sql', 'duckdb'] };
      function extractWebScriptBlock(textMd, mode) {
        if (!textMd) return '';
        const wanted = WEB_FENCE_LANGS[mode] || WEB_FENCE_LANGS.python;
        const re = /```(\w*)\s*\n([\s\S]*?)```/g;
        let m, fallback = '';
        while ((m = re.exec(textMd)) !== null) {
          const lang = (m[1] || '').toLowerCase();
          const body = (m[2] || '').trim();
          if (!body) continue;
          if (wanted.indexOf(lang) >= 0) return body;
          if (!fallback) fallback = body;
        }
        return fallback;
      }

      // Replace the editor content with the generated script (mirrors the
      // existing "Sett inn" response-action button in attachResponseInsertBar).
      function insertScriptIntoEditor(script) {
        if (!dom.scriptInput) return;
        dom.scriptInput.value = script;
        dom.scriptInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // Run the script currently in the editor via the SAME path the Kjør
      // button uses (index.html's btnRun click handler — it dispatches on
      // activeEditorMode, handles local/remote execution, and renders
      // output/errors into #outputArea). That handler has no return value or
      // promise of its own, so this is a v1 compromise: click the button, wait
      // for the run to settle via window.mdIsScriptRunning() (a one-line getter
      // exposed by index.html for exactly this purpose), then read the error
      // back out of #outputArea's `pre.error` node (also index.html's existing
      // error-rendering convention — see the catch-block in btnRun's handler).
      // Returns null on success, or the error text on failure.
      //
      // Staleness note (checked against index.html's btnRun handler): every
      // run path — the python/duckdb try/catch (renderOutput on success,
      // `pre.error` in the catch block) and R's runSelf -> runHybridR ->
      // renderROutputParts — rewrites #outputArea for THIS run before its own
      // `finally` flips scriptRunInProgress back to false. So whenever the
      // poll loop below observes mdIsScriptRunning() === false, #outputArea
      // already reflects this run's outcome, never a stale previous round's —
      // no pre-run snapshot of the error text is needed. That guarantee only
      // covers the "settled" case, though: if we hit the 180s ceiling while
      // mdIsScriptRunning() is still true, the run handler hasn't written
      // anything for this run yet, so #outputArea may still hold the previous
      // round's error. In that case we return a distinct, honest timeout
      // message instead of reading `.error` — this ends the repair loop as a
      // failure and leaves the script in the editor, rather than reporting a
      // false success or feeding a stale error into the next repair round.
      async function runScriptAndCaptureError() {
        const btn = document.getElementById('btnRun');
        const outputArea = document.getElementById('outputArea');
        if (!btn) return T('Fant ikke Kjør-knappen.');
        if (typeof window.mdIsScriptRunning !== 'function') {
          return T('Kan ikke sjekke kjørestatus (mdIsScriptRunning mangler).');
        }
        let waited = 0;
        // B7 (docs/REVIEW_2026-07-07.md §3): waiting on btn.disabled alone is
        // not enough — during an active run the button stays ENABLED but
        // relabeled "Avbryt", so a click would call performRunInterrupt() on
        // the user's own run instead of starting ours, and the repair loop
        // would then misread the aborted run's error as our script's error.
        // Wait for BOTH pyodide-ready (btn no longer disabled-for-loading)
        // AND no run already in progress; give up loudly (return an error
        // string, never click) if that doesn't happen within the timeout.
        while ((btn.disabled || window.mdIsScriptRunning()) && waited < 20000) {
          await sleep(200); waited += 200;
        }
        if (btn.disabled) return T('Kjør-knappen er ikke klar (miljøet laster fortsatt).');
        if (window.mdIsScriptRunning()) {
          return T('Kan ikke starte automatisk kjøring — en annen kjøring pågår allerede.');
        }
        btn.click();
        await sleep(50);   // let the click handler's async body flip the running flag
        const start = Date.now();
        while (window.mdIsScriptRunning() && Date.now() - start < 180000) {
          await sleep(150);
        }
        if (window.mdIsScriptRunning()) {
          return T('Kjøringen var ikke ferdig etter 180 sekunder — overvåking avbrutt.');
        }
        const errEl = outputArea && outputArea.querySelector('pre.error');
        return errEl ? errEl.textContent : null;
      }

      // S2 (docs/REVIEW_2026-07-07.md §3): Web-mode answers can contain a
      // prompt-injected script (the /api/data-svar backend does agentic web
      // search — a poisoned page can inject arbitrary instructions), and the
      // app runs it in main-thread Pyodide alongside localStorage secrets
      // (GitHub PAT, API keys). The script is still auto-inserted into the
      // editor, but the FIRST run of an answer must be user-initiated. This
      // renders a small inline confirmation bubble styled like the existing
      // chat action buttons (attachResponseInsertBar's ai-response-actions /
      // ai-response-insert-btn, and ai-codeblock-btn for the secondary
      // action) and resolves true/false on Kjør/Avbryt.
      //
      // Power-user opt-out (no settings UI by design — set directly):
      //   localStorage.setItem('md_ai_autorun', '1')
      // skips this confirmation entirely and auto-runs immediately, same as
      // before S2. Anyone flipping this on has explicitly opted into the risk.
      function getAutorunPref() {
        try { return localStorage.getItem('md_ai_autorun') === '1'; } catch (e) { return false; }
      }
      function confirmAutoRun() {
        if (getAutorunPref()) return Promise.resolve(true);
        return new Promise(function (resolve) {
          const wrap = document.createElement('div');
          wrap.className = 'ai-msg ai-msg-assistant';
          wrap.innerHTML = '<div class="ai-bubble"></div>';
          const bubble = wrap.querySelector('.ai-bubble');
          const question = document.createElement('div');
          question.textContent = T('Kjør det genererte scriptet?');
          bubble.appendChild(question);
          const bar = document.createElement('div');
          bar.className = 'ai-response-actions';
          const runBtn = document.createElement('button');
          runBtn.type = 'button';
          runBtn.className = 'ai-response-insert-btn';
          runBtn.textContent = T('Kjør');
          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'ai-codeblock-btn';
          cancelBtn.textContent = T('Avbryt');
          bar.appendChild(runBtn);
          bar.appendChild(cancelBtn);
          bubble.appendChild(bar);
          dom.aiThread.appendChild(wrap);
          scrollToBottom();
          function settle(ok) {
            runBtn.disabled = true;
            cancelBtn.disabled = true;
            bar.remove();
            const status = document.createElement('div');
            status.className = 'ai-repair-note';
            status.textContent = ok ? T('✓ Kjører …') : T('Avbrutt — scriptet står i editoren.');
            bubble.appendChild(status);
            resolve(ok);
          }
          runBtn.addEventListener('click', function () { settle(true); });
          cancelBtn.addEventListener('click', function () { settle(false); });
        });
      }

      // Auto-run + repair loop (max 3 rounds): extract → insert → confirm →
      // run → on failure, POST the script+error back as `repair` and try
      // again. Only the FIRST run of an answer waits on user confirmation
      // (S2 above) — once the user has opted in for this answer, repair-round
      // re-runs proceed automatically, since the user already agreed to run
      // scripts for this question.
      async function webAnswerWithRepair(question, thinkingNode) {
        const mode = (typeof activeEditorMode !== 'undefined' && activeEditorMode) ? activeEditorMode : 'python';
        let round = 0, lastError = null, script = null, confirmed = false;
        let result = await runWebAnswer(question, thinkingNode, null, 0);
        while (true) {
          script = extractWebScriptBlock(result.markdown, mode);
          if (!script) return;   // prose-only answer (e.g. honest "fant ikke data") — already rendered, nothing to run
          insertScriptIntoEditor(script);
          if (!confirmed) {
            const ok = await confirmAutoRun();
            if (!ok) return;   // user declined — script stays in the editor, nothing runs
            confirmed = true;
          }
          try {
            lastError = await runScriptAndCaptureError();
            if (!lastError) return;   // success
          } catch (e) { lastError = (e && e.message) ? e.message : String(e); }
          round++;
          if (round > 3) {
            const giveUp = document.createElement('div');
            giveUp.className = 'ai-msg ai-msg-assistant';
            giveUp.innerHTML = '<div class="ai-bubble ai-error"></div>';
            giveUp.querySelector('.ai-bubble').textContent =
              T('Kunne ikke få scriptet til å kjøre etter 3 reparasjonsrunder. Siste feil:\n\n{err}\n\nScriptet står i editoren — juster gjerne manuelt.', { err: lastError });
            dom.aiThread.appendChild(giveUp);
            scrollToBottom();
            return;
          }
          const roundNote = document.createElement('div');
          roundNote.className = 'ai-msg ai-msg-assistant';
          roundNote.innerHTML = '<div class="ai-bubble ai-repair-note"></div>';
          roundNote.querySelector('.ai-bubble').textContent =
            T('⚙️ Reparasjonsrunde {round} — retter: {err}', { round: round, err: String(lastError).slice(0, 120) });
          dom.aiThread.appendChild(roundNote);
          scrollToBottom();
          const repairNode = appendThinking();
          try {
            result = await runWebAnswer(question, repairNode, { script, error: lastError }, round);
          } catch (e) {
            // A thrown error here (401, SSE `error` event, network drop) must land
            // in THIS round's own bubble (repairNode) — not bubble up to
            // sendWebMessage's outer catch, which would target thinkingNode
            // (round 0) and wipe out the already-rendered first answer. Stop the
            // loop on failure; the previous answer(s) stay intact.
            appendError(repairNode, '✗ ' + ((e && e.message) ? e.message : String(e)));
            return;
          }
        }
      }

      // Full send flow for Web mode: auth gate, user bubble, thinking node,
      // then the answer+auto-run+repair loop. Mirrors sendMessage()'s
      // boilerplate (see above) but dispatches to runWebAnswer/webAnswerWithRepair
      // instead of the fast API path.
      async function sendWebMessage() {
        if (state.sending) return;
        const text = dom.aiInput.value.trim();
        if (!text) return;
        if (!state.anthropicKey) {
          openSettings();
          return;
        }
        state.sending = true;
        if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = true;
        if (dom.aiSendWebBtn) dom.aiSendWebBtn.disabled = true;
        if (state.history.length === 0) dom.aiThread.innerHTML = '';
        appendUserMessage(text);
        state.history.push({ role: 'user', text });
        dom.aiInput.value = '';
        autoresize();
        const thinkingNode = appendThinking();
        try {
          await webAnswerWithRepair(text, thinkingNode);
          state.history.push({ role: 'assistant', meta: { intent: 'web' } });
        } catch (e) {
          appendError(thinkingNode, '✗ ' + ((e && e.message) ? e.message : String(e)));
        } finally {
          state.sending = false;
          if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = false;
          if (dom.aiSendWebBtn) dom.aiSendWebBtn.disabled = false;
          dom.aiInput.focus();
        }
      }

      // Pull the first ```microdata / ``` code block that looks like a
      // microdata script out of streamed markdown.
      function extractFirstMicrodataBlock(textMd) {
        if (!textMd) return '';
        const re = /```(\w*)\s*\n([\s\S]*?)```/g;
        let m;
        while ((m = re.exec(textMd)) !== null) {
          const lang = (m[1] || '').toLowerCase();
          const body = (m[2] || '').trim();
          if (lang === 'python' || lang === 'py' || lang === 'r') continue;
          if (/\b(require|create-dataset|import\s+\w+\/|use\s+\w)/.test(body)) return body;
          if (lang === 'microdata') return body;
        }
        return '';
      }

      // Run the script through a throwaway m2py interpreter on synthetic data
      // (disclosure control off, so only structural/runtime errors surface).
      // Returns {passed, errors:[{kind,message}]} or {skipped:true}.
      async function validateMicrodataLocal(script) {
        let py;
        try { py = await loadPyodideAndM2py(); }
        catch (_) { return { skipped: true }; }
        if (!py) return { skipped: true };
        const base = window.location.href.replace(/[^/]+$/, '');
        const catalogJson = (typeof microdataCatalog !== 'undefined' && microdataCatalog && microdataCatalog.variables)
          ? JSON.stringify(microdataCatalog.variables) : null;
        const pyCode =
          'import json, sys\n' +
          '_script = ' + JSON.stringify(script) + '\n' +
          '_catalog_json = ' + (catalogJson !== null ? JSON.stringify(catalogJson) : 'None') + '\n' +
          '_base = ' + JSON.stringify(base) + '\n' +
          '_m = sys.modules.get("m2py")\n' +
          '_prev_dc = getattr(_m, "M2PY_DISCLOSURE_CONTROL", "0") if _m is not None else "0"\n' +
          '_out = json.dumps({"passed": False, "errors": [{"kind": "runtime", "message": "validator unavailable"}]})\n' +
          'try:\n' +
          '    if _m is not None:\n' +
          '        _m.M2PY_DISCLOSURE_CONTROL = "0"\n' +
          '    from m2py import MicroInterpreter\n' +
          '    _cat = json.loads(_catalog_json) if _catalog_json else None\n' +
          '    _vi = MicroInterpreter(catalog=_cat, metadata_base_url=_base)\n' +
          '    try:\n' +
          '        _vi.data_engine.default_rows = 200\n' +
          '    except Exception:\n' +
          '        pass\n' +
          '    _err = None\n' +
          '    try:\n' +
          '        if hasattr(_vi, "run_script_async"):\n' +
          '            _err = "ASYNC"\n' +
          '        else:\n' +
          '            _vi.run_script(_script)\n' +
          '    except Exception as _ex:\n' +
          '        _err = f"{type(_ex).__name__}: {_ex}"\n' +
          '    if _err == "ASYNC":\n' +
          '        _out = json.dumps({"async": True})\n' +
          '    elif _err is None:\n' +
          '        _out = json.dumps({"passed": True, "errors": []})\n' +
          '    else:\n' +
          '        _out = json.dumps({"passed": False, "errors": [{"kind": "runtime", "message": _err}]})\n' +
          'except Exception as _ex2:\n' +
          '    _out = json.dumps({"skipped": True, "error": f"{type(_ex2).__name__}: {_ex2}"})\n' +
          'finally:\n' +
          '    if _m is not None:\n' +
          '        _m.M2PY_DISCLOSURE_CONTROL = _prev_dc\n' +
          '_out\n';
        let raw;
        try { raw = await py.runPythonAsync(pyCode); }
        catch (_) { return { skipped: true }; }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return { skipped: true }; }
        if (parsed.skipped) return { skipped: true };
        // Async interpreter variant — run via the async API and re-check.
        if (parsed.async) {
          return await validateMicrodataLocalAsync(py, script, catalogJson, base);
        }
        return parsed;
      }

      async function validateMicrodataLocalAsync(py, script, catalogJson, base) {
        const setup =
          'import json, sys\n' +
          '_script = ' + JSON.stringify(script) + '\n' +
          '_catalog_json = ' + (catalogJson !== null ? JSON.stringify(catalogJson) : 'None') + '\n' +
          '_base = ' + JSON.stringify(base) + '\n' +
          '_m = sys.modules.get("m2py")\n' +
          'globals()["_prev_dc"] = getattr(_m, "M2PY_DISCLOSURE_CONTROL", "0") if _m is not None else "0"\n' +
          'if _m is not None:\n' +
          '    _m.M2PY_DISCLOSURE_CONTROL = "0"\n' +
          'from m2py import MicroInterpreter\n' +
          '_cat = json.loads(_catalog_json) if _catalog_json else None\n' +
          '_vi = MicroInterpreter(catalog=_cat, metadata_base_url=_base)\n' +
          'try:\n' +
          '    _vi.data_engine.default_rows = 200\n' +
          'except Exception:\n' +
          '    pass\n' +
          'globals()["_vi"] = _vi\n';
        try { await py.runPythonAsync(setup); } catch (_) { return { skipped: true }; }
        let raw;
        try {
          raw = await py.runPythonAsync(
            '_err = None\n' +
            'try:\n' +
            '    await _vi.run_script_async(_script)\n' +
            'except Exception as _ex:\n' +
            '    _err = f"{type(_ex).__name__}: {_ex}"\n' +
            'finally:\n' +
            '    if _m is not None:\n' +
            '        _m.M2PY_DISCLOSURE_CONTROL = _prev_dc\n' +
            'json.dumps({"passed": _err is None, "errors": [] if _err is None else [{"kind": "runtime", "message": _err}]})\n'
          );
        } catch (_) { return { skipped: true }; }
        try { return JSON.parse(raw); } catch (_) { return { skipped: true }; }
      }

      // Isolate the #python/#r code segment out of a python/r kode-svar-v2
      // candidate script (which is ALWAYS a single hybrid blob: a `#micro`
      // directive header followed by a `#r`/`#python` marker + the actual
      // analysis code — see kode-svar.ts MICRO_IMPORT_BRIDGE). Reuses
      // index.html's own parseHybridScript segmenter (bare global — same
      // cross-file convention as activeEditorMode/microdataCatalog elsewhere
      // in this file) so the split matches EXACTLY how the app itself would
      // interpret the hybrid script. Falls back to the whole script when
      // parseHybridScript is unavailable (e.g. the node test harness) or no
      // segment of the wanted kind was found — better to syntax-check a little
      // too much (the #micro lines would then fail compile()/parse(), which
      // just degrades to a reported {passed:false} error, not "skipped" —
      // compile()/parse() DOES run, it just fails) than to silently skip
      // validation.
      const LANG_SEGMENT_KIND = { python: 'pyodide', r: 'r' };
      function extractLangSegment(script, lang) {
        if (!script) return '';
        const wantKind = LANG_SEGMENT_KIND[lang] || lang;
        if (typeof parseHybridScript !== 'function') return script;
        let segments;
        try { segments = parseHybridScript(script, wantKind); } catch (_) { return script; }
        const parts = (segments || [])
          .filter(function (s) { return s.kind === wantKind; })
          .map(function (s) { return s.text; });
        return parts.length ? parts.join('\n\n') : script;
      }

      // Nivå 1 python-syntaks-sjekk (docs/ROADMAP.md §AI-assistenten):
      // compile(...,'exec') via en ALLEREDE lastet/lastende Pyodide-økt.
      // __pyodidePromise (index.html sin loadPyodideAndM2py-memoisering) er
      // en bare global, samme mønster som activeEditorMode/microdataCatalog
      // ellers i denne fila. VIKTIG: vi kaller ALDRI loadPyodideAndM2py() selv
      // — det ville boot-et en ny ~30s-runtime bare for å validere ett
      // AI-svar. Vi hekter oss KUN på en økt andre deler av appen allerede har
      // startet (varmlasting ved modusbytte til python, eller en tidligere
      // Kjør) — hvis ingen finnes, hopper vi over (skipped:true), aldri boot.
      // Merk: når en økt ER i ferd med å starte (booting, ikke ferdig), AWAITER
      // vi den (linjen under) i stedet for å hoppe over — badgen kan derfor
      // dukke opp et lite øyeblikk etter selve svarteksten, uten at vi noen
      // gang selv trigget boot-en.
      async function validatePythonSyntax(script) {
        if (typeof __pyodidePromise === 'undefined' || !__pyodidePromise) return { skipped: true };
        let py;
        try { py = await __pyodidePromise; } catch (_) { return { skipped: true }; }
        if (!py) return { skipped: true };
        const pyCode = extractLangSegment(script, 'python');
        if (!pyCode) return { skipped: true };
        // Linjenumre er relative til DEN UTTRUKNE python-delen (#micro-linjene
        // foran er kuttet bort) — det holder fint for reparasjonsrundens
        // feilmelding, som uansett sender hele kandidatscriptet tilbake til AI-en.
        const checkCode =
          'import json\n' +
          '_src = ' + JSON.stringify(pyCode) + '\n' +
          'try:\n' +
          '    compile(_src, "<ai-script>", "exec")\n' +
          '    _out = json.dumps({"passed": True, "errors": []})\n' +
          'except SyntaxError as _ex:\n' +
          '    _out = json.dumps({"passed": False, "errors": [{"kind": "parse", "message": str(_ex.msg) if _ex.msg else str(_ex), "line_no": _ex.lineno}]})\n' +
          'except Exception as _ex2:\n' +
          '    _out = json.dumps({"passed": False, "errors": [{"kind": "parse", "message": f"{type(_ex2).__name__}: {_ex2}"}]})\n' +
          '_out\n';
        let raw;
        try { raw = await py.runPythonAsync(checkCode); } catch (_) { return { skipped: true }; }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return { skipped: true }; }
        // _ex.lineno (line_no over) was captured but never surfaced: buildRepairErrors
        // only reads e.message/e.kind, so a bare line_no field silently vanished before
        // ever reaching the repair-round prompt. Fold it into the message itself — R's
        // parse() error text already embeds "<text>:LINJE:KOLONNE:" on its own, so this
        // brings python's repair-error string to parity with R's.
        if (parsed && Array.isArray(parsed.errors)) {
          parsed.errors = parsed.errors.map(function (e) {
            if (e && e.line_no != null && e.message) {
              return Object.assign({}, e, { message: 'linje ' + e.line_no + ': ' + e.message });
            }
            return e;
          });
        }
        return parsed;
      }

      // Nivå 1 R-syntaks-sjekk: parse(text=...) via en ALLEREDE lastet/
      // lastende webR-økt (webRPromise — samme bare-global-mønster og samme
      // "aldri boot"-regel som validatePythonSyntax over). Bruker KUN base R
      // (ingen jsonlite — jsonlite krever en defensiv webr::install() først,
      // se andre webR-kallsteder i index.html, og det ville også være en
      // uønsket bivirkning bare for å validere). Feilteksten fra parse()
      // inneholder selv linje/kolonne på formen "<text>:LINJE:KOLONNE:" —
      // trekkes ut med et enkelt regex i stedet.
      async function validateRSyntax(script) {
        if (typeof webRPromise === 'undefined' || !webRPromise) return { skipped: true };
        try { await webRPromise; } catch (_) { return { skipped: true }; }
        if (typeof webRReady === 'undefined' || !webRReady || typeof webR === 'undefined' || !webR) return { skipped: true };
        const rCode = extractLangSegment(script, 'r');
        if (!rCode) return { skipped: true };
        const checkExpr =
          'tryCatch({ parse(text = ' + JSON.stringify(rCode) + '); "OK" }, ' +
          'error = function(e) paste0("ERR:", conditionMessage(e)))';
        let robj;
        try { robj = await webR.evalR(checkExpr); } catch (_) { return { skipped: true }; }
        try {
          const js = await robj.toJs();
          const result = (js.values || [])[0];
          if (result === 'OK') return { passed: true, errors: [] };
          const msg = String(result || '').replace(/^ERR:/, '');
          const lm = /<text>:(\d+):\d+:/.exec(msg);
          return { passed: false, errors: [{ kind: 'parse', message: msg, line_no: lm ? parseInt(lm[1], 10) : null }] };
        } catch (_) {
          return { skipped: true };
        } finally {
          try { await webR.destroy(robj); } catch (_) {}
        }
      }

      function autoresize() {
        const ta = dom.aiInput;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';  // ~5 linjer maks, så scroller den
      }

      function refreshUserPanel() {
        if (dom.aiCfgByokStored) dom.aiCfgByokStored.style.display = state.anthropicKey ? '' : 'none';
        if (window.mdSyncWebBtnVisibility) window.mdSyncWebBtnVisibility();
      }

      // Datakilde-nøkler (spec 2026-07-23): radene genereres fra registeret —
      // én rad per kilde med auth.user. Ny nøkkelkrevende kilde = ny register-
      // oppføring, ingen UI-kode. Verdier vises aldri igjen etter lagring
      // (passordfelt + placeholder), men kan erstattes eller fjernes.
      var _srcKeyRegistry = null;
      async function userKeySources() {
        if (!_srcKeyRegistry) {
          try {
            var r = await fetch('data/data-sources.json');
            _srcKeyRegistry = r.ok ? await r.json() : [];
          } catch (e) { _srcKeyRegistry = []; }
        }
        return _srcKeyRegistry.filter(function (s) { return s.auth && s.auth.user; });
      }

      async function renderSourceKeys() {
        var box = dom.aiCfgSourceKeys;
        if (!box) return;
        var sources = await userKeySources();
        box.innerHTML = '';
        if (!sources.length) return;
        var head = document.createElement('label');
        head.textContent = T('Datakilde-nøkler');
        box.appendChild(head);
        sources.forEach(function (s) {
          var has = !!(window.Keys && window.Keys.get(s.id));
          var wrap = document.createElement('div');
          wrap.style.margin = '6px 0 10px';
          var lab = document.createElement('div');
          lab.className = 'ai-modal-help';
          lab.textContent = s.navn + (has ? ' — ' + T('nøkkel registrert') : '');
          wrap.appendChild(lab);
          var inp = document.createElement('input');
          inp.type = 'password';
          inp.autocomplete = 'off';
          inp.dataset.sourceKeyId = s.id;
          inp.placeholder = has ? '••••••••' : (s.nokkel_hint || T('lim inn nøkkel'));
          wrap.appendChild(inp);
          if (has) {
            var rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'ai-modal-btn';
            rm.style.marginTop = '4px';
            rm.textContent = T('Fjern nøkkel');
            rm.addEventListener('click', function () {
              window.Keys.remove(s.id);
              renderSourceKeys();
            });
            wrap.appendChild(rm);
          }
          box.appendChild(wrap);
        });
      }

      // Global AI-leverandør (spec 2026-07-23-llm-provider-tiers A1): type +
      // base-URL + modell i md_llm_provider (ikke hemmelig); nøkkelen i det
      // felles nøkkellageret (js/keys.js, type 'llm').
      var LS_PROVIDER = 'md_llm_provider';
      function providerConfig() {
        var p = null;
        try { p = JSON.parse(localStorage.getItem(LS_PROVIDER) || 'null'); } catch (e) { /* korrupt → ignorer */ }
        if (!p || !p.type || p.type === 'anthropic') return null;
        if (!p.base_url || !p.model) return null;
        return { type: p.type, base_url: p.base_url, model: p.model };
      }
      function syncProviderFields() {
        if (!dom.aiCfgProviderType || !dom.aiCfgProviderFields) return;
        var custom = dom.aiCfgProviderType.value !== 'anthropic';
        dom.aiCfgProviderFields.style.display = custom ? '' : 'none';
        if (dom.aiCfgLlmKey) {
          dom.aiCfgLlmKey.placeholder = (window.Keys && window.Keys.get('llm'))
            ? '••••••••' : T('lim inn nøkkel');
        }
      }
      function openSettings() {
        if (dom.aiCfgAnthropicKey) dom.aiCfgAnthropicKey.value = state.anthropicKey;
        refreshUserPanel();
        renderSourceKeys();
        var provRaw = null;
        try { provRaw = JSON.parse(localStorage.getItem(LS_PROVIDER) || 'null'); } catch (e) {}
        if (dom.aiCfgProviderType) dom.aiCfgProviderType.value = (provRaw && provRaw.type) || 'anthropic';
        if (dom.aiCfgProviderUrl) dom.aiCfgProviderUrl.value = (provRaw && provRaw.base_url) || '';
        if (dom.aiCfgProviderModel) dom.aiCfgProviderModel.value = (provRaw && provRaw.model) || '';
        if (dom.aiCfgLlmKey) dom.aiCfgLlmKey.value = '';
        syncProviderFields();
        dom.aiSettingsBackdrop.classList.add('open');
      }
      function closeSettings() { dom.aiSettingsBackdrop.classList.remove('open'); }
      function saveSettings() {
        const akey = dom.aiCfgAnthropicKey ? dom.aiCfgAnthropicKey.value.trim() : '';
        if (akey) window.Keys.set('anthropic', akey);
        else window.Keys.remove('anthropic');
        // BYOK-nøkkelen påvirker Web-knappens synlighet (webModeEligible).
        if (window.mdSyncWebBtnVisibility) window.mdSyncWebBtnVisibility();
        if (dom.aiCfgSourceKeys && window.Keys) {
          dom.aiCfgSourceKeys.querySelectorAll('input[data-source-key-id]').forEach(function (inp) {
            var v = inp.value.trim();
            if (v) window.Keys.set(inp.dataset.sourceKeyId, v);
          });
        }
        if (dom.aiCfgProviderType) {
          var ptype = dom.aiCfgProviderType.value;
          if (ptype === 'anthropic') {
            localStorage.removeItem(LS_PROVIDER);
          } else {
            localStorage.setItem(LS_PROVIDER, JSON.stringify({
              type: ptype,
              base_url: (dom.aiCfgProviderUrl ? dom.aiCfgProviderUrl.value.trim() : ''),
              model: (dom.aiCfgProviderModel ? dom.aiCfgProviderModel.value.trim() : ''),
            }));
            var lk = dom.aiCfgLlmKey ? dom.aiCfgLlmKey.value.trim() : '';
            if (lk && window.Keys) window.Keys.set('llm', lk);
          }
        }
        closeSettings();
      }

      function clearChat() {
        state.history = [];
        renderEmpty();
      }

      function init() {
        cacheDom();
        if (!dom.aiSidebar) return;

        dom.aiToggleBtn.addEventListener('click', toggleOpen);
        dom.aiCloseBtn.addEventListener('click', () => setOpen(false));
        dom.aiSettingsBtn.addEventListener('click', openSettings);
        dom.aiClearBtn.addEventListener('click', clearChat);
        dom.aiCfgSave.addEventListener('click', saveSettings);
        dom.aiCfgCancel.addEventListener('click', closeSettings);
        dom.aiSettingsBackdrop.addEventListener('click', (e) => {
          if (e.target === dom.aiSettingsBackdrop) closeSettings();
        });

        if (dom.aiCfgProviderType) dom.aiCfgProviderType.addEventListener('change', syncProviderFields);

        if (dom.aiCfgByokRemove) {
          dom.aiCfgByokRemove.addEventListener('click', () => {
            window.Keys.remove('anthropic');
            if (dom.aiCfgAnthropicKey) dom.aiCfgAnthropicKey.value = '';
            if (dom.aiCfgByokStored) dom.aiCfgByokStored.style.display = 'none';
            if (window.mdSyncWebBtnVisibility) window.mdSyncWebBtnVisibility();
          });
        }

        // Send is routed by the active mode: microdata-modus → microdata AI
        // (kode-svar); otherwise the agentic data-svar flow (search data → script
        // in the active mode's language → run → revise).
        function sendCurrent() {
          var _m = window.M2PY && window.M2PY.currentMode && window.M2PY.currentMode();
          if (_m && _m.id === 'microdata') {
            // v2-flyten (2-stegs variabelvalg + auto-retting) gir best svar;
            // den gamle enstegsflyten nås ikke lenger fra UI.
            sendMessage(true);
          } else {
            sendWebMessage();
          }
        }
        if (dom.aiSendFastBtn) dom.aiSendFastBtn.addEventListener('click', sendCurrent);
        // Send⚗︎ er nå bakt inn i Send (microdata-modus → v2); knappen holdes skjult.
        if (dom.aiSendV2Btn) { dom.aiSendV2Btn.style.display = 'none'; dom.aiSendV2Btn.addEventListener('click', () => sendMessage(true)); }
        // The old Web button is subsumed by the URL-routed Send; keep it hidden.
        if (dom.aiSendWebBtn) { dom.aiSendWebBtn.style.display = 'none'; dom.aiSendWebBtn.addEventListener('click', () => { sendWebMessage(); }); }
        if (dom.aiAbortBtn) dom.aiAbortBtn.addEventListener('click', () => { if (state.abortCtrl) state.abortCtrl.abort(); });
        dom.aiInput.addEventListener('input', autoresize);
        dom.aiInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendCurrent();   // Enter = send (modus fra menyen); Shift+Enter = ny linje
          }
        });

        // Shows/hides the dedicated Web send button: admin + python/r/duckdb only.
        // Called after login/user fetch (refreshUserPanel), on editor-mode changes
        // (see switchEditorMode() in index.html), and once here at init.
        function syncWebBtnVisibility() {
          // The Web button is subsumed by the URL-routed Send; keep it hidden.
          if (dom.aiSendWebBtn) dom.aiSendWebBtn.style.display = 'none';
        }
        window.mdSyncWebBtnVisibility = syncWebBtnVisibility;
        syncWebBtnVisibility();

        // Keyboard shortcut Ctrl+I
        document.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
            e.preventDefault();
            toggleOpen();
          } else if (e.key === 'Escape') {
            if (dom.aiSettingsBackdrop.classList.contains('open')) closeSettings();
          }
        });

        // If Datasett sidebar opens later, close AI to keep mutual exclusion.
        if (dom.sidebarRight) {
          const observer = new MutationObserver(() => {
            const datasettOpen = !dom.sidebarRight.classList.contains('collapsed');
            const aiOpen = dom.aiSidebar.classList.contains('open');
            if (datasettOpen && aiOpen) setOpen(false);
          });
          observer.observe(dom.sidebarRight, { attributes: true, attributeFilter: ['class'] });
        }

        // Auth gate is in sendMessage; no auto-open of settings on first AI-panel
        // toggle. Users see the panel and the empty state; only Send triggers
        // the Settings dialog to collect a BYOK key.

        // Offentlig: åpne AI-panelet og send et spørsmål (brukes av hurtigspør-boksen i toppen).
        window.mdAskAi = function(question) {
          if (!question || !question.trim()) return;
          setOpen(true);
          dom.aiInput.value = question;
          autoresize();
          sendMessage();
        };

        // Offentlig: åpne AI-panelet og tolk resultatene (output) fra forrige kjøring.
        window.mdInterpretResults = function(payload) {
          payload = payload || {};
          if (!payload.output || !payload.output.trim()) return;
          if (state.sending) return;
          if (!state.anthropicKey) { openSettings(); return; }
          setOpen(true);
          if (state.history.length === 0) dom.aiThread.innerHTML = '';
          appendUserMessage(T('Tolk resultatene fra forrige kjøring.'));
          state.history.push({ role: 'user', text: 'Tolk resultatene' });
          const thinkingNode = appendThinking();
          state.sending = true;
          if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = true;
          if (dom.aiSendWebBtn) dom.aiSendWebBtn.disabled = true;
          const ctrl = new AbortController();
          state.abortCtrl = ctrl;
          if (dom.aiAbortBtn) dom.aiAbortBtn.style.display = '';
          runInterpretQuery(payload, thinkingNode, ctrl.signal)
            .catch(e => { if (e.name !== 'AbortError') appendError(thinkingNode, '✗ ' + e.message); })
            .finally(() => {
              state.abortCtrl = null;
              if (dom.aiAbortBtn) dom.aiAbortBtn.style.display = 'none';
              state.sending = false;
              if (dom.aiSendFastBtn) dom.aiSendFastBtn.disabled = false;
              if (dom.aiSendWebBtn) dom.aiSendWebBtn.disabled = false;
              if (dom.aiInput) dom.aiInput.focus();
            });
        };
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }

      // Node-testbar seam (samme mønster som js/ui.js, js/cells.js, js/names.js
      // m.fl.): eksporter et lite, stabilt sett av rene funksjoner + nivå
      // 1-dispatch-tabellen for tests/js/*.test.js. Resten av modulen (init(),
      // sendMessage() m.fl.) krever en ekte nettleser-DOM og eksporteres ikke —
      // se tests/js/ui-dom.test.js for mønsteret dersom det trengs senere.
      if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
          extractFirstCodeBlock: extractFirstCodeBlock,
          extractFirstMicrodataBlock: extractFirstMicrodataBlock,
          extractLangSegment: extractLangSegment,
          extractAllCode: extractAllCode,
          findUnknownVarNames: findUnknownVarNames,
          buildRepairErrors: buildRepairErrors,
          validatePythonSyntax: validatePythonSyntax,
          validateRSyntax: validateRSyntax,
          _v2Validators: _v2Validators,
        };
      }
    })();
