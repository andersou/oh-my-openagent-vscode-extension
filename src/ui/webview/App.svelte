<script module>
  let fallbackUid = 0;

  function nextFallbackUid() {
    fallbackUid += 1;
    return fallbackUid;
  }
</script>

<script>
  import { onMount, tick } from 'svelte';
  import { moveItem } from './reorder.js';

  let entityKind = $state(null);
  let entityName = $state(null);
  let modelCards = $state([createModelCard()]);
  let initialThinkingType = $state(null);
  let initialized = $state(false);
  let formDirty = $state(false);
  let samplingOpen = $state(false);
  let thinkingOpen = $state(false);
  let status = $state({ message: '', type: '' });
  let modelStatus = $state({ message: '', type: 'loading' });
  let modelDatalist = $state([]);
  let modelMetadata = $state({});
  let availableVariants = $state([]);
  let availableReasoning = $state([]);
  let dragIndex = $state(null);
  let dragOverIndex = $state(null);
  let keyboardDragStartIndex = $state(null);
  let dragAnnouncement = $state('');

  const FALLBACK_VARIANTS = ['max', 'xhigh', 'high', 'medium', 'low'];
  const FALLBACK_REASONING = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  let mainModel = $derived(modelCards[0]);
  let capabilities = $derived(modelMetadata[mainModel?.model]?.capabilities ?? null);
  let variants = $derived(modelMetadata[mainModel?.model]?.variants ?? null);
  let temperatureSupported = $derived(capabilities ? capabilities.temperature !== false : true);
  let reasoningSupported = $derived(capabilities ? capabilities.reasoning !== false : true);

  let vscodeApi = null;
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

  function createModelCard(entry = {}) {
    const thinking = entry.thinking && entry.thinking.type === 'enabled'
      ? entry.thinking
      : null;
    return {
      model: entry.model != null ? String(entry.model) : '',
      variant: entry.variant != null ? String(entry.variant) : '',
      reasoningEffort: entry.reasoningEffort != null ? String(entry.reasoningEffort) : '',
      temperature: entry.temperature !== undefined && entry.temperature !== null && entry.temperature !== '' ? String(entry.temperature) : '',
      top_p: entry.top_p !== undefined && entry.top_p !== null && entry.top_p !== '' ? String(entry.top_p) : '',
      maxTokens: entry.maxTokens !== undefined && entry.maxTokens !== null && entry.maxTokens !== '' ? String(entry.maxTokens) : '',
      thinkingEnabled: thinking !== null,
      budgetTokens: thinking?.budgetTokens !== undefined && thinking?.budgetTokens !== null && thinking?.budgetTokens !== '' ? String(thinking.budgetTokens) : '',
      __uid: nextFallbackUid(),
    };
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
      temperature: validateNumber('temperature', mainModel.temperature),
      top_p: validateNumber('top_p', mainModel.top_p),
      maxTokens: validateNumber('maxTokens', mainModel.maxTokens),
      budgetTokens: mainModel.thinkingEnabled ? validateNumber('budgetTokens', mainModel.budgetTokens) : null,
    };
  }

  function readFormPayload() {
    const out = {};
    if (asString(mainModel.model) !== undefined) out.model = asString(mainModel.model);
    // Explicit null clears the key from the JSON override (vs omitting
    // it, which preserves whatever was already there).
    out.variant = asString(mainModel.variant) ?? null;
    out.reasoningEffort = asString(mainModel.reasoningEffort) ?? null;
    out.temperature = asNumber(mainModel.temperature) ?? null;
    out.top_p = asNumber(mainModel.top_p) ?? null;
    out.maxTokens = asInt(mainModel.maxTokens) ?? null;
    if (mainModel.thinkingEnabled) {
      const thinking = { type: 'enabled' };
      const b = asInt(mainModel.budgetTokens);
      if (b !== undefined) thinking.budgetTokens = b;
      out.thinking = thinking;
    } else if (initialThinkingType === 'enabled') {
      out.thinking = { type: 'disabled' };
    }
    if (modelCards.length > 1) out.fallback_models = modelCards.slice(1).map(readModelCard);
    return out;
  }

  function readModelCard(entry) {
    const out = { model: entry.model };
    if (entry.variant) out.variant = entry.variant;
    if (entry.reasoningEffort) out.reasoningEffort = entry.reasoningEffort;
    if (entry.temperature !== '') out.temperature = Number(entry.temperature);
    if (entry.top_p !== '') out.top_p = Number(entry.top_p);
    if (entry.maxTokens !== '') out.maxTokens = Number(entry.maxTokens);
    if (entry.thinkingEnabled) {
      const thinking = { type: 'enabled' };
      if (entry.budgetTokens !== '') thinking.budgetTokens = Number(entry.budgetTokens);
      out.thinking = thinking;
    }
    return out;
  }

  function serializeValues() {
    return {
      model: mainModel.model,
      variant: mainModel.variant,
      reasoningEffort: mainModel.reasoningEffort,
      temperature: asNumber(mainModel.temperature),
      top_p: asNumber(mainModel.top_p),
      maxTokens: asInt(mainModel.maxTokens),
      thinking: mainModel.thinkingEnabled
        ? { type: 'enabled', budgetTokens: asInt(mainModel.budgetTokens) }
        : { type: 'disabled' },
      fallback_models: modelCards.slice(1).map(readModelCard),
    };
  }

  function applyInit(data) {
    entityKind = data?.type ?? null;
    entityName = data?.name ?? null;
    const cfg = data?.config ?? {};
    initialThinkingType = cfg.thinking?.type === 'enabled' || cfg.thinking?.type === 'disabled' ? cfg.thinking.type : null;
    const fallbackEntries = Array.isArray(cfg.fallback_models)
      ? cfg.fallback_models
      : typeof cfg.fallback_models === 'string' && cfg.fallback_models.length > 0
        ? [cfg.fallback_models]
        : [];
    modelCards = [
      createModelCard(cfg),
      ...fallbackEntries.map((entry) => createModelCard(
        typeof entry === 'string' ? { model: entry } : entry,
      )),
    ];
    formDirty = false;
    initialized = true;
    setStatus(null);
    setModelStatus(null);
    persist();
  }

  function onModelInput() {
    updateDynamicFieldsForModel(mainModel.model);
    formDirty = true;
    persist();
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
    modelCards = [...modelCards, createModelCard()];
    formDirty = true;
    persist();
  }

  function canMoveModel(from, to) {
    const length = modelCards.length;
    return Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= 0 && from < length && to < length && from !== to;
  }

  function moveModel(from, to) {
    if (!canMoveModel(from, to)) return false;
    modelCards = moveItem(modelCards, from, to);
    updateDynamicFieldsForModel(mainModel.model);
    formDirty = true;
    persist();
    return true;
  }

  function clearDragState() {
    dragIndex = null;
    dragOverIndex = null;
    keyboardDragStartIndex = null;
  }

  function onModelDragStart(event, index) {
    keyboardDragStartIndex = null;
    dragIndex = index;
    dragOverIndex = index;
    event.dataTransfer?.setData('text/plain', String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function onModelDragOver(event, index) {
    event.preventDefault();
    dragOverIndex = index;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  function onModelDrop(event, index) {
    event.preventDefault();
    moveModel(dragIndex, index);
    clearDragState();
  }

  function modelPosition(index) {
    return index === 0 ? 'Main model' : `Fallback ${index}`;
  }

  function focusModelHandle(uid) {
    tick().then(() => {
      document.querySelector(`[data-model-card-uid="${uid}"]`)?.focus();
    });
  }

  function onModelKeydown(event, index) {
    const isPickupKey = event.key === ' ' || event.key === 'Enter';
    if (keyboardDragStartIndex === null) {
      if (!isPickupKey) return;
      event.preventDefault();
      dragIndex = index;
      dragOverIndex = index;
      keyboardDragStartIndex = index;
      dragAnnouncement = `${modelPosition(index)} picked up. Use Arrow Up or Arrow Down to move, Space or Enter to drop, Escape to cancel.`;
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      const restoreIndex = keyboardDragStartIndex;
      if (dragIndex !== restoreIndex) moveModel(dragIndex, restoreIndex);
      dragAnnouncement = `Move canceled. Restored to ${modelPosition(restoreIndex)}.`;
      clearDragState();
      focusModelHandle(modelCards[restoreIndex].__uid);
      return;
    }

    if (isPickupKey) {
      event.preventDefault();
      dragAnnouncement = `Dropped at ${modelPosition(dragIndex)}.`;
      clearDragState();
      return;
    }

    const targetIndex = event.key === 'ArrowUp'
      ? dragIndex - 1
      : event.key === 'ArrowDown'
        ? dragIndex + 1
        : dragIndex;
    if (targetIndex === dragIndex) return;
    event.preventDefault();
    if (moveModel(dragIndex, targetIndex)) {
      dragIndex = targetIndex;
      dragOverIndex = targetIndex;
      dragAnnouncement = `Moved to ${modelPosition(targetIndex)}.`;
      focusModelHandle(modelCards[targetIndex].__uid);
    }
  }

  function onRemoveFallback(index) {
    if (index <= 0 || index >= modelCards.length) return;
    modelCards = modelCards.filter((_, i) => i !== index);
    formDirty = true;
    persist();
  }

  function onThinkingToggle() {
    if (!mainModel.thinkingEnabled) mainModel.budgetTokens = '';
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
      updateDynamicFieldsForModel(mainModel.model);
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

  <p class="sr-only" id="model-drag-instructions">Press Space or Enter to pick up a model, Arrow Up or Arrow Down to reorder it, Space or Enter to drop it, or Escape to cancel.</p>
  <div class="sr-only" id="model-drag-status" role="status" aria-live="polite">{dragAnnouncement}</div>

  <form id="editor-form" class="editor__form" onsubmit={(e) => { e.preventDefault(); onSave(); }} novalidate autocomplete="off">
    <section
      class="editor__section"
      class:dragging={dragIndex === 0}
      class:drag-over={dragOverIndex === 0 && dragIndex !== null && dragIndex !== 0}
      data-section="model"
      aria-labelledby="main-model-heading"
      ondragover={(e) => onModelDragOver(e, 0)}
      ondrop={(e) => onModelDrop(e, 0)}
      ondragend={clearDragState}
    >
      <header class="editor__section-header">
        <div class="fallback-card__heading">
          <button
            type="button"
            class="fallback-card__handle"
            draggable="true"
            title="Drag Main model to reorder"
            aria-label="Drag Main model to reorder"
            aria-describedby="model-drag-instructions"
            aria-grabbed={keyboardDragStartIndex !== null && dragIndex === 0}
            aria-keyshortcuts="Space Enter ArrowUp ArrowDown Escape"
            data-model-card-uid={mainModel.__uid}
            ondragstart={(e) => onModelDragStart(e, 0)}
            ondragend={clearDragState}
            onkeydown={(e) => onModelKeydown(e, 0)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
              <path d="M3 2h1.5v1.5H3V2Zm4.5 0H9v1.5H7.5V2ZM3 5.25h1.5v1.5H3v-1.5Zm4.5 0H9v1.5H7.5v-1.5ZM3 8.5h1.5V10H3V8.5Zm4.5 0H9V10H7.5V8.5Z" />
            </svg>
          </button>
          <h2 class="editor__section-title" id="main-model-heading">Main model</h2>
        </div>
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
            bind:value={mainModel.model}
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
          <select class="field__input" id="f-variant" name="variant" bind:value={mainModel.variant} onchange={onFieldChange} disabled={!mainModel.model}>
            {#each availableVariants as v}
              <option value={v}>{v === '' ? '(default)' : v}</option>
            {/each}
          </select>
        </div>

        <div class="field">
          <label class="field__label" for="f-reasoning">Reasoning effort</label>
          <select class="field__input" id="f-reasoning" name="reasoningEffort" bind:value={mainModel.reasoningEffort} onchange={onFieldChange} disabled={!reasoningSupported}>
            {#each availableReasoning as r}
              <option value={r}>{r === '' ? '(default)' : r}</option>
            {/each}
          </select>
        </div>
      </div>
    </section>

    <section class="editor__section" data-section="sampling" hidden={!temperatureSupported}>
      <button type="button" class="editor__section-toggle" aria-expanded={samplingOpen} aria-controls="sampling-section-body" onclick={() => samplingOpen = !samplingOpen}>
        <span class="editor__section-header">
          <span class="editor__section-title">Sampling</span>
          <span class="editor__section-desc">Generation parameters applied per request.</span>
        </span>
        <span class="editor__section-chevron" class:expanded={samplingOpen} aria-hidden="true">▸</span>
      </button>

      <div id="sampling-section-body" hidden={!samplingOpen}>
        <div class="field-grid field-grid--three">
        <div class="field">
          <label class="field__label" for="f-temperature">Temperature</label>
          <input class="field__input" type="number" id="f-temperature" name="temperature" step="0.1" min="0" max="2" inputmode="decimal" placeholder="0.0 – 2.0" bind:value={mainModel.temperature} oninput={onFieldChange} onchange={onFieldChange} disabled={!temperatureSupported} title={temperatureSupported ? '' : 'This model does not support temperature.'} />
        </div>
        <div class="field">
          <label class="field__label" for="f-top-p">Top-p</label>
          <input class="field__input" type="number" id="f-top-p" name="top_p" step="0.05" min="0" max="1" inputmode="decimal" placeholder="0.0 – 1.0" bind:value={mainModel.top_p} oninput={onFieldChange} onchange={onFieldChange} disabled={!temperatureSupported} title={temperatureSupported ? '' : 'This model does not support sampling parameters.'} />
        </div>
        <div class="field">
          <label class="field__label" for="f-max-tokens">Max tokens</label>
          <input class="field__input" type="number" id="f-max-tokens" name="maxTokens" step="1" min="1" inputmode="numeric" placeholder="e.g. 4096" bind:value={mainModel.maxTokens} oninput={onFieldChange} onchange={onFieldChange} disabled={!temperatureSupported} title={temperatureSupported ? '' : 'This model does not support max tokens.'} />
        </div>
        </div>
      </div>
    </section>

    <section class="editor__section" data-section="thinking" hidden={!reasoningSupported}>
      <button type="button" class="editor__section-toggle" aria-expanded={thinkingOpen} aria-controls="thinking-section-body" onclick={() => thinkingOpen = !thinkingOpen}>
        <span class="editor__section-header">
          <span class="editor__section-title">Thinking</span>
          <span class="editor__section-desc">Extended reasoning budget for models that support it.</span>
        </span>
        <span class="editor__section-chevron" class:expanded={thinkingOpen} aria-hidden="true">▸</span>
      </button>

      <div id="thinking-section-body" hidden={!thinkingOpen}>
        <div class="field field--checkbox">
          <input class="field__checkbox" type="checkbox" id="f-thinking-enabled" name="thinkingEnabled" bind:checked={mainModel.thinkingEnabled} onchange={onThinkingToggle} disabled={!reasoningSupported} />
          <label class="field__label field__label--inline" for="f-thinking-enabled">Enable extended thinking</label>
        </div>

        <div class="field field--nested" id="f-budget-field" hidden={!mainModel.thinkingEnabled}>
          <label class="field__label" for="f-budget-tokens">Budget tokens</label>
          <input class="field__input" type="number" id="f-budget-tokens" name="budgetTokens" step="1" min="1" inputmode="numeric" placeholder="e.g. 8192" bind:value={mainModel.budgetTokens} oninput={onFieldChange} onchange={onFieldChange} disabled={!reasoningSupported} />
          <p class="field__hint">Token budget reserved for chain-of-thought reasoning.</p>
        </div>
      </div>
    </section>

    <section class="editor__section" data-section="fallback">
      <header class="editor__section-header">
        <h2 class="editor__section-title">Fallback models</h2>
        <p class="editor__section-desc">Tried in order when the primary model is unavailable.</p>
      </header>

      <div class="fallback-list" id="fallback-list" role="list">
        {#each modelCards.slice(1) as entry, i (entry.__uid)}
          <div
            class="fallback-card"
            class:dragging={dragIndex === i + 1}
            class:drag-over={dragOverIndex === i + 1 && dragIndex !== null && dragIndex !== i + 1}
            role="listitem"
            ondragover={(e) => onModelDragOver(e, i + 1)}
            ondrop={(e) => onModelDrop(e, i + 1)}
            ondragend={clearDragState}
          >
            <div class="fallback-card__header">
              <div class="fallback-card__heading">
                <button
                  type="button"
                  class="fallback-card__handle"
                  draggable="true"
                  title="Drag Fallback {i + 1} to reorder"
                  aria-label="Drag Fallback {i + 1} to reorder"
                  aria-describedby="model-drag-instructions"
                  aria-grabbed={keyboardDragStartIndex !== null && dragIndex === i + 1}
                  aria-keyshortcuts="Space Enter ArrowUp ArrowDown Escape"
                  data-model-card-uid={entry.__uid}
                  ondragstart={(e) => onModelDragStart(e, i + 1)}
                  ondragend={clearDragState}
                  onkeydown={(e) => onModelKeydown(e, i + 1)}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <path d="M3 2h1.5v1.5H3V2Zm4.5 0H9v1.5H7.5V2ZM3 5.25h1.5v1.5H3v-1.5Zm4.5 0H9v1.5H7.5v-1.5ZM3 8.5h1.5V10H3V8.5Zm4.5 0H9V10H7.5V8.5Z" />
                  </svg>
                </button>
                <h3 class="fallback-card__title">Fallback {i + 1}</h3>
              </div>
              <div class="fallback-card__actions">
                <button type="button" class="fallback-card__remove" onclick={() => onRemoveFallback(i + 1)}>Remove</button>
              </div>
            </div>
            <div class="fallback-card__row">
              <div class="field">
                <label class="field__label" for="fb-model-{entry.__uid}">Model</label>
                <input class="field__input field__input--mono" type="text" id="fb-model-{entry.__uid}" list="model-datalist" placeholder="provider/model-name" spellcheck="false" autocapitalize="off" autocorrect="off" bind:value={entry.model} oninput={onFieldChange} />
              </div>
              <div class="field">
                <label class="field__label" for="fb-variant-{entry.__uid}">Variant</label>
                <select class="field__input" id="fb-variant-{entry.__uid}" bind:value={entry.variant} onchange={onFieldChange}>
                  <option value="">(default)</option>
                  {#each FALLBACK_VARIANTS as v}
                    <option value={v}>{v}</option>
                  {/each}
                </select>
              </div>
              <div class="field">
                <label class="field__label" for="fb-reasoning-{entry.__uid}">Reasoning</label>
                <select class="field__input" id="fb-reasoning-{entry.__uid}" bind:value={entry.reasoningEffort} onchange={onFieldChange}>
                  <option value="">(default)</option>
                  {#each FALLBACK_REASONING as r}
                    <option value={r}>{r}</option>
                  {/each}
                </select>
              </div>
            </div>
            <div class="fallback-card__row fallback-card__row--sampling">
              <div class="field">
                <label class="field__label" for="fb-temperature-{entry.__uid}">Temperature</label>
                <input class="field__input" type="number" id="fb-temperature-{entry.__uid}" step="0.1" min="0" max="2" bind:value={entry.temperature} oninput={onFieldChange} />
              </div>
              <div class="field">
                <label class="field__label" for="fb-top-p-{entry.__uid}">Top-p</label>
                <input class="field__input" type="number" id="fb-top-p-{entry.__uid}" step="0.05" min="0" max="1" bind:value={entry.top_p} oninput={onFieldChange} />
              </div>
              <div class="field">
                <label class="field__label" for="fb-max-tokens-{entry.__uid}">Max tokens</label>
                <input class="field__input" type="number" id="fb-max-tokens-{entry.__uid}" step="1" min="1" bind:value={entry.maxTokens} oninput={onFieldChange} />
              </div>
            </div>
            <div class="fallback-card__row fallback-card__row--thinking">
              <div class="fallback-card__checkbox">
                <input type="checkbox" id="fb-thinking-{entry.__uid}" bind:checked={entry.thinkingEnabled} onchange={onFieldChange} />
                <label for="fb-thinking-{entry.__uid}">Enable thinking</label>
              </div>
              <div class="field">
                <label class="field__label" for="fb-budget-{entry.__uid}">Budget tokens</label>
                <input class="field__input" type="number" id="fb-budget-{entry.__uid}" step="1" min="1" bind:value={entry.budgetTokens} disabled={!entry.thinkingEnabled} oninput={onFieldChange} />
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
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  .editor__form { display: flex; flex-direction: column; gap: 18px; }
  .editor__section { display: flex; flex-direction: column; gap: 14px; padding: 16px 18px 18px; background: var(--vscode-sideBar-background, transparent); border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
  .editor__section.drag-over { border-top-color: var(--vscode-focusBorder); box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  .editor__section-header { display: flex; flex-direction: column; gap: 2px; margin-bottom: 2px; }
  .editor__section-toggle { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; margin: 0 0 2px; padding: 0; font: inherit; color: inherit; text-align: left; background: transparent; border: 0; cursor: pointer; }
  .editor__section-toggle .editor__section-header { margin-bottom: 0; }
  .editor__section-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .editor__section-chevron { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; color: var(--vscode-descriptionForeground); transition: transform 120ms ease; }
  .editor__section-chevron.expanded { transform: rotate(90deg); }
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
  .fallback-card.dragging { opacity: 0.55; }
  .fallback-card.drag-over { border-top-color: var(--vscode-focusBorder); box-shadow: inset 0 2px 0 var(--vscode-focusBorder); }
  .fallback-card__row { display: grid; grid-template-columns: 1fr 140px 140px; gap: 8px; align-items: end; }
  .fallback-card__row--sampling { grid-template-columns: 1fr 1fr 1fr; }
  .fallback-card__row--thinking { grid-template-columns: 1fr 1fr; align-items: center; }
  .fallback-card__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .fallback-card__heading { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .fallback-card__handle { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; color: var(--vscode-descriptionForeground); background: transparent; border: 1px solid var(--vscode-widget-border); border-radius: 2px; cursor: grab; }
  .fallback-card__handle:active { cursor: grabbing; }
  .fallback-card__handle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .fallback-card__title { margin: 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); }
  .fallback-card__actions { display: flex; align-items: center; gap: 6px; }
  .fallback-card__remove { display: inline-flex; align-items: center; min-height: 24px; background: transparent; border: 1px solid transparent; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 11px; padding: 2px 6px; border-radius: 2px; }
  .fallback-card__remove:hover { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .fallback-card__checkbox { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .fallback-card .field__input { font-size: 12px; padding: 4px 6px; }
  @media (max-width: 520px) {
    .fallback-card__row, .fallback-card__row--sampling, .fallback-card__row--thinking { grid-template-columns: 1fr; }
    .field-grid, .field-grid--three { grid-template-columns: 1fr; }
  }
</style>
