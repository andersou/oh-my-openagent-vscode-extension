import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'jsonc-parser';
import { ConfigStore } from './configStore.js';
import { ProfileStore } from './profileStore.js';
import { saveProfileJson } from '../ui/profileJsonEditorHost.js';
import type { AgentConfig } from './schema.js';

/** Routing exactly as older extension versions wrote it. */
const LEGACY_AGENT: AgentConfig = {
  model: 'legacy/main',
  variant: 'high',
  main_overrides: { temperature: 0.3 },
  fallback_models: ['legacy/fallback', { model: 'legacy/other', variant: 'low' }],
};

const CONFIG_WITH_COMMENT = `{
  // keep me
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "old/model" },
    },
  },
}
`;

describe('routing boundary', () => {
  let tmpDir: string;
  let configPath: string;
  let configStore: ConfigStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-routing-boundary-'));
    configPath = path.join(tmpDir, 'omo.jsonc');
    configStore = new ConfigStore(tmpDir);
  });

  afterEach(() => {
    configStore.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(content: string): void {
    fs.writeFileSync(configPath, content, 'utf-8');
  }

  function readRaw(): string {
    return fs.readFileSync(configPath, 'utf-8');
  }

  function readAgent(name: string): Record<string, unknown> {
    const document = parse(readRaw(), [], { allowTrailingComma: true }) as {
      '[opencode]'?: { agents?: Record<string, Record<string, unknown>> };
    };
    return document['[opencode]']?.agents?.[name] ?? {};
  }

  function expectNoDeprecatedRouting(raw: string): void {
    expect(raw).not.toContain('main_overrides');
    expect(raw).not.toContain('fallback_models');
    expect(raw).not.toContain('"variant"');
  }

  it('writes only public routing when a legacy profile is activated', async () => {
    // Given: a live config and a saved profile using the legacy routing fields
    writeConfig(CONFIG_WITH_COMMENT);
    const profileStore = new ProfileStore(configStore);
    await profileStore.createProfileFromFragment('legacy', {
      agents: { sisyphus: LEGACY_AGENT },
    });

    // When: the profile is activated
    await profileStore.activateProfile('legacy');

    // Then: omo.jsonc carries the modern chain and nothing doctor rejects
    const raw = readRaw();
    expect(raw).toContain('// keep me');
    expectNoDeprecatedRouting(raw);
    expect(readAgent('sisyphus')).toEqual({
      reasoning: 'high',
      models: [
        { model: 'legacy/main', temperature: 0.3 },
        'legacy/fallback',
        { model: 'legacy/other', reasoning: 'low' },
      ],
    });
  });

  it('migrates legacy routing already on disk during an unrelated write', async () => {
    // Given: a config file hand-written with the deprecated fields
    writeConfig(`{
  // keep me
  "[opencode]": {
    "agents": {
      "sisyphus": {
        "model": "legacy/main",
        "variant": "max",
        "main_overrides": { "top_p": 0.8 },
        "fallback_models": "legacy/fallback"
      }
    }
  }
}
`);

    // When: an unrelated agent is edited
    await configStore.updateConfig((draft) => {
      draft.agents = { ...draft.agents, explore: { model: 'new/model' } };
    });

    // Then: the untouched agent is rewritten in the public dialect
    const raw = readRaw();
    expect(raw).toContain('// keep me');
    expectNoDeprecatedRouting(raw);
    expect(readAgent('sisyphus')).toEqual({
      reasoning: 'max',
      models: [{ model: 'legacy/main', top_p: 0.8 }, 'legacy/fallback'],
    });
    expect(readAgent('explore')).toEqual({ model: 'new/model' });
  });

  it('leaves a provider variant in place while removing a reasoning one', async () => {
    // Given: one agent with a model variant and one with a reasoning variant
    writeConfig(`{
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "a/one", "variant": "thinking-2026", "main_overrides": { "temperature": 0.2 } },
      "explore": { "model": "b/two", "variant": "low" }
    }
  }
}
`);

    // When: any write happens
    await configStore.updateConfig((draft) => {
      draft.categories = { deep: { model: 'c/three' } };
    });

    // Then: only the reasoning-style variant is converted
    expect(readAgent('sisyphus')).toEqual({
      variant: 'thinking-2026',
      models: [{ model: 'a/one', temperature: 0.2 }],
    });
    expect(readAgent('explore')).toEqual({ model: 'b/two', reasoning: 'low' });
  });

  it('reads a public models chain back as internal routing', () => {
    // Given: a config written in the modern public dialect
    writeConfig(`{
  "[opencode]": {
    "agents": {
      "sisyphus": {
        "models": [
          { "model": "a/one", "temperature": 0.3, "reasoning": "high" },
          "b/two",
          { "model": "c/three", "top_p": 0.5 }
        ]
      }
    },
    "categories": {
      "deep": { "models": ["d/four"] }
    }
  }
}
`);

    // When: the effective config is read
    const agent = configStore.getAgent('sisyphus');
    const category = configStore.getCategory('deep');

    // Then: editor and profile code see the internal representation
    expect(agent).toEqual({
      model: 'a/one',
      main_overrides: { temperature: 0.3, reasoning: 'high' },
      fallback_models: ['b/two', { model: 'c/three', top_p: 0.5 }],
    });
    expect(category).toEqual({ model: 'd/four' });
  });

  it('snapshots the internal representation into a new profile', async () => {
    // Given: a config file written in the public dialect
    writeConfig(`{
  "[opencode]": {
    "agents": {
      "sisyphus": { "models": [{ "model": "a/one", "temperature": 0.3 }, "b/two"] }
    }
  }
}
`);
    const profileStore = new ProfileStore(configStore);

    // When: a profile snapshots the live config
    const profile = await profileStore.createProfile('snapshot');

    // Then: the profile stores the internal routing fields
    expect(profile.agents).toEqual({
      sisyphus: {
        model: 'a/one',
        main_overrides: { temperature: 0.3 },
        fallback_models: ['b/two'],
      },
    });
  });

  it('round-trips a legacy profile through activation and save-back', async () => {
    // Given: an activated legacy profile
    writeConfig(CONFIG_WITH_COMMENT);
    const profileStore = new ProfileStore(configStore);
    await profileStore.createProfileFromFragment('legacy', {
      agents: { sisyphus: LEGACY_AGENT },
    });
    await profileStore.activateProfile('legacy');

    // When: the live config is snapshotted back into the profile
    const saved = await profileStore.saveActiveConfigToProfile();

    // Then: the reasoning-style variant is now stored as `reasoning`
    expect(saved.agents).toEqual({
      sisyphus: {
        reasoning: 'high',
        model: 'legacy/main',
        main_overrides: { temperature: 0.3 },
        fallback_models: ['legacy/fallback', { model: 'legacy/other', reasoning: 'low' }],
      },
    });
    expect(profileStore.isActiveProfileModified()).toBe(false);
  });

  it('converts a public fragment saved through the active JSON editor', async () => {
    // Given: an empty live config
    writeConfig('{}');
    const profileStore = new ProfileStore(configStore);

    // When: a fragment using the modern chain replaces the active config
    await profileStore.replaceActiveConfigFragment({
      agents: { sisyphus: { models: [{ model: 'a/one', temperature: 0.3 }, 'b/two'] } },
    });

    // Then: the config is stored publicly and read back internally
    expect(readAgent('sisyphus')).toEqual({
      models: [{ model: 'a/one', temperature: 0.3 }, 'b/two'],
    });
    expect(configStore.getAgent('sisyphus')).toEqual({
      model: 'a/one',
      main_overrides: { temperature: 0.3 },
      fallback_models: ['b/two'],
    });
  });

  it('saves a public fragment typed into the active JSON editor', async () => {
    // Given: an empty live config and the active-config JSON editor target
    writeConfig('{}');
    const profileStore = new ProfileStore(configStore);
    const text = JSON.stringify({
      agents: {
        sisyphus: { models: [{ model: 'a/one', variant: 'high' }, 'b/two'] },
      },
    });

    // When: the user saves text written in the public dialect
    const result = await saveProfileJson(
      { type: 'profileJson', source: 'active' },
      text,
      profileStore,
      configStore,
    );

    // Then: it is echoed and stored internally, and written publicly
    expect(result.ok).toBe(true);
    expect(configStore.getAgent('sisyphus')).toEqual({
      model: 'a/one',
      main_overrides: { reasoning: 'high' },
      fallback_models: ['b/two'],
    });
    expect(readAgent('sisyphus')).toEqual({
      models: [{ model: 'a/one', reasoning: 'high' }, 'b/two'],
    });
    expectNoDeprecatedRouting(readRaw());
  });

  it('keeps configScope in the sidecar and out of omo.jsonc', async () => {
    // Given: a persisted scope selection
    writeConfig(CONFIG_WITH_COMMENT);
    const profileStore = new ProfileStore(configStore);
    await profileStore.setConfigScope('opencode');
    await profileStore.createProfileFromFragment('legacy', {
      agents: { sisyphus: LEGACY_AGENT },
    });

    // When: a profile is activated
    await profileStore.activateProfile('legacy');

    // Then: only the sidecar knows about the scope
    expect(readRaw()).not.toContain('configScope');
    expect(profileStore.getConfigScope()).toBe('opencode');
  });

  describe('routing dialect writes', () => {
    it('latest + opencode writes fallback_models and never models for a chain', async () => {
      writeConfig(CONFIG_WITH_COMMENT);
      configStore = new ConfigStore(tmpDir, undefined, 'opencode', 'latest');

      await configStore.updateConfig((draft) => {
        draft.agents = {
          sisyphus: { model: 'a/one', fallback_models: ['b/two'] },
        };
      });

      const raw = readRaw();
      expect(readAgent('sisyphus')).toEqual({
        model: 'a/one',
        fallback_models: ['b/two'],
      });
      expect(raw).not.toContain('"models"');
    });

    it('latest + senpi writes the models array', async () => {
      writeConfig(CONFIG_WITH_COMMENT);
      configStore = new ConfigStore(tmpDir, undefined, 'senpi', 'latest');

      await configStore.updateConfig((draft) => {
        draft.agents = {
          sisyphus: { model: 'a/one', fallback_models: ['b/two'] },
        };
      });

      const parsed = parse(readRaw(), [], { allowTrailingComma: true }) as {
        '[senpi]'?: { agents?: Record<string, Record<string, unknown>> };
      };
      expect(parsed['[senpi]']?.agents?.sisyphus).toEqual({
        models: ['a/one', 'b/two'],
      });
    });

    it('latest + global writes model-only and drops chain keys', async () => {
      writeConfig(CONFIG_WITH_COMMENT);
      configStore = new ConfigStore(tmpDir, undefined, 'global', 'latest');

      await configStore.updateConfig((draft) => {
        draft.agents = {
          sisyphus: { model: 'a/one', fallback_models: ['b/two'] },
        };
      });

      const raw = readRaw();
      const parsed = parse(raw, [], { allowTrailingComma: true }) as {
        agents?: Record<string, Record<string, unknown>>;
      };
      expect(parsed.agents?.sisyphus).toEqual({ model: 'a/one' });
      expect(raw).not.toContain('fallback_models');
      expect(raw).not.toContain('"models"');
    });

    it('latest + opencode rewrites a legacy models array to fallback_models', async () => {
      writeConfig(`{
  "[opencode]": {
    "agents": {
      "sisyphus": {
        "models": [
          { "model": "a/one", "temperature": 0.3 },
          "b/two"
        ]
      }
    }
  }
}
`);
      configStore = new ConfigStore(tmpDir, undefined, 'opencode', 'latest');

      await configStore.updateConfig((draft) => {
        draft.categories = { deep: { model: 'c/three' } };
      });

      const raw = readRaw();
      expect(readAgent('sisyphus')).toEqual({
        model: 'a/one',
        temperature: 0.3,
        fallback_models: ['b/two'],
      });
      expect(raw).not.toContain('"models"');
    });

    it('mainline + opencode rewrites a legacy fallback_models file to models', async () => {
      writeConfig(`{
  "[opencode]": {
    "agents": {
      "sisyphus": {
        "model": "a/one",
        "fallback_models": ["b/two"]
      }
    }
  }
}
`);
      configStore = new ConfigStore(tmpDir, undefined, 'opencode', 'mainline');

      await configStore.updateConfig((draft) => {
        draft.categories = { deep: { model: 'c/three' } };
      });

      expect(readAgent('sisyphus')).toEqual({
        models: ['a/one', 'b/two'],
      });
    });
  });
  describe('profile source of truth', () => {
    it('reprojects one internal profile across routing dialects without mutating it', async () => {
      writeConfig(CONFIG_WITH_COMMENT);
      configStore.dispose();
      configStore = new ConfigStore(tmpDir, undefined, 'opencode', 'mainline');
      const profileStore = new ProfileStore(configStore);
      await profileStore.createProfileFromFragment('truth', {
        agents: {
          sisyphus: {
            model: 'a/one',
            main_overrides: { temperature: 0.3 },
            fallback_models: ['b/two'],
          },
        },
      });
      await profileStore.activateProfile('truth');
      const storedProfile = profileStore.getProfile('truth');

      expect(readAgent('sisyphus')).toEqual({
        models: [{ model: 'a/one', temperature: 0.3 }, 'b/two'],
      });

      configStore.setRoutingDialect('latest');
      await profileStore.projectActiveProfileToConfig();

      expect(readAgent('sisyphus')).toEqual({
        model: 'a/one',
        temperature: 0.3,
        fallback_models: ['b/two'],
      });
      expect(profileStore.getProfile('truth')).toEqual(storedProfile);

      configStore.setRoutingDialect('mainline');
      await profileStore.projectActiveProfileToConfig();

      expect(readAgent('sisyphus')).toEqual({
        models: [{ model: 'a/one', temperature: 0.3 }, 'b/two'],
      });
      expect(profileStore.getProfile('truth')).toEqual(storedProfile);
    });

    it('compares the normalized global output and preserves routing hidden from disk', async () => {
      writeConfig('{}');
      configStore.dispose();
      configStore = new ConfigStore(tmpDir, undefined, 'global', 'latest');
      const profileStore = new ProfileStore(configStore);
      await profileStore.createProfileFromFragment('truth', {
        agents: {
          sisyphus: {
            model: 'a/one',
            main_overrides: { temperature: 0.3 },
            fallback_models: ['b/two'],
          },
        },
      });
      await profileStore.activateProfile('truth');

      const projected = parse(readRaw(), [], { allowTrailingComma: true }) as {
        agents?: Record<string, Record<string, unknown>>;
      };
      expect(projected.agents?.sisyphus).toEqual({
        model: 'a/one',
        temperature: 0.3,
      });
      expect(profileStore.getActiveProfileModifications()).toEqual([]);
      expect(profileStore.isActiveProfileModified()).toBe(false);

      await profileStore.saveActiveConfigToProfile();

      expect(profileStore.getProfile('truth')?.agents?.sisyphus).toEqual({
        model: 'a/one',
        main_overrides: { temperature: 0.3 },
        fallback_models: ['b/two'],
      });

      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "c/three", "temperature": 0.3 }
  }
}`);
      configStore.refreshFromDisk();
      await profileStore.saveActiveConfigToProfile();

      expect(profileStore.getProfile('truth')?.agents?.sisyphus).toEqual({
        model: 'c/three',
        main_overrides: { temperature: 0.3 },
        fallback_models: ['b/two'],
      });
    });
  });
});
