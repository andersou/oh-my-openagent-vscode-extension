export function acquireApi(current) {
  if (current) return current;
  if (typeof globalThis === 'undefined' || !globalThis.acquireVsCodeApi) return null;
  try {
    return globalThis.acquireVsCodeApi();
  } catch {
    return null;
  }
}

export function persistEditorState(api, state) {
  if (!api || typeof api.setState !== 'function') return;
  try {
    api.setState(state);
  } catch {
    return;
  }
}

export function restoredEditorState(api) {
  if (!api || typeof api.getState !== 'function') return null;
  try {
    const state = api.getState();
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}
