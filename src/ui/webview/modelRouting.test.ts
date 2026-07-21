import { describe, expect, it } from 'vitest';

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

describe('model routing state', () => {
  it('loads top-level defaults and fallback override modes', () => {
    // Given: top-level settings, a string fallback, and an object fallback.
    const config = {
      model: 'main/model',
      temperature: 0.7,
      top_p: 0.8,
      fallback_models: ['inheriting/model', { model: 'overriding/model', temperature: 0.2 }],
    };

    // When: the upstream config is loaded into editor state.
    const state = loadModelRouting(config);

    // Then: defaults and explicit property ownership remain distinct.
    expect(state.defaults).toEqual({ temperature: 0.7, top_p: 0.8 });
    expect(state.cards.map((card) => card.uid)).toEqual(['card-0', 'card-1', 'card-2']);
    expect(state.cards[0]).toMatchObject({ model: 'main/model', provenance: 'loaded-main', source: 'object' });
    expect(state.cards[1].overrides.temperature).toEqual({ mode: 'inherit' });
    expect(state.cards[2].overrides.temperature).toEqual({ mode: 'override', value: 0.2 });
  });

  it('keeps an explicit promoted temperature separate from global defaults', () => {
    // Given: Main uses 0.7 and a fallback explicitly overrides it with 0.2.
    const config = { model: 'main/model', temperature: 0.7,
      fallback_models: [{ model: 'fallback/model', temperature: 0.2 }] };
    const state = loadModelRouting(config);
    const beforeMove = structuredClone(state);

    // When: the fallback is moved to index zero by stable UID.
    const moved = moveModelCard(state, state.cards[1].uid, 0);

    // Then: its explicit value is effective without changing global defaults, and the caller state is untouched.
    expect(moved.defaults.temperature).toBe(0.7);
    expect(moved.cards[0].overrides.temperature).toEqual({ mode: 'override', value: 0.2 });
    expect(moved.cards[1].overrides.temperature).toEqual({ mode: 'override', value: 0.7 });
    expect(state).toEqual(beforeMove);
  });

  it('keeps a variant-less promoted fallback inheriting the existing global variant', () => {
    // Given: Main owns variant fast while the fallback has no variant property.
    const state = loadModelRouting({ model: 'main/model', variant: 'fast',
      fallback_models: [{ model: 'fallback/model' }] });
    expect(state.cards[1].overrides.variant).toEqual({ mode: 'inherit' });

    // When: the variant-less fallback is promoted to Main.
    const moved = moveModelCard(state, state.cards[1].uid, 0);
    const payload = serializeModelRouting(moved);

    // Then: the promoted Main remains inheriting while the unchanged global variant remains effective.
    expect(moved.cards[0].overrides.variant).toEqual({ mode: 'inherit' });
    expect(moved.defaults.variant).toBe('fast');
    expect(moved.cards[1].overrides.variant).toEqual({ mode: 'override', value: 'fast' });
    expect(payload.variant).toBe('fast');
  });

  it('leaves defaults unchanged when an inheriting fallback becomes Main', () => {
    // Given: a fallback with no own sampling settings.
    const state = loadModelRouting({ model: 'main/model', temperature: 0.7,
      fallback_models: ['fallback/model'] });

    // When: the inheriting fallback becomes Main.
    const moved = moveModelCard(state, state.cards[1].uid, 0);

    // Then: it inherits 0.7 and the old Main records that prior effective value.
    expect(moved.defaults.temperature).toBe(0.7);
    expect(moved.cards[0].overrides.temperature).toEqual({ mode: 'inherit' });
    expect(moved.cards[1].overrides.temperature).toEqual({ mode: 'override', value: 0.7 });
  });

  it('retains defaults and original card modes across A to B to A', () => {
    // Given: B overrides temperature but inherits top-p from A.
    const initial = loadModelRouting({ model: 'a/model', temperature: 0.7, top_p: 0.8,
      fallback_models: [{ model: 'b/model', temperature: 0.2 }] });
    const aUid = initial.cards[0].uid;
    const bUid = initial.cards[1].uid;

    // When: B is promoted and then A is promoted again.
    const bMain = moveModelCard(initial, bUid, 0);
    const aMainAgain = moveModelCard(bMain, aUid, 0);

    // Then: shared defaults and both cards' original modes remain stable.
    expect(aMainAgain.defaults).toEqual({ temperature: 0.7, top_p: 0.8 });
    expect(aMainAgain.cards[1].overrides.temperature).toEqual({ mode: 'override', value: 0.2 });
    expect(aMainAgain.cards[1].overrides.top_p).toEqual({ mode: 'inherit' });
    expect(serializeModelRouting(aMainAgain).fallback_models).toEqual([{ model: 'b/model', temperature: 0.2 }]);
  });

  it('preserves promoted Main overrides across save and reopen via main_overrides', () => {
    // Given: B explicitly overrides temperature before it is promoted over A.
    const initial = loadModelRouting({ model: 'a/model', temperature: 0.7, top_p: 0.8,
      fallback_models: [{ model: 'b/model', temperature: 0.2 }] });
    const promoted = moveModelCard(initial, initial.cards[1].uid, 0);
    const saved = serializeModelRouting(promoted);

    // When: the saved payload is reopened and A becomes Main again.
    const persisted = Object.fromEntries(Object.entries(saved).filter(([, value]) => value !== null));
    const reopened = loadModelRouting(persisted);
    const restored = moveModelCard(reopened, reopened.cards[1].uid, 0);

    // Then: B's explicit temperature override survives in main_overrides; shared defaults stay unchanged.
    expect(saved).toEqual({ model: 'b/model', variant: null, reasoningEffort: null,
      temperature: 0.7, top_p: 0.8, maxTokens: null, thinking: null,
      main_overrides: { temperature: 0.2 },
      fallback_models: [{ model: 'a/model', temperature: 0.7, top_p: 0.8 }] });
    expect(promoted.cards[0].overrides.temperature).toEqual({ mode: 'override', value: 0.2 });
    expect(reopened.cards[0].overrides.temperature).toEqual({ mode: 'override', value: 0.2 });
    expect(restored.cards[1].overrides.top_p).toEqual({ mode: 'override', value: 0.8 });
  });

  it('preserves string and object fallback representation', () => {
    // Given: equivalent fallback settings encoded in both accepted shapes.
    const state = loadModelRouting({ model: 'main/model', fallback_models: ['string/model', { model: 'object/model' }] });

    // When: the untouched editor state is serialized.
    const payload = serializeModelRouting(state);

    // Then: string remains string and object remains object.
    expect(payload.fallback_models).toEqual(['string/model', { model: 'object/model' }]);
  });

  it('preserves unknown fallback and atomic thinking properties', () => {
    // Given: runtime extensions on fallback and thinking objects.
    const state = loadModelRouting({
      model: 'main/model',
      thinking: { type: 'enabled', budgetTokens: 100, adaptive: true },
      fallback_models: [{
        model: 'fallback/model',
        routeHint: { region: 'west' },
        thinking: { type: 'enabled', budgetTokens: 50, adaptive: false },
      }],
    });

    // When: the state is serialized without edits.
    const payload = serializeModelRouting(state);

    // Then: both known and unknown nested properties survive.
    expect(payload.thinking).toEqual({ type: 'enabled', budgetTokens: 100, adaptive: true });
    expect(payload.fallback_models).toEqual([{ model: 'fallback/model',
      routeHint: { region: 'west' },
      thinking: { type: 'enabled', budgetTokens: 50, adaptive: false } }]);
  });

  it('keeps disabled thinking distinct from absent inheritance', () => {
    // Given: disabled Main thinking, one inheriting fallback, and one explicit disable.
    const state = loadModelRouting({
      model: 'main/model',
      thinking: { type: 'disabled' },
      fallback_models: [
        'inheriting/model',
        { model: 'disabled/model', thinking: { type: 'disabled' } },
      ],
    });

    // When: override modes and payload are inspected.
    const payload = serializeModelRouting(state);

    // Then: absence stays inherit while explicit disabled remains serializable.
    expect(state.cards[1].overrides.thinking).toEqual({ mode: 'inherit' });
    expect(state.cards[2].overrides.thinking).toEqual({
      mode: 'override',
      value: { type: 'disabled' },
    });
    expect(payload.thinking).toEqual({ type: 'disabled' });
    expect(payload.fallback_models).toEqual([
      'inheriting/model',
      { model: 'disabled/model', thinking: { type: 'disabled' } },
    ]);
  });

  it('emits an explicit override even when it equals the default', () => {
    // Given: an object fallback explicitly repeats Main's temperature.
    const state = loadModelRouting({
      model: 'main/model',
      temperature: 0.7,
      fallback_models: [{ model: 'fallback/model', temperature: 0.7 }],
    });

    // When: the routing payload is serialized.
    const payload = serializeModelRouting(state);

    // Then: property ownership, not value equality, controls emission.
    expect(payload.fallback_models).toEqual([
      { model: 'fallback/model', temperature: 0.7 },
    ]);
  });

  it('updates a card between explicit override and inheritance', () => {
    // Given: a string fallback inheriting all settings.
    const state = loadModelRouting({
      model: 'main/model',
      fallback_models: ['fallback/model'],
    });
    const fallbackUid = state.cards[1].uid;

    // When: an explicit value is attached and then returned to inherit mode.
    const explicit = setCardOverride(state, fallbackUid, 'temperature', {
      mode: 'override',
      value: '0.4',
    });
    const inherited = setCardOverride(explicit, fallbackUid, 'temperature', {
      mode: 'inherit',
    });

    // Then: explicit mode forces object output and inherit restores string output.
    expect(serializeModelRouting(explicit).fallback_models).toEqual([
      { model: 'fallback/model', temperature: 0.4 },
    ]);
    expect(serializeModelRouting(inherited).fallback_models).toEqual([
      'fallback/model',
    ]);
    expect(state.cards[1].overrides.temperature).toEqual({ mode: 'inherit' });
  });

  it('edits a model ID by UID without mutating the caller state', () => {
    // Given: Main and fallback cards with stable UIDs.
    const state = loadModelRouting({ model: 'main/model', fallback_models: ['old/model'] });
    const original = structuredClone(state);

    // When: the fallback model is edited by UID.
    const edited = setCardModel(state, state.cards[1].uid, 'new/model');

    // Then: only the selected card changes and remains a string fallback.
    expect(edited.cards.map((card) => card.model)).toEqual(['main/model', 'new/model']);
    expect(serializeModelRouting(edited).fallback_models).toEqual(['new/model']);
    expect(state).toEqual(original);
  });

  it('sets and removes a Main default without changing an inherited card mode', () => {
    // Given: loaded Main has inherit mode for every attached setting.
    const state = loadModelRouting({ model: 'main/model' });

    // When: a default is set and then removed through the Main API.
    const set = setMainDefault(state, 'temperature', 0.6);
    const removed = setMainDefault(set, 'temperature', undefined);

    // Then: the active default is removed and Main's attached mode remains inherit.
    expect(set.defaults.temperature).toBe(0.6);
    expect(Object.hasOwn(removed.defaults, 'temperature')).toBe(false);
    expect(removed.cards[0].overrides.temperature).toEqual({ mode: 'inherit' });
    expect(state.defaults).toEqual({});
  });

  it.each([
    ['variant', 'fast'], ['reasoningEffort', 'high'], ['temperature', 0.7],
    ['top_p', 0.8], ['maxTokens', 2048], ['thinking', { type: 'disabled' }],
  ] as const)('emits null for cleared %s without null fallback fields', (key, value) => {
    // Given: one configured Main setting and an object fallback inheriting it.
    const state = loadModelRouting({ model: 'main/model', [key]: value,
      fallback_models: [{ model: 'fallback/model' }] });

    // When: the configured Main setting is cleared and serialized.
    const payload = serializeModelRouting(setMainDefault(state, key, undefined));

    // Then: every absent Main setting deletes stale host values while fallback fields stay omitted.
    expect(payload).toMatchObject({ variant: null, reasoningEffort: null, temperature: null,
      top_p: null, maxTokens: null, thinking: null });
    expect(payload.fallback_models).toEqual([{ model: 'fallback/model' }]);
  });

  it('does not change Main card modes or overrides when a global default is edited', () => {
    // Given: fallback B explicitly overrides A's temperature before promotion.
    const initial = loadModelRouting({
      model: 'a/model', temperature: 0.7,
      fallback_models: [{ model: 'b/model', temperature: 0.2 }],
    });
    const promoted = moveModelCard(initial, initial.cards[1].uid, 0);

    // When: B's global default is edited.
    const edited = setMainDefault(promoted, 'temperature', 0.4);

    // Then: only the global default changes; B's explicit override remains untouched.
    expect(edited.defaults.temperature).toBe(0.4);
    expect(edited.cards[0].overrides.temperature).toEqual({ mode: 'override', value: 0.2 });
    expect(edited.cards[1].overrides.temperature).toEqual({ mode: 'override', value: 0.7 });
    expect(serializeModelRouting(edited).fallback_models).toEqual([
      { model: 'a/model', temperature: 0.7 },
    ]);
  });

  it('keeps inherit mode attached when inheriting Main is edited then demoted', () => {
    // Given: fallback B inherits A's temperature before promotion.
    const initial = loadModelRouting({
      model: 'a/model', temperature: 0.7, fallback_models: ['b/model'],
    });
    const aUid = initial.cards[0].uid;
    const promoted = moveModelCard(initial, initial.cards[1].uid, 0);

    // When: the shared Main default changes and B is subsequently demoted.
    const edited = setMainDefault(promoted, 'temperature', 0.4);
    const demoted = moveModelCard(edited, aUid, 0);

    // Then: B returns to inheriting instead of gaining an explicit override.
    expect(demoted.cards[1].overrides.temperature).toEqual({ mode: 'inherit' });
    expect(serializeModelRouting(demoted).fallback_models).toEqual(['b/model']);
  });

  it('appends collision-free all-inherit fallbacks after removal and reorder', () => {
    // Given: a removed UID gap, reordered cards, and a cloned persisted state.
    const loaded = loadModelRouting({
      model: 'a/model', fallback_models: ['b/model', 'c/model'],
    });
    const withoutB = removeFallback(loaded, loaded.cards[1].uid);
    const reordered = moveModelCard(withoutB, loaded.cards[2].uid, 0);
    const restored = structuredClone(reordered);

    // When: two new fallbacks are appended and the first receives a model ID.
    const first = appendFallback(restored);
    const second = appendFallback(first);
    const edited = setCardModel(second, first.cards[2].uid, 'new/model');

    // Then: UIDs remain unique and the all-inherit card serializes as a string.
    expect(edited.cards.map((card) => card.uid)).toEqual(['card-2', 'card-0', 'card-3', 'card-4']);
    expect(new Set(edited.cards.map((card) => card.uid)).size).toBe(4);
    expect(first.cards[2].overrides.temperature).toEqual({ mode: 'inherit' });
    expect(serializeModelRouting(edited).fallback_models).toEqual([
      { model: 'a/model' }, 'new/model', '',
    ]);
  });

  it('removes a fallback but refuses to remove current Main', () => {
    // Given: one Main card and one fallback card.
    const state = loadModelRouting({ model: 'main/model', fallback_models: ['fallback/model'] });

    // When: removal is attempted for Main and then for the fallback.
    const mainRefused = removeFallback(state, state.cards[0].uid);
    const fallbackRemoved = removeFallback(mainRefused, state.cards[1].uid);

    // Then: Main remains and serializing the final card deletes the old chain.
    expect(mainRefused).toEqual(state);
    expect(fallbackRemoved.cards.map((card) => card.model)).toEqual(['main/model']);
    expect(serializeModelRouting(fallbackRemoved).fallback_models).toBeNull();
  });

  it('emits null fallback_models when Main is the only card', () => {
    // Given: a routing state with no fallback chain.
    const state = loadModelRouting({ model: 'main/model', temperature: 0.7 });

    // When: it is serialized for persistence.
    const payload = serializeModelRouting(state);

    // Then: an old persisted chain will be deleted explicitly.
    expect(payload).toEqual({ model: 'main/model', variant: null, reasoningEffort: null,
      temperature: 0.7, top_p: null, maxTokens: null, thinking: null,
      main_overrides: null,
      fallback_models: null });
  });

  it('returns UID and field keyed errors for editable invalid values', () => {
    // Given: invalid model IDs, defaults, fallback overrides, and thinking budgets.
    const state = loadModelRouting({
      model: '   ',
      temperature: 'Infinity',
      top_p: 1.1,
      maxTokens: 1.5,
      thinking: { type: 'enabled', budgetTokens: 0 },
      fallback_models: [{
        model: '',
        temperature: -0.1,
        top_p: 'not-a-number',
        maxTokens: 0,
        thinking: { type: 'enabled', budgetTokens: 'also-invalid' },
      }],
    });

    // When: the editable state is validated.
    const errors = validateModelRouting(state);

    // Then: validation reports every invalid field without throwing.
    const invalidFields = ['model', 'temperature', 'top_p', 'maxTokens', 'budgetTokens'] as const;
    expect(Object.keys(errors[state.cards[0].uid])).toEqual(invalidFields);
    expect(Object.keys(errors[state.cards[1].uid])).toEqual(invalidFields);
  });

  it('loads main_overrides into Main card override modes', () => {
    // Given: a saved config with shared defaults and Main-specific overrides.
    const state = loadModelRouting({
      model: 'main/model', temperature: 0.7,
      main_overrides: { temperature: 0.2, variant: 'fast' },
      fallback_models: ['fallback/model'],
    });

    // Then: Main carries its explicit overrides while shared defaults stay separate.
    expect(state.defaults.temperature).toBe(0.7);
    expect(state.cards[0].overrides.temperature).toEqual({ mode: 'override', value: 0.2 });
    expect(state.cards[0].overrides.variant).toEqual({ mode: 'override', value: 'fast' });
    expect(state.cards[0].overrides.top_p).toEqual({ mode: 'inherit' });
    expect(state.cards[1].overrides.temperature).toEqual({ mode: 'inherit' });
  });

  it('round-trips Main overrides through serialize and reload', () => {
    // Given: Main has explicit overrides set via setCardOverride.
    const state = loadModelRouting({ model: 'main/model', temperature: 0.7,
      fallback_models: ['fallback/model'] });
    const edited = setCardOverride(state, state.cards[0].uid, 'temperature', {
      mode: 'override', value: 0.2,
    });

    // When: the state is serialized and reloaded.
    const saved = serializeModelRouting(edited);
    const persisted = Object.fromEntries(Object.entries(saved).filter(([, value]) => value !== null));
    const reopened = loadModelRouting(persisted);

    // Then: Main's explicit override survives the round-trip; shared defaults remain unchanged.
    expect(saved.main_overrides).toEqual({ temperature: 0.2 });
    expect(reopened.cards[0].overrides.temperature).toEqual({ mode: 'override', value: 0.2 });
    expect(reopened.defaults.temperature).toBe(0.7);
  });

  it('ignores null top-level defaults on load without creating invalid fallback overrides on demotion', () => {
    // Given: a saved payload with null deletion sentinels for unset defaults.
    const saved = {
      model: 'main/model', temperature: 0.7,
      variant: null, reasoningEffort: null, top_p: null, maxTokens: null, thinking: null,
      main_overrides: null,
      fallback_models: ['fallback/model'],
    };
    const state = loadModelRouting(saved);

    // When: the fallback is promoted to Main, then demoted back.
    const promoted = moveModelCard(state, state.cards[1].uid, 0);
    const demoted = moveModelCard(promoted, state.cards[0].uid, 0);

    // Then: no fallback object contains a null override for an unset default.
    expect(promoted.defaults).toEqual({ temperature: 0.7 });
    expect(promoted.cards[1].overrides.top_p).toEqual({ mode: 'inherit' });
    expect(promoted.cards[1].overrides.maxTokens).toEqual({ mode: 'inherit' });
    const payload = serializeModelRouting(demoted);
    expect(payload.fallback_models).toEqual(['fallback/model']);
  });

  it('validates Main card overrides the same as fallback overrides', () => {
    // Given: Main has an invalid explicit temperature override.
    const state = loadModelRouting({ model: 'main/model', temperature: 0.7 });
    const edited = setCardOverride(state, state.cards[0].uid, 'temperature', {
      mode: 'override', value: -0.1,
    });

    // When: the editable state is validated.
    const errors = validateModelRouting(edited);

    // Then: the invalid Main override is reported.
    expect(errors[edited.cards[0].uid].temperature).toBe('Must be between 0 and 2');
  });

  it('serializes main_overrides as null when Main has no explicit overrides', () => {
    // Given: Main inherits all settings.
    const state = loadModelRouting({ model: 'main/model', temperature: 0.7,
      fallback_models: ['fallback/model'] });

    // When: the state is serialized.
    const payload = serializeModelRouting(state);

    // Then: main_overrides is null so any previously saved object is deleted.
    expect(payload.main_overrides).toBeNull();
  });
});
