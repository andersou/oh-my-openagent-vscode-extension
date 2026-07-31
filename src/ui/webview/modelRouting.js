// @ts-check

/** @type {readonly SettingKey[]} */
const SETTINGS = ['variant', 'reasoning', 'reasoningEffort', 'temperature', 'top_p', 'maxTokens', 'thinking'];
const NUMERIC_SETTINGS = new Set(['temperature', 'top_p', 'maxTokens']);
const FALLBACK_KNOWN_FIELDS = new Set(['model', ...SETTINGS]);

/** @typedef {'variant' | 'reasoning' | 'reasoningEffort' | 'temperature' | 'top_p' | 'maxTokens' | 'thinking'} SettingKey */
/** @typedef {{ readonly mode: 'inherit' } | { readonly mode: 'override', readonly value: unknown }} OverrideState */
/** @typedef {Readonly<Record<SettingKey, OverrideState>>} CardOverrides */
/** @typedef {Partial<Record<SettingKey, unknown>>} RoutingDefaults */
/** @typedef {'loaded-main' | 'loaded-fallback' | 'session'} CardProvenance */
/** @typedef {'string' | 'object'} SourceShape */
/** @typedef {{ readonly uid: string, readonly model: string, readonly provenance: CardProvenance, readonly source: SourceShape, readonly overrides: CardOverrides, readonly unknown: Readonly<Record<string, unknown>> }} ModelCard */
/** @typedef {{ readonly defaults: RoutingDefaults, readonly cards: readonly ModelCard[] }} ModelRoutingState */
/** @typedef {Record<string, Record<string, string>>} ValidationErrors */

/** @template T @param {T} value @returns {T} */
function clone(value) { return structuredClone(value); }

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** @param {Record<string, unknown>} value @param {string} key */
function owns(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }

/** @param {Record<string, unknown>} entry @param {SettingKey} key @param {boolean} explicit @returns {OverrideState} */
function overrideFrom(entry, key, explicit) {
  return explicit && owns(entry, key)
    ? { mode: 'override', value: clone(entry[key]) }
    : { mode: 'inherit' };
}

/** @param {Record<string, unknown>} entry @param {boolean} explicit @returns {CardOverrides} */
function createOverrides(entry, explicit) {
  return {
    variant: overrideFrom(entry, 'variant', explicit),
    reasoning: overrideFrom(entry, 'reasoning', explicit),
    reasoningEffort: overrideFrom(entry, 'reasoningEffort', explicit),
    temperature: overrideFrom(entry, 'temperature', explicit),
    top_p: overrideFrom(entry, 'top_p', explicit),
    maxTokens: overrideFrom(entry, 'maxTokens', explicit),
    thinking: overrideFrom(entry, 'thinking', explicit),
  };
}

/** @param {unknown} entry @param {number} index @param {boolean} main @returns {ModelCard} */
function createCard(entry, index, main) {
  const objectEntry = isRecord(entry) ? entry : {};
  const modelValue = typeof entry === 'string' ? entry : objectEntry.model;
  const unknown = main || typeof entry === 'string'
    ? {}
    : Object.fromEntries(
      Object.entries(objectEntry)
        .filter(([key]) => !FALLBACK_KNOWN_FIELDS.has(key))
        .map(([key, value]) => [key, clone(value)]),
    );
  return {
    uid: `card-${index}`,
    model: modelValue === undefined || modelValue === null ? '' : String(modelValue),
    provenance: main ? 'loaded-main' : 'loaded-fallback',
    source: typeof entry === 'string' ? 'string' : 'object',
    overrides: createOverrides(objectEntry, !main && typeof entry !== 'string'),
    unknown,
  };
}

/** @param {RoutingDefaults} defaults @returns {CardOverrides} */
function overridesFromDefaults(defaults) { return createOverrides(clone(defaults), true); }

/** @param {Record<string, unknown>} overrides @returns {CardOverrides} */
function overridesFromMainOverrides(overrides) {
  return createOverrides(overrides, true);
}

/** @param {ModelCard} card @param {RoutingDefaults} defaults @returns {ModelCard} */
function demoteLoadedMain(card, defaults) {
  const next = clone(card.overrides);
  for (const key of SETTINGS) {
    if (next[key].mode === 'inherit') {
      const value = defaults[key];
      if (value !== undefined && value !== null) {
        next[key] = { mode: 'override', value: clone(value) };
      }
    }
  }
  return { ...card, provenance: 'session', overrides: next };
}

/** @param {unknown} config @returns {ModelRoutingState} */
export function loadModelRouting(config) {
  const input = isRecord(config) ? config : {};
  /** @type {RoutingDefaults} */
  const defaults = {};
  for (const key of SETTINGS) {
    if (owns(input, key) && input[key] !== null) defaults[key] = clone(input[key]);
  }
  const mainOverrides = isRecord(input.main_overrides) ? input.main_overrides : {};
  const fallbackValue = input.fallback_models;
  const fallbackEntries = typeof fallbackValue === 'string'
    ? [fallbackValue]
    : Array.isArray(fallbackValue)
      ? fallbackValue.filter((entry) => typeof entry === 'string' || isRecord(entry))
      : [];
  return {
    defaults,
    cards: [
      createMainCard(input, 0, mainOverrides),
      ...fallbackEntries.map((entry, index) => createCard(entry, index + 1, false)),
    ],
  };
}

/** @param {Record<string, unknown>} entry @param {number} index @param {Record<string, unknown>} mainOverrides @returns {ModelCard} */
function createMainCard(entry, index, mainOverrides) {
  const card = createCard(entry, index, true);
  return { ...card, overrides: overridesFromMainOverrides(mainOverrides) };
}

/** @param {ModelRoutingState} state @param {string} uid @param {number} toIndex @returns {ModelRoutingState} */
export function moveModelCard(state, uid, toIndex) {
  const cards = clone(state.cards);
  const fromIndex = cards.findIndex((card) => card.uid === uid);
  if (!Number.isInteger(toIndex) || fromIndex < 0 || toIndex < 0 || toIndex >= cards.length || fromIndex === toIndex) {
    return { defaults: clone(state.defaults), cards };
  }
  const movedCard = cards[fromIndex];
  const oldMain = cards[0];
  if (movedCard === undefined || oldMain === undefined) return { defaults: clone(state.defaults), cards };
  const reordered = [...cards];
  reordered.splice(fromIndex, 1);
  reordered.splice(toIndex, 0, movedCard);
  const newMain = reordered[0];
  if (newMain === undefined || newMain.uid === oldMain.uid) {
    return { defaults: clone(state.defaults), cards: reordered };
  }
  const adjusted = oldMain.provenance === 'loaded-main'
    ? reordered.map((card) => card.uid === oldMain.uid
      ? demoteLoadedMain(card, state.defaults)
      : card)
    : reordered;
  return {
    defaults: clone(state.defaults),
    cards: adjusted,
  };
}

/** @param {ModelRoutingState} state @param {string} uid @param {SettingKey} key @param {OverrideState} override @returns {ModelRoutingState} */
export function setCardOverride(state, uid, key, override) {
  return updateCard(state, uid, (card) =>
    ({ ...card, overrides: { ...card.overrides, [key]: clone(override) } }));
}

/** @param {ModelRoutingState} state @param {string} uid @param {(card: ModelCard) => ModelCard} update @returns {ModelRoutingState} */
function updateCard(state, uid, update) {
  return { defaults: clone(state.defaults),
    cards: state.cards.map((card) => card.uid === uid ? update(clone(card)) : clone(card)) };
}

/** @param {ModelRoutingState} state @param {string} uid @param {string} model @returns {ModelRoutingState} */
export function setCardModel(state, uid, model) { return updateCard(state, uid, (card) => ({ ...card, model })); }

/** @param {ModelRoutingState} state @param {SettingKey} key @param {unknown} value @returns {ModelRoutingState} */
export function setMainDefault(state, key, value) {
  const next = { defaults: clone(state.defaults), cards: state.cards.map(clone) };
  if (value === undefined) delete next.defaults[key];
  else next.defaults[key] = clone(value);
  return next;
}

/** @param {ModelRoutingState} state @returns {ModelRoutingState} */
export function appendFallback(state) {
  let nextIndex = 0;
  for (const card of state.cards) {
    const match = /^card-(\d+)$/.exec(card.uid);
    if (match?.[1] !== undefined) nextIndex = Math.max(nextIndex, Number(match[1]) + 1);
  }
  return { defaults: clone(state.defaults),
    cards: [...clone(state.cards), createCard('', nextIndex, false)] };
}

/** @param {ModelRoutingState} state @param {string} uid @returns {ModelRoutingState} */
export function removeFallback(state, uid) {
  const main = state.cards[0];
  if (main?.uid === uid) return clone(state);
  return { defaults: clone(state.defaults),
    cards: state.cards.filter((card) => card.uid !== uid).map(clone) };
}

/** @param {SettingKey} key @param {unknown} value */
function serializedValue(key, value) {
  if (!NUMERIC_SETTINGS.has(key) || value === null || value === '') return clone(value);
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : clone(value);
}

/** @param {ModelCard} card */
function serializeFallback(card) {
  const inheritsAll = SETTINGS.every((key) => card.overrides[key].mode === 'inherit');
  if (card.source === 'string' && inheritsAll && Object.keys(card.unknown).length === 0) {
    return card.model.trim();
  }
  /** @type {Record<string, unknown>} */
  const output = { ...clone(card.unknown), model: card.model.trim() };
  for (const key of SETTINGS) {
    const setting = card.overrides[key];
    if (setting.mode === 'override') output[key] = serializedValue(key, setting.value);
  }
  return output;
}

/** @param {ModelCard} card @returns {Record<string, unknown>} */
function serializeMainOverrides(card) {
  /** @type {Record<string, unknown>} */
  const output = {};
  for (const key of SETTINGS) {
    const setting = card.overrides[key];
    if (setting.mode === 'override') output[key] = serializedValue(key, setting.value);
  }
  return output;
}

/** @param {ModelRoutingState} state @returns {Record<string, unknown>} */
export function serializeModelRouting(state) {
  const main = state.cards[0];
  /** @type {Record<string, unknown>} */
  const output = { model: main?.model.trim() ?? '' };
  for (const key of SETTINGS) {
    const value = state.defaults[key];
    output[key] = owns(state.defaults, key) && value !== undefined && value !== '' ? serializedValue(key, value) : null;
  }
  output.fallback_models = state.cards.length === 1
    ? null
    : state.cards.slice(1).map(serializeFallback);
  const mainOverrides = main === undefined ? {} : serializeMainOverrides(main);
  output.main_overrides = Object.keys(mainOverrides).length === 0 ? null : mainOverrides;
  return output;
}

/** @param {ValidationErrors} errors @param {string} uid @param {string} field @param {string} message */
function addError(errors, uid, field, message) {
  if (errors[uid] === undefined) errors[uid] = {};
  errors[uid][field] = message;
}

/** @param {SettingKey} key @param {unknown} value @returns {string | null} */
function numericError(key, value) {
  if ((typeof value === 'string' && value.trim() === '') || value === null || value === undefined) return 'Must be a finite number';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'Must be a finite number';
  if (key === 'temperature' && (numeric < 0 || numeric > 2)) return 'Must be between 0 and 2';
  if (key === 'top_p' && (numeric < 0 || numeric > 1)) return 'Must be between 0 and 1';
  if (key === 'maxTokens' && (!Number.isInteger(numeric) || numeric <= 0)) return 'Must be a positive integer';
  return null;
}

/** @param {ValidationErrors} errors @param {string} uid @param {unknown} thinking */
function validateThinking(errors, uid, thinking) {
  if (!isRecord(thinking) || (thinking.type !== 'enabled' && thinking.type !== 'disabled')) {
    addError(errors, uid, 'thinking', 'Must be enabled or disabled');
    return;
  }
  if (thinking.type !== 'enabled') return;
  const budget = Number(thinking.budgetTokens);
  if (!Number.isInteger(budget) || budget <= 0) {
    addError(errors, uid, 'budgetTokens', 'Must be a positive integer');
  }
}

/** @param {ModelRoutingState} state @returns {ValidationErrors} */
export function validateModelRouting(state) {
  /** @type {ValidationErrors} */
  const errors = {};
  for (const card of state.cards) {
    if (card.model.trim() === '') addError(errors, card.uid, 'model', 'Model is required');
  }
  const main = state.cards[0];
  if (main !== undefined) {
    for (const key of SETTINGS) {
      const value = state.defaults[key];
      if (!owns(state.defaults, key) || value === undefined || value === null || value === '') continue;
      if (NUMERIC_SETTINGS.has(key)) {
        const message = numericError(key, value);
        if (message !== null) addError(errors, main.uid, key, message);
      } else if (key === 'thinking') validateThinking(errors, main.uid, value);
    }
    for (const key of SETTINGS) {
      const setting = main.overrides[key];
      if (setting.mode !== 'override') continue;
      if (NUMERIC_SETTINGS.has(key)) {
        const message = numericError(key, setting.value);
        if (message !== null) addError(errors, main.uid, key, message);
      } else if (key === 'thinking') validateThinking(errors, main.uid, setting.value);
    }
  }
  for (const card of state.cards.slice(1)) {
    for (const key of SETTINGS) {
      const setting = card.overrides[key];
      if (setting.mode !== 'override') continue;
      if (NUMERIC_SETTINGS.has(key)) {
        const message = numericError(key, setting.value);
        if (message !== null) addError(errors, card.uid, key, message);
      } else if (key === 'thinking') validateThinking(errors, card.uid, setting.value);
    }
  }
  return errors;
}
