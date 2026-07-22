import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AgentConfig, Profile, ProfilesFile } from './schema.js';

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

// Pinned upstream contract: 9c81de52a18f5787154debe0e3cdf0ab465da2ff
// https://github.com/code-yeongyu/oh-my-openagent/blob/9c81de52a18f5787154debe0e3cdf0ab465da2ff/assets/oh-my-opencode.schema.json
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
});
