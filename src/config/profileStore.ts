import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from './configStore.js';
import type {
  AgentConfig,
  CategoryConfig,
  ConfigScope,
  ImportProfilesResult,
  Profile,
  ProfilesFile,
  OmOConfig,
} from './schema.js';
import { CONFIG_SCOPES } from './schema.js';
import {
  ROUTING_DIALECTS,
  routingScopeKindForScope,
  toInternalRoutingEntry,
  toInternalRoutingFragment,
  toPublicRoutingConfig,
  type RoutingDialect,
  type RoutingScopeKind,
} from './routingConversion.js';
import type {
  NormalizedProfilesFile,
  ProfileFragment,
} from './profileValidation.js';
import {
  cloneProfileFragment,
  cloneProfilesFile,
  deriveProfileNameFromSource,
  exportProfileFragment,
  resolveProfileNameCollisions,
} from './profileTransferSerialization.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep-clone via JSON round-trip. Safe for Profile/OmOConfig shapes. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Order-independent structural equality for plain JSON values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return false;
  }
  const aArray = Array.isArray(a);
  const bArray = Array.isArray(b);
  if (aArray !== bArray) return false;
  if (aArray && bArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/**
 * Profiles are stored in the internal routing representation, so a fragment
 * arriving from a public omo config is converted on the way in (no-op for one
 * that already uses `model` / `main_overrides` / `fallback_models`).
 */
function internalFragment(fragment: ProfileFragment): ProfileFragment {
  return toInternalRoutingFragment(cloneProfileFragment(fragment));
}

function internalProfile(profile: Profile): Profile {
  const converted = toInternalRoutingFragment(profile);
  return {
    ...profile,
    ...(profile.agents === undefined ? {} : { agents: converted.agents }),
    ...(profile.categories === undefined
      ? {}
      : { categories: converted.categories }),
  };
}

type ProfileEntry = AgentConfig | CategoryConfig;

function profileFragment(
  source: Pick<OmOConfig, 'agents' | 'categories'>,
): ProfileFragment {
  return {
    ...(source.agents === undefined
      ? {}
      : { agents: deepClone(source.agents) }),
    ...(source.categories === undefined
      ? {}
      : { categories: deepClone(source.categories) }),
  };
}

function publicRoutingFragment(
  fragment: ProfileFragment,
  dialect: RoutingDialect,
  scope: ConfigScope,
): ProfileFragment {
  const output = toPublicRoutingConfig(
    {
      ...(fragment.agents === undefined ? {} : { agents: fragment.agents }),
      ...(fragment.categories === undefined
        ? {}
        : { categories: fragment.categories }),
    },
    dialect,
    routingScopeKindForScope(scope),
  );
  return {
    ...(output.agents === undefined ? {} : { agents: output.agents }),
    ...(output.categories === undefined
      ? {}
      : { categories: output.categories }),
  };
}

function reconcileInternalEntry(
  previous: ProfileEntry,
  publicOutput: ProfileEntry,
  dialect: RoutingDialect,
  scopeKind: RoutingScopeKind,
): ProfileEntry {
  const previousRecord = previous as Record<string, unknown>;
  const outputRecord = publicOutput as Record<string, unknown>;
  const next = toInternalRoutingEntry(outputRecord);
  if (dialect !== 'latest' || scopeKind === 'harness') {
    return next as ProfileEntry;
  }

  const previousOverrides = previousRecord.main_overrides;
  if (
    typeof previousOverrides === 'object' &&
    previousOverrides !== null &&
    !Array.isArray(previousOverrides)
  ) {
    const restoredOverrides: Record<string, unknown> = {};
    for (const key of Object.keys(previousOverrides)) {
      if (!Object.hasOwn(outputRecord, key)) {
        delete next[key];
        continue;
      }
      restoredOverrides[key] = structuredClone(outputRecord[key]);
      if (Object.hasOwn(previousRecord, key)) {
        next[key] = structuredClone(previousRecord[key]);
      } else {
        delete next[key];
      }
    }
    if (Object.keys(restoredOverrides).length > 0) {
      next.main_overrides = restoredOverrides;
    } else {
      delete next.main_overrides;
    }
  }

  if (
    scopeKind === 'global' &&
    Object.hasOwn(previousRecord, 'fallback_models')
  ) {
    next.fallback_models = structuredClone(previousRecord.fallback_models);
  }
  return next as ProfileEntry;
}

function reconcileInternalFragment(
  previous: ProfileFragment,
  current: ProfileFragment,
  dialect: RoutingDialect,
  scope: ConfigScope,
): ProfileFragment {
  const previousOutput = publicRoutingFragment(previous, dialect, scope);
  const currentOutput = publicRoutingFragment(current, dialect, scope);
  const scopeKind = routingScopeKindForScope(scope);
  const result: {
    agents?: Record<string, AgentConfig>;
    categories?: Record<string, CategoryConfig>;
  } = {};

  for (const group of ['agents', 'categories'] as const) {
    const currentEntries = currentOutput[group];
    if (currentEntries === undefined) {
      continue;
    }
    const previousEntries = previous[group] ?? {};
    const previousOutputEntries = previousOutput[group] ?? {};
    const reconciled: Record<string, ProfileEntry> = {};
    for (const [name, currentEntry] of Object.entries(currentEntries)) {
      const previousEntry = previousEntries[name];
      const previousOutputEntry = previousOutputEntries[name];
      reconciled[name] =
        previousEntry !== undefined &&
        previousOutputEntry !== undefined &&
        deepEqual(previousOutputEntry, currentEntry)
          ? deepClone(previousEntry)
          : previousEntry === undefined
            ? (toInternalRoutingEntry(
                currentEntry as Record<string, unknown>,
              ) as ProfileEntry)
            : reconcileInternalEntry(
                previousEntry,
                currentEntry,
                dialect,
                scopeKind,
              );
    }
    if (group === 'agents') {
      result.agents = reconciled as Record<string, AgentConfig>;
    } else {
      result.categories = reconciled as Record<string, CategoryConfig>;
    }
  }
  return result;
}

export interface ActiveProfileModification {
  group: 'agents' | 'categories';
  name: string;
  type: 'added' | 'removed' | 'modified';
  changedFields?: string[];
}

// ---------------------------------------------------------------------------
// Sidecar naming and legacy migration
// ---------------------------------------------------------------------------

const SIDECAR_FILENAME = 'omo.profiles.json';
const LEGACY_SIDECAR_FILENAME = 'oh-my-openagent.profiles.json';

/**
 * Legacy sidecar locations to migrate from, in priority order:
 * first the file sitting next to the (possibly legacy) user config, then the
 * pre-omo.dev `~/.config/opencode` directory. Exported for unit tests.
 */
export function legacySidecarCandidates(configDir: string): string[] {
  const candidates = [path.join(configDir, LEGACY_SIDECAR_FILENAME)];
  try {
    candidates.push(
      path.join(os.homedir(), '.config', 'opencode', LEGACY_SIDECAR_FILENAME),
    );
  } catch {
    // os.homedir() can throw in exotic environments; skip that candidate.
  }
  return candidates;
}

/**
 * One-time migration: when the new sidecar does not exist, move the first
 * existing legacy sidecar to its new location. Move, not copy. Never throws —
 * a failed rename falls back to copy+unlink, and if both fail we warn and
 * continue with empty profiles.
 */
function migrateLegacySidecar(sidecarPath: string, configDir: string): void {
  if (fs.existsSync(sidecarPath)) {
    return;
  }
  const legacyPath = legacySidecarCandidates(configDir).find((candidate) =>
    fs.existsSync(candidate),
  );
  if (legacyPath === undefined) {
    return;
  }
  try {
    fs.renameSync(legacyPath, sidecarPath);
  } catch {
    try {
      fs.copyFileSync(legacyPath, sidecarPath);
      fs.unlinkSync(legacyPath);
    } catch (err: unknown) {
      console.warn(
        `[OhMyOpenAgent] Failed to migrate legacy profiles sidecar ${legacyPath}:`,
        err,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// ProfileStore
// ---------------------------------------------------------------------------

/**
 * Manages a sidecar JSON file (`omo.profiles.json`) next to the active omo.dev
 * config (`~/.omo/omo.jsonc`). Profiles are named snapshots of `agents` /
 * `categories` that can be activated via `ConfigStore.updateConfig`,
 * preserving JSONC formatting in the active config. On first access, a legacy
 * `oh-my-openagent.profiles.json` (beside the config or under the pre-omo.dev
 * `~/.config/opencode` directory) is moved to the new sidecar path.
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
   * Return the sidecar path: `<active-config-dir>/omo.profiles.json`.
   */
  private getSidecarPath(): string {
    const configPath = this.configStore.getConfigPath();
    const dir = path.dirname(configPath);
    return path.join(dir, SIDECAR_FILENAME);
  }

  // ---- Sidecar I/O ----

  /**
   * Read and parse the sidecar file. Returns a default (empty) structure when
   * the file does not exist.
   */
  private readProfilesFile(): ProfilesFile {
    const sidecarPath = this.getSidecarPath();
    migrateLegacySidecar(sidecarPath, path.dirname(sidecarPath));
    try {
      const raw = fs.readFileSync(sidecarPath, 'utf-8');
      const data = JSON.parse(raw) as ProfilesFile;
      return {
        profiles: Array.isArray(data.profiles)
          ? data.profiles.map(internalProfile)
          : [],
        lastActiveProfile: data.lastActiveProfile,
        version: data.version ?? 1,
        configScope: data.configScope,
        routingDialect: data.routingDialect,
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

    migrateLegacySidecar(sidecarPath, dir);

    const canonicalData: ProfilesFile = {
      ...data,
      profiles: data.profiles.map(internalProfile),
    };
    const content = JSON.stringify(canonicalData, null, 2) + '\n';
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
   * Return a deep-cloned canonical internal `ProfileFragment` (only `agents`
   * and `categories`) of the named saved profile. Throws when absent.
   */
  getProfileFragment(name: string): ProfileFragment {
    const profile = this.getProfile(name);
    if (!profile) {
      throw new Error(`Profile "${name}" not found`);
    }
    return exportProfileFragment(profile);
  }

  /**
   * Return a deep-cloned canonical internal snapshot of the entire sidecar,
   * suitable for full profile backup. Mutating it does not affect the store.
   */
  getProfilesFileSnapshot(): NormalizedProfilesFile {
    const data = this.readProfilesFile();
    const snapshot: NormalizedProfilesFile & {
      lastActiveProfile?: string;
      configScope?: ConfigScope;
      routingDialect?: RoutingDialect;
    } = {
      version: 1,
      profiles: data.profiles,
    };
    if (data.lastActiveProfile !== undefined) {
      snapshot.lastActiveProfile = data.lastActiveProfile;
    }
    if (data.configScope !== undefined) {
      snapshot.configScope = data.configScope;
    }
    if (data.routingDialect !== undefined) {
      snapshot.routingDialect = data.routingDialect;
    }
    return cloneProfilesFile(snapshot);
  }

  /**
   * Replace only the `agents` and `categories` of the named saved profile,
   * preserving its `name`, `description`, and `createdAt`. Refresh `updatedAt`
   * to now. Missing fragment sections delete the stored section. Throws when
   * the profile does not exist.
   */
  async replaceProfileFragment(
    name: string,
    fragment: ProfileFragment,
  ): Promise<Profile> {
    const data = this.readProfilesFile();
    const profile = data.profiles.find((p) => p.name === name);

    if (!profile) {
      throw new Error(`Profile "${name}" not found`);
    }

    const clone = internalFragment(fragment);
    if (clone.agents === undefined) {
      delete profile.agents;
    } else {
      profile.agents = clone.agents;
    }

    if (clone.categories === undefined) {
      delete profile.categories;
    } else {
      profile.categories = clone.categories;
    }

    profile.updatedAt = new Date().toISOString();

    await this.writeProfilesFile(data);

    return profile;
  }

  /**
   * Replace only the `agents` and `categories` of the live config via
   * `ConfigStore.updateConfig`, preserving unrelated keys and JSONC comments.
   * Missing fragment sections delete the corresponding live config sections.
   * This never touches the sidecar.
   */
  async replaceActiveConfigFragment(
    fragment: ProfileFragment,
  ): Promise<void> {
    const clone = internalFragment(fragment);

    await this.configStore.updateConfig((draft: OmOConfig) => {
      if (clone.agents === undefined) {
        delete draft.agents;
      } else {
        draft.agents = clone.agents;
      }

      if (clone.categories === undefined) {
        delete draft.categories;
      } else {
        draft.categories = clone.categories;
      }
    });
  }
  async createProfile(
    name: string,
    description?: string,
  ): Promise<Profile> {
    const data = this.readProfilesFile();

    if (data.profiles.some((p) => p.name === name)) {
      throw new Error(`Profile "${name}" already exists`);
    }

    const now = new Date().toISOString();
    const snapshot = internalFragment(
      profileFragment(this.configStore.getConfig()),
    );

    const profile: Profile = {
      name,
      description,
      agents: snapshot.agents,
      categories: snapshot.categories,
      createdAt: now,
      updatedAt: now,
    };

    data.profiles.push(profile);
    await this.writeProfilesFile(data);

    return profile;
  }

  /**
   * Create a new profile from a caller-supplied `{ agents?, categories? }` fragment.
   * The fragment is deep-cloned so later mutations do not affect the stored profile.
   * The active config is not read or modified. Throws the same duplicate-name error
   * as `createProfile`.
   */
  async createProfileFromFragment(
    name: string,
    fragment: ProfileFragment,
  ): Promise<Profile> {
    const data = this.readProfilesFile();

    if (data.profiles.some((p) => p.name === name)) {
      throw new Error(`Profile "${name}" already exists`);
    }

    const now = new Date().toISOString();
    const clone = internalFragment(fragment);

    const profile: Profile = {
      name,
      agents: clone.agents,
      categories: clone.categories,
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
    const updated = internalProfile({
      ...existing,
      ...rest,
      name,
      updatedAt: new Date().toISOString(),
    });

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
      const internalPatch = toInternalRoutingFragment({
        agents: { [entryName]: patch },
      }).agents![entryName]!;
      const merged: AgentConfig = {
        ...entries[entryName],
        ...internalPatch,
      };
      for (const key of nullKeys) {
        delete (merged as Record<string, unknown>)[key];
      }
      entries[entryName] = merged;
      profile.agents = entries;
    } else {
      const entries = profile.categories ?? {};
      const internalPatch = toInternalRoutingFragment({
        categories: { [entryName]: patch },
      }).categories![entryName]!;
      const merged: CategoryConfig = {
        ...entries[entryName],
        ...internalPatch,
      };
      for (const key of nullKeys) {
        delete (merged as Record<string, unknown>)[key];
      }
      entries[entryName] = merged;
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
   * Project a saved profile into `omo.jsonc`. The profile remains the internal
   * source of truth; `ConfigStore` performs the dialect/scope serialization.
   */
  private async projectProfileToConfig(profile: Profile): Promise<void> {
    await this.replaceActiveConfigFragment(profileFragment(profile));
  }

  /**
   * Reproject the active profile using the current routing dialect and scope.
   * Returns `false` when no profile is active.
   */
  async projectActiveProfileToConfig(): Promise<boolean> {
    const data = this.readProfilesFile();
    const active = data.lastActiveProfile;
    if (active === undefined) {
      return false;
    }
    const profile = data.profiles.find((candidate) => candidate.name === active);
    if (profile === undefined) {
      throw new Error(`Active profile "${active}" not found`);
    }
    await this.projectProfileToConfig(profile);
    return true;
  }

  /**
   * Activate a profile by projecting its internal `agents` / `categories`
   * through `ConfigStore`, then persist the active profile name.
   */
  async activateProfile(name: string): Promise<void> {
    const profile = this.getProfile(name);
    if (!profile) {
      throw new Error(`Profile "${name}" not found`);
    }

    await this.projectProfileToConfig(profile);

    const data = this.readProfilesFile();
    data.lastActiveProfile = name;
    await this.writeProfilesFile(data);
  }



  /**
   * Import a single normalized profile fragment as a new profile.
   *
   * The profile name is derived from the supplied filename by stripping the
   * transfer extensions and trimming whitespace. Exact case-sensitive name
   * collisions against existing sidecar profiles are resolved in source order
   * with `-2`, `-3`, etc. The live config is never touched.
   */
  async importSingleProfile(
    fragment: ProfileFragment,
    filename?: string,
  ): Promise<Profile> {
    const sourceName = deriveProfileNameFromSource(filename ?? '');
    const data = this.readProfilesFile();
    const existingNames = data.profiles.map((p) => p.name);
    const [resolvedName] = resolveProfileNameCollisions(existingNames, [
      sourceName,
    ]);

    const now = new Date().toISOString();
    const clone = internalFragment(fragment);
    const profile: Profile = {
      name: resolvedName,
      agents: clone.agents,
      categories: clone.categories,
      createdAt: now,
      updatedAt: now,
    };

    data.profiles.push(profile);
    await this.writeProfilesFile(data);

    return profile;
  }

  /**
   * Import a normalized full sidecar into the local sidecar file.
   *
   * `replace` overwrites the local profile list with the imported profiles,
   * preserving their imported timestamps. `extend` appends the imported
   * profiles, resolving name collisions in source order against both existing
   * sidecar names and names already allocated during this import, and only
   * bumps `updatedAt` when the final name differs from the imported name.
   *
   * The imported `lastActiveProfile` is always ignored; the local marker is
   * preserved only when a profile with that exact name still exists after the
   * import. Exactly one sidecar write and one `change` event are emitted. The
   * live OmO config is never modified.
   */
  async importProfiles(
    sidecar: NormalizedProfilesFile,
    mode: 'extend' | 'replace',
  ): Promise<ImportProfilesResult> {
    const data = this.readProfilesFile();
    const imported = cloneProfilesFile(sidecar).profiles.map(internalProfile);

    const existingNames =
      mode === 'extend' ? data.profiles.map((p) => p.name) : [];
    const importedNames = imported.map((p) => p.name);
    const resolvedNames = resolveProfileNameCollisions(existingNames, importedNames);

    const now = new Date().toISOString();
    for (let i = 0; i < imported.length; i++) {
      const profile = imported[i];
      const resolvedName = resolvedNames[i];
      profile.name = resolvedName;
      if (resolvedName !== importedNames[i]) {
        profile.updatedAt = now;
      }
    }

    if (mode === 'replace') {
      data.profiles = imported;
    } else {
      data.profiles.push(...imported);
    }

    if (
      data.lastActiveProfile !== undefined &&
      !data.profiles.some((p) => p.name === data.lastActiveProfile)
    ) {
      delete data.lastActiveProfile;
    }

    await this.writeProfilesFile(data);

    return {
      mode,
      added: imported.length,
      importedNames: resolvedNames,
    };
  }

  /**
   * Return the name of the last activated profile, or `undefined`.
   */
  getActiveProfileName(): string | undefined {
    return this.readProfilesFile().lastActiveProfile;
  }

  /**
   * Return the persisted config scope if it is a valid {@link ConfigScope},
   * otherwise `undefined`. Missing sidecar also returns `undefined`.
   */
  getConfigScope(): ConfigScope | undefined {
    const scope = this.readProfilesFile().configScope;
    if (CONFIG_SCOPES.includes(scope as ConfigScope)) {
      return scope as ConfigScope;
    }
    return undefined;
  }

  /**
   * Persist the requested config scope in the sidecar. Creates a new
   * `{ version: 1, profiles: [] }` sidecar when none exists. Emits one
   * `change` event when the stored value actually changes.
   */
  async setConfigScope(scope: ConfigScope): Promise<void> {
    const data = this.readProfilesFile();
    if (data.configScope === scope) {
      return;
    }
    data.configScope = scope;
    await this.writeProfilesFile(data);
  }

  /**
   * Return the persisted routing dialect if it is a valid {@link RoutingDialect},
   * otherwise `undefined`. Missing sidecar also returns `undefined`.
   */
  getRoutingDialect(): RoutingDialect | undefined {
    const dialect = this.readProfilesFile().routingDialect;
    if (ROUTING_DIALECTS.includes(dialect as RoutingDialect)) {
      return dialect as RoutingDialect;
    }
    return undefined;
  }

  /**
   * Persist the requested routing dialect in the sidecar. Creates a new
   * `{ version: 1, profiles: [] }` sidecar when none exists. Emits one
   * `change` event when the stored value actually changes.
   */
  async setRoutingDialect(dialect: RoutingDialect): Promise<void> {
    const data = this.readProfilesFile();
    if (data.routingDialect === dialect) {
      return;
    }
    data.routingDialect = dialect;
    await this.writeProfilesFile(data);
  }

  /**
   * Return a structured list of differences between the active profile's
   * stored snapshot and the live config. Each entry describes whether an
   * agent/category was added, removed, or modified (with changed field
   * names). Returns an empty array when no profile is active or unchanged.
   */
  getActiveProfileModifications(): ActiveProfileModification[] {
    const data = this.readProfilesFile();
    const active = data.lastActiveProfile;
    if (active === undefined) return [];
    const profile = data.profiles.find((candidate) => candidate.name === active);
    if (profile === undefined) return [];
    const scope = this.configStore.getScope();
    const dialect = this.configStore.getRoutingDialect();
    const profileOutput = publicRoutingFragment(
      profileFragment(profile),
      dialect,
      scope,
    );
    const configOutput = publicRoutingFragment(
      profileFragment(this.configStore.getConfig()),
      dialect,
      scope,
    );
    return [
      ...this.diffGroup(
        'agents',
        profileOutput.agents ?? {},
        configOutput.agents ?? {},
      ),
      ...this.diffGroup(
        'categories',
        profileOutput.categories ?? {},
        configOutput.categories ?? {},
      ),
    ];
  }

  private diffGroup(
    group: 'agents' | 'categories',
    profileEntries: Record<string, AgentConfig | CategoryConfig>,
    configEntries: Record<string, AgentConfig | CategoryConfig>,
  ): ActiveProfileModification[] {
    const result: ActiveProfileModification[] = [];
    const allKeys = new Set([
      ...Object.keys(profileEntries),
      ...Object.keys(configEntries),
    ]);
    for (const name of allKeys) {
      const inProfile = profileEntries[name];
      const inConfig = configEntries[name];
      if (inProfile === undefined) {
        result.push({ group, name, type: 'added' });
      } else if (inConfig === undefined) {
        result.push({ group, name, type: 'removed' });
      } else if (!deepEqual(inProfile, inConfig)) {
        const changedFields = this.diffFieldNames(
          inProfile as Record<string, unknown>,
          inConfig as Record<string, unknown>,
        );
        result.push({ group, name, type: 'modified', changedFields });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  private diffFieldNames(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): string[] {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const changed: string[] = [];
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) {
        changed.push(key);
      }
    }
    return changed.sort();
  }

  /**
   * Return `true` when the active profile and live config produce different
   * normalized public output for the selected routing dialect and scope.
   */
  isActiveProfileModified(): boolean {
    return this.getActiveProfileModifications().length > 0;
  }

  /**
   * Reconcile the normalized live output back into the active internal
   * profile. Internal routing state hidden by the selected output projection
   * is preserved.
   */
  async saveActiveConfigToProfile(): Promise<Profile> {
    const data = this.readProfilesFile();
    const active = data.lastActiveProfile;
    if (active === undefined) {
      throw new Error('No active profile to save into');
    }
    const profile = data.profiles.find((candidate) => candidate.name === active);
    if (!profile) {
      throw new Error(`Active profile "${active}" not found`);
    }

    const reconciled = reconcileInternalFragment(
      profileFragment(profile),
      profileFragment(this.configStore.getConfig()),
      this.configStore.getRoutingDialect(),
      this.configStore.getScope(),
    );
    if (reconciled.agents === undefined) {
      delete profile.agents;
    } else {
      profile.agents = reconciled.agents;
    }
    if (reconciled.categories === undefined) {
      delete profile.categories;
    } else {
      profile.categories = reconciled.categories;
    }
    profile.updatedAt = new Date().toISOString();

    await this.writeProfilesFile(data);
    return profile;
  }
}
