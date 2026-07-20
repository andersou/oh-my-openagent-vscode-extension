import { describe, expect, it } from 'vitest';
import { loadModelRouting, setCardOverride } from './modelRouting.js';
import { validateModelCapabilities } from './modelCapabilities.js';

describe('validateModelCapabilities', () => {
  it('reports inherited unsupported settings for each fallback model', () => {
    const routing = loadModelRouting({
      model: 'main',
      temperature: 0.4,
      top_p: 0.8,
      reasoningEffort: 'high',
      thinking: { type: 'enabled', budgetTokens: 32 },
      fallback_models: ['no-temperature', 'no-reasoning'],
    });

    expect(validateModelCapabilities(routing, {
      'no-temperature': { capabilities: { temperature: false } },
      'no-reasoning': { capabilities: { reasoning: false } },
    })).toEqual({
      'card-1': { temperature: 'This model does not support temperature.', top_p: 'This model does not support top-p.' },
      'card-2': { reasoningEffort: 'This model does not support reasoning controls.', thinking: 'This model does not support thinking controls.' },
    });
  });

  it('does not classify maxTokens as a temperature capability', () => {
    const routing = loadModelRouting({ model: 'main', maxTokens: 100, fallback_models: ['no-temperature'] });
    expect(validateModelCapabilities(routing, { 'no-temperature': { capabilities: { temperature: false } } })).toEqual({});
  });

  it('validates explicit variants against card metadata while unknown metadata remains permissive', () => {
    const routing = setCardOverride(loadModelRouting({ model: 'main', fallback_models: ['known', 'unknown'] }), 'card-1', 'variant', { mode: 'override', value: 'missing' });
    expect(validateModelCapabilities(routing, {
      known: { variants: { fast: {} } },
    })).toEqual({ 'card-1': { variant: 'This model does not offer the selected variant.' } });
  });
});
