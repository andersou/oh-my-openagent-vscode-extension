// ---------------------------------------------------------------------------
// Oh My OpenAgent — Editor webview controller
//
// Plain DOM, no dependencies. Bundled by esbuild (platform: browser,
// format: iife) to out/webview.js and loaded into a VS Code webview.
//
// Communicates with the extension host via acquireVsCodeApi(). The host
// (AgentEditorPanel) uses `command` as the message discriminator:
//   host -> webview : { command: 'init',           type, name, config, ... }
//                     { command: 'saved' }
//                     { command: 'profileCreated', name }
//                     { command: 'error',          message }
//   webview -> host : { command: 'ready' }
//                     { command: 'save',       payload }
//                     { command: 'createProfile' }
//
// Form state is persisted to vscode.setState() on every change so the
// webview can be hidden and re-shown without losing unsaved edits.
// ---------------------------------------------------------------------------

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // VS Code API
  // -------------------------------------------------------------------------

  var api =
    typeof globalThis !== 'undefined' && globalThis.acquireVsCodeApi
      ? globalThis.acquireVsCodeApi
      : undefined;

  // The previous state object is captured automatically by VS Code on
  // subsequent calls to acquireVsCodeApi — but the very first call returns
  // undefined for getState. We grab the previous state lazily.
  var vscode = null;
  if (api) {
    try {
      vscode = api();
    } catch (err) {
      // Defensive: some hosts throw if called outside a real webview.
      vscode = null;
    }
  }

  if (!vscode) {
    // Standalone preview (e.g. opening the HTML directly). The form still
    // works for visual inspection but messages go nowhere.
    console.warn('[omo] acquireVsCodeApi unavailable — running in preview mode');
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** @type {null | string} */
  var entityKind = null;
  /** @type {null | string} */
  var entityName = null;
  /**
   * Form values mirror. Kept in sync with the inputs so we can:
   *  - restore from init() without re-reading the DOM
   *  - persist to vscode.setState() without re-reading the DOM
   *  - know the initial thinking state for the "user disabled" case
   * @type {{
   *   model?: string,
   *   variant?: string,
   *   reasoningEffort?: string,
   *   temperature?: number,
   *   top_p?: number,
   *   maxTokens?: number,
   *   thinking?: { type: 'enabled'|'disabled', budgetTokens?: number },
   *   fallback_models?: string[]
   * }}
   */
  var values = {};
  /** Tracks the initial thinking type so we know when to emit 'disabled'. */
  var initialThinkingType = null; // 'enabled' | 'disabled' | null
  var formDirty = false;
  var initialized = false;
  var statusTimer = null;

  // -------------------------------------------------------------------------
  // DOM
  // -------------------------------------------------------------------------

  /** @type {HTMLElement|null} */
  var root = document.getElementById('editor');

  var el = {
    title: document.getElementById('title'),
    subtitle: document.getElementById('subtitle'),
    eyebrow: document.getElementById('eyebrow'),
    form: document.getElementById('editor-form'),
    status: document.getElementById('status'),
    btnSave: document.getElementById('btn-save'),
    btnCreateProfile: document.getElementById('btn-create-profile'),
    model: document.getElementById('f-model'),
    modelDatalist: document.getElementById('model-datalist'),
    modelStatus: document.getElementById('model-status'),
    variant: document.getElementById('f-variant'),
    reasoning: document.getElementById('f-reasoning'),
    temperature: document.getElementById('f-temperature'),
    topP: document.getElementById('f-top-p'),
    maxTokens: document.getElementById('f-max-tokens'),
    thinkingEnabled: document.getElementById('f-thinking-enabled'),
    budgetField: document.getElementById('f-budget-field'),
    budgetTokens: document.getElementById('f-budget-tokens'),
    fallback: document.getElementById('f-fallback'),
  };

  var errorEls = {
    temperature: document.getElementById('f-temperature-error'),
    top_p: document.getElementById('f-top-p-error'),
    maxTokens: document.getElementById('f-max-tokens-error'),
    budgetTokens: document.getElementById('f-budget-tokens-error'),
  };

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  function persist() {
    if (!vscode || typeof vscode.setState !== 'function') return;
    try {
      vscode.setState({
        kind: entityKind,
        name: entityName,
        values: values,
      });
    } catch (err) {
      // Non-fatal — the in-memory form still works.
      console.warn('[omo] setState failed:', err);
    }
  }

  function restorePersisted() {
    if (!vscode || typeof vscode.getState !== 'function') return null;
    try {
      var s = vscode.getState();
      return s && typeof s === 'object' ? s : null;
    } catch (err) {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Parsing helpers
  // -------------------------------------------------------------------------

  function asString(v) {
    if (v === null || v === undefined) return undefined;
    var s = String(v).trim();
    return s.length > 0 ? s : undefined;
  }

  function asNumber(v) {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    var s = String(v).trim();
    if (s.length === 0) return undefined;
    var n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }

  function asInt(v) {
    var n = asNumber(v);
    if (n === undefined) return undefined;
    return Number.isInteger(n) ? n : undefined;
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * @param {'temperature'|'top_p'|'maxTokens'|'budgetTokens'} name
   * @param {string} raw
   * @returns {string|null} error message or null if valid
   */
  function validateNumberField(name, raw) {
    if (raw === '' || raw === null || raw === undefined) return null;
    var n = Number(raw);
    if (!Number.isFinite(n)) return 'Must be a number';

    switch (name) {
      case 'temperature':
        if (n < 0) return 'Temperature must be \u2265 0';
        if (n > 2) return 'Temperature must be \u2264 2';
        return null;
      case 'top_p':
        if (n < 0) return 'Top-p must be \u2265 0';
        if (n > 1) return 'Top-p must be \u2264 1';
        return null;
      case 'maxTokens':
        if (!Number.isInteger(n)) return 'Max tokens must be a whole number';
        if (n < 1) return 'Max tokens must be \u2265 1';
        return null;
      case 'budgetTokens':
        if (!Number.isInteger(n)) return 'Budget tokens must be a whole number';
        if (n < 1) return 'Budget tokens must be \u2265 1';
        return null;
      default:
        return null;
    }
  }

  function showFieldError(input, errEl, message) {
    if (message) {
      input.classList.add('is-invalid');
      input.setAttribute('aria-invalid', 'true');
      errEl.textContent = message;
      errEl.hidden = false;
    } else {
      input.classList.remove('is-invalid');
      input.removeAttribute('aria-invalid');
      errEl.textContent = '';
      errEl.hidden = true;
    }
  }

  function clearAllErrors() {
    showFieldError(el.temperature, errorEls.temperature, null);
    showFieldError(el.topP, errorEls.top_p, null);
    showFieldError(el.maxTokens, errorEls.maxTokens, null);
    showFieldError(el.budgetTokens, errorEls.budgetTokens, null);
  }

  function validateAll() {
    var errors = {};
    var t = validateNumberField('temperature', el.temperature.value);
    if (t) errors.temperature = t;
    var p = validateNumberField('top_p', el.topP.value);
    if (p) errors.top_p = p;
    var m = validateNumberField('maxTokens', el.maxTokens.value);
    if (m) errors.maxTokens = m;
    if (el.thinkingEnabled.checked) {
      var b = validateNumberField('budgetTokens', el.budgetTokens.value);
      if (b) errors.budgetTokens = b;
    }
    return errors;
  }

  // -------------------------------------------------------------------------
  // Read form -> save payload (omit empty/undefined)
  // -------------------------------------------------------------------------

  function readFormPayload() {
    var out = {};

    var model = asString(el.model.value);
    if (model !== undefined) out.model = model;

    var variant = asString(el.variant.value);
    if (variant !== undefined) out.variant = variant;

    var reasoning = asString(el.reasoning.value);
    if (reasoning !== undefined) out.reasoningEffort = reasoning;

    var temperature = asNumber(el.temperature.value);
    if (temperature !== undefined) out.temperature = temperature;

    var topP = asNumber(el.topP.value);
    if (topP !== undefined) out.top_p = topP;

    var maxTokens = asInt(el.maxTokens.value);
    if (maxTokens !== undefined) out.maxTokens = maxTokens;

    if (el.thinkingEnabled.checked) {
      var thinking = { type: 'enabled' };
      var budget = asInt(el.budgetTokens.value);
      if (budget !== undefined) thinking.budgetTokens = budget;
      out.thinking = thinking;
    } else if (initialThinkingType === 'enabled') {
      // User toggled thinking off after it was previously enabled — emit
      // an explicit disabled marker so the host can clear the field.
      out.thinking = { type: 'disabled' };
    }
    // else: user didn't touch thinking, leave it out of the payload.

    // Fallback models: split textarea by newline, trim, drop empties.
    var raw = el.fallback.value || '';
    var lines = raw
      .split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0; });
    if (lines.length > 0) out.fallback_models = lines;

    return out;
  }

  // -------------------------------------------------------------------------
  // Status banner
  // -------------------------------------------------------------------------

  function setStatus(message, type) {
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (!message) {
      el.status.hidden = true;
      el.status.textContent = '';
      el.status.className = 'editor__status';
      return;
    }
    el.status.hidden = false;
    el.status.textContent = message;
    el.status.className = 'editor__status editor__status--' + (type || 'info');
    if (type === 'success') {
      statusTimer = setTimeout(function () {
        // Only clear if the message hasn't been replaced.
        if (el.status.textContent === message) {
          setStatus(null);
        }
      }, 3000);
    }
  }

  // -------------------------------------------------------------------------
  // Model status / datalist
  // -------------------------------------------------------------------------

  function setModelStatus(message, type) {
    if (!el.modelStatus) return;
    if (!message) {
      el.modelStatus.hidden = true;
      el.modelStatus.textContent = '';
      el.modelStatus.className = 'field__model-status';
      return;
    }
    el.modelStatus.hidden = false;
    el.modelStatus.textContent = message;
    el.modelStatus.className =
      'field__model-status field__model-status--' + (type || 'loading');
  }

  function populateModelDatalist(modelIds) {
    if (!el.modelDatalist) return;
    while (el.modelDatalist.firstChild) {
      el.modelDatalist.removeChild(el.modelDatalist.firstChild);
    }
    if (!Array.isArray(modelIds)) return;
    for (var i = 0; i < modelIds.length; i++) {
      var id = modelIds[i];
      if (typeof id !== 'string' || id.length === 0) continue;
      var opt = document.createElement('option');
      opt.value = id;
      el.modelDatalist.appendChild(opt);
    }
  }

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------

  function renderHeader() {
    if (entityKind && entityName) {
      el.eyebrow.hidden = false;
      el.subtitle.hidden = false;
      var kindLabel = entityKind === 'agent' ? 'Agent' : 'Category';
      el.title.textContent = 'Edit ' + kindLabel;
      el.subtitle.textContent = entityName;
    } else if (entityKind) {
      el.eyebrow.hidden = false;
      el.subtitle.hidden = true;
      el.title.textContent = 'Edit ' + (entityKind === 'agent' ? 'Agent' : 'Category');
    } else {
      // Pre-init: generic title; will be replaced when init arrives.
      el.eyebrow.hidden = false;
      el.subtitle.hidden = true;
      el.title.textContent = 'Edit';
    }
  }

  // -------------------------------------------------------------------------
  // Form <-> values
  // -------------------------------------------------------------------------

  function applyValuesToForm() {
    el.model.value = values.model != null ? String(values.model) : '';
    el.variant.value = values.variant != null ? String(values.variant) : '';
    el.reasoning.value =
      values.reasoningEffort != null ? String(values.reasoningEffort) : '';

    el.temperature.value =
      typeof values.temperature === 'number' ? String(values.temperature) : '';
    el.topP.value = typeof values.top_p === 'number' ? String(values.top_p) : '';
    el.maxTokens.value =
      typeof values.maxTokens === 'number' ? String(values.maxTokens) : '';

    if (values.thinking && values.thinking.type === 'enabled') {
      el.thinkingEnabled.checked = true;
      el.budgetField.hidden = false;
      el.budgetTokens.value =
        typeof values.thinking.budgetTokens === 'number'
          ? String(values.thinking.budgetTokens)
          : '';
    } else {
      el.thinkingEnabled.checked = false;
      el.budgetField.hidden = true;
      el.budgetTokens.value = '';
    }

    if (Array.isArray(values.fallback_models)) {
      el.fallback.value = values.fallback_models
        .filter(function (v) { return typeof v === 'string' && v.length > 0; })
        .join('\n');
    } else if (typeof values.fallback_models === 'string') {
      el.fallback.value = values.fallback_models;
    } else {
      el.fallback.value = '';
    }
  }

  function captureInitialState() {
    if (values.thinking && (values.thinking.type === 'enabled' || values.thinking.type === 'disabled')) {
      initialThinkingType = values.thinking.type;
    } else {
      initialThinkingType = null;
    }
  }

  // -------------------------------------------------------------------------
  // Init handler
  // -------------------------------------------------------------------------

  function applyInit(data) {
    entityKind = (data && (data.type || data.kind || data.entityKind)) || null;
    entityName = (data && (data.name || data.entityName)) || null;
    values = (data && data.config) || {};
    if (typeof values !== 'object' || values === null) values = {};

    captureInitialState();
    applyValuesToForm();
    renderHeader();
    clearAllErrors();
    setStatus(null);
    formDirty = false;
    initialized = true;

    if (el.btnSave) el.btnSave.disabled = false;
    if (el.btnCreateProfile) el.btnCreateProfile.disabled = false;
    if (root) root.setAttribute('aria-busy', 'false');

    persist();
  }

  // -------------------------------------------------------------------------
  // Save / Create profile
  // -------------------------------------------------------------------------

  function onSave() {
    if (!initialized) {
      setStatus('Form is not ready yet.', 'error');
      return;
    }

    clearAllErrors();
    var errors = validateAll();
    var hasErrors = Object.keys(errors).length > 0;

    if (errors.temperature) {
      showFieldError(el.temperature, errorEls.temperature, errors.temperature);
    }
    if (errors.top_p) {
      showFieldError(el.topP, errorEls.top_p, errors.top_p);
    }
    if (errors.maxTokens) {
      showFieldError(el.maxTokens, errorEls.maxTokens, errors.maxTokens);
    }
    if (errors.budgetTokens) {
      showFieldError(
        el.budgetTokens,
        errorEls.budgetTokens,
        errors.budgetTokens,
      );
    }

    if (hasErrors) {
      setStatus('Please fix the errors above before saving.', 'error');
      // Move focus to the first invalid field for accessibility.
      var firstInvalid = document.querySelector('.field__input.is-invalid');
      if (firstInvalid && typeof firstInvalid.focus === 'function') {
        firstInvalid.focus();
      }
      return;
    }

    var payload = readFormPayload();
    formDirty = false;
    if (vscode) {
      vscode.postMessage({ command: 'save', payload: payload });
    }
  }

  function onCreateProfile() {
    if (!initialized) {
      setStatus('Form is not ready yet.', 'error');
      return;
    }
    setStatus(null);
    if (vscode) {
      vscode.postMessage({ command: 'createProfile' });
    }
  }

  // -------------------------------------------------------------------------
  // Field change tracking
  // -------------------------------------------------------------------------

  function onFieldChange() {
    formDirty = true;
    persist();
  }

  function onThinkingToggle() {
    el.budgetField.hidden = !el.thinkingEnabled.checked;
    if (el.budgetField.hidden) {
      // Clear residual error when hiding.
      showFieldError(el.budgetTokens, errorEls.budgetTokens, null);
    }
    onFieldChange();
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  function wireEvents() {
    el.btnSave.addEventListener('click', onSave);
    el.btnCreateProfile.addEventListener('click', onCreateProfile);

    // Track edits to enable persistence.
    var trackable = [
      el.model,
      el.variant,
      el.reasoning,
      el.temperature,
      el.topP,
      el.maxTokens,
      el.budgetTokens,
      el.fallback,
    ];
    for (var i = 0; i < trackable.length; i++) {
      var input = trackable[i];
      if (!input) continue;
      input.addEventListener('input', onFieldChange);
      input.addEventListener('change', onFieldChange);
    }

    el.thinkingEnabled.addEventListener('change', onThinkingToggle);

    // Clear individual field errors as the user types — feels less punitive
    // than waiting until the next save.
    el.temperature.addEventListener('input', function () {
      showFieldError(el.temperature, errorEls.temperature, null);
    });
    el.topP.addEventListener('input', function () {
      showFieldError(el.topP, errorEls.top_p, null);
    });
    el.maxTokens.addEventListener('input', function () {
      showFieldError(el.maxTokens, errorEls.maxTokens, null);
    });
    el.budgetTokens.addEventListener('input', function () {
      showFieldError(el.budgetTokens, errorEls.budgetTokens, null);
    });

    // Cmd/Ctrl+Enter in the form is a shortcut for Save.
    el.form.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        onSave();
      }
    });

    // Warn before unload if there are unsaved changes.
    window.addEventListener('beforeunload', function (e) {
      if (formDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  // -------------------------------------------------------------------------
  // Message handler
  // -------------------------------------------------------------------------

  var pendingInit = null;

  function handleMessage(event) {
    var msg = event && event.data;
    if (!msg || typeof msg !== 'object') return;
    var command = msg.command;
    if (!command) return;
    switch (command) {
      case 'init': {
        var payload = msg;
        if (document.readyState === 'loading') {
          pendingInit = payload;
        } else {
          applyInit(payload);
        }
        break;
      }
      case 'saved':
        setStatus('Saved.', 'success');
        formDirty = false;
        break;
      case 'error':
        setStatus(
          (msg && msg.message) ? String(msg.message) : 'Host reported an error',
          'error',
        );
        break;
      case 'profileCreated':
        setStatus('Profile "' + (msg.name || '') + '" created.', 'success');
        break;
      case 'modelsLoading':
        setModelStatus('Loading available models…', 'loading');
        break;
      case 'modelsLoaded': {
        var raw = msg && msg.models;
        var ids = Array.isArray(raw)
          ? raw
              .map(function (m) {
                return m && typeof m === 'object' ? m.modelId : undefined;
              })
              .filter(function (id) {
                return typeof id === 'string' && id.length > 0;
              })
          : [];
        populateModelDatalist(ids);
        if (ids.length > 0) {
          setModelStatus(
            ids.length + ' model' + (ids.length === 1 ? '' : 's') + ' available — type to filter.',
            'loaded',
          );
        } else {
          setModelStatus('No models reported by the local CLI.', 'loaded');
        }
        break;
      }
      case 'modelsUnavailable': {
        var err =
          msg && typeof msg.error === 'string' && msg.error.length > 0
            ? msg.error
            : 'the local opencode CLI is unavailable';
        setModelStatus(
          'Model list unavailable (' + err + '). You can type any model identifier.',
          'unavailable',
        );
        break;
      }
      default:
        break;
    }
  }

  function setupMessageHandler() {
    window.addEventListener('message', handleMessage);
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  function boot() {
    // Restore any persisted state so a hide/show cycle keeps unsaved edits.
    var persisted = restorePersisted();
    if (persisted) {
      entityKind = persisted.kind || null;
      entityName = persisted.name || null;
      if (persisted.values && typeof persisted.values === 'object') {
        values = persisted.values;
      }
      captureInitialState();
      applyValuesToForm();
      renderHeader();
    } else {
      renderHeader();
    }

    wireEvents();
    setupMessageHandler();

    // Apply any init that arrived before we finished booting.
    if (pendingInit) {
      applyInit(pendingInit);
      pendingInit = null;
    }

    if (vscode) {
      vscode.postMessage({ command: 'ready' });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
