import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigStore } from './configStore.js';
import type {
  AgentConfig,
  CategoryConfig,
  Profile,
  ProfilesFile,
  OmOConfig,
} from './schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep-clone via JSON round-trip. Safe for Profile/OmOConfig shapes. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// ProfileStore
// ---------------------------------------------------------------------------

/**
 * Manages a sidecar JSON file (`oh-my-openagent.profiles.json`) next to the
 * active OmO config. Profiles are named snapshots of `agents` / `categories`
 * that can be activated via `ConfigStore.updateConfig`, preserving JSONC
 * formatting in the active config.
 */
export class ProfileStore {
  private readonly configStore: ConfigStore;
  private readonly _emitter = new EventEmitter();

  constructor(configStore: ConfigStore) {
    this.configStore = configStore;
  }

  /** Emitted after every write to the sidecar file. */
  get onDidChange(): EventEmitter {
    return this._emitter;
  }

  // ---- Path resolution ----

  /**
   * Return the sidecar path: `<active-config-dir>/oh-my-openagent.profiles.json`.
   */
  private getSidecarPath(): string {
    const configPath = this.configStore.getConfigPath();
    const dir = path.dirname(configPath);
    return path.join(dir, 'oh-my-openagent.profiles.json');
  }

  // ---- Sidecar I/O ----

  /**
   * Read and parse the sidecar file. Returns a default (empty) structure when
   * the file does not exist.
   */
  private readProfilesFile(): ProfilesFile {
    const sidecarPath = this.getSidecarPath();
    try {
      const raw = fs.readFileSync(sidecarPath, 'utf-8');
      const data = JSON.parse(raw) as ProfilesFile;
      return {
        profiles: Array.isArray(data.profiles) ? data.profiles : [],
        lastActiveProfile: data.lastActiveProfile,
        version: data.version ?? 1,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { profiles: [], version: 1 };
      }
      throw err;
    }
  }

  /**
   * Atomically write the profiles file (temp + rename) and emit `change`.
   */
  private async writeProfilesFile(data: ProfilesFile): Promise<void> {
    const sidecarPath = this.getSidecarPath();
    const dir = path.dirname(sidecarPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify(data, null, 2) + '\n';
    const tmpPath = `${sidecarPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, sidecarPath);

    this._emitter.emit('change');
  }

  // ---- Public API ----

  /**
   * List all profiles in the sidecar.
   */
  listProfiles(): Profile[] {
    return this.readProfilesFile().profiles;
  }

  /**
   * Get a single profile by name, or `undefined` if not found.
   */
  getProfile(name: string): Profile | undefined {
    return this.listProfiles().find((p) => p.name === name);
  }

  /**
   * Create a new profile by snapshotting the current `agents` / `categories`
   * from the active config. Name must be unique (case-sensitive).
   */
  async createProfile(
    name: string,
    description?: string,
  ): Promise<Profile> {
    const data = this.readProfilesFile();

    if (data.profiles.some((p) => p.name === name)) {
      throw new Error(`Profile "${name}" already exists`);
    }

    const now = new Date().toISOString();
    const config = this.configStore.getConfig();

    const profile: Profile = {
      name,
      description,
      agents: config.agents ? deepClone(config.agents) : undefined,
      categories: config.categories
        ? deepClone(config.categories)
        : undefined,
      createdAt: now,
      updatedAt: now,
    };

    data.profiles.push(profile);
    await this.writeProfilesFile(data);

    return profile;
  }

  /**
   * Update an existing profile by merging a partial patch. The `name` field
   * in the patch is ignored — use `renameProfile` to rename.
   */
  async updateProfile(
    name: string,
    patch: Partial<Profile>,
  ): Promise<Profile> {
    const data = this.readProfilesFile();
    const index = data.profiles.findIndex((p) => p.name === name);

    if (index === -1) {
      throw new Error(`Profile "${name}" not found`);
    }

    const existing = data.profiles[index];
    // Merge patch over existing, but preserve the original name
    const { name: _name, ...rest } = patch;
    const updated: Profile = {
      ...existing,
      ...rest,
      name,
      updatedAt: new Date().toISOString(),
    };

    data.profiles[index] = updated;
    await this.writeProfilesFile(data);

    return updated;
  }

  async updateProfileEntry(
    profileName: string,
    group: 'agents',
    entryName: string,
    patch: AgentConfig,
    nullKeys: Set<string>,
  ): Promise<Profile>;
  async updateProfileEntry(
    profileName: string,
    group: 'categories',
    entryName: string,
    patch: CategoryConfig,
    nullKeys: Set<string>,
  ): Promise<Profile>;
  async updateProfileEntry(
    profileName: string,
    group: 'agents' | 'categories',
    entryName: string,
    patch: AgentConfig | CategoryConfig,
    nullKeys: Set<string>,
  ): Promise<Profile> {
    const data = this.readProfilesFile();
    const profile = data.profiles.find((p) => p.name === profileName);

    if (!profile) {
      throw new Error(`Profile "${profileName}" not found`);
    }

    if (group === 'agents') {
      const entries = profile.agents ?? {};
      const existing = entries[entryName] ?? {};
      entries[entryName] = { ...existing, ...patch };
      for (const key of nullKeys) {
        delete (entries[entryName] as Record<string, unknown>)[key];
      }
      profile.agents = entries;
    } else {
      const entries = profile.categories ?? {};
      const existing = entries[entryName] ?? {};
      entries[entryName] = { ...existing, ...patch };
      for (const key of nullKeys) {
        delete (entries[entryName] as Record<string, unknown>)[key];
      }
      profile.categories = entries;
    }

    profile.updatedAt = new Date().toISOString();
    await this.writeProfilesFile(data);

    return profile;
  }

  /**
   * Rename a profile. Updates `lastActiveProfile` if it matched the old name.
   */
  async renameProfile(
    oldName: string,
    newName: string,
  ): Promise<Profile> {
    const data = this.readProfilesFile();
    const index = data.profiles.findIndex((p) => p.name === oldName);

    if (index === -1) {
      throw new Error(`Profile "${oldName}" not found`);
    }

    if (data.profiles.some((p) => p.name === newName)) {
      throw new Error(`Profile "${newName}" already exists`);
    }

    const profile = data.profiles[index];
    profile.name = newName;
    profile.updatedAt = new Date().toISOString();

    if (data.lastActiveProfile === oldName) {
      data.lastActiveProfile = newName;
    }

    await this.writeProfilesFile(data);
    return profile;
  }

  /**
   * Duplicate an existing profile under a new name.
   */
  async duplicateProfile(
    name: string,
    newName: string,
  ): Promise<Profile> {
    const data = this.readProfilesFile();

    if (data.profiles.some((p) => p.name === newName)) {
      throw new Error(`Profile "${newName}" already exists`);
    }

    const existing = data.profiles.find((p) => p.name === name);
    if (!existing) {
      throw new Error(`Profile "${name}" not found`);
    }

    const now = new Date().toISOString();
    const clone = deepClone(existing);
    clone.name = newName;
    clone.createdAt = now;
    clone.updatedAt = now;

    data.profiles.push(clone);
    await this.writeProfilesFile(data);
    return clone;
  }

  /**
   * Delete a profile by name. Clears `lastActiveProfile` if it matched.
   */
  async deleteProfile(name: string): Promise<void> {
    const data = this.readProfilesFile();
    const index = data.profiles.findIndex((p) => p.name === name);

    if (index === -1) {
      throw new Error(`Profile "${name}" not found`);
    }

    data.profiles.splice(index, 1);

    if (data.lastActiveProfile === name) {
      delete data.lastActiveProfile;
    }

    await this.writeProfilesFile(data);
  }

  /**
   * Activate a profile by writing its `agents` / `categories` into the
   * active config via `ConfigStore.updateConfig`, which preserves JSONC
   * formatting (comments, trailing commas, etc.). Also persists the active
   * profile name in the sidecar.
   */
  async activateProfile(name: string): Promise<void> {
    const profile = this.getProfile(name);
    if (!profile) {
      throw new Error(`Profile "${name}" not found`);
    }

    await this.configStore.updateConfig((draft: OmOConfig) => {
      if (profile.agents) {
        draft.agents = profile.agents;
      } else {
        delete draft.agents;
      }
      if (profile.categories) {
        draft.categories = profile.categories;
      } else {
        delete draft.categories;
      }
    });

    const data = this.readProfilesFile();
    data.lastActiveProfile = name;
    await this.writeProfilesFile(data);
  }

  /**
   * Return the name of the last activated profile, or `undefined`.
   */
  getActiveProfileName(): string | undefined {
    return this.readProfilesFile().lastActiveProfile;
  }
}
