import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AGENT_FIELDS, CATEGORY_FIELDS } from './agentEditorPanel.js';
import { validateAndClean } from './editorPayloadValidation.js';

describe('structured editor allow-lists', () => {
  it('pins the agent fields accepted before payload validation', () => {
    // Given
    const expected = [
      'category',
      'color',
      'disable',
      'fallback_models',
      'main_overrides',
      'maxTokens',
      'mode',
      'model',
      'permission',
      'prompt',
      'prompt_append',
      'providerOptions',
      'reasoningEffort',
      'temperature',
      'textVerbosity',
      'thinking',
      'tools',
      'top_p',
      'variant',
    ];

    // When
    const actual = [...AGENT_FIELDS].sort();

    // Then
    expect(actual).toEqual(expected);
  });

  it('pins the category fields accepted before payload validation', () => {
    // Given
    const expected = [
      'description',
      'disable',
      'fallback_models',
      'is_unstable_agent',
      'main_overrides',
      'maxTokens',
      'max_prompt_tokens',
      'model',
      'prompt_append',
      'reasoningEffort',
      'temperature',
      'textVerbosity',
      'thinking',
      'tools',
      'top_p',
      'variant',
    ];

    // When
    const actual = [...CATEGORY_FIELDS].sort();

    // Then
    expect(actual).toEqual(expected);
  });

  it('preserves legacy free-form color validation', () => {
    // When
    const color = validateAndClean<{ readonly color: string }>(
      { color: 'blue' },
      AGENT_FIELDS,
    );

    // Then
    expect(color).toEqual({ color: 'blue' });
  });

  it('preserves legacy integer maxTokens validation', () => {
    // When / Then
    expect(() =>
      validateAndClean<Record<string, unknown>>(
        { maxTokens: 1.5 },
        AGENT_FIELDS,
      ),
    ).toThrow('Invalid maxTokens: must be a positive integer');
  });

  it('preserves the legacy required enabled-thinking budget', () => {
    // When / Then
    expect(() =>
      validateAndClean<Record<string, unknown>>(
        { thinking: { type: 'enabled' } },
        AGENT_FIELDS,
      ),
    ).toThrow('Invalid thinking.budgetTokens: must be a positive integer');
  });
});
