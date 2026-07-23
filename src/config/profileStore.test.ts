import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from './configStore.js';
import { ProfileStore } from './profileStore.js';
import type { ProfileFragment, NormalizedProfilesFile } from './profileValidation.js';
import type { ImportProfilesResult, Profile } from './schema.js';

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
  // updateProfileEntry
  // -----------------------------------------------------------------------

  describe('updateProfileEntry', () => {
    it('merges an agent patch over an existing profile entry', async () => {
      // Given: a profile entry with fields the editor did not send back
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('fast');
      await profileStore.updateProfile('fast', {
        agents: {
          sisyphus: {
            model: 'old/model',
            prompt: 'keep this prompt',
            tools: { read: true },
          },
        },
      });

      // When: only the model field is saved from a profile-context editor
      const updated = await profileStore.updateProfileEntry(
        'fast',
        'agents',
        'sisyphus',
        { model: 'new/model' },
        new Set(),
      );

      // Then: the patch is merged without dropping unrelated profile fields
      expect(updated.agents?.sisyphus).toEqual({
        model: 'new/model',
        prompt: 'keep this prompt',
        tools: { read: true },
      });
    });

    it('deletes null-key fields after merging an entry patch', async () => {
      // Given: a profile category entry with a clearable field
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('careful');
      await profileStore.updateProfile('careful', {
        categories: {
          deep: {
            model: 'old/category',
            description: 'remove me',
            max_prompt_tokens: 200000,
          },
        },
      });

      // When: the editor submits a null key for deletion
      const updated = await profileStore.updateProfileEntry(
        'careful',
        'categories',
        'deep',
        { model: 'new/category' },
        new Set(['description']),
      );

      // Then: the null-key field is removed while other fields are preserved
      expect(updated.categories?.deep).toEqual({
        model: 'new/category',
        max_prompt_tokens: 200000,
      });
    });

    it('creates the group map and entry when missing', async () => {
      // Given: a profile captured from an empty active config
      createStores();
      await profileStore.createProfile('empty');

      // When: saving a category into the empty profile
      const updated = await profileStore.updateProfileEntry(
        'empty',
        'categories',
        'quick',
        { model: 'quick/model' },
        new Set(),
      );

      // Then: the categories map and entry are created
      expect(updated.categories?.quick).toEqual({ model: 'quick/model' });
    });

    it('throws when the target profile is unknown', async () => {
      // Given: a sidecar without the requested profile
      setupWithConfig(CONFIG_MINIMAL);

      // When/Then: the profile-context write rejects with the profile name
      await expect(
        profileStore.updateProfileEntry(
          'ghost',
          'agents',
          'sisyphus',
          { model: 'ghost/model' },
          new Set(),
        ),
      ).rejects.toThrow('Profile "ghost" not found');
    });

    it('emits change after a successful entry update', async () => {
      // Given: a profile and a change listener on the profile store
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('fast');
      let changes = 0;
      profileStore.onDidChange.on('change', () => {
        changes += 1;
      });

      // When: the profile entry is updated
      await profileStore.updateProfileEntry(
        'fast',
        'agents',
        'sisyphus',
        { model: 'changed/model' },
        new Set(),
      );

      // Then: writeProfilesFile emitted the store change event
      expect(changes).toBe(1);
    });

    it('bumps updatedAt when an entry is updated', async () => {
      // Given: a profile with an old timestamp on disk
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('fast');
      const oldUpdatedAt = '2000-01-01T00:00:00.000Z';
      const onDisk = readSidecar(sidecarPath);
      onDisk.profiles[0].updatedAt = oldUpdatedAt;
      fs.writeFileSync(sidecarPath, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf-8');

      // When: a profile entry is updated
      const updated = await profileStore.updateProfileEntry(
        'fast',
        'agents',
        'sisyphus',
        { model: 'new/model' },
        new Set(),
      );

      // Then: the profile updatedAt reflects the new write
      expect(updated.updatedAt).not.toBe(oldUpdatedAt);
      expect(new Date(updated.updatedAt!).getTime()).toBeGreaterThan(
        new Date(oldUpdatedAt).getTime(),
      );
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
  // importSingleProfile
  // -----------------------------------------------------------------------

  describe('importSingleProfile', () => {
    it('imports a single fragment and derives the name from the filename', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      const fragment: ProfileFragment = {
        agents: { sisyphus: { model: 'imported/model' } },
      };

      const profile = await profileStore.importSingleProfile(
        fragment,
        'my-cool.profile.jsonc',
      );

      expect(profile.name).toBe('my-cool');
      expect(profile.agents?.sisyphus?.model).toBe('imported/model');
      expect(profile.createdAt).toBe(profile.updatedAt);
      expect(profileStore.getProfile('my-cool')).toBeDefined();
    });

    it('trims Unicode whitespace and falls back to imported-profile', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      const fragment: ProfileFragment = { categories: { quick: { model: 'q' } } };

      const profile = await profileStore.importSingleProfile(fragment, '   \t\n ');

      expect(profile.name).toBe('imported-profile');
      expect(profile.categories?.quick?.model).toBe('q');
    });

    it('resolves collisions against existing sidecar names in source order', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('collision');

      const p1 = await profileStore.importSingleProfile(
        { agents: { sisyphus: { model: 'a' } } },
        'collision.json',
      );
      const p2 = await profileStore.importSingleProfile(
        { agents: { sisyphus: { model: 'b' } } },
        'collision.json', // exact case-sensitive collision
      );
      const p3 = await profileStore.importSingleProfile(
        { agents: { sisyphus: { model: 'c' } } },
        'collision.jsonc',
      );

      expect(p1.name).toBe('collision-2');
      expect(p2.name).toBe('collision-3');
      expect(p3.name).toBe('collision-4');
    });

    it('strips extensions case-insensitively and path segments', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      const profile = await profileStore.importSingleProfile(
        { agents: { sisyphus: { model: 'x' } } },
        '/some/path/Foo.PROFILE.JSON',
      );

      expect(profile.name).toBe('Foo');
    });

    it('emits exactly one change event and writes the sidecar once', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      let changes = 0;
      profileStore.onDidChange.on('change', () => {
        changes += 1;
      });

      await profileStore.importSingleProfile(
        { agents: { sisyphus: { model: 'x' } } },
        'one.json',
      );

      expect(changes).toBe(1);
      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.profiles).toHaveLength(1);
    });

    it('clones the input fragment so callers cannot mutate the stored profile', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      const fragment: ProfileFragment = {
        agents: { sisyphus: { model: 'before' } },
      };

      await profileStore.importSingleProfile(fragment, 'clone.json');
      fragment.agents!.sisyphus!.model = 'after';

      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.profiles[0].agents.sisyphus.model).toBe('before');
    });

    it('does not modify the live OmO config', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      await profileStore.importSingleProfile(
        { agents: { sisyphus: { model: 'imported' } } },
        'imported.json',
      );

      expect(configStore.getAgent('sisyphus')?.model).toBe('minimal/model');
      expect(readConfig(configPath)).toContain('minimal/model');
    });
  });

  // -----------------------------------------------------------------------
  // importProfiles
  // -----------------------------------------------------------------------

  describe('importProfiles', () => {
    function makeSidecar(
      profiles: Profile[],
      lastActiveProfile?: string,
    ): NormalizedProfilesFile {
      return {
        version: 1,
        profiles,
        ...(lastActiveProfile !== undefined ? { lastActiveProfile } : {}),
      };
    }

    function makeProfile(
      name: string,
      agents: Record<string, { model: string }>,
    ): Profile {
      return {
        name,
        agents,
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-02T00:00:00.000Z',
      };
    }

    it('extends with no collisions and preserves imported timestamps', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      const existing = await profileStore.createProfile('local');
      const sidecar = makeSidecar([makeProfile('alpha', { sisyphus: { model: 'a' } })]);

      const result = await profileStore.importProfiles(sidecar, 'extend');

      expect(result.mode).toBe('extend');
      expect(result.added).toBe(1);
      expect(result.importedNames).toEqual(['alpha']);
      const profiles = profileStore.listProfiles();
      expect(profiles).toHaveLength(2);
      expect(profiles[0].name).toBe('local');
      expect(profiles[1].name).toBe('alpha');
      expect(profiles[1].createdAt).toBe('2020-01-01T00:00:00.000Z');
      expect(profiles[1].updatedAt).toBe('2020-01-02T00:00:00.000Z');
    });

    it('extends resolving collisions against existing and already-allocated names', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('alpha');
      await profileStore.createProfile('alpha-2');
      const sidecar = makeSidecar([
        makeProfile('alpha', { sisyphus: { model: 'a' } }),
        makeProfile('alpha', { sisyphus: { model: 'b' } }),
      ]);

      const result = await profileStore.importProfiles(sidecar, 'extend');

      expect(result.importedNames).toEqual(['alpha-3', 'alpha-4']);
      const names = profileStore.listProfiles().map((p) => p.name);
      expect(names).toEqual(['alpha', 'alpha-2', 'alpha-3', 'alpha-4']);
    });

    it('bumps updatedAt only when the final name differs from the imported name', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('alpha');
      const sidecar = makeSidecar([
        makeProfile('alpha', { sisyphus: { model: 'a' } }),
        makeProfile('beta', { sisyphus: { model: 'b' } }),
      ]);

      await profileStore.importProfiles(sidecar, 'extend');

      const profiles = profileStore.listProfiles();
      const alpha2 = profiles.find((p) => p.name === 'alpha-2')!;
      const beta = profiles.find((p) => p.name === 'beta')!;
      expect(alpha2.createdAt).not.toBe(alpha2.updatedAt); // bumped because renamed
      expect(beta.createdAt).toBe('2020-01-01T00:00:00.000Z');
      expect(beta.updatedAt).toBe('2020-01-02T00:00:00.000Z'); // unchanged
    });

    it('replaces the entire profiles list and preserves imported timestamps', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('old');
      const sidecar = makeSidecar([makeProfile('alpha', { sisyphus: { model: 'a' } })]);

      const result = await profileStore.importProfiles(sidecar, 'replace');

      expect(result.mode).toBe('replace');
      expect(result.added).toBe(1);
      expect(result.importedNames).toEqual(['alpha']);
      expect(profileStore.listProfiles()).toHaveLength(1);
      expect(profileStore.getProfile('old')).toBeUndefined();
      expect(profileStore.getProfile('alpha')).toBeDefined();
    });

    it('ignores the imported lastActiveProfile and preserves the local one when it still exists', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('keep');
      await profileStore.activateProfile('keep');
      expect(profileStore.getActiveProfileName()).toBe('keep');
      const sidecar = makeSidecar(
        [makeProfile('remote', { sisyphus: { model: 'r' } })],
        'remote',
      );

      await profileStore.importProfiles(sidecar, 'extend');

      expect(profileStore.getActiveProfileName()).toBe('keep');
      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.lastActiveProfile).toBe('keep');
    });

    it('clears the local lastActiveProfile when its profile no longer exists after replace', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('gone');
      await profileStore.activateProfile('gone');
      expect(profileStore.getActiveProfileName()).toBe('gone');
      const sidecar = makeSidecar([makeProfile('alpha', { sisyphus: { model: 'a' } })]);

      await profileStore.importProfiles(sidecar, 'replace');

      expect(profileStore.getActiveProfileName()).toBeUndefined();
      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.lastActiveProfile).toBeUndefined();
    });

    it('emits exactly one change event and writes the sidecar once', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      let changes = 0;
      profileStore.onDidChange.on('change', () => {
        changes += 1;
      });
      const sidecar = makeSidecar([makeProfile('alpha', { sisyphus: { model: 'a' } })]);

      await profileStore.importProfiles(sidecar, 'extend');

      expect(changes).toBe(1);
      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.profiles).toHaveLength(1);
    });

    it('clones the sidecar input so callers cannot mutate stored profiles', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      const sidecar = makeSidecar([makeProfile('alpha', { sisyphus: { model: 'a' } })]);

      await profileStore.importProfiles(sidecar, 'extend');
      sidecar.profiles[0].agents!.sisyphus!.model = 'mutated';

      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.profiles[0].agents.sisyphus.model).toBe('a');
    });

    it('does not modify the live OmO config on extend or replace', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      const sidecar = makeSidecar([makeProfile('alpha', { sisyphus: { model: 'imported' } })]);

      await profileStore.importProfiles(sidecar, 'extend');
      expect(configStore.getAgent('sisyphus')?.model).toBe('minimal/model');
      expect(readConfig(configPath)).toContain('minimal/model');

      await profileStore.importProfiles(sidecar, 'replace');
      expect(configStore.getAgent('sisyphus')?.model).toBe('minimal/model');
      expect(readConfig(configPath)).toContain('minimal/model');
    });

    it('preserves the local lastActiveProfile when replaced set contains that exact name', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('alpha');
      await profileStore.activateProfile('alpha');
      const sidecar = makeSidecar([makeProfile('alpha', { sisyphus: { model: 'a' } })]);

      await profileStore.importProfiles(sidecar, 'replace');

      expect(profileStore.getActiveProfileName()).toBe('alpha');
    });
  });

  // -----------------------------------------------------------------------
  // Transfer snapshots and replacement (Todo 7)
  // -----------------------------------------------------------------------

  describe('getProfileFragment', () => {
    it('returns a deep clone of the profile fragment omitting metadata', async () => {
      // Given: a profile with both agents and categories
      setupWithConfig(CONFIG_WITH_COMMENTS);
      const created = await profileStore.createProfile('source', 'desc');

      // When: exporting the fragment
      const fragment = profileStore.getProfileFragment('source');

      // Then: only agents and categories are returned, deeply cloned
      expect(fragment).toEqual({
        agents: created.agents,
        categories: created.categories,
      });
      // Mutation of the returned fragment does not affect the store
      fragment.agents!.sisyphus!.model = 'mutated/model';
      expect(profileStore.getProfile('source')!.agents!.sisyphus!.model).toBe(
        'sisyphus/model',
      );
    });

    it('omits agents when the profile has no agents section', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('no-agents');
      await profileStore.updateProfile('no-agents', {
        categories: { deep: { model: 'deep/model' } },
        agents: undefined,
      });

      const fragment = profileStore.getProfileFragment('no-agents');

      expect(fragment.agents).toBeUndefined();
      expect(fragment.categories).toBeDefined();
    });

    it('omits categories when the profile has no categories section', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('no-categories');
      await profileStore.updateProfile('no-categories', {
        categories: undefined,
      });

      const fragment = profileStore.getProfileFragment('no-categories');

      expect(fragment.categories).toBeUndefined();
      expect(fragment.agents).toBeDefined();
    });

    it('throws when the profile does not exist', () => {
      setupWithConfig(CONFIG_MINIMAL);

      expect(() => profileStore.getProfileFragment('ghost')).toThrow(
        'Profile "ghost" not found',
      );
    });
  });

  describe('getProfilesFileSnapshot', () => {
    it('returns a normalized deep clone of the whole sidecar', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('alpha');
      await profileStore.createProfile('beta');

      const snapshot = profileStore.getProfilesFileSnapshot();

      expect(snapshot.version).toBe(1);
      expect(snapshot.profiles).toHaveLength(2);
      expect(snapshot.profiles[0].name).toBe('alpha');
      expect(snapshot.profiles[1].name).toBe('beta');
      // Returned snapshot is a deep clone
      snapshot.profiles[0].name = 'mutated';
      expect(profileStore.listProfiles()[0].name).toBe('alpha');
    });

    it('includes lastActiveProfile when present', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('active');
      await profileStore.activateProfile('active');

      const snapshot = profileStore.getProfilesFileSnapshot();

      expect(snapshot.lastActiveProfile).toBe('active');
    });

    it('returns an empty profiles list when the sidecar does not exist', () => {
      createStores();

      const snapshot = profileStore.getProfilesFileSnapshot();

      expect(snapshot).toEqual({ version: 1, profiles: [] });
    });
  });

  describe('replaceProfileFragment', () => {
    it('replaces only the agents and categories of the named profile', async () => {
      // Given: a profile with metadata and existing agents/categories
      setupWithConfig(CONFIG_MINIMAL);
      const original = await profileStore.createProfile('target', 'original desc');
      await profileStore.updateProfile('target', {
        categories: { deep: { model: 'old/category' } },
      });
      const originalCreatedAt = original.createdAt;

      // When: replacing the fragment
      const fragment: ProfileFragment = {
        agents: { explore: { model: 'new/model' } },
      };
      const updated = await profileStore.replaceProfileFragment('target', fragment);

      // Then: name, description, and createdAt are preserved; updatedAt is refreshed
      expect(updated.name).toBe('target');
      expect(updated.description).toBe('original desc');
      expect(updated.createdAt).toBe(originalCreatedAt);
      expect(updated.updatedAt).not.toBe(original.updatedAt);
      expect(new Date(updated.updatedAt!).getTime()).toBeGreaterThan(
        new Date(original.updatedAt!).getTime(),
      );
      expect(updated.agents).toEqual({ explore: { model: 'new/model' } });
      expect(updated.categories).toBeUndefined();

      // On disk matches
      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.profiles[0].agents).toEqual({
        explore: { model: 'new/model' },
      });
      expect(onDisk.profiles[0].categories).toBeUndefined();
    });

    it('deletes stored section when replacement fragment omits it', async () => {
      setupWithConfig(CONFIG_WITH_COMMENTS);
      const original = await profileStore.createProfile('both');
      expect(original.agents).toBeDefined();
      expect(original.categories).toBeDefined();

      const updated = await profileStore.replaceProfileFragment('both', {
        categories: { quick: { model: 'quick/model' } },
      });

      expect(updated.agents).toBeUndefined();
      expect(updated.categories).toEqual({ quick: { model: 'quick/model' } });
      expect(profileStore.getProfile('both')!.agents).toBeUndefined();
    });

    it('clones the input fragment so caller mutations do not affect the store', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('clone');
      const fragment: ProfileFragment = {
        agents: { sisyphus: { model: 'before' } },
      };

      await profileStore.replaceProfileFragment('clone', fragment);
      fragment.agents!.sisyphus!.model = 'after';

      const onDisk = readSidecar(sidecarPath);
      expect(onDisk.profiles[0].agents.sisyphus.model).toBe('before');
    });

    it('emits exactly one change event and writes once', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('event');
      let changes = 0;
      profileStore.onDidChange.on('change', () => {
        changes += 1;
      });

      await profileStore.replaceProfileFragment('event', {
        agents: { sisyphus: { model: 'event/model' } },
      });

      expect(changes).toBe(1);
    });

    it('throws when the profile does not exist', async () => {
      setupWithConfig(CONFIG_MINIMAL);

      await expect(
        profileStore.replaceProfileFragment('ghost', { agents: {} }),
      ).rejects.toThrow('Profile "ghost" not found');
    });
  });

  describe('replaceActiveConfigFragment', () => {
    it('replaces agents and categories in the live config preserving comments and unrelated keys', async () => {
      // Given: a config with comments, agent_order, and a saved profile
      setupWithConfig(CONFIG_WITH_COMMENTS);
      await profileStore.createProfile('snap');

      // When: editing only the live config via the active config fragment helper
      await profileStore.replaceActiveConfigFragment({
        agents: { hephaestus: { model: 'hephaestus/new' } },
      });

      // Then: the live config contains the new agent and drops the old ones
      const cfg = configStore.getConfig();
      expect(cfg.agents).toEqual({ hephaestus: { model: 'hephaestus/new' } });
      expect(cfg.categories).toBeUndefined();

      // Comments and unrelated keys survive on disk
      const raw = readConfig(configPath);
      expect(raw).toContain('// Top-level comment');
      expect(raw).toContain('"agent_order"');
      expect(raw).toContain('"hephaestus"');
      expect(raw).toContain('"hephaestus/new"');
      expect(raw).not.toContain('"sisyphus/model"');
      expect(raw).not.toContain('"explore/model"');
      expect(cfg.agent_order).toEqual(['sisyphus', 'explore']);
    });

    it('preserves comments on untouched keys when replacing categories', async () => {
      setupWithConfig(CONFIG_WITH_COMMENTS);
      await profileStore.createProfile('snap');

      await profileStore.replaceActiveConfigFragment({
        agents: { sisyphus: { model: 'sisyphus/model' } },
        categories: { writing: { model: 'writing/new' } },
      });

      const cfg = configStore.getConfig();
      expect(cfg.categories).toEqual({
        writing: { model: 'writing/new' },
      });
      expect(cfg.agents).toEqual({
        sisyphus: { model: 'sisyphus/model' },
      });

      const raw = readConfig(configPath);
      expect(raw).toContain('// Top-level comment');
      expect(raw).toContain('// inline comment');
      expect(raw).toContain('"agent_order"');
    });

    it('deletes a live config section when the replacement omits it', async () => {
      setupWithConfig(CONFIG_WITH_COMMENTS);

      await profileStore.replaceActiveConfigFragment({
        agents: { sisyphus: { model: 'sisyphus/only' } },
      });

      const cfg = configStore.getConfig();
      expect(cfg.agents).toEqual({ sisyphus: { model: 'sisyphus/only' } });
      expect(cfg.categories).toBeUndefined();
      const raw = readConfig(configPath);
      expect(raw).not.toContain('"deep"');
      expect(raw).not.toContain('// category comment');
    });

    it('clones the input fragment so caller mutations do not affect the live config', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      const fragment: ProfileFragment = {
        agents: { sisyphus: { model: 'before' } },
      };

      await profileStore.replaceActiveConfigFragment(fragment);
      fragment.agents!.sisyphus!.model = 'after';

      expect(configStore.getAgent('sisyphus')?.model).toBe('before');
    });

    it('does not mutate the sidecar when editing the active config', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      await profileStore.createProfile('sidecar');
      const before = readSidecar(sidecarPath);

      await profileStore.replaceActiveConfigFragment({
        agents: { sisyphus: { model: 'active/new' } },
      });

      const after = readSidecar(sidecarPath);
      expect(after).toEqual(before);
      expect(profileStore.getProfile('sidecar')!.agents!.sisyphus!.model).toBe(
        'minimal/model',
      );
    });

    it('emits a config change event', async () => {
      setupWithConfig(CONFIG_MINIMAL);
      let changes = 0;
      configStore.onDidChange.on('change', () => {
        changes += 1;
      });

      await profileStore.replaceActiveConfigFragment({
        agents: { sisyphus: { model: 'changed' } },
      });

      expect(changes).toBe(1);
      expect(configStore.getAgent('sisyphus')?.model).toBe('changed');
    });
  });
});
