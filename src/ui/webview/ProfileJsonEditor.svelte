<script>
  import { onMount } from 'svelte';
  import { acquireApi, persistEditorState, restoredEditorState } from './webviewState.js';

  let { target, postMessage } = $props();

  let text = $state('');
  let canonicalText = $state('');
  let initialized = $state(false);
  let dirty = $state(false);
  let status = $state({ message: '', type: 'info' });
  let errorDetail = $state(null);
  let vscodeApi = null;
  let statusTimer = null;

  function getApi() { vscodeApi = acquireApi(vscodeApi); return vscodeApi; }
  function currentTarget() {
    return { type: 'profileJson', source: target.source, profile: target.profile ?? null };
  }
  function isSameTarget(other) {
    const current = currentTarget();
    return other?.type === current.type && other?.source === current.source && (other?.profile ?? null) === current.profile;
  }
  function persist() { persistEditorState(getApi(), currentTarget(), { text, canonicalText, dirty }); }
  function restorePersisted() { return restoredEditorState(getApi(), currentTarget()); }

  function setStatus(message, type = 'info') {
    if (statusTimer) clearTimeout(statusTimer);
    status = { message: message ?? '', type };
    errorDetail = null;
  }

  function setError(message, detail = null) {
    if (statusTimer) clearTimeout(statusTimer);
    status = { message: message ?? '', type: 'error' };
    errorDetail = detail && typeof detail === 'object' ? detail : null;
  }

  function setDirty(value) {
    const next = value !== text;
    if (next === dirty) return;
    dirty = next;
    persist();
    postMessage({ command: 'dirtyState', target: currentTarget(), dirty: next });
  }

  function onInput(event) {
    text = event.currentTarget.value;
    setDirty(true);
  }

  function applyCanonical(savedText) {
    text = savedText;
    canonicalText = savedText;
    dirty = false;
    setStatus('Saved.', 'success');
    persist();
    postMessage({ command: 'dirtyState', target: currentTarget(), dirty: false });
  }

  function onSave() {
    if (!initialized) return setError('Editor is not ready yet.');
    postMessage({ command: 'save', target: currentTarget(), payload: { text } });
  }

  function handleKeydown(event) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      onSave();
    }
  }

  function applyInit(data) {
    const incomingText = typeof data?.text === 'string' ? data.text : '';
    const persisted = restorePersisted();
    if (persisted?.dirty && typeof persisted.text === 'string') {
      text = persisted.text;
      canonicalText = typeof persisted.canonicalText === 'string' ? persisted.canonicalText : incomingText;
      dirty = true;
      postMessage({ command: 'dirtyState', target: currentTarget(), dirty: true });
    } else {
      text = incomingText;
      canonicalText = incomingText;
      dirty = false;
    }
    initialized = true;
    setStatus(null);
    persist();
  }

  function handleMessage(event) {
    const message = event?.data;
    if (!message || typeof message !== 'object') return;
    if (message.command === 'init') applyInit(message);
    else if (message.command === 'saved' && isSameTarget(message.target)) applyCanonical(message.text ?? '');
    else if (message.command === 'error' && isSameTarget(message.target)) {
      const detail = message.path || message.line !== undefined || message.column !== undefined
        ? { path: message.path, line: message.line, column: message.column }
        : null;
      setError(message.message ? String(message.message) : 'Host reported an error', detail);
    }
  }

  onMount(() => {
    applyInit(target);
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="editor" id="editor">
  <header class="editor__header">
    <p class="editor__eyebrow">Oh My OpenAgent</p>
    <h1 class="editor__title">Profile JSON</h1>
    <p class="editor__subtitle">{target.source === 'active' ? 'Active config fragment' : target.profile}</p>
  </header>

  <form class="editor__form" onsubmit={(event) => { event.preventDefault(); onSave(); }} novalidate autocomplete="off">
    <div class="field">
      <label class="field__label" for="profile-json-text">Profile fragment JSON</label>
      <p class="field__help" id="profile-json-help">
        Edit an object with optional <code>agents</code> and <code>categories</code> keys. Other root keys are rejected by the host validator.
      </p>
      <textarea
        id="profile-json-text"
        class="field__textarea field__textarea--code"
        aria-describedby="profile-json-help"
        spellcheck="false"
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        value={text}
        oninput={onInput}
      ></textarea>
    </div>

    <div class="editor__status editor__status--{status.type}" id="profile-json-status" role="status" aria-live="polite" hidden={!status.message}>
      {status.message}
      {#if errorDetail}
        <span class="editor__error-detail">
          {#if errorDetail.path}<span class="editor__error-location">Path: {String(errorDetail.path)}</span>{/if}
          {#if typeof errorDetail.line === 'number'}<span class="editor__error-location">Line: {errorDetail.line}</span>{/if}
          {#if typeof errorDetail.column === 'number'}<span class="editor__error-location">Column: {errorDetail.column}</span>{/if}
        </span>
      {/if}
    </div>

    <div class="editor__actions">
      <button type="button" class="vscode-button vscode-button--primary" id="btn-save" onclick={onSave} disabled={!initialized}>Save</button>
    </div>
  </form>
</div>
