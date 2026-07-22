import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { AGENT_FIELDS, CATEGORY_FIELDS } from './agentEditorPanel.js';

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
});
