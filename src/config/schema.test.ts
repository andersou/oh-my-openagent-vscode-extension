import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  AgentConfig,
  CategoryConfig,
  FallbackModelConfig,
  ModelVariantConfig,
  Profile,
  ProfilesFile,
  Reasoning,
} from './schema.js';

type IsAssignable<Source, Target> = Source extends Target ? true : false;

type ExpectedProfileRootKey =
  | 'name'
  | 'description'
  | 'agents'
  | 'categories'
  | 'createdAt'
  | 'updatedAt';
type ExpectedProfilesFileRootKey =
  | 'profiles'
  | 'lastActiveProfile'
  | 'version';

// Pinned upstream contract (omo.dev unified config spec, dev branch):
// https://github.com/code-yeongyu/oh-my-openagent/blob/dev/assets/omo.schema.json
const UPSTREAM_PROFILE_AGENT = {
  model: 'openai/gpt-5.4',
  skills: ['programming', 'git-master'],
  description: 'Coordinates implementation work',
  displayName: 'Implementation Coordinator',
  ultrawork: { model: 'openai/gpt-5.4', variant: 'high' },
  compaction: { model: 'openai/gpt-5.4-mini', variant: 'medium' },
  permission: {
    task: 'allow',
    lsp_diagnostics: 'ask',
  },
  providerOptions: {
    transport: { mode: 'direct' },
    featureFlags: ['profile-transfer'],
  },
} satisfies AgentConfig;

const INVALID_SKILLS: { skills: number[] } = { skills: [42] };
const INVALID_TASK_PERMISSION = {
  permission: { task: 'sometimes' },
} as const;
const INVALID_ULTRAWORK_MODEL = { ultrawork: { model: 42 } } as const;

const PROFILE_SECTIONS = {
  agents: { sisyphus: UPSTREAM_PROFILE_AGENT },
  categories: {
    deep: {
      model: 'openai/gpt-5.4',
      main_overrides: { reasoningEffort: 'high' },
    },
  },
} satisfies Pick<Profile, 'agents' | 'categories'>;

// New in the omo.schema.json contract: `reasoning` alongside the unchanged
// `reasoningEffort`, on agents, categories, fallback models and variants.
const REASONING_SURFACE = {
  agent: { reasoning: 'auto' } satisfies AgentConfig,
  category: { reasoning: 'xhigh' } satisfies CategoryConfig,
  fallback: { model: 'openai/gpt-5.4', reasoning: 'off' } satisfies FallbackModelConfig,
  variant: { model: 'openai/gpt-5.4', reasoning: 'max' } satisfies ModelVariantConfig,
} as const;

describe('profile schema contract', () => {
  it('pins exact Profile root keys at compile time', () => {
    expectTypeOf<keyof Profile>().toEqualTypeOf<ExpectedProfileRootKey>();
  });

  it('pins exact ProfilesFile root keys at compile time', () => {
    expectTypeOf<keyof ProfilesFile>().toEqualTypeOf<ExpectedProfilesFileRootKey>();
  });

  it('rejects mutable numeric skills by element type at compile time', () => {
    expectTypeOf<
      NonNullable<AgentConfig['skills']>[number]
    >().toEqualTypeOf<string>();
    expectTypeOf<
      IsAssignable<typeof INVALID_SKILLS, Pick<AgentConfig, 'skills'>>
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsAssignable<
        typeof INVALID_TASK_PERMISSION,
        Pick<AgentConfig, 'permission'>
      >
    >().toEqualTypeOf<false>();
    expectTypeOf<
      IsAssignable<
        typeof INVALID_ULTRAWORK_MODEL,
        Pick<AgentConfig, 'ultrawork'>
      >
    >().toEqualTypeOf<false>();
  });

  it('serializes the pinned upstream agent subset inside profile sections', () => {
    // Given
    const expectedAgent = UPSTREAM_PROFILE_AGENT;

    // When
    const roundTrip = JSON.parse(JSON.stringify(PROFILE_SECTIONS));

    // Then
    expect(roundTrip.agents.sisyphus).toEqual(expectedAgent);
    expect(roundTrip.categories.deep.main_overrides).toEqual({
      reasoningEffort: 'high',
    });
  });

  it('pins the new `reasoning` enum on the editable surfaces', () => {
    expectTypeOf<Reasoning>().toEqualTypeOf<
      'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto'
    >();
    expectTypeOf<AgentConfig['reasoning']>().toEqualTypeOf<
      Reasoning | undefined
    >();
    expectTypeOf<CategoryConfig['reasoning']>().toEqualTypeOf<
      Reasoning | undefined
    >();
    expectTypeOf<FallbackModelConfig['reasoning']>().toEqualTypeOf<
      Reasoning | undefined
    >();
    expectTypeOf<ModelVariantConfig['reasoning']>().toEqualTypeOf<
      Reasoning | undefined
    >();

    // reasoningEffort is unchanged and remains available on agents/categories
    expectTypeOf<AgentConfig['reasoningEffort']>().toEqualTypeOf<
      | 'none'
      | 'minimal'
      | 'low'
      | 'medium'
      | 'high'
      | 'xhigh'
      | 'max'
      | undefined
    >();

    // Compile-time assignment round-trip (satisfies above already pins this)
    expect(REASONING_SURFACE.agent.reasoning).toBe('auto');
    expect(REASONING_SURFACE.category.reasoning).toBe('xhigh');
    expect(REASONING_SURFACE.fallback.reasoning).toBe('off');
    expect(REASONING_SURFACE.variant.reasoning).toBe('max');
  });
});
