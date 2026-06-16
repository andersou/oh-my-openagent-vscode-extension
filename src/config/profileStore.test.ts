import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from './configStore.js';
import { ProfileStore } from './profileStore.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONFIG_WITH_COMMENTS = `{
  // Top-level comment
  "agents": {
    "sisyphus": {
      "model": "sisyphus/model", // inline comment
    },
    "explore": { "model": "explore/model" },
  },
  "categories": {
    "deep": {
      "model": "deep/model", // category comment
    },
  },
  "agent_order": [
    "sisyphus",
    "explore",
  ],
}
`;

const CONFIG_MINIMAL = `{
  "agents": {
    "sisyphus": { "model": "minimal/model" },
  },
}
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readConfig(configPath: string): string {
  return fs.readFileSync(configPath, 'utf-8');
}

function readSidecar(sidecarPath: string): ProfilesFileFromDisk {
  return JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
}

/** Shape of the sidecar file on disk. */
interface ProfilesFileFromDisk {
  profiles: Array<Record<string, unknown>>;
  lastActiveProfile?: string;
  version: number;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProfileStore', () => {
  let tmpDir: string;
  let configPath: string;
  let sidecarPath: string;
  let configStore: ConfigStore;
  let profileStore: ProfileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-profile-test-'));
    configPath = path.join(tmpDir, 'oh-my-openagent.json');
    sidecarPath = path.join(tmpDir, 'oh-my-openagent.profiles.json');
  });

  afterEach(() => {
    if (configStore) {
      configStore.dispose();
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create ConfigStore + ProfileStore pointing at tmpDir. */
  function createStores(): void {
    configStore = new ConfigStore(tmpDir);
    profileStore = new ProfileStore(configStore);
  }

  /** Write a config fixture and then create both stores (so they pick it up). */
  function setupWithConfig(fixture: string): void {
    fs.writeFileSync(configPath, fixture, 'utf-8');
    createStores();
  }

  // -----------------------------------------------------------------------
  // Empty / missing sidecar
  // -----------------------------------------------------------------------

  describe('when sidecar does not exist', () => {
    beforeEach(() => {
      createStores();
    });

    it('listProfiles returns empty array', () => {
      expect(profileStore.listProfiles()).toEqual([]);
    });

    it('getProfile returns undefined for any name', () => {
      expect(profileStore.getProfile('anything')).toBeUndefined();
    });

    it('getActiveProfileName returns undefined', () => {
      expect(profileStore.getActiveProfileName()).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // createProfile
  // -----------------------------------------------------------------------

  describe('createProfile', () => {
    it('creates a profile with a snapshot of agents and categories', async () => {
      setupWithConfig(CONFIG_WITH_COMMENTS);

      const profile = await profileStore.createProfile(
        'my-profile',
        'Test description',
      );

      expect(profile.name).toBe('my-profile');
      expect(profile.description).toBe('Test description');
      expect(profile.agents).toBeDefined();
      expect(profile.agents!.sisyphus?.model).toBe('sisyphus/model');
      expect(profile.agents!.explore?.model).toBe('explore/model');
      expect(profile.categories).toBeDefined();
      expect(profile.categories!.deep?.model).toBe('deep/model');
      expect(profile.createdAt).toBeDefined();
      expect(profile.updatedAt).toBeDefined();
      expect(profile.createdAt).toBe(profile.updatedAt);

      // Sidecar file now exists
      expect(fs.existsSync(sidecarPath)).toBe(true);
      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.profiles).toHaveLength(1);
      expect(onDisk.profiles[0].name).toBe('my-profile');
      expect(onDisk.version).toBe(1);
    });

    it('does NOT include agent_order in the snapshot', async () => {
      setupWithConfig(CONFIG_WITH_COMMENTS);

      const profile = await profileStore.createProfile('no-order');

      // Profiles only snapshot agents and categories, not agent_order
      expect((profile as Record<string, unknown>).agent_order).toBeUndefined();
    });

    it('throws when creating a profile with a duplicate name', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      await profileStore.createProfile('dup');

      await expect(profileStore.createProfile('dup')).rejects.toThrow(
        'Profile "dup" already exists',
      );
    });

    it('creates a profile even when the config is empty', async () => {
      // No config file at all — ConfigStore returns {}
      createStores();

      const profile = await profileStore.createProfile('empty-config');

      expect(profile.name).toBe('empty-config');
      expect(profile.agents).toBeUndefined();
      expect(profile.categories).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getProfile
  // -----------------------------------------------------------------------

  describe('getProfile', () => {
    it('returns undefined when no profile matches', () => {
      setupWithConfig(CONFIG_MINIMAL);
      expect(profileStore.getProfile('no-such')).toBeUndefined();
    });

    it('returns the matching profile after creation', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      await profileStore.createProfile('test');
      const found = profileStore.getProfile('test');

      expect(found).toBeDefined();
      expect(found!.name).toBe('test');
    });
  });

  // -----------------------------------------------------------------------
  // updateProfile
  // -----------------------------------------------------------------------

  describe('updateProfile', () => {
    it('merges a partial patch into an existing profile', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('test', 'original desc');

      const updated = await profileStore.updateProfile('test', {
        description: 'new desc',
        agents: { sisyphus: { model: 'patched/model' } },
      });

      expect(updated.name).toBe('test');
      expect(updated.description).toBe('new desc');
      expect(updated.agents!.sisyphus?.model).toBe('patched/model');
      // updatedAt should be a valid ISO timestamp (at least as recent as createdAt)
      expect(new Date(updated.updatedAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(updated.createdAt!).getTime(),
      );

      // Sidecar on disk updated
      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.profiles[0].description).toBe('new desc');
    });

    it('throws when the profile does not exist', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      await expect(
        profileStore.updateProfile('no-such', { description: 'x' }),
      ).rejects.toThrow('Profile "no-such" not found');
    });

    it('ignores the name field in the patch', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('original');

      const updated = await profileStore.updateProfile('original', {
        name: 'hacked-name',
      });

      expect(updated.name).toBe('original');
    });
  });

  // -----------------------------------------------------------------------
  // renameProfile
  // -----------------------------------------------------------------------

  describe('renameProfile', () => {
    it('renames a profile', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('old');

      const renamed = await profileStore.renameProfile('old', 'new');

      expect(renamed.name).toBe('new');
      expect(profileStore.getProfile('old')).toBeUndefined();
      expect(profileStore.getProfile('new')).toBeDefined();
    });

    it('throws when the old name does not exist', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      await expect(
        profileStore.renameProfile('no-such', 'target'),
      ).rejects.toThrow('Profile "no-such" not found');
    });

    it('throws when the new name already exists', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('a');
      await profileStore.createProfile('b');

      await expect(
        profileStore.renameProfile('a', 'b'),
      ).rejects.toThrow('Profile "b" already exists');
    });

    it('updates lastActiveProfile when renaming the active profile', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('old');
      await profileStore.activateProfile('old');

      await profileStore.renameProfile('old', 'new');

      expect(profileStore.getActiveProfileName()).toBe('new');
    });
  });

  // -----------------------------------------------------------------------
  // duplicateProfile
  // -----------------------------------------------------------------------

  describe('duplicateProfile', () => {
    it('creates a deep copy under a new name', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      const original = await profileStore.createProfile('src', 'desc');

      const dup = await profileStore.duplicateProfile('src', 'dst');

      expect(dup.name).toBe('dst');
      expect(dup.description).toBe('desc');
      expect(dup.agents).toEqual(original.agents);
      // Duplicate gets fresh timestamps (at least as recent as the original)
      expect(new Date(dup.createdAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(original.createdAt!).getTime(),
      );
      expect(dup.updatedAt).toBe(dup.createdAt);

      // Original unchanged
      expect(profileStore.getProfile('src')).toBeDefined();
    });

    it('deep-clones agents so mutations are isolated', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('src');
      await profileStore.duplicateProfile('src', 'dst');

      // Mutate the duplicate's agents
      await profileStore.updateProfile('dst', {
        agents: { sisyphus: { model: 'mutated/model' } },
      });

      // Original should be unaffected
      const src = profileStore.getProfile('src');
      expect(src!.agents!.sisyphus?.model).toBe('minimal/model');
    });

    it('throws when the source does not exist', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      await expect(
        profileStore.duplicateProfile('no-such', 'dst'),
      ).rejects.toThrow('Profile "no-such" not found');
    });

    it('throws when the target name already exists', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('src');
      await profileStore.createProfile('dst');

      await expect(
        profileStore.duplicateProfile('src', 'dst'),
      ).rejects.toThrow('Profile "dst" already exists');
    });
  });

  // -----------------------------------------------------------------------
  // deleteProfile
  // -----------------------------------------------------------------------

  describe('deleteProfile', () => {
    it('removes the profile from the sidecar', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('a');
      await profileStore.createProfile('b');

      await profileStore.deleteProfile('a');

      expect(profileStore.listProfiles()).toHaveLength(1);
      expect(profileStore.getProfile('a')).toBeUndefined();
      expect(profileStore.getProfile('b')).toBeDefined();
    });

    it('throws when the profile does not exist', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      await expect(
        profileStore.deleteProfile('no-such'),
      ).rejects.toThrow('Profile "no-such" not found');
    });

    it('clears lastActiveProfile when deleting the active profile', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('active');
      await profileStore.activateProfile('active');
      expect(profileStore.getActiveProfileName()).toBe('active');

      await profileStore.deleteProfile('active');

      expect(profileStore.getActiveProfileName()).toBeUndefined();
      // Sidecar should not have the key at all (JSON.stringify drops undefined)
      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.lastActiveProfile).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // activateProfile
  // -----------------------------------------------------------------------

  describe('activateProfile', () => {
    it('throws when the profile does not exist', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      await expect(
        profileStore.activateProfile('no-such'),
      ).rejects.toThrow('Profile "no-such" not found');
    });

    it('writes profile agents and categories into the active config', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('snap');
      await profileStore.activateProfile('snap');

      const cfg = configStore.getConfig();
      expect(cfg.agents?.sisyphus?.model).toBe('minimal/model');
    });

    it('preserves JSONC formatting (comments and trailing commas) in the active config', async () => {
      setupWithConfig(CONFIG_WITH_COMMENTS);

      // Snapshot the current config
      await profileStore.createProfile('snap');

      // Modify the active config — change a model value
      await configStore.updateConfig((draft) => {
        if (!draft.agents) {
          draft.agents = {};
        }
        if (!draft.agents.sisyphus) {
          draft.agents.sisyphus = {};
        }
        draft.agents.sisyphus.model = 'modified/model';
      });

      // Verify the modification took effect
      expect(configStore.getAgent('sisyphus')?.model).toBe('modified/model');

      // Activate the profile — should restore the original values
      await profileStore.activateProfile('snap');

      const raw = readConfig(configPath);

      // Comments survive
      expect(raw).toContain('// Top-level comment');
      expect(raw).toContain('// inline comment');
      expect(raw).toContain('// category comment');

      // Trailing commas survive (the original fixture has trailing commas)
      expect(raw).toContain('"sisyphus/model"');

      // Values restored from the profile
      expect(raw).toContain('"sisyphus/model"');
      expect(raw).not.toContain('"modified/model"');
      expect(configStore.getAgent('sisyphus')?.model).toBe('sisyphus/model');
    });

    it('replaces existing agents and categories entirely with the profile values', async () => {
      setupWithConfig(CONFIG_WITH_COMMENTS);

      // Create profile with only one agent (different from original which has 2)
      await configStore.updateConfig((draft) => {
        draft.agents = {
          sisyphus: { model: 'sisyphus/model' },
        };
      });
      await profileStore.createProfile('single-agent');

      // Restore the full config (with explore agent)
      fs.writeFileSync(configPath, CONFIG_WITH_COMMENTS, 'utf-8');
      // Force re-read
      configStore = new ConfigStore(tmpDir);
      profileStore = new ProfileStore(configStore);

      await profileStore.activateProfile('single-agent');

      const cfg = configStore.getConfig();
      expect(cfg.agents?.explore).toBeUndefined();
      expect(cfg.agents?.sisyphus?.model).toBe('sisyphus/model');
    });

    it('sets and persists lastActiveProfile', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('my-profile');

      await profileStore.activateProfile('my-profile');

      expect(profileStore.getActiveProfileName()).toBe('my-profile');

      // Persisted to sidecar
      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.lastActiveProfile).toBe('my-profile');
    });

    it('replaces lastActiveProfile on subsequent activations', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('first');
      await profileStore.createProfile('second');

      await profileStore.activateProfile('first');
      expect(profileStore.getActiveProfileName()).toBe('first');

      await profileStore.activateProfile('second');
      expect(profileStore.getActiveProfileName()).toBe('second');
    });
  });

  // -----------------------------------------------------------------------
  // onDidChange event
  // -----------------------------------------------------------------------

  describe('onDidChange', () => {
    it('emits "change" when a profile is created', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      let fired = false;
      profileStore.onDidChange.once('change', () => {
        fired = true;
      });

      await profileStore.createProfile('test');
      expect(fired).toBe(true);
    });

    it('emits "change" when a profile is updated', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('test');

      let fired = false;
      profileStore.onDidChange.once('change', () => {
        fired = true;
      });

      await profileStore.updateProfile('test', { description: 'updated' });
      expect(fired).toBe(true);
    });

    it('emits "change" when a profile is deleted', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('test');

      let fired = false;
      profileStore.onDidChange.once('change', () => {
        fired = true;
      });
      await profileStore.deleteProfile('test');
      expect(fired).toBe(true);
    });

    it('emits "change" when activateProfile updates lastActiveProfile', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('test');

      let fired = false;
      profileStore.onDidChange.once('change', () => {
        fired = true;
      });

      await profileStore.activateProfile('test');
      expect(fired).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Persistence round-trip
  // -----------------------------------------------------------------------

  describe('persistence', () => {
    it('survives a fresh ProfileStore instance (re-reads from disk)', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('persist');
      await profileStore.activateProfile('persist');

      // Create a fresh store pair pointing at the same directory
      const store2 = new ConfigStore(tmpDir);
      const profiles2 = new ProfileStore(store2);

      expect(profiles2.listProfiles()).toHaveLength(1);
      expect(profiles2.getProfile('persist')).toBeDefined();
      expect(profiles2.getActiveProfileName()).toBe('persist');

      store2.dispose();
    });
  });
});
