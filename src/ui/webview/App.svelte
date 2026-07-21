<script>
  import { onMount, tick } from 'svelte';
  import ModelCard from './ModelCard.svelte';
  import DefaultSettings from './DefaultSettings.svelte';
  import { mergeValidationErrors, validateModelCapabilities } from './modelCapabilities.js';
  import { acquireApi, persistEditorState, restoredEditorState } from './webviewState.js';
  import {
    appendFallback,
    loadModelRouting,
    moveModelCard,
    removeFallback,
    serializeModelRouting,
    setCardModel,
    setCardOverride,
    setMainDefault,
    validateModelRouting,
  } from './modelRouting.js';

  let entityKind = $state(null);
  let entityName = $state(null);
  let entityProfile = $state(null);
  let routing = $state(loadModelRouting({}));
  let initialized = $state(false);
  let formDirty = $state(false);
  let status = $state({ message: '', type: 'info' });
  let modelStatus = $state({ message: '', type: 'loading' });
  let modelDatalist = $state([]);
  let modelMetadata = $state({});
  let dragUid = $state(null);
  let dragOverUid = $state(null);
  let keyboardDrag = $state(null);
  let dragAnnouncement = $state('');
  let routingAnnouncement = $state('');
  let vscodeApi = null;
  let statusTimer = null;

  let mainCard = $derived(routing.cards[0]);
  let hasInheritedSettings = $derived(routing.cards.some((card) =>
    Object.values(card.overrides).some((setting) => setting.mode === 'inherit')));
  let validationErrors = $derived(mergeValidationErrors(validateModelRouting(routingSnapshot()), validateModelCapabilities(routingSnapshot(), modelMetadata)));
  let mainMetadata = $derived(modelMetadata[mainCard?.model] ?? null);

  function getApi() { vscodeApi = acquireApi(vscodeApi); return vscodeApi; }
  function postMessage(message) { getApi()?.postMessage(message); }
  function serializeValues() { return serializeModelRouting(routingSnapshot()); }
  function routingSnapshot() { return JSON.parse(JSON.stringify(routing)); }
  function currentTarget() {
    if ((entityKind !== 'agent' && entityKind !== 'category') || typeof entityName !== 'string') return null;
    return { type: entityKind, name: entityName, profile: entityProfile ?? null };
  }
  function matchesCurrentTarget(target) {
    const current = currentTarget();
    return current !== null && target?.type === current.type && target?.name === current.name && (target?.profile ?? null) === current.profile;
  }
  function persist() { persistEditorState(getApi(), { kind: entityKind, name: entityName, profile: entityProfile, routing: routingSnapshot(), dirty: formDirty, values: serializeValues() }); }
  function restorePersisted() { return restoredEditorState(getApi()); }
  function setDirty(dirty) {
    formDirty = dirty;
    persist();
    const target = currentTarget();
    if (target) postMessage({ command: 'dirtyState', target, dirty });
  }

  function setStatus(message, type = 'info') {
    if (statusTimer) clearTimeout(statusTimer);
    status = { message: message ?? '', type };
    if (type === 'success' && message) {
      statusTimer = setTimeout(() => {
        if (status.message === message) status = { message: '', type: 'info' };
      }, 3000);
    }
  }

  function changeRouting(next) {
    routing = next;
    setDirty(true);
  }


  function applyInit(data) {
    if (formDirty && matchesCurrentTarget(data)) {
      setDirty(true);
      return;
    }
    entityKind = data?.type ?? null;
    entityName = data?.name ?? null;
    entityProfile = data?.profile ?? null;
    const source = data?.config && typeof data.config === 'object' ? data.config : {};
    const fallbackModels = Array.isArray(source.fallback_models)
      ? source.fallback_models.map((entry) => entry && typeof entry === 'object' ? { ...entry } : entry)
      : source.fallback_models;
    const config = { ...source, ...(fallbackModels === undefined ? {} : { fallback_models: fallbackModels }) };
    routing = loadModelRouting(config);
    initialized = true;
    formDirty = false;
    setStatus(null);
    persist();
  }

  function onModel(uid, model) { changeRouting(setCardModel(routingSnapshot(), uid, model)); }
  function onOverride(uid, key, override) { changeRouting(setCardOverride(routingSnapshot(), uid, key, override)); }
  function onDefault(key, value) { changeRouting(setMainDefault(routingSnapshot(), key, value)); }

  function onSave() {
    if (!initialized) return setStatus('Form is not ready yet.', 'error');
    if (Object.keys(validationErrors).length > 0) return setStatus('Please fix the errors above before saving.', 'error');
    const target = currentTarget();
    if (!target) return setStatus('Form is not ready yet.', 'error');
    postMessage({ command: 'save', target, payload: serializeValues() });
    persist();
  }

  function onAddFallback() {
    const next = appendFallback(routingSnapshot());
    const added = next.cards[next.cards.length - 1];
    changeRouting(next);
    tick().then(() => document.querySelector(`[data-model-input-uid="${added.uid}"]`)?.focus());
  }

  function focusHandle(uid) {
    tick().then(() => document.querySelector(`[data-model-card-uid="${uid}"]`)?.focus());
  }

  function positionName(index) {
    return index === 0 ? 'Main model' : `Fallback ${index}`;
  }

  function moveCard(uid, targetIndex) {
    const beforeMain = routing.cards[0]?.uid;
    const sourceIndex = routing.cards.findIndex((card) => card.uid === uid);
    if (sourceIndex < 0 || sourceIndex === targetIndex) return false;
    const next = moveModelCard(routingSnapshot(), uid, targetIndex);
    const nextMain = next.cards[0]?.uid;
    changeRouting(next);
    if (nextMain === uid && beforeMain !== uid) {
      routingAnnouncement = 'Main model replaced. Model-specific settings and shared defaults were preserved.';
      dragAnnouncement = `${positionName(0)} replaced.`;
    }
    return true;
  }

  function clearDrag() {
    dragUid = null;
    dragOverUid = null;
    keyboardDrag = null;
  }

  function onDragStart(event, uid) {
    keyboardDrag = null;
    dragUid = uid;
    event.dataTransfer?.setData('text/plain', uid);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function onDrop(event, targetIndex) {
    event.preventDefault();
    if (dragUid) moveCard(dragUid, targetIndex);
    clearDrag();
  }

  function onDragOver(event, uid) { event.preventDefault(); dragOverUid = uid; }

  function onDragLeave(uid) { if (dragOverUid === uid) dragOverUid = null; }

  function onKeydown(event, uid, index) {
    const pickup = event.key === ' ' || event.key === 'Enter';
    if (keyboardDrag === null) {
      if (!pickup) return;
      event.preventDefault();
      dragUid = uid;
      keyboardDrag = { uid, originalIndex: index };
      dragAnnouncement = `${positionName(index)} picked up.`;
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      const currentIndex = routing.cards.findIndex((card) => card.uid === keyboardDrag.uid);
      if (currentIndex !== keyboardDrag.originalIndex) moveCard(keyboardDrag.uid, keyboardDrag.originalIndex);
      dragAnnouncement = `Move canceled. Restored to ${positionName(keyboardDrag.originalIndex)}.`;
      const restoreUid = keyboardDrag.uid;
      clearDrag();
      focusHandle(restoreUid);
      return;
    }
    if (pickup) {
      event.preventDefault();
      dragAnnouncement = `Dropped at ${positionName(index)}.`;
      clearDrag();
      return;
    }
    const direction = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    const currentIndex = routing.cards.findIndex((card) => card.uid === keyboardDrag.uid);
    const targetIndex = currentIndex + direction;
    if (direction === 0 || targetIndex < 0 || targetIndex >= routing.cards.length) return;
    event.preventDefault();
    if (moveCard(keyboardDrag.uid, targetIndex)) {
      dragUid = keyboardDrag.uid;
      dragAnnouncement = `Moved to ${positionName(targetIndex)}.`;
      focusHandle(keyboardDrag.uid);
    }
  }

  function onRemoveFallback(uid) {
    const removedIndex = routing.cards.findIndex((card) => card.uid === uid);
    const nextFocus = routing.cards[removedIndex + 1] ?? routing.cards[removedIndex - 1];
    changeRouting(removeFallback(routingSnapshot(), uid));
    tick().then(() => {
      const target = nextFocus
        ? document.querySelector(`[data-model-card-uid="${nextFocus.uid}"]`)
        : document.getElementById('btn-add-fallback');
      target?.focus();
    });
  }

  function handleMessage(event) {
    const message = event?.data;
    if (!message || typeof message !== 'object') return;
    if (message.command === 'init') applyInit(message);
    else if (message.command === 'saved' && matchesCurrentTarget(message.target)) { setStatus('Saved.', 'success'); setDirty(false); }
    else if (message.command === 'error' && matchesCurrentTarget(message.target)) setStatus(message.message ? String(message.message) : 'Host reported an error', 'error');
    else if (message.command === 'modelsLoading') modelStatus = { message: 'Loading available models…', type: 'loading' };
    else if (message.command === 'modelsUnavailable') {
      const error = typeof message.error === 'string' && message.error.length > 0 ? message.error : 'the local opencode CLI is unavailable';
      modelStatus = { message: `Model list unavailable (${error}). You can type any model identifier.`, type: 'unavailable' };
    } else if (message.command === 'modelsLoaded') {
      const models = Array.isArray(message.models)
        ? message.models.filter((model) => model && typeof model === 'object' && typeof model.modelId === 'string' && model.modelId.length > 0)
        : [];
      modelDatalist = models.map((model) => model.modelId);
      modelMetadata = { ...modelMetadata, ...Object.fromEntries(models.map((model) => [model.modelId, model])) };
      modelStatus = { message: models.length > 0 ? `${models.length} model${models.length === 1 ? '' : 's'} available — type to filter.` : 'No models reported by the local CLI.', type: 'loaded' };
    }
  }

  onMount(() => {
    const persisted = restorePersisted();
    if (persisted?.routing && persisted?.dirty) {
      entityKind = persisted.kind ?? null;
      entityName = persisted.name ?? null;
      entityProfile = persisted.profile ?? null;
      routing = persisted.routing;
      formDirty = true;
      initialized = true;
    } else if (persisted?.values) applyInit({ type: persisted.kind, name: persisted.name, profile: persisted.profile, config: persisted.values });
    window.addEventListener('message', handleMessage);
    postMessage({ command: 'ready' });
    return () => window.removeEventListener('message', handleMessage);
  });
</script>

<svelte:window onkeydown={(event) => { if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === 's' || event.key === 'Enter')) { event.preventDefault(); onSave(); } }} />

<main class="editor" id="editor" aria-busy={!initialized}>
  <header class="editor__header">
    <p class="editor__eyebrow">Oh My OpenAgent</p>
    <h1 class="editor__title">Edit {entityKind === 'agent' ? 'Agent' : entityKind === 'category' ? 'Category' : ''}</h1>
    <p class="editor__subtitle">{entityName ?? ''}</p>
  </header>

  <p class="model-list__helper" id="model-list-help">Order is runtime priority. Drop a fallback first to replace Main; its override or inherit choices move with it.</p>
  <p class="sr-only" id="model-drag-instructions">Space or Enter picks up or drops. Arrow keys move. Escape cancels. Drop in the first position to replace Main.</p>
  <div class="sr-only" id="model-drag-status" role="status" aria-live="polite">{dragAnnouncement}</div>

  <form class="editor__form" onsubmit={(event) => { event.preventDefault(); onSave(); }} novalidate autocomplete="off">
    <section class="editor__section model-routing" aria-labelledby="model-routing-heading">
      <header class="editor__section-header"><h2 class="editor__section-title" id="model-routing-heading">Model routing</h2><p class="editor__section-desc">Models are attempted in this order.</p></header>
      <ol class="model-list fallback-list" id="model-list" aria-describedby="model-list-help">
        {#each routing.cards as card, index (card.uid)}
          <li
            class:model-list__item--drag-over={dragOverUid === card.uid && dragUid !== card.uid}
            data-model-position={index === 0 ? 'main' : `fallback-${index}`}
            data-section={index === 0 ? 'model' : undefined}
            ondragover={(event) => onDragOver(event, card.uid)}
            ondragleave={() => onDragLeave(card.uid)}
            ondrop={(event) => onDrop(event, index)}
          >
            <ModelCard card={card} index={index} defaults={routing.defaults} metadata={modelMetadata[card.model]} errors={validationErrors[card.uid] ?? {}} dragActive={dragUid === card.uid} onModel={onModel} onOverride={onOverride} onRemove={onRemoveFallback} onDragStart={onDragStart} onDragEnd={clearDrag} onKeydown={onKeydown} />
          </li>
        {/each}
      </ol>
      <button type="button" class="vscode-button vscode-button--secondary" id="btn-add-fallback" onclick={onAddFallback}>Add fallback</button>
    </section>

    {#if hasInheritedSettings}
      <DefaultSettings defaults={routing.defaults} metadata={mainMetadata} errors={validationErrors[mainCard?.uid] ?? {}} onDefault={onDefault} />
    {/if}

    <datalist id="model-datalist">{#each modelDatalist as id}<option value={id}></option>{/each}</datalist>
    <p class="field__model-status field__model-status--{modelStatus.type}" id="model-status" role="status" aria-live="polite" hidden={!modelStatus.message}>{modelStatus.message}</p>
    <button type="button" class="vscode-button vscode-button--secondary" id="btn-reload-models" title="Reload available models from the local opencode CLI" onclick={() => postMessage({ command: 'reloadModels' })}>Reload models</button>
    <div class="editor__status editor__status--{status.type}" id="status" role="status" aria-live="polite" hidden={!status.message}>{status.message}</div>
    <div class="editor__status" id="model-routing-status" role="status" aria-live="polite" hidden={!routingAnnouncement}>{routingAnnouncement}</div>
    <div class="editor__actions"><button type="button" class="vscode-button vscode-button--primary" id="btn-save" onclick={onSave} disabled={!initialized}>Save</button></div>
  </form>
</main>
