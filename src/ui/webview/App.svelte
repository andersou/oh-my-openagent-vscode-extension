<script>
  import { onMount } from 'svelte';

  let entityKind = $state(null);
  let entityName = $state(null);
  let model = $state('');
  let variant = $state('');
  let reasoning = $state('');
  let temperature = $state('');
  let topP = $state('');
  let maxTokens = $state('');
  let thinkingEnabled = $state(false);
  let budgetTokens = $state('');
  let fallbackModels = $state([]);
  let initialThinkingType = $state(null);
  let initialized = $state(false);
  let formDirty = $state(false);
  let status = $state({ message: '', type: '' });
  let modelStatus = $state({ message: '', type: 'loading' });
  let modelDatalist = $state([]);
  let modelMetadata = $state({});
  let availableVariants = $state([]);
  let availableReasoning = $state([]);

  const FALLBACK_VARIANTS = ['max', 'xhigh', 'high', 'medium', 'low'];
  const FALLBACK_REASONING = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  let capabilities = $derived(modelMetadata[model]?.capabilities ?? null);
  let variants = $derived(modelMetadata[model]?.variants ?? null);
  let temperatureSupported = $derived(capabilities ? capabilities.temperature !== false : true);
  let reasoningSupported = $derived(capabilities ? capabilities.reasoning !== false : true);

  let vscodeApi = null;
  let modelChangeTimer = null;
  let statusTimer = null;

  function getApi() {
    if (vscodeApi) return vscodeApi;
    if (typeof globalThis !== 'undefined' && globalThis.acquireVsCodeApi) {
      try {
        vscodeApi = globalThis.acquireVsCodeApi();
        return vscodeApi;
      } catch {
        return null;
      }
    }
    return null;
  }

  function postMessage(msg) {
    const api = getApi();
    if (api) api.postMessage(msg);
  }

  function setStatus(message, type = 'info') {
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    status = { message: message ?? '', type };
    if (type === 'success' && message) {
      statusTimer = setTimeout(() => {
        if (status.message === message) status = { message: '', type: 'info' };
      }, 3000);
    }
  }

  function setModelStatus(message, type = 'loading') {
    modelStatus = { message: message ?? '', type };
  }

  function persist() {
    const api = getApi();
    if (!api || typeof api.setState !== 'function') return;
    try {
      api.setState({ kind: entityKind, name: entityName, values: serializeValues() });
    } catch {}
  }

  function restorePersisted() {
    const api = getApi();
    if (!api || typeof api.getState !== 'function') return null;
    try {
      const s = api.getState();
      return s && typeof s === 'object' ? s : null;
    } catch {
      return null;
    }
  }

  function asString(v) {
    if (v == null) return undefined;
    const s = String(v).trim();
    return s.length > 0 ? s : undefined;
  }

  function asNumber(v) {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }

  function asInt(v) {
    const n = asNumber(v);
    if (n === undefined) return undefined;
    return Number.isInteger(n) ? n : undefined;
  }

  function validateNumber(name, raw) {
    if (raw === '' || raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 'Must be a number';
    if (name === 'temperature' && (n < 0 || n > 2)) return 'Temperature must be 0\u20132';
    if (name === 'top_p' && (n < 0 || n > 1)) return 'Top-p must be 0\u20131';
    if ((name === 'maxTokens' || name === 'budgetTokens') && (!Number.isInteger(n) || n < 1)) {
      return name === 'maxTokens' ? 'Max tokens must be a whole number \u2265 1' : 'Budget tokens must be a whole number \u2265 1';
    }
    return null;
  }

  function validateAll() {
    return {
      temperature: validateNumber('temperature', temperature),
      top_p: validateNumber('top_p', topP),
      maxTokens: validateNumber('maxTokens', maxTokens),
      budgetTokens: thinkingEnabled ? validateNumber('budgetTokens', budgetTokens) : null,
    };
  }

  function readFormPayload() {
    const out = {};
    if (asString(model) !== undefined) out.model = asString(model);
    // Explicit null clears the key from the JSON override (vs omitting
    // it, which preserves whatever was already there).
    out.variant = asString(variant) ?? null;
    out.reasoningEffort = asString(reasoning) ?? null;
    out.temperature = asNumber(temperature) ?? null;
    out.top_p = asNumber(topP) ?? null;
    out.maxTokens = asInt(maxTokens) ?? null;
    if (thinkingEnabled) {
      const thinking = { type: 'enabled' };
      const b = asInt(budgetTokens);
      if (b !== undefined) thinking.budgetTokens = b;
      out.thinking = thinking;
    } else if (initialThinkingType === 'enabled') {
      out.thinking = { type: 'disabled' };
    }
    const fallbacks = readFallbackCards();
    if (fallbacks !== undefined) out.fallback_models = fallbacks;
    return out;
  }

  function readFallbackCards() {
    if (fallbackModels.length === 0) return undefined;
    return fallbackModels.map((entry) => {
      const e = { model: entry.model };
      if (entry.variant) e.variant = entry.variant;
      if (entry.reasoningEffort) e.reasoningEffort = entry.reasoningEffort;
      if (entry.temperature !== undefined && entry.temperature !== null && entry.temperature !== '') {
        e.temperature = Number(entry.temperature);
      }
      if (entry.top_p !== undefined && entry.top_p !== null && entry.top_p !== '') {
        e.top_p = Number(entry.top_p);
      }
      if (entry.maxTokens !== undefined && entry.maxTokens !== null && entry.maxTokens !== '') {
        e.maxTokens = Number(entry.maxTokens);
      }
      if (entry.thinking) {
        const t = { type: 'enabled' };
        if (entry.thinking.budgetTokens !== undefined && entry.thinking.budgetTokens !== null && entry.thinking.budgetTokens !== '') {
          t.budgetTokens = Number(entry.thinking.budgetTokens);
        }
        e.thinking = t;
      }
      return e;
    });
  }

  function serializeValues() {
    return {
      model, variant, reasoningEffort: reasoning,
      temperature: asNumber(temperature), top_p: asNumber(topP), maxTokens: asInt(maxTokens),
      thinking: thinkingEnabled ? { type: 'enabled', budgetTokens: asInt(budgetTokens) } : { type: 'disabled' },
      fallback_models: readFallbackCards() || [],
    };
  }

  function applyInit(data) {
    entityKind = data?.type ?? null;
    entityName = data?.name ?? null;
    const cfg = data?.config ?? {};
    model = cfg.model != null ? String(cfg.model) : '';
    variant = cfg.variant != null ? String(cfg.variant) : '';
    reasoning = cfg.reasoningEffort != null ? String(cfg.reasoningEffort) : '';
    temperature = typeof cfg.temperature === 'number' ? String(cfg.temperature) : '';
    topP = typeof cfg.top_p === 'number' ? String(cfg.top_p) : '';
    maxTokens = typeof cfg.maxTokens === 'number' ? String(cfg.maxTokens) : '';
    thinkingEnabled = !!(cfg.thinking && cfg.thinking.type === 'enabled');
    budgetTokens = thinkingEnabled && typeof cfg.thinking.budgetTokens === 'number' ? String(cfg.thinking.budgetTokens) : '';
    initialThinkingType = cfg.thinking?.type === 'enabled' || cfg.thinking?.type === 'disabled' ? cfg.thinking.type : null;
    if (Array.isArray(cfg.fallback_models)) {
      fallbackModels = cfg.fallback_models.map((entry) => {
        if (typeof entry === 'string') return { model: entry };
        return { ...entry, model: entry.model ?? '' };
      });
    } else if (typeof cfg.fallback_models === 'string' && cfg.fallback_models.length > 0) {
      fallbackModels = [{ model: cfg.fallback_models }];
    } else {
      fallbackModels = [];
    }
    formDirty = false;
    initialized = true;
    setStatus(null);
    setModelStatus(null);
    persist();
  }

  function onModelInput() {
    updateDynamicFieldsForModel(model);
    formDirty = true;
    persist();
    if (modelChangeTimer) clearTimeout(modelChangeTimer);
    const current = model;
    if (!current) return;
    modelChangeTimer = setTimeout(() => {
      modelChangeTimer = null;
      postMessage({ command: 'modelChanged', modelId: current });
    }, 200);
  }

  function updateDynamicFieldsForModel(modelId) {
    const meta = modelMetadata[modelId];
    const variantKeys = meta?.variants && typeof meta.variants === 'object' && !Array.isArray(meta.variants)
      ? Object.keys(meta.variants)
      : [];
    availableVariants = variantKeys.length > 0 ? ['', ...variantKeys.sort()] : [''];
    const fromVariants = [];
    if (variantKeys.length > 0 && meta.variants) {
      for (const v of Object.values(meta.variants)) {
        if (v && typeof v === 'object' && typeof v.reasoningEffort === 'string') {
          fromVariants.push(v.reasoningEffort);
        }
      }
    }
    const seen = new Set();
    const opts = [''];
    for (const r of fromVariants) {
      if (!seen.has(r)) { opts.push(r); seen.add(r); }
    }
    for (const r of FALLBACK_REASONING) {
      if (!seen.has(r)) { opts.push(r); seen.add(r); }
    }
    availableReasoning = opts;
  }

  function onSave() {
    if (!initialized) {
      setStatus('Form is not ready yet.', 'error');
      return;
    }
    const errors = validateAll();
    if (errors.temperature || errors.top_p || errors.maxTokens || errors.budgetTokens) {
      setStatus('Please fix the errors above before saving.', 'error');
      return;
    }
    const payload = readFormPayload();
    formDirty = false;
    postMessage({ command: 'save', payload });
  }

  function onCreateProfile() {
    if (!initialized) {
      setStatus('Form is not ready yet.', 'error');
      return;
    }
    postMessage({ command: 'createProfile' });
  }

  function onReloadModels() {
    postMessage({ command: 'reloadModels' });
  }

  function onAddFallback() {
    fallbackModels = [...fallbackModels, { model: '' }];
    formDirty = true;
    persist();
  }

  function onRemoveFallback(index) {
    fallbackModels = fallbackModels.filter((_, i) => i !== index);
    formDirty = true;
    persist();
  }

  function onSwitchMain(index) {
    const entry = fallbackModels[index];
    if (!entry || !entry.model) return;

    const currentModel = model;
    const currentVariant = variant;

    // Promote fallback to main
    model = entry.model;
    variant = entry.variant || '';

    // Demote current main to the fallback slot
    fallbackModels[index] = {
      ...entry,
      model: currentModel || fallbackModels[index].model,
      variant: currentVariant || '',
    };

    // Recompute capabilities / variant / reasoning options for the new model
    updateDynamicFieldsForModel(model);

    // Update the tree sidebar preview so it reflects the swap before Save
    if (model) {
      if (modelChangeTimer) clearTimeout(modelChangeTimer);
      modelChangeTimer = setTimeout(() => {
        modelChangeTimer = null;
        postMessage({ command: 'modelChanged', modelId: model });
      }, 200);
    }

    formDirty = true;
    persist();
  }

  function onThinkingToggle() {
    if (!thinkingEnabled) budgetTokens = '';
    formDirty = true;
    persist();
  }

  function onFieldChange() {
    formDirty = true;
    persist();
  }

  function handleMessage(event) {
    const msg = event?.data;
    if (!msg || typeof msg !== 'object') return;
    const { command } = msg;
    if (command === 'init') {
      applyInit(msg);
    } else if (command === 'saved') {
      setStatus('Saved.', 'success');
      formDirty = false;
    } else if (command === 'error') {
      setStatus(msg.message ? String(msg.message) : 'Host reported an error', 'error');
    } else if (command === 'profileCreated') {
      setStatus(`Profile "${msg.name || ''}" created.`, 'success');
    } else if (command === 'modelsLoading') {
      setModelStatus('Loading available models\u2026', 'loading');
    } else if (command === 'modelsLoaded') {
      const raw = Array.isArray(msg.models) ? msg.models : [];
      const models = raw.filter((m) => m && typeof m === 'object' && typeof m.modelId === 'string' && m.modelId.length > 0);
      const ids = models.map((m) => m.modelId);
      modelDatalist = ids;
      for (const m of models) {
        modelMetadata = { ...modelMetadata, [m.modelId]: m };
      }
      updateDynamicFieldsForModel(model);
      if (ids.length > 0) {
        setModelStatus(`${ids.length} model${ids.length === 1 ? '' : 's'} available \u2014 type to filter.`, 'loaded');
      } else {
        setModelStatus('No models reported by the local CLI.', 'loaded');
      }
    } else if (command === 'modelsUnavailable') {
      const err = typeof msg.error === 'string' && msg.error.length > 0 ? msg.error : 'the local opencode CLI is unavailable';
      setModelStatus(`Model list unavailable (${err}). You can type any model identifier.`, 'unavailable');
    }
  }

  onMount(() => {
    const persisted = restorePersisted();
    if (persisted) {
      entityKind = persisted.kind || null;
      entityName = persisted.name || null;
      if (persisted.values) applyInit({ type: persisted.kind, name: persisted.name, config: persisted.values });
    }
    window.addEventListener('message', handleMessage);
    postMessage({ command: 'ready' });
  });
</script>

<svelte:window onkeydown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSave(); }} />

<main class="editor" id="editor" aria-busy={!initialized}>
  <header class="editor__header">
    <p class="editor__eyebrow" id="eyebrow">Oh My OpenAgent</p>
    <h1 class="editor__title" id="title">Edit {entityKind === 'agent' ? 'Agent' : entityKind === 'category' ? 'Category' : ''}</h1>
    <p class="editor__subtitle" id="subtitle">{entityName ?? ''}</p>
  </header>

  <form id="editor-form" class="editor__form" onsubmit={(e) => { e.preventDefault(); onSave(); }} novalidate autocomplete="off">
    <section class="editor__section" data-section="model">
      <header class="editor__section-header">
        <h2 class="editor__section-title">Model</h2>
        <p class="editor__section-desc">Override the default model and tuning tier.</p>
      </header>

      <div class="field">
        <label class="field__label" for="f-model">Model</label>
        <div class="field__model-row">
          <input
            class="field__input field__input--mono"
            type="text"
            id="f-model"
            name="model"
            list="model-datalist"
            placeholder="provider/model-name"
            spellcheck="false"
            autocapitalize="off"
            autocorrect="off"
            bind:value={model}
            oninput={onModelInput}
            onchange={onModelInput}
          />
          <button
            type="button"
            class="vscode-button vscode-button--icon"
            id="btn-reload-models"
            title="Reload available models from the local opencode CLI"
            aria-label="Reload available models"
            onclick={onReloadModels}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4.5 2A1.5 1.5 0 0 0 3 3.5v.35a.5.5 0 0 0 1 0V3.5a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-.35a.5.5 0 0 0-1 0v.35A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 11.5 1h-7ZM8.854 5.146a.5.5 0 0 0-.708 0l-2.5 2.5a.5.5 0 1 0 .708.708L8 6.207l2.146 2.147a.5.5 0 1 0 .708-.708l-2.5-2.5a.5.5 0 0 0-.708 0Z"/>
              <path d="M5.354 8.146a.5.5 0 0 0-.708.708l2.5 2.5a.5.5 0 0 0 .708 0l2.5-2.5a.5.5 0 0 0-.708-.708L8 10.293 5.354 7.646Z"/>
            </svg>
          </button>
        </div>
        <datalist id="model-datalist">
          {#each modelDatalist as id}
            <option value={id}></option>
          {/each}
        </datalist>
        <p class="field__hint">Provider-qualified model identifier, e.g. <code>anthropic/claude-sonnet-4</code></p>
        <p
          class="field__model-status field__model-status--{modelStatus.type}"
          id="model-status"
          role="status"
          aria-live="polite"
          hidden={!modelStatus.message}
        >{modelStatus.message}</p>
      </div>

      <div class="field-grid">
        <div class="field">
          <label class="field__label" for="f-variant">Variant</label>
          <select class="field__input" id="f-variant" name="variant" bind:value={variant} onchange={onFieldChange} disabled={!model}>
            {#each availableVariants as v}
              <option value={v}>{v === '' ? '(default)' : v}</option>
            {/each}
          </select>
        </div>

        <div class="field">
          <label class="field__label" for="f-reasoning">Reasoning effort</label>
          <select class="field__input" id="f-reasoning" name="reasoningEffort" bind:value={reasoning} onchange={onFieldChange} disabled={!reasoningSupported}>
            {#each availableReasoning as r}
              <option value={r}>{r === '' ? '(default)' : r}</option>
            {/each}
          </select>
        </div>
      </div>
    </section>

    <section class="editor__section" data-section="sampling" hidden={!temperatureSupported}>
      <header class="editor__section-header">
        <h2 class="editor__section-title">Sampling</h2>
        <p class="editor__section-desc">Generation parameters applied per request.</p>
      </header>

      <div class="field-grid field-grid--three">
        <div class="field">
          <label class="field__label" for="f-temperature">Temperature</label>
          <input class="field__input" type="number" id="f-temperature" name="temperature" step="0.1" min="0" max="2" inputmode="decimal" placeholder="0.0 \u2013 2.0" bind:value={temperature} oninput={onFieldChange} onchange={onFieldChange} disabled={!temperatureSupported} title={temperatureSupported ? '' : 'This model does not support temperature.'} />
        </div>
        <div class="field">
          <label class="field__label" for="f-top-p">Top-p</label>
          <input class="field__input" type="number" id="f-top-p" name="top_p" step="0.05" min="0" max="1" inputmode="decimal" placeholder="0.0 \u2013 1.0" bind:value={topP} oninput={onFieldChange} onchange={onFieldChange} disabled={!temperatureSupported} title={temperatureSupported ? '' : 'This model does not support sampling parameters.'} />
        </div>
        <div class="field">
          <label class="field__label" for="f-max-tokens">Max tokens</label>
          <input class="field__input" type="number" id="f-max-tokens" name="maxTokens" step="1" min="1" inputmode="numeric" placeholder="e.g. 4096" bind:value={maxTokens} oninput={onFieldChange} onchange={onFieldChange} disabled={!temperatureSupported} title={temperatureSupported ? '' : 'This model does not support max tokens.'} />
        </div>
      </div>
    </section>

    <section class="editor__section" data-section="thinking" hidden={!reasoningSupported}>
      <header class="editor__section-header">
        <h2 class="editor__section-title">Thinking</h2>
        <p class="editor__section-desc">Extended reasoning budget for models that support it.</p>
      </header>

      <div class="field field--checkbox">
        <input class="field__checkbox" type="checkbox" id="f-thinking-enabled" name="thinkingEnabled" bind:checked={thinkingEnabled} onchange={onThinkingToggle} disabled={!reasoningSupported} />
        <label class="field__label field__label--inline" for="f-thinking-enabled">Enable extended thinking</label>
      </div>

      <div class="field field--nested" id="f-budget-field" hidden={!thinkingEnabled}>
        <label class="field__label" for="f-budget-tokens">Budget tokens</label>
        <input class="field__input" type="number" id="f-budget-tokens" name="budgetTokens" step="1" min="1" inputmode="numeric" placeholder="e.g. 8192" bind:value={budgetTokens} oninput={onFieldChange} onchange={onFieldChange} disabled={!reasoningSupported} />
        <p class="field__hint">Token budget reserved for chain-of-thought reasoning.</p>
      </div>
    </section>

    <section class="editor__section" data-section="fallback">
      <header class="editor__section-header">
        <h2 class="editor__section-title">Fallback models</h2>
        <p class="editor__section-desc">Tried in order when the primary model is unavailable.</p>
      </header>

      <div class="fallback-list" id="fallback-list" role="list">
        {#each fallbackModels as entry, i (i)}
          <div class="fallback-card" role="listitem">
            <div class="fallback-card__header">
              <h3 class="fallback-card__title">Fallback {i + 1}</h3>
              <div class="fallback-card__actions">
                <button type="button" class="fallback-card__switch" onclick={() => onSwitchMain(i)} disabled={!entry.model}>Switch as Main</button>
                <button type="button" class="fallback-card__remove" onclick={() => onRemoveFallback(i)}>Remove</button>
              </div>
            </div>
            <div class="fallback-card__row">
              <div class="field">
                <label class="field__label" for="fb-model-{i}">Model</label>
                <input class="field__input field__input--mono" type="text" id="fb-model-{i}" list="model-datalist" placeholder="provider/model-name" spellcheck="false" autocapitalize="off" autocorrect="off" bind:value={entry.model} oninput={onFieldChange} />
              </div>
              <div class="field">
                <label class="field__label" for="fb-variant-{i}">Variant</label>
                <select class="field__input" id="fb-variant-{i}" bind:value={entry.variant} onchange={onFieldChange}>
                  <option value="">(default)</option>
                  {#each FALLBACK_VARIANTS as v}
                    <option value={v}>{v}</option>
                  {/each}
                </select>
              </div>
              <div class="field">
                <label class="field__label" for="fb-reasoning-{i}">Reasoning</label>
                <select class="field__input" id="fb-reasoning-{i}" bind:value={entry.reasoningEffort} onchange={onFieldChange}>
                  <option value="">(default)</option>
                  {#each FALLBACK_REASONING as r}
                    <option value={r}>{r}</option>
                  {/each}
                </select>
              </div>
            </div>
            <div class="fallback-card__row fallback-card__row--sampling">
              <div class="field">
                <label class="field__label" for="fb-temperature-{i}">Temperature</label>
                <input class="field__input" type="number" id="fb-temperature-{i}" step="0.1" min="0" max="2" bind:value={entry.temperature} oninput={onFieldChange} />
              </div>
              <div class="field">
                <label class="field__label" for="fb-top-p-{i}">Top-p</label>
                <input class="field__input" type="number" id="fb-top-p-{i}" step="0.05" min="0" max="1" bind:value={entry.top_p} oninput={onFieldChange} />
              </div>
              <div class="field">
                <label class="field__label" for="fb-max-tokens-{i}">Max tokens</label>
                <input class="field__input" type="number" id="fb-max-tokens-{i}" step="1" min="1" bind:value={entry.maxTokens} oninput={onFieldChange} />
              </div>
            </div>
            <div class="fallback-card__row fallback-card__row--thinking">
              <div class="fallback-card__checkbox">
                <input type="checkbox" id="fb-thinking-{i}" bind:checked={entry.thinking} onchange={onFieldChange} />
                <label for="fb-thinking-{i}">Enable thinking</label>
              </div>
              <div class="field">
                <label class="field__label" for="fb-budget-{i}">Budget tokens</label>
                <input class="field__input" type="number" id="fb-budget-{i}" step="1" min="1" bind:value={entry.thinking.budgetTokens} disabled={!entry.thinking} oninput={onFieldChange} />
              </div>
            </div>
          </div>
        {/each}
      </div>

      <button type="button" class="vscode-button vscode-button--secondary" id="btn-add-fallback" onclick={onAddFallback}>Add fallback</button>
    </section>

    <div class="editor__status editor__status--{status.type || 'info'}" id="status" role="status" aria-live="polite" hidden={!status.message}>{status.message}</div>

    <div class="editor__actions">
      <button type="button" class="vscode-button vscode-button--secondary" id="btn-create-profile" onclick={onCreateProfile} disabled={!initialized}>Create Profile</button>
      <button type="button" class="vscode-button vscode-button--primary" id="btn-save" onclick={onSave} disabled={!initialized}>Save</button>
    </div>
  </form>
</main>

<style>
  @keyframes editor-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .editor {
    max-width: 720px;
    margin: 0 auto;
    padding: 28px 32px 64px;
    font-family: var(--vscode-font-family, system-ui, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    line-height: 1.5;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .editor__header { margin-bottom: 28px; padding-bottom: 18px; border-bottom: 1px solid var(--vscode-widget-border); }
  .editor__eyebrow { margin: 0 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); }
  .editor__title { margin: 0 0 6px; font-size: 20px; font-weight: 600; color: var(--vscode-foreground); }
  .editor__subtitle { margin: 0; font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 12px; color: var(--vscode-descriptionForeground); word-break: break-all; }
  .editor__form { display: flex; flex-direction: column; gap: 18px; }
  .editor__section { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 18px; background: var(--vscode-sideBar-background, transparent); border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
  .editor__section-header { display: flex; flex-direction: column; gap: 2px; margin-bottom: 2px; }
  .editor__section-title { margin: 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--vscode-foreground); }
  .editor__section-desc { margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .field--checkbox { flex-direction: row; align-items: center; gap: 8px; padding: 2px 0; }
  .field--nested { padding-left: 24px; border-left: 2px solid var(--vscode-widget-border); margin-left: 4px; }
  .field__label { font-size: 12px; font-weight: 500; color: var(--vscode-foreground); }
  .field__label--inline { cursor: pointer; user-select: none; }
  .field__input { width: 100%; font-family: inherit; font-size: var(--vscode-font-size, 13px); line-height: 1.4; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 5px 8px; outline: none; }
  .field__input--mono { font-family: var(--vscode-editor-font-family, ui-monospace, monospace); font-size: 12.5px; }
  .field__input:disabled { opacity: 0.55; cursor: not-allowed; }
  .field__input:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .field__hint { margin: 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .field__model-row { display: flex; gap: 8px; align-items: stretch; }
  .field__model-row .field__input { flex: 1 1 auto; min-width: 0; }
  .field__model-status { margin: 0; font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 6px; }
  .field__model-status::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.7; }
  .field__model-status--loading { color: var(--vscode-descriptionForeground); font-style: italic; }
  .field__model-status--loaded { color: var(--vscode-textLink-foreground); }
  .field__model-status--unavailable { color: var(--vscode-descriptionForeground); }
  .field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .field-grid--three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .editor__status { margin: 0; padding: 8px 12px; font-size: 12px; color: var(--vscode-foreground); background: var(--vscode-textBlockQuote-background); border-left: 2px solid var(--vscode-textBlockQuote-border); border-radius: 0 2px 2px 0; }
  .editor__status--error { background: var(--vscode-inputValidation-errorBackground); border-left-color: var(--vscode-errorForeground); color: var(--vscode-errorForeground); }
  .editor__status--success { border-left-color: var(--vscode-textLink-foreground); }
  .editor__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
  .vscode-button { font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: var(--vscode-font-size, 13px); line-height: 1; padding: 7px 14px; border: 1px solid transparent; border-radius: 2px; cursor: pointer; user-select: none; }
  .vscode-button:disabled { opacity: 0.5; cursor: not-allowed; }
  .vscode-button--primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .vscode-button--secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .vscode-button--icon { display: inline-flex; align-items: center; justify-content: center; padding: 0 8px; }
  .fallback-list { display: flex; flex-direction: column; gap: 10px; }
  .fallback-card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; background: var(--vscode-input-background); border: 1px solid var(--vscode-widget-border); border-radius: 3px; }
  .fallback-card__row { display: grid; grid-template-columns: 1fr 140px 140px; gap: 8px; align-items: end; }
  .fallback-card__row--sampling { grid-template-columns: 1fr 1fr 1fr; }
  .fallback-card__row--thinking { grid-template-columns: 1fr 1fr; align-items: center; }
  .fallback-card__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .fallback-card__title { margin: 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
  .fallback-card__actions { display: flex; align-items: center; gap: 6px; }
  .fallback-card__switch { background: transparent; border: 1px solid var(--vscode-textLink-foreground); color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; padding: 2px 8px; border-radius: 2px; font-weight: 500; }
  .fallback-card__switch:hover { background: var(--vscode-textLink-foreground); color: var(--vscode-button-foreground, #fff); }
  .fallback-card__switch:disabled { opacity: 0.4; cursor: not-allowed; border-color: var(--vscode-descriptionForeground); color: var(--vscode-descriptionForeground); }
  .fallback-card__switch:disabled:hover { background: transparent; color: var(--vscode-descriptionForeground); }
  .fallback-card__remove { background: transparent; border: 1px solid transparent; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 2px; }
  .fallback-card__remove:hover { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .fallback-card__checkbox { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .fallback-card .field__input { font-size: 12px; padding: 4px 6px; }
  @media (max-width: 520px) {
    .fallback-card__row, .fallback-card__row--sampling, .fallback-card__row--thinking { grid-template-columns: 1fr; }
    .field-grid, .field-grid--three { grid-template-columns: 1fr; }
  }
</style>
