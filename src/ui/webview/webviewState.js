/**
 * VS Code webview state persistence helpers.
 *
 * The persisted shape is a versioned target-keyed envelope so dirty drafts for
 * different agents, categories, or profile JSON targets never overwrite each
 * other:
 *
 *   { v: 1, targets: { '<targetKey>': { kind: 'agent'|'category', ... } } }
 *
 * Old flat state from before the envelope is detected by the absence of `v`
 * and `targets` and is ignored.
 */

/**
 * @typedef {Object} AgentCategoryTarget
 * @property {'agent'|'category'} type
 * @property {string} name
 * @property {string|null} profile
 */

/**
 * @typedef {Object} ProfileJsonTarget
 * @property {'profileJson'} type
 * @property {'active'|'saved'} source
 * @property {string|null} profile
 */

/**
 * @typedef {AgentCategoryTarget|ProfileJsonTarget} TargetKey
 */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function targetKeyFor(target) {
  if (!isObject(target)) return null;
  const t = /** @type {Record<string, unknown>} */ (target);
  if (t.type === 'agent' || t.type === 'category') {
    if (typeof t.name !== 'string') return null;
    return JSON.stringify({
      type: t.type,
      name: t.name,
      profile: t.profile ?? null,
    });
  }
  if (t.type === 'profileJson') {
    if (t.source !== 'active' && t.source !== 'saved') return null;
    return JSON.stringify({
      type: 'profileJson',
      source: t.source,
      profile: t.profile ?? null,
    });
  }
  return null;
}

function isEnvelope(state) {
  if (!isObject(state)) return false;
  const s = /** @type {Record<string, unknown>} */ (state);
  return s.v === 1 && isObject(s.targets);
}

export function acquireApi(current) {
  if (current) return current;
  if (typeof globalThis === 'undefined' || !globalThis.acquireVsCodeApi) return null;
  try {
    return globalThis.acquireVsCodeApi();
  } catch {
    return null;
  }
}

/**
 * Persist per-target state inside a versioned envelope.
 *
 * @param {unknown} api
 * @param {TargetKey} target
 * @param {Record<string, unknown>} state
 */
export function persistEditorState(api, target, state) {
  if (!api || typeof api.setState !== 'function') return;
  const key = targetKeyFor(target);
  if (!key) return;
  try {
    const current = api.getState();
    const envelope = isEnvelope(current)
      ? { ...current, targets: { ...current.targets } }
      : { v: 1, targets: {} };
    envelope.targets[key] = { ...state };
    api.setState(envelope);
  } catch {
    return;
  }
}

/**
 * Restore per-target state from the versioned envelope.
 *
 * @param {unknown} api
 * @param {TargetKey} target
 * @returns {Record<string, unknown>|null}
 */
export function restoredEditorState(api, target) {
  if (!api || typeof api.getState !== 'function') return null;
  try {
    const state = api.getState();
    if (!isEnvelope(state)) return null;
    const key = targetKeyFor(target);
    if (!key) return null;
    const found = state.targets[key];
    return isObject(found) ? { ...found } : null;
  } catch {
    return null;
  }
}

/**
 * Read the full envelope for enumeration/migration (optional).
 *
 * @param {unknown} api
 * @returns {{ v: 1, targets: Record<string, Record<string, unknown>> }|null}
 */
export function restoredEnvelope(api) {
  if (!api || typeof api.getState !== 'function') return null;
  try {
    const state = api.getState();
    return isEnvelope(state) ? state : null;
  } catch {
    return null;
  }
}
