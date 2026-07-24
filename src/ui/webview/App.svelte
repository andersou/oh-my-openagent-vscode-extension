<script>
  import { onMount } from 'svelte';
  import AgentFormEditor from './AgentFormEditor.svelte';
  import ProfileJsonEditor from './ProfileJsonEditor.svelte';

  let target = $state(null);
  let isProfileJson = $state(false);
  let vscodeApi = null;

  function getApi() {
    if (vscodeApi) return vscodeApi;
    if (typeof globalThis === 'undefined' || !globalThis.acquireVsCodeApi) return null;
    try {
      vscodeApi = globalThis.acquireVsCodeApi();
      return vscodeApi;
    } catch {
      return null;
    }
  }
  function postMessage(message) { getApi()?.postMessage(message); }

  function isProfileJsonTarget(data) {
    return data && typeof data === 'object' && data.type === 'profileJson' && (data.source === 'active' || data.source === 'saved');
  }

  function applyInit(data) {
    isProfileJson = isProfileJsonTarget(data);
    target = { ...data };
  }

  function handleMessage(event) {
    const message = event?.data;
    if (!message || typeof message !== 'object') return;
    if (message.command === 'init') applyInit(message);
  }

  onMount(() => {
    window.addEventListener('message', handleMessage);
    postMessage({ command: 'ready' });
    return () => window.removeEventListener('message', handleMessage);
  });
</script>

<main class="editor" id="editor">
  {#if target && isProfileJson}
    <ProfileJsonEditor {target} {postMessage} />
  {:else}
    <AgentFormEditor init={target} {postMessage} />
  {/if}
</main>
