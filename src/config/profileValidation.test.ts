import { describe, expect, it } from 'vitest';

import {
  validateProfile,
  validateProfileFragment,
  validateProfilesFile,
  validateProfileTransfer,
  type ProfileValidationErrorCode,
  type ProfileValidationResult,
} from './profileValidation.js';

function expectFailure(
  result: ProfileValidationResult<unknown>,
  code: ProfileValidationErrorCode,
  path: readonly (string | number)[],
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected profile validation to fail');
  }
  expect(result.error).toMatchObject({ code, path });
}

describe('profile runtime validation', () => {
  it('projects a full upstream-shaped config to rich profile sections', () => {
    // Given
    const agents = {
      sisyphus: {
        model: 'openai/gpt-5.4',
        variant: 'high',
        fallback_models: [
          'openai/gpt-5.4-mini',
          {
            model: 'anthropic/claude-4',
            reasoning: 'auto',
            reasoningEffort: 'medium',
            temperature: 0.4,
            top_p: 0.9,
            maxTokens: 8192,
            thinking: { type: 'enabled', budgetTokens: 2048 },
          },
        ],
        main_overrides: { reasoningEffort: 'high', maxTokens: 16384 },
        temperature: 0.7,
        top_p: 0.95,
        maxTokens: 32768,
        reasoning: 'high',
        reasoningEffort: 'xhigh',
        thinking: { type: 'enabled', budgetTokens: 4096 },
        prompt: 'Coordinate implementation.',
        prompt_append: 'Prefer focused changes.',
        skills: ['programming', 'git-master'],
        tools: { bash: true, write: false },
        disable: false,
        description: 'Implementation coordinator',
        permission: {
          task: 'allow',
          lsp_diagnostics: 'ask',
          bash: { '*': 'deny', 'git status': 'allow' },
        },
        category: 'deep',
        mode: 'primary',
        color: '#4488ff',
        displayName: 'Coordinator',
        textVerbosity: 'medium',
        providerOptions: {
          nullable: null,
          nested: { enabled: true, limits: [1, 'two'] },
        },
        ultrawork: { model: 'openai/gpt-5.4', variant: 'high' },
        compaction: { model: 'openai/gpt-5.4-mini' },
      },
    };
    const categories = {
      deep: {
        model: 'openai/gpt-5.4',
        reasoning: 'xhigh',
        main_overrides: { temperature: 0.2 },
        fallback_models: ['openai/gpt-5.4-mini'],
        textVerbosity: 'high',
        tools: { bash: true },
        prompt_append: 'Reason carefully.',
        description: 'Deep work',
        is_unstable_agent: false,
        disable: false,
        max_prompt_tokens: 120000,
      },
    };

    // When
    const result = validateProfileTransfer({
      kind: 'fragment',
      value: {
        $schema: 'https://example.test/upstream.schema.json',
        agent_order: ['sisyphus'],
        experimental: { enabled: true },
        agents,
        categories,
      },
    });

    // Then
    expect(result).toEqual({
      ok: true,
      value: { kind: 'fragment', value: { agents, categories } },
    });
  });

  it('normalizes missing and explicit sidecar version one', () => {
    // Given
    const roots = [
      {
        profiles: [
          {
            name: '  Focused profile  ',
            description: 'Pinned metadata',
            agents: {},
            createdAt: '2026-07-22T10:00:00.000Z',
            updatedAt: '2026-07-22T10:00:01.000Z',
          },
        ],
        lastActiveProfile: 'Focused profile',
      },
      { version: 1, profiles: [] },
    ];

    // When
    const results = roots.map((root) => validateProfilesFile(root));

    // Then
    expect(results).toEqual([
      {
        ok: true,
        value: {
          version: 1,
          profiles: [
            {
              name: 'Focused profile',
              description: 'Pinned metadata',
              agents: {},
              createdAt: '2026-07-22T10:00:00.000Z',
              updatedAt: '2026-07-22T10:00:01.000Z',
            },
          ],
          lastActiveProfile: 'Focused profile',
        },
      },
      { ok: true, value: { version: 1, profiles: [] } },
    ]);
  });

  it('validates an individual profile for later store and editor consumers', () => {
    // Given
    const input = { name: ' Unicode ✓ ', categories: { quick: {} } };

    // When
    const result = validateProfile(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: { name: 'Unicode ✓', categories: { quick: {} } },
    });
  });

  it.each([
    {
      label: 'agent root',
      config: { maxTokens: 1.5 },
    },
    {
      label: 'fallback entry',
      config: {
        fallback_models: [{ model: 'valid/model', maxTokens: 2.5 }],
      },
    },
    {
      label: 'main overrides',
      config: { main_overrides: { maxTokens: 3.5 } },
    },
  ])('accepts decimal maxTokens in an $label', ({ config }) => {
    // When
    const result = validateProfileFragment({ agents: { a: config } });

    // Then
    expect(result).toEqual({
      ok: true,
      value: { agents: { a: config } },
    });
  });

  it.each([
    {
      label: 'agent root',
      config: { thinking: { type: 'enabled', budgetTokens: 1.5 } },
    },
    {
      label: 'fallback entry',
      config: {
        fallback_models: [
          {
            model: 'valid/model',
            thinking: { type: 'enabled', budgetTokens: 2.5 },
          },
        ],
      },
    },
    {
      label: 'main overrides',
      config: {
        main_overrides: {
          thinking: { type: 'enabled', budgetTokens: 3.5 },
        },
      },
    },
  ])('accepts decimal thinking budgets in an $label', ({ config }) => {
    // When
    const result = validateProfileFragment({ agents: { a: config } });

    // Then
    expect(result).toEqual({
      ok: true,
      value: { agents: { a: config } },
    });
  });

  it.each([
    {
      label: 'agent root',
      config: { thinking: { type: 'enabled' } },
    },
    {
      label: 'fallback entry',
      config: {
        fallback_models: [
          { model: 'valid/model', thinking: { type: 'enabled' } },
        ],
      },
    },
    {
      label: 'main overrides',
      config: { main_overrides: { thinking: { type: 'enabled' } } },
    },
  ])('accepts enabled thinking without a budget in an $label', ({ config }) => {
    // When
    const result = validateProfileFragment({ agents: { a: config } });

    // Then
    expect(result).toEqual({
      ok: true,
      value: { agents: { a: config } },
    });
  });

  it('accepts direct permission extensions and nested bash permissions', () => {
    // Given
    const permission = {
      custom_tool: 'allow',
      bash: { '*': 'ask', 'git status': 'allow' },
    };

    // When
    const result = validateProfileFragment({
      agents: { a: { permission } },
    });

    // Then
    expect(result).toEqual({
      ok: true,
      value: { agents: { a: { permission } } },
    });
  });

  it.each([
    {
      label: 'unknown agent field',
      input: { agents: { custom: { invented: true } } },
      code: 'unknown_field',
      path: ['agents', 'custom', 'invented'],
    },
    {
      label: 'unknown category field',
      input: { categories: { quick: { invented: true } } },
      code: 'unknown_field',
      path: ['categories', 'quick', 'invented'],
    },
    {
      label: 'non-string agent reasoning',
      input: { agents: { custom: { reasoning: 3 } } },
      code: 'invalid_type',
      path: ['agents', 'custom', 'reasoning'],
    },
    {
      label: 'non-string category reasoning',
      input: { categories: { quick: { reasoning: { level: 'high' } } } },
      code: 'invalid_type',
      path: ['categories', 'quick', 'reasoning'],
    },
    {
      label: 'non-string nested fallback reasoning',
      input: {
        agents: {
          custom: {
            fallback_models: [{ model: 'valid/model', reasoning: true }],
          },
        },
      },
      code: 'invalid_type',
      path: ['agents', 'custom', 'fallback_models', 0, 'reasoning'],
    },
    {
      label: 'invalid nested fallback enum',
      input: {
        agents: {
          custom: {
            fallback_models: [{ model: 'valid/model', reasoningEffort: 'huge' }],
          },
        },
      },
      code: 'invalid_value',
      path: ['agents', 'custom', 'fallback_models', 0, 'reasoningEffort'],
    },
    {
      label: 'unknown nested fallback field',
      input: {
        categories: {
          quick: { fallback_models: [{ model: 'valid/model', extra: true }] },
        },
      },
      code: 'unknown_field',
      path: ['categories', 'quick', 'fallback_models', 0, 'extra'],
    },
    {
      label: 'temperature outside its range',
      input: { agents: { custom: { temperature: 2.1 } } },
      code: 'invalid_value',
      path: ['agents', 'custom', 'temperature'],
    },
    {
      label: 'non-finite maxTokens',
      input: { agents: { custom: { maxTokens: Number.NaN } } },
      code: 'invalid_value',
      path: ['agents', 'custom', 'maxTokens'],
    },
    {
      label: 'non-finite thinking budget',
      input: {
        agents: {
          custom: {
            thinking: { type: 'enabled', budgetTokens: Number.POSITIVE_INFINITY },
          },
        },
      },
      code: 'invalid_value',
      path: ['agents', 'custom', 'thinking', 'budgetTokens'],
    },
    {
      label: 'invalid agent mode',
      input: { agents: { custom: { mode: 'worker' } } },
      code: 'invalid_value',
      path: ['agents', 'custom', 'mode'],
    },
    {
      label: 'invalid category verbosity',
      input: { categories: { writing: { textVerbosity: 'verbose' } } },
      code: 'invalid_value',
      path: ['categories', 'writing', 'textVerbosity'],
    },
    {
      label: 'unknown thinking field',
      input: {
        agents: {
          custom: { thinking: { type: 'enabled', budgetTokens: 10, extra: true } },
        },
      },
      code: 'unknown_field',
      path: ['agents', 'custom', 'thinking', 'extra'],
    },
    {
      label: 'non-object provider options',
      input: { agents: { custom: { providerOptions: [] } } },
      code: 'invalid_type',
      path: ['agents', 'custom', 'providerOptions'],
    },
    {
      label: 'invalid permission extension value',
      input: { agents: { custom: { permission: { custom_tool: 'sometimes' } } } },
      code: 'invalid_value',
      path: ['agents', 'custom', 'permission', 'custom_tool'],
    },
    {
      label: 'non-hex agent color',
      input: { agents: { a: { color: 'blue' } } },
      code: 'invalid_value',
      path: ['agents', 'a', 'color'],
    },
    {
      label: 'nested edit permission map',
      input: { agents: { a: { permission: { edit: { '*': 'allow' } } } } },
      code: 'invalid_type',
      path: ['agents', 'a', 'permission', 'edit'],
    },
    {
      label: 'nested extension permission map',
      input: {
        agents: { a: { permission: { custom_tool: { '*': 'allow' } } } },
      },
      code: 'invalid_type',
      path: ['agents', 'a', 'permission', 'custom_tool'],
    },
    {
      label: 'missing fragment sections',
      input: { unrelated: true },
      code: 'missing_field',
      path: [],
    },
  ] as const)('rejects $label with an exact path', ({ input, code, path }) => {
    // When
    const result = validateProfileFragment(input);

    // Then
    expectFailure(result, code, path);
  });

  it.each([
    {
      label: 'missing profile name',
      input: { profiles: [{}] },
      code: 'missing_field',
      path: ['profiles', 0, 'name'],
    },
    {
      label: 'blank profile name',
      input: { profiles: [{ name: '   ' }] },
      code: 'invalid_value',
      path: ['profiles', 0, 'name'],
    },
    {
      label: 'malformed profile timestamp',
      input: { profiles: [{ name: 'bad time', createdAt: 'yesterday' }] },
      code: 'invalid_value',
      path: ['profiles', 0, 'createdAt'],
    },
    {
      label: 'impossible calendar timestamp',
      input: {
        profiles: [{ name: 'bad date', createdAt: '2026-02-31T00:00:00.000Z' }],
      },
      code: 'invalid_value',
      path: ['profiles', 0, 'createdAt'],
    },
    {
      label: 'updated timestamp before created timestamp',
      input: {
        profiles: [
          {
            name: 'reversed',
            createdAt: '2026-07-22T10:00:01.000Z',
            updatedAt: '2026-07-22T10:00:00.000Z',
          },
        ],
      },
      code: 'invalid_value',
      path: ['profiles', 0, 'updatedAt'],
    },
    {
      label: 'future sidecar version',
      input: { version: 2, profiles: [] },
      code: 'unsupported_version',
      path: ['version'],
    },
    {
      label: 'unrelated sidecar root key',
      input: { version: 1, profiles: [], $schema: 'not-allowed-here' },
      code: 'unknown_field',
      path: ['$schema'],
    },
    {
      label: 'malformed sidecar metadata',
      input: { profiles: [], lastActiveProfile: 42 },
      code: 'invalid_type',
      path: ['lastActiveProfile'],
    },
    {
      label: 'unknown profile metadata',
      input: { profiles: [{ name: 'strict', importedBy: 'nobody' }] },
      code: 'unknown_field',
      path: ['profiles', 0, 'importedBy'],
    },
    {
      label: 'non-numeric sidecar version',
      input: { version: '1', profiles: [] },
      code: 'invalid_type',
      path: ['version'],
    },
  ] as const)('rejects $label with an exact path', ({ input, code, path }) => {
    // When
    const result = validateProfilesFile(input);

    // Then
    expectFailure(result, code, path);
  });

  it('validates a sidecar as a sidecar rather than as an upstream config root', () => {
    // Given
    const input = {
      kind: 'sidecar' as const,
      value: { profiles: [{ name: 'portable', categories: { writing: {} } }] },
    };

    // When
    const result = validateProfileTransfer(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'sidecar',
        value: {
          version: 1,
          profiles: [{ name: 'portable', categories: { writing: {} } }],
        },
      },
    });
  });

  it.each([
    { label: 'valid configScope', configScope: 'opencode' },
    { label: 'invalid configScope', configScope: 'unknown' },
    { label: 'non-string configScope', configScope: 42 },
  ])('accepts but ignores imported $label on a full sidecar', ({ configScope }) => {
    // Given
    const input = { version: 1, profiles: [], configScope };

    // When
    const result = validateProfilesFile(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: { version: 1, profiles: [] },
    });
  });

  it('accepts a missing configScope on a full sidecar', () => {
    // Given
    const input = { version: 1, profiles: [] };

    // When
    const result = validateProfilesFile(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: { version: 1, profiles: [] },
    });
  });
});

describe('modern models routing validation', () => {
  it('accepts a public models chain in agents and categories', () => {
    // Given: a fragment taken from an omo.jsonc that uses the modern chain
    const input = {
      agents: {
        sisyphus: {
          models: [
            'openai/gpt-5.4',
            { model: 'anthropic/claude-4', reasoning: 'high', maxTokens: 8192 },
          ],
        },
      },
      categories: { deep: { models: ['openai/gpt-5.4'] } },
    };

    // When
    const result = validateProfileFragment(input);

    // Then
    expect(result).toEqual({ ok: true, value: input });
  });

  it.each([
    { label: 'agents', group: 'agents' },
    { label: 'categories', group: 'categories' },
  ])('rejects an unknown key inside a $label models entry', ({ group }) => {
    // Given: a model entry carrying a key the upstream schema rejects
    const entry = {
      models: [{ model: 'a/one', main_overrides: { temperature: 0.2 } }],
    };

    // When
    const result = validateProfileFragment({ [group]: { sisyphus: entry } });

    // Then
    expectFailure(result, 'unknown_field', [
      group,
      'sisyphus',
      'models',
      0,
      'main_overrides',
    ]);
  });

  it('rejects a models entry without a model', () => {
    // Given: an object entry that names no model
    const input = { agents: { sisyphus: { models: [{ temperature: 0.2 }] } } };

    // When
    const result = validateProfileFragment(input);

    // Then
    expectFailure(result, 'missing_field', [
      'agents',
      'sisyphus',
      'models',
      0,
      'model',
    ]);
  });

  it('rejects a models value that is not an array', () => {
    // Given: the legacy scalar form, which `models` does not accept
    const input = { agents: { sisyphus: { models: 'a/one' } } };

    // When
    const result = validateProfileFragment(input);

    // Then
    expectFailure(result, 'invalid_type', ['agents', 'sisyphus', 'models']);
  });
});
