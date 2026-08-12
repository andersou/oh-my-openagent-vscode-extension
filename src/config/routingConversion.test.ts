import { describe, it, expect } from 'vitest';
import {
  hasLegacyRouting,
  toInternalRoutingConfig,
  toInternalRoutingEntry,
  toPublicRoutingConfig,
  toPublicRoutingEntry,
} from './routingConversion.js';

describe('toPublicRoutingEntry', () => {
  it('keeps a plain model when there is nothing to chain', () => {
    // Given: an entry whose routing is a single model with no overrides
    const entry = { model: 'openai/gpt-4', temperature: 0.4 };

    // When: converting to the public boundary shape
    const result = toPublicRoutingEntry(entry);

    // Then: `model` survives and no `models` array is invented
    expect(result).toEqual({ model: 'openai/gpt-4', temperature: 0.4 });
  });

  it('merges model and main_overrides into the first models entry', () => {
    // Given: an entry with main-only overrides
    const entry = {
      model: 'openai/gpt-4',
      temperature: 0.4,
      main_overrides: { reasoningEffort: 'high', top_p: 0.9 },
    };

    // When: converting to the public boundary shape
    const result = toPublicRoutingEntry(entry);

    // Then: the primary carries the overrides and no legacy key remains
    expect(result).toEqual({
      temperature: 0.4,
      models: [{ model: 'openai/gpt-4', reasoningEffort: 'high', top_p: 0.9 }],
    });
    expect(Object.hasOwn(result, 'main_overrides')).toBe(false);
    expect(Object.hasOwn(result, 'model')).toBe(false);
  });

  it('places fallbacks after the primary in order', () => {
    // Given: a string fallback chain
    const entry = {
      model: 'a/one',
      fallback_models: ['b/two', { model: 'c/three', temperature: 0.2 }],
    };

    // When: converting to the public boundary shape
    const result = toPublicRoutingEntry(entry);

    // Then: models is primary-first and fallback_models is gone
    expect(result).toEqual({
      models: ['a/one', 'b/two', { model: 'c/three', temperature: 0.2 }],
    });
  });

  it('accepts a single string fallback_models value', () => {
    // Given: the legacy scalar fallback form
    const entry = { model: 'a/one', fallback_models: 'b/two' };

    // When: converting to the public boundary shape
    const result = toPublicRoutingEntry(entry);

    // Then: it becomes a two-entry chain
    expect(result).toEqual({ models: ['a/one', 'b/two'] });
  });

  it('converts a reasoning-style variant to reasoning everywhere', () => {
    // Given: reasoning-style variants at top level, on main, and on a fallback
    const entry = {
      model: 'a/one',
      variant: 'high',
      main_overrides: { variant: 'max' },
      fallback_models: [{ model: 'b/two', variant: 'low' }],
    };

    // When: converting to the public boundary shape
    const result = toPublicRoutingEntry(entry);

    // Then: every reasoning-style variant became `reasoning`
    expect(result).toEqual({
      reasoning: 'high',
      models: [
        { model: 'a/one', reasoning: 'max' },
        { model: 'b/two', reasoning: 'low' },
      ],
    });
  });

  it('preserves a provider variant that is not a reasoning level', () => {
    // Given: a provider/model variant name
    const entry = { model: 'a/one', variant: 'thinking-2026' };

    // When: converting to the public boundary shape
    const result = toPublicRoutingEntry(entry);

    // Then: the upstream schema still accepts it, so it stays
    expect(result).toEqual({ model: 'a/one', variant: 'thinking-2026' });
  });

  it('drops a reasoning-style variant when reasoning is already set', () => {
    // Given: both keys present with the modern one explicit
    const entry = { model: 'a/one', reasoning: 'low', variant: 'high' };

    // When: converting to the public boundary shape
    const result = toPublicRoutingEntry(entry);

    // Then: the explicit modern value wins and the deprecated key is removed
    expect(result).toEqual({ model: 'a/one', reasoning: 'low' });
  });

  it('preserves non-routing fields untouched', () => {
    // Given: an entry mixing routing and unrelated configuration
    const entry = {
      model: 'a/one',
      main_overrides: { temperature: 0.1 },
      prompt_append: 'be terse',
      tools: { bash: true },
      disable: false,
    };

    // When: converting to the public boundary shape
    const result = toPublicRoutingEntry(entry);

    // Then: only routing keys are rewritten
    expect(result).toEqual({
      models: [{ model: 'a/one', temperature: 0.1 }],
      prompt_append: 'be terse',
      tools: { bash: true },
      disable: false,
    });
  });

  it('combines a legacy primary, modern models, and legacy fallbacks', () => {
    // Given: an entry carrying both representations during migration
    const entry = {
      model: 'legacy/main',
      main_overrides: { variant: 'high', temperature: 0.9 },
      fallback_models: ['legacy/fallback'],
      models: [{ model: 'modern/main', reasoning: 'high' }],
    };

    // When: converting to the public boundary shape
    const result = toPublicRoutingEntry(entry);

    // Then: upstream migration ordering is preserved without losing data
    expect(result).toEqual({
      models: [
        { model: 'legacy/main', reasoning: 'high', temperature: 0.9 },
        { model: 'modern/main', reasoning: 'high' },
        'legacy/fallback',
      ],
    });
  });

  it('preserves ownerless main_overrides instead of deleting data', () => {
    const entry = {
      description: 'incomplete draft',
      main_overrides: { reasoning: 'high', temperature: 0.2 },
    };

    expect(toPublicRoutingEntry(entry)).toEqual(entry);
  });

  it('preserves every schema-valid harness-neutral model-entry field', () => {
    const entry = {
      model: 'a/one',
      fallback_models: [{
        model: 'b/two',
        max_tokens: 1024,
        provider_options: { beta: true },
        textVerbosity: 'high',
        providerOptions: { reasoningSummary: 'detailed' },
      }],
    };

    expect(toPublicRoutingEntry(entry)).toEqual({
      models: [
        'a/one',
        {
          model: 'b/two',
          max_tokens: 1024,
          provider_options: { beta: true },
          textVerbosity: 'high',
          providerOptions: { reasoningSummary: 'detailed' },
        },
      ],
    });
  });

  it('classifies mixed model and models routing as legacy', () => {
    expect(
      hasLegacyRouting({ model: 'legacy/main', models: ['modern/fallback'] }),
    ).toBe(true);
  });

  it('is idempotent', () => {
    // Given: an entry with every legacy routing form
    const entry = {
      model: 'a/one',
      variant: 'high',
      main_overrides: { temperature: 0.1 },
      fallback_models: ['b/two'],
    };

    // When: converting twice
    const once = toPublicRoutingEntry(entry);
    const twice = toPublicRoutingEntry(once);

    // Then: the second pass changes nothing
    expect(twice).toEqual(once);
  });

  it('does not mutate its input', () => {
    // Given: an entry with legacy routing
    const entry = { model: 'a/one', main_overrides: { temperature: 0.1 } };

    // When: converting
    toPublicRoutingEntry(entry);

    // Then: the caller's object is untouched
    expect(entry).toEqual({ model: 'a/one', main_overrides: { temperature: 0.1 } });
  });
});

describe('toInternalRoutingEntry', () => {
  it('maps a plain string primary to model only', () => {
    // Given: a single-entry public chain
    const entry = { models: ['a/one'], temperature: 0.4 };

    // When: converting back to the internal shape
    const result = toInternalRoutingEntry(entry);

    // Then: no redundant main_overrides is produced
    expect(result).toEqual({ model: 'a/one', temperature: 0.4 });
  });

  it('splits an object primary into model and main_overrides', () => {
    // Given: a primary carrying main-only settings
    const entry = { models: [{ model: 'a/one', reasoning: 'high', top_p: 0.9 }] };

    // When: converting back to the internal shape
    const result = toInternalRoutingEntry(entry);

    // Then: the settings land in main_overrides
    expect(result).toEqual({
      model: 'a/one',
      main_overrides: { reasoning: 'high', top_p: 0.9 },
    });
  });

  it('maps trailing entries to fallback_models in order', () => {
    // Given: a three-entry public chain
    const entry = {
      models: ['a/one', 'b/two', { model: 'c/three', temperature: 0.2 }],
    };

    // When: converting back to the internal shape
    const result = toInternalRoutingEntry(entry);

    // Then: order is preserved after the primary
    expect(result).toEqual({
      model: 'a/one',
      fallback_models: ['b/two', { model: 'c/three', temperature: 0.2 }],
    });
  });

  it('combines mixed public and legacy routing using upstream order', () => {
    // Given: an entry that mixes both representations
    const entry = {
      model: 'legacy/main',
      main_overrides: { temperature: 0.9 },
      fallback_models: ['legacy/fallback'],
      models: [{ model: 'modern/main', temperature: 0.1 }],
    };

    // When: converting back to the internal shape
    const result = toInternalRoutingEntry(entry);

    // Then: legacy primary is first, followed by modern entries and fallbacks
    expect(result).toEqual({
      model: 'legacy/main',
      main_overrides: { temperature: 0.9 },
      fallback_models: [
        { model: 'modern/main', temperature: 0.1 },
        'legacy/fallback',
      ],
    });
  });

  it('keeps legacy routing fields but normalizes a reasoning-style variant', () => {
    // Given: an entry written by an older extension version
    const entry = {
      model: 'a/one',
      main_overrides: { temperature: 0.1 },
      fallback_models: ['b/two', { model: 'c/three', variant: 'low' }],
      variant: 'high',
    };

    // When: converting back to the internal shape
    const result = toInternalRoutingEntry(entry);

    // Then: only the deprecated reasoning-style variant changes
    expect(result).toEqual({
      model: 'a/one',
      main_overrides: { temperature: 0.1 },
      fallback_models: ['b/two', { model: 'c/three', reasoning: 'low' }],
      reasoning: 'high',
    });
  });

  it('preserves non-routing fields', () => {
    // Given: a public entry with unrelated configuration
    const entry = { models: ['a/one'], prompt: 'hello', tools: { bash: true } };

    // When: converting back to the internal shape
    const result = toInternalRoutingEntry(entry);

    // Then: unknown/non-routing keys survive
    expect(result).toEqual({ model: 'a/one', prompt: 'hello', tools: { bash: true } });
  });

  it('round-trips an internal entry through the public form', () => {
    // Given: the richest internal routing the editor can produce
    const entry = {
      model: 'a/one',
      temperature: 0.4,
      main_overrides: { reasoningEffort: 'high' },
      fallback_models: [{ model: 'b/two', temperature: 0.2 }],
      prompt_append: 'be terse',
    };

    // When: converting to public and back
    const result = toInternalRoutingEntry(toPublicRoutingEntry(entry));

    // Then: the internal representation is recovered exactly
    expect(result).toEqual(entry);
  });
});

describe('routing config conversion', () => {
  it('converts agents and categories and preserves other keys', () => {
    // Given: a config with legacy routing in both groups
    const config = {
      agents: { sisyphus: { model: 'a/one', main_overrides: { temperature: 0.1 } } },
      categories: { deep: { model: 'b/two', fallback_models: ['c/three'] } },
      agent_order: ['sisyphus'],
      disabled_agents: ['momus'],
    };

    // When: converting to the public boundary shape
    const result = toPublicRoutingConfig(config);

    // Then: routing is modernized and non-routing keys are untouched
    expect(result).toEqual({
      agents: { sisyphus: { models: [{ model: 'a/one', temperature: 0.1 }] } },
      categories: { deep: { models: ['b/two', 'c/three'] } },
      agent_order: ['sisyphus'],
      disabled_agents: ['momus'],
    });
  });

  it('converts a public config back to the internal shape', () => {
    // Given: a config as it is written to omo.jsonc
    const config = {
      agents: { sisyphus: { models: [{ model: 'a/one', temperature: 0.1 }] } },
      categories: { deep: { models: ['b/two', 'c/three'] } },
      agent_order: ['sisyphus'],
    };

    // When: converting back for editor/profile use
    const result = toInternalRoutingConfig(config);

    // Then: the internal routing fields are restored
    expect(result).toEqual({
      agents: { sisyphus: { model: 'a/one', main_overrides: { temperature: 0.1 } } },
      categories: { deep: { model: 'b/two', fallback_models: ['c/three'] } },
      agent_order: ['sisyphus'],
    });
  });

  it('leaves an empty config alone', () => {
    // Given: no overrides at all
    // When: converting in both directions
    // Then: the empty object survives
    expect(toPublicRoutingConfig({})).toEqual({});
    expect(toInternalRoutingConfig({})).toEqual({});
  });
});
