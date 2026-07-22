import { describe, expect, it } from 'vitest';

import type {
  AgentConfig,
  CategoryConfig,
  Profile,
  ProfilesFile,
} from './schema.js';

type IsAssignable<Source, Target> = Source extends Target ? true : false;

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

const INVALID_SKILLS = { skills: [42] } as const;
const INVALID_TASK_PERMISSION = {
  permission: { task: 'sometimes' },
} as const;
const INVALID_ULTRAWORK_MODEL = { ultrawork: { model: 42 } } as const;

const INVALID_FIXTURES_ARE_REJECTED = [
  false satisfies IsAssignable<typeof INVALID_SKILLS, AgentConfig>,
  false satisfies IsAssignable<typeof INVALID_TASK_PERMISSION, AgentConfig>,
  false satisfies IsAssignable<typeof INVALID_ULTRAWORK_MODEL, AgentConfig>,
] as const;

describe('profile schema contract', () => {
  it('keeps local profiles scoped to metadata, agents, and categories', () => {
    // Given
    const category = {
      model: 'openai/gpt-5.4',
      main_overrides: { variant: 'high' },
    } satisfies CategoryConfig;
    const profile = {
      name: 'portable-profile',
      description: 'Profile metadata',
      agents: { sisyphus: { model: 'openai/gpt-5.4' } },
      categories: { deep: category },
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    } satisfies Profile;
    const profilesFile = {
      profiles: [profile],
      lastActiveProfile: profile.name,
      version: 1,
    } satisfies ProfilesFile;

    // When
    const roundTrip = JSON.parse(JSON.stringify(profilesFile));

    // Then
    expect(Object.keys(roundTrip)).toEqual([
      'profiles',
      'lastActiveProfile',
      'version',
    ]);
    expect(Object.keys(roundTrip.profiles[0])).toEqual([
      'name',
      'description',
      'agents',
      'categories',
      'createdAt',
      'updatedAt',
    ]);
    expect(roundTrip.profiles[0].categories.deep.main_overrides).toEqual({
      variant: 'high',
    });
    expect(roundTrip.profiles[0]).not.toHaveProperty('agent_order');
    expect(roundTrip.profiles[0]).not.toHaveProperty('disabled_agents');
  });

  it('serializes the pinned upstream agent subset inside profile sections', () => {
    // Given
    const profileSections = {
      agents: { sisyphus: UPSTREAM_PROFILE_AGENT },
      categories: {
        deep: {
          model: 'openai/gpt-5.4',
          main_overrides: { reasoningEffort: 'high' },
        },
      },
    } satisfies Pick<Profile, 'agents' | 'categories'>;

    // When
    const roundTrip = JSON.parse(JSON.stringify(profileSections));

    // Then
    expect(roundTrip).toEqual(profileSections);
    expect(Object.keys(roundTrip)).toEqual(['agents', 'categories']);
  });

  it('rejects invalid pinned upstream agent fixtures at compile time', () => {
    expect(INVALID_FIXTURES_ARE_REJECTED).toEqual([false, false, false]);
  });
});
