import { describe, expect, it } from 'vitest';

import {
  cloneProfileFragment,
  cloneProfilesFile,
  containsProviderOptions,
  deriveProfileNameFromSource,
  exportProfileFragment,
  parseProfileTransfer,
  resolveProfileNameCollisions,
  sanitizeExportBasename,
  serializeProfileTransfer,
} from './profileTransfer.js';
import { validateProfileTransfer, type ProfileFragment } from './profileValidation.js';
import type { Profile } from './schema.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('profile transfer serialization', () => {
  it('serializes normalized fragments as two-space JSON with one trailing newline', () => {
    const fragment: ProfileFragment = {
      agents: { sisyphus: { model: 'openai/gpt-5.6' } },
      categories: { deep: { reasoningEffort: 'high' } },
    };

    expect(serializeProfileTransfer(fragment)).toBe(
      '{\n  "agents": {\n    "sisyphus": {\n      "model": "openai/gpt-5.6"\n    }\n  },\n  "categories": {\n    "deep": {\n      "reasoningEffort": "high"\n    }\n  }\n}\n',
    );
  });

  it('round-trips supported agent and category values through parser and validator', () => {
    const fragment: ProfileFragment = {
      agents: {
        sisyphus: {
          model: 'openai/gpt-5.6',
          fallback_models: [{ model: 'openai/gpt-5.5', temperature: 0.4 }],
          permission: { bash: { 'git status': 'allow' }, custom: 'ask' },
          providerOptions: { vendor: { opaque: ['do not inspect', 7] } },
          skills: ['git-master'],
        },
      },
      categories: { deep: { maxTokens: 1234.5, thinking: { type: 'enabled' } } },
    };

    const parsed = parseProfileTransfer(encode(serializeProfileTransfer(fragment)));
    if (!parsed.ok) throw new TypeError('canonical export did not parse');
    const validated = validateProfileTransfer(parsed.root);

    expect(validated).toEqual({
      ok: true,
      value: { kind: 'fragment', value: fragment },
    });
  });

  it('exports a clone-safe profile fragment without profile metadata or omitted sections', () => {
    const agents = { sisyphus: { model: 'openai/gpt-5.6' } };
    const profile: Profile = {
      name: 'Unicode 猫',
      description: 'private metadata',
      createdAt: '2026-07-22T00:00:00Z',
      updatedAt: '2026-07-22T00:01:00Z',
      agents,
    };

    const fragment = exportProfileFragment(profile);
    if (fragment.agents === undefined) throw new TypeError('agents were omitted');
    fragment.agents.sisyphus = { model: 'changed/model' };

    expect(fragment).not.toHaveProperty('categories');
    expect(fragment).not.toHaveProperty('name');
    expect(agents.sisyphus).toEqual({ model: 'openai/gpt-5.6' });
  });

  it('clones externally returned fragment and sidecar payloads', () => {
    const fragment: ProfileFragment = {
      agents: { explore: { providerOptions: { endpoint: 'original' } } },
    };
    const sidecar = {
      version: 1 as const,
      profiles: [{ name: 'One', agents: fragment.agents }],
    };

    const fragmentClone = cloneProfileFragment(fragment);
    const sidecarClone = cloneProfilesFile(sidecar);
    const firstProfile = sidecarClone.profiles[0];
    if (fragmentClone.agents === undefined) throw new TypeError('agents were omitted');
    if (firstProfile === undefined) throw new TypeError('profile was omitted');
    fragmentClone.agents.explore = { model: 'changed/model' };
    firstProfile.agents = { explore: { model: 'changed/sidecar' } };

    expect(fragment.agents?.explore).toEqual({
      providerOptions: { endpoint: 'original' },
    });
    expect(sidecar.profiles[0]?.agents?.explore).toEqual({
      providerOptions: { endpoint: 'original' },
    });
  });

  it.each([
    { sourceName: 'Focus.profile.jsonc', expected: 'Focus' },
    { sourceName: 'Focus.PROFILE.JSON', expected: 'Focus' },
    { sourceName: 'Focus.jsonc', expected: 'Focus' },
    { sourceName: ' Focus.json ', expected: 'Focus' },
    { sourceName: '  猫 profile.jsonc  ', expected: '猫 profile' },
    { sourceName: ' .PROFILE.JSONC ', expected: 'imported-profile' },
  ])('derives $expected from $sourceName', ({ sourceName, expected }) => {
    expect(deriveProfileNameFromSource(sourceName)).toBe(expected);
  });

  it('resolves exact case-sensitive existing and in-file collisions in source order', () => {
    expect(
      resolveProfileNameCollisions(['Alpha', 'alpha', 'Alpha-2'], [
        'Alpha',
        'Alpha',
        'alpha',
        '猫',
        '猫',
      ]),
    ).toEqual(['Alpha-3', 'Alpha-4', 'alpha-2', '猫', '猫-2']);
  });

  it.each([
    { name: 'Roadmap/2026', expected: 'Roadmap-2026' },
    { name: 'unsafe<>:"\\|?*', expected: 'unsafe-' },
    { name: 'unsafe\u0000name', expected: 'unsafe-name' },
    { name: 'report. ', expected: 'report' },
    { name: '   ', expected: 'profile' },
    { name: 'CON', expected: 'profile-CON' },
    { name: 'lPt9.txt', expected: 'profile-lPt9.txt' },
  ])('creates safe export basename $expected from $name', ({ name, expected }) => {
    expect(sanitizeExportBasename(name)).toBe(expected);
  });

  it('detects only own non-empty providerOptions without reading option values', () => {
    const opaqueOptions: Record<string, unknown> = {};
    Object.defineProperty(opaqueOptions, 'secret', {
      enumerable: true,
      get: () => {
        throw new TypeError('provider option value must remain opaque');
      },
    });
    class AgentWithInheritedProviderOptions {}
    Object.defineProperty(AgentWithInheritedProviderOptions.prototype, 'providerOptions', {
      value: { inherited: true },
    });
    const fragment: ProfileFragment = {
      agents: {
        empty: { providerOptions: {} },
        inherited: new AgentWithInheritedProviderOptions(),
        opaque: { providerOptions: opaqueOptions },
      },
    };

    expect(containsProviderOptions({ agents: { empty: {} } })).toBe(false);
    expect(containsProviderOptions({ agents: { empty: { providerOptions: {} } } })).toBe(false);
    expect(containsProviderOptions({ agents: { inherited: fragment.agents?.inherited ?? {} } })).toBe(false);
    expect(containsProviderOptions(fragment)).toBe(true);
  });
});
