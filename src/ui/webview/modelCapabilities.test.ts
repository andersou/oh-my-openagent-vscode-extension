import { describe, expect, it } from 'vitest';
import { loadModelRouting, setCardOverride } from './modelRouting.js';
import { validateModelCapabilities } from './modelCapabilities.js';

describe('validateModelCapabilities', () => {
  it('ignores inherited unsupported sampling defaults while retaining reasoning validation', () => {
    const routing = loadModelRouting({
      model: 'main',
      temperature: 0.4,
      top_p: 0.8,
      reasoning: 'high',
      thinking: { type: 'enabled', budgetTokens: 32 },
      fallback_models: ['no-temperature', 'no-reasoning'],
    });

    expect(validateModelCapabilities(routing, {
      'no-temperature': { capabilities: { temperature: false } },
      'no-reasoning': { capabilities: { reasoning: false } },
    })).toEqual({
      'card-2': { reasoning: 'This model does not support reasoning controls.', thinking: 'This model does not support thinking controls.' },
    });
  });

  it('reports explicit unsupported sampling overrides', () => {
    const withTemperature = setCardOverride(
      loadModelRouting({ model: 'main', fallback_models: ['no-sampling'] }),
      'card-1',
      'temperature',
      { mode: 'override', value: 0.4 },
    );
    const routing = setCardOverride(withTemperature, 'card-1', 'top_p', { mode: 'override', value: 0.8 });

    expect(validateModelCapabilities(routing, {
      'no-sampling': { capabilities: { temperature: false } },
    })).toEqual({
      'card-1': { temperature: 'This model does not support temperature.', top_p: 'This model does not support top-p.' },
    });
  });

  it('does not classify maxTokens as a temperature capability', () => {
    const routing = loadModelRouting({ model: 'main', maxTokens: 100, fallback_models: ['no-temperature'] });
    expect(validateModelCapabilities(routing, { 'no-temperature': { capabilities: { temperature: false } } })).toEqual({});
  });

  it('does not block preserved legacy fields that are no longer editable', () => {
    const routing = setCardOverride(
      loadModelRouting({
        model: 'main',
        reasoningEffort: 'high',
        fallback_models: ['known'],
      }),
      'card-1',
      'variant',
      { mode: 'override', value: 'missing' },
    );
    expect(validateModelCapabilities(routing, {
      known: {
        capabilities: { reasoning: false },
        variants: { fast: {} },
      },
    })).toEqual({});
  });
});
