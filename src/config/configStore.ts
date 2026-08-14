import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse, modify, applyEdits } from 'jsonc-parser';
import type { EditResult, JSONPath } from 'jsonc-parser';

import type {
  OmOConfig,
  AgentConfig,
  CategoryConfig,
  ConfigScope,
} from './schema.js';
import {
  CONFIG_SCOPES,
  omoConfigKeysForScope,
  writePrefixForScope,
} from './schema.js';
import type { PublicOmOConfig } from './routingConversion.js';
import {
  hasLegacyRouting,
  routingScopeKindForScope,
  toInternalRoutingConfig,
  toPublicRoutingConfig,
  toPublicRoutingEntry,
  type RoutingDialect,
  type RoutingScopeKind,
} from './routingConversion.js';

// ---------------------------------------------------------------------------
// Candidate filenames checked in priority order (omo.dev unified config spec)
// ---------------------------------------------------------------------------
const CANDIDATE_FILES = ['omo.jsonc', 'omo.json'] as const;

/** Every scope that lives in its own `[<scope>]` block, in declaration order. */
const HARNESS_SCOPES = CONFIG_SCOPES.filter(
  (scope): scope is Exclude<ConfigScope, 'global'> => scope !== 'global',
);

/** Top-level harness-block keys in a unified omo config file. */
const HARNESS_KEYS = new Set(HARNESS_SCOPES.map((scope) => `[${scope}]`));

/** Formatting applied to every jsonc-parser edit this store makes. */
const FORMATTING_OPTIONS = {
  tabSize: 2,
  insertSpaces: true,
  eol: '\n',
  insertFinalNewline: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default user-layer base directory: ~/.omo on every platform. */
function defaultBaseDir(): string {
  return path.join(os.homedir(), '.omo');
}

/** Deep-clone via JSON round-trip. Safe for OmOConfig shapes (no Date, Map, etc.). */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Returns true for a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keys that must never be merged (prototype pollution defense). */
const FORBIDDEN_MERGE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Deep-merge `source` into `target`, mutating and returning `target`.
 * Plain objects recurse; arrays and scalars replace. Keys named
 * `__proto__` / `prototype` / `constructor` in the source are stripped.
 */
function deepMergeInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(source)) {
    if (FORBIDDEN_MERGE_KEYS.has(key)) {
      continue;
    }
    const sourceVal = source[key];
    const targetVal = target[key];
    if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      deepMergeInto(targetVal, sourceVal);
    } else if (isPlainObject(sourceVal)) {
      target[key] = deepMergeInto({}, sourceVal);
    } else if (Array.isArray(sourceVal)) {
      target[key] = deepClone(sourceVal);
    } else {
      target[key] = sourceVal;
    }
  }
  return target;
}

/**
 * Deep-diff two OmOConfig objects, producing a list of [JSONPath, value]
 * pairs for every change. A value of `undefined` means the key was removed.
 */
function diffConfigs(
  original: object,
  draft: object,
  basePath: JSONPath = [],
): Array<[JSONPath, unknown]> {
  const patches: Array<[JSONPath, unknown]> = [];
  const allKeys = new Set([
    ...Object.keys(original),
    ...Object.keys(draft),
  ]);

  for (const key of allKeys) {
    const childPath: JSONPath = [...basePath, key];
    const origVal = (original as Record<string, unknown>)[key];
    const draftVal = (draft as Record<string, unknown>)[key];

    // Key removed
    if (draftVal === undefined && origVal !== undefined) {
      patches.push([childPath, undefined]);
      continue;
    }
    // Key added
    if (origVal === undefined && draftVal !== undefined) {
      patches.push([childPath, draftVal]);
      continue;
    }

    // Both exist — compare by type
    if (Array.isArray(draftVal) && Array.isArray(origVal)) {
      // For our schema, arrays are string arrays — compare whole
      if (JSON.stringify(origVal) !== JSON.stringify(draftVal)) {
        patches.push([childPath, draftVal]);
      }
    } else if (isPlainObject(draftVal) && isPlainObject(origVal)) {
      // Both are plain objects — recurse
      patches.push(...diffConfigs(origVal, draftVal, childPath));
    } else {
      // Primitive comparison
      if (origVal !== draftVal) {
        patches.push([childPath, draftVal]);
      }
    }
  }

  return patches;
}

/** Restrict an arbitrary parsed object to the OmOConfig editable surface. */
function pickOmOConfig(value: unknown, scope: ConfigScope): OmOConfig {
  const result: Record<string, unknown> = {};
  const keys = omoConfigKeysForScope(scope);
  if (isPlainObject(value)) {
    for (const key of keys) {
      if (value[key] !== undefined) {
        result[key] = value[key];
      }
    }
  }
  return result as OmOConfig;
}

/**
 * Collect project-layer config paths by walking `.omo/omo.jsonc` /
 * `.omo/omo.json` from `workspaceDir` up to `homedir` (exclusive; $HOME
 * itself is the user layer and is skipped). Symlinked `.omo` directories or
 * files are skipped. Returns paths ordered farthest-ancestor first so that
 * sequential merging lets the nearest layer win.
 */
function collectProjectLayers(workspaceDir: string, homedir: string): string[] {
  const layers: string[] = [];
  const resolvedHome = path.resolve(homedir);
  let dir = path.resolve(workspaceDir);

  for (;;) {
    if (dir === resolvedHome) {
      break; // $HOME itself is the user layer — never a project layer
    }
    const omoDir = path.join(dir, '.omo');
    try {
      const dirStat = fs.lstatSync(omoDir);
      if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
        for (const name of CANDIDATE_FILES) {
          const candidate = path.join(omoDir, name);
          try {
            const fileStat = fs.lstatSync(candidate);
            if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
              continue;
            }
            layers.push(candidate);
            break; // first candidate wins within a layer
          } catch {
            // candidate does not exist — try the next basename
          }
        }
      }
    } catch {
      // no .omo dir at this level
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break; // reached filesystem root
    }
    dir = parent;
  }

  return layers.reverse();
}

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

export class ConfigStore {
  private readonly baseDir: string;
  private readonly workspaceDir: string;
  /** Whether project-layer walking is active. */
  private readonly projectLayersEnabled: boolean;
  private scope: ConfigScope;
  private dialect: RoutingDialect;
  private configPath: string | null = null;
  private cachedConfig: OmOConfig | null = null;
  private cachedRaw: string | null = null;

  private readonly _emitter = new EventEmitter();
  private watcher: fs.FSWatcher | null = null;
  private watcherDebounce: ReturnType<typeof setTimeout> | null = null;
  private suppressWatch = false;

  /**
   * @param baseDir User-layer directory. Defaults to `~/.omo`.
   * @param workspaceDir Root for project-layer discovery. When `baseDir` is
   *   provided explicitly (tests, tools), project-layer walking stays OFF
   *   unless `workspaceDir` is also given. When both are omitted, walking
   *   starts at `process.cwd()`.
   */
  constructor(
    baseDir?: string,
    workspaceDir?: string,
    scope: ConfigScope = 'opencode',
    dialect: RoutingDialect = 'mainline',
  ) {
    this.baseDir = baseDir ?? defaultBaseDir();
    this.workspaceDir = workspaceDir ?? process.cwd();
    this.projectLayersEnabled = baseDir === undefined || workspaceDir !== undefined;
    this.scope = scope;
    this.dialect = dialect;
  }

  // ---- Event ----

  /** Emitted when the backing config file changes on disk. */
  get onDidChange(): EventEmitter {
    return this._emitter;
  }

  // ---- Discovery ----

  /** Return the first existing config path, or null if none found. */
  private resolveConfigPath(): string | null {
    for (const name of CANDIDATE_FILES) {
      const p = path.join(this.baseDir, name);
      if (fs.existsSync(p)) {
        return p;
      }
    }
    // Default to primary name (for creation on first write)
    return null;
  }

  /** Return the active user-layer config path, resolving on first call. */
  getConfigPath(): string {
    if (this.configPath === null) {
      this.configPath = this.resolveConfigPath();
      // Default to the primary filename when no file exists yet
      if (this.configPath === null) {
        this.configPath = path.join(this.baseDir, CANDIDATE_FILES[0]);
      }
    }
    return this.configPath;
  }

  /** Return the user-layer directory. */
  getBaseDir(): string {
    return this.baseDir;
  }

  /** Return the active config scope. */
  getScope(): ConfigScope {
    return this.scope;
  }

  /**
   * Switch the active config scope, invalidate the in-memory cache, and emit
   * a single change event. Calling with the current scope is a no-op.
   */
  setScope(scope: ConfigScope): void {
    if (scope === this.scope) {
      return;
    }
    this.scope = scope;
    this.cachedConfig = null;
    this.cachedRaw = null;
    this._emitter.emit('change');
  }

  /** Return the active routing dialect. */
  getRoutingDialect(): RoutingDialect {
    return this.dialect;
  }

  /**
   * Switch the active routing dialect, invalidate the in-memory cache, and emit
   * a single change event. Calling with the current dialect is a no-op.
   */
  setRoutingDialect(dialect: RoutingDialect): void {
    if (dialect === this.dialect) {
      return;
    }
    this.dialect = dialect;
    this.cachedConfig = null;
    this.cachedRaw = null;
    this._emitter.emit('change');
  }

  // ---- Read ----

  /** Read the raw config text from disk. Returns empty string if file does not exist. */
  private readRaw(): string {
    const p = this.getConfigPath();
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch (err: unknown) {
      if (!fs.existsSync(p)) {
        return '';
      }
      throw err;
    }
  }

  /** Parse JSONC text, returning an empty object on empty input. */
  private parseJson(raw: string, source: string): Record<string, unknown> {
    if (!raw.trim()) {
      return {};
    }
    const errors: import('jsonc-parser').ParseError[] = [];
    const config = parse(raw, errors, {
      allowTrailingComma: true,
    }) as Record<string, unknown>;
    // Log parse errors but don't throw — best-effort parsing
    if (errors.length > 0) {
      console.warn(`[OhMyOpenAgent] JSONC parse warnings (${source}):`, errors);
    }
    return isPlainObject(config) ? config : {};
  }

  /**
   * Compute the effective view: the merged user + project layers, with the
   * selected scope's harness block overlaid on the shared base. For `agents`
   * and `categories` the overlay deep-merges per entry; every other harness
   * key overlays (arrays/scalars replace) the base too. For the `global`
   * scope only the shared base is folded.
   */
  private computeEffectiveView(
    userRaw: string,
    userPath: string,
  ): OmOConfig {
    // Fold layers in two passes so the harness block keeps higher priority
    // than the shared base ACROSS layers, matching the documented resolution
    // order (shared base keys first, then the [harness] block; later layers
    // win within each pass). The selected harness block is determined by the
    // active scope; for the global scope there is no harness block pass.
    const harnessKey = writePrefixForScope(this.scope)[0] ?? null;
    const baseFold: Record<string, unknown> = {};
    const harnessFold: Record<string, unknown> = {};
    const foldLayer = (doc: Record<string, unknown>): void => {
      const base: Record<string, unknown> = {};
      for (const key of Object.keys(doc)) {
        if (!HARNESS_KEYS.has(key)) {
          base[key] = doc[key];
        }
      }
      deepMergeInto(baseFold, base);
      if (harnessKey !== null) {
        const harness = doc[harnessKey];
        if (isPlainObject(harness)) {
          deepMergeInto(harnessFold, harness);
        }
      }
    };

    foldLayer(this.parseJson(userRaw, userPath));
    if (this.projectLayersEnabled) {
      for (const layerPath of collectProjectLayers(this.workspaceDir, os.homedir())) {
        let layerRaw: string;
        try {
          layerRaw = fs.readFileSync(layerPath, 'utf-8');
        } catch {
          continue; // unreadable layer — skip
        }
        foldLayer(this.parseJson(layerRaw, layerPath));
      }
    }

    deepMergeInto(baseFold, harnessFold);
    // Disk speaks the public routing dialect; every caller sees the internal one.
    return toInternalRoutingConfig(pickOmOConfig(baseFold, this.scope));
  }

  /** Refresh the in-memory cache from disk. */
  private refresh(): void {
    this.cachedRaw = this.readRaw();
    this.cachedConfig = this.computeEffectiveView(
      this.cachedRaw,
      this.getConfigPath(),
    );
  }

  /**
   * Force the next config read to go to disk by invalidating the in-memory
   * cache, then emit a change event so subscribers (e.g. the sidebar tree
   * provider) re-query from the fresh data.
   *
   * This is the programmatic equivalent of the file-watcher path and is
   * triggered by the sidebar's Refresh button.
   */
  refreshFromDisk(): void {
    this.cachedConfig = null;
    this.cachedRaw = null;
    this._emitter.emit('change');
  }

  /** Return the effective config view (cached). */
  getConfig(): OmOConfig {
    if (this.cachedConfig === null) {
      this.refresh();
    }
    return this.cachedConfig!;
  }

  /** Return a single agent override, or undefined. */
  getAgent(name: string): AgentConfig | undefined {
    return this.getConfig().agents?.[name];
  }

  /** Return a single category override, or undefined. */
  getCategory(name: string): CategoryConfig | undefined {
    return this.getConfig().categories?.[name];
  }

  // ---- Write ----

  /**
   * Apply mutations to a draft copy of the current effective config, compute
   * minimal jsonc-parser edits against the user file's raw text, and write
   * the result back to disk. Comments, trailing commas, and formatting are
   * preserved.
   *
   * Patches are computed as `diff(effectiveView, draft)` and applied to the
   * USER file under the scope's write prefix (`[]` for global, `['[<scope>]']`
   * for harness scopes). This means values inherited from project layers are
   * only written to the user file when the updater actually changed them —
   * project-layer content is never flattened into the user layer. When the
   * updater overrides a project-inherited value, the new value lands under the
   * selected scope prefix and wins on subsequent reads (correct precedence).
   */
  async updateConfig(updater: (draft: OmOConfig) => void): Promise<void> {
    // Ensure cache is populated
    if (this.cachedConfig === null) {
      this.refresh();
    }
    const effective = this.cachedConfig!;
    const draft = deepClone(effective);
    updater(draft);

    // Defensively strip keys that the active scope does not allow, so only
    // schema-accepted keys can ever reach omo.jsonc.
    const allowedKeys = new Set<string>(omoConfigKeysForScope(this.scope));
    for (const key of Object.keys(draft)) {
      if (!allowedKeys.has(key)) {
        delete (draft as Record<string, unknown>)[key];
      }
    }

    // Diff effective view ↔ draft in the public dialect — only actual updater
    // changes are written — after migrating routing keys the public schema
    // rejects, so the updater's changes always win over the migration.
    const prefix = writePrefixForScope(this.scope);
    const scopeKind = routingScopeKindForScope(this.scope);
    const publicDraft = toPublicRoutingConfig(draft, this.dialect, scopeKind);
    const patches = [
      ...this.legacyRoutingPatches(prefix, publicDraft, this.dialect, scopeKind),
      ...diffConfigs(
        toPublicRoutingConfig(effective, this.dialect, scopeKind),
        publicDraft,
      ),
    ];
    if (patches.length === 0) {
      return; // nothing changed
    }

    // Apply edits sequentially — each modify generates edits relative to
    // the current text, and applyEdits produces the new base for the next.
    // Paths are prefixed with the scope's write prefix: [] for global,
    // ['[<scope>]'] for harness scopes. Writes ALWAYS target the user file
    // under that prefix, never the shared base or project layers. When the
    // file is missing/empty, seed a minimal document so modify() has a valid
    // base; jsonc-parser creates the block and any intermediate objects
    // automatically.
    let text = this.cachedRaw ?? '';
    if (!text.trim()) {
      text = prefix.length === 0 ? '{}' : `{\n  "${prefix[0]}": {}\n}`;
    }
    for (const [jsonPath, value] of patches) {
      const edits: EditResult = modify(text, [...prefix, ...jsonPath], value, {
        formattingOptions: FORMATTING_OPTIONS,
      });
      text = applyEdits(text, edits);
    }

    this.writeConfigFile(text);
    // Update cache with the round-tripped view, so it matches a fresh read
    this.cachedConfig = toInternalRoutingConfig(publicDraft);
    this._emitter.emit('change');
  }

  /**
   * Create the base directory if needed and atomically replace the user
   * config file with `text` via temp + rename, suppressing the watch so the
   * self-triggered change event is ignored. Updates `cachedRaw` only — the
   * caller decides what the parsed cache becomes.
   */
  private writeConfigFile(text: string): void {
    const configPath = this.getConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpPath = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, text, 'utf-8');
    this.suppressWatch = true;
    try {
      fs.renameSync(tmpPath, configPath);
    } finally {
      // Re-enable after a short delay so the OS has time to fire the
      // watch event (which we ignore).
      setTimeout(() => {
        this.suppressWatch = false;
      }, 200);
    }

    this.cachedRaw = text;
  }

  /**
   * Patches that rewrite routing keys the public schema rejects
   * (`main_overrides`, `fallback_models`, a reasoning-style `variant`) into
   * their public equivalents wherever they are still literally present in the
   * user file. Each entity is converted from its own raw text — never from the
   * merged effective view — so project-layer values are not flattened into the
   * user layer. Entities the updater removed are skipped.
   */
  private legacyRoutingPatches(
    prefix: readonly string[],
    publicDraft: PublicOmOConfig,
    dialect: RoutingDialect,
    scopeKind: RoutingScopeKind,
  ): Array<[JSONPath, unknown]> {
    const document = this.parseJson(this.cachedRaw ?? '', this.getConfigPath());
    const scopeRoot = prefix.length === 0 ? document : document[prefix[0]];
    if (!isPlainObject(scopeRoot)) {
      return [];
    }
    const patches: Array<[JSONPath, unknown]> = [];
    for (const group of ['agents', 'categories'] as const) {
      const rawGroup = scopeRoot[group];
      const draftGroup = publicDraft[group];
      if (!isPlainObject(rawGroup) || draftGroup === undefined) {
        continue;
      }
      for (const [name, rawEntry] of Object.entries(rawGroup)) {
        if (!isPlainObject(rawEntry) || !hasLegacyRouting(rawEntry, dialect, scopeKind)) {
          continue;
        }
        if (!Object.hasOwn(draftGroup, name)) {
          continue;
        }
        const converted = toPublicRoutingEntry(rawEntry, dialect, scopeKind);
        if (hasLegacyRouting(converted, dialect, scopeKind)) {
          continue;
        }
        const allKeys = new Set([...Object.keys(rawEntry), ...Object.keys(converted)]);
        for (const key of allKeys) {
          if (JSON.stringify(rawEntry[key]) === JSON.stringify(converted[key])) {
            continue;
          }
          patches.push([[group, name, key], converted[key]]);
        }
      }
    }
    return patches;
  }

  // ---- Scope reconciliation ----

  /** Parse the user config file, refreshing the cache when it is cold. */
  private readUserDocument(): Record<string, unknown> {
    if (this.cachedRaw === null) {
      this.refresh();
    }
    return this.parseJson(this.cachedRaw ?? '', this.getConfigPath());
  }

  /** Persist raw text, drop the parsed cache, and notify subscribers. */
  private commitRaw(text: string): void {
    this.writeConfigFile(text);
    this.cachedConfig = null;
    this._emitter.emit('change');
  }

  /**
   * Return the harness scopes whose block defines a key the `global` scope
   * also owns. Those blocks win over the shared base, so while one exists a
   * `global` edit never reaches the harness it shadows.
   */
  getShadowingHarnessScopes(): ConfigScope[] {
    const document = this.readUserDocument();
    const globalKeys = omoConfigKeysForScope('global');
    return HARNESS_SCOPES.filter((scope) => {
      const block = document[`[${scope}]`];
      return (
        isPlainObject(block) && globalKeys.some((key) => block[key] !== undefined)
      );
    });
  }

  /**
   * Delete every harness block, leaving the shared base as the only source of
   * overrides. Comments and formatting on the surviving keys are preserved.
   */
  async removeHarnessBlocks(): Promise<void> {
    const document = this.readUserDocument();
    const present = HARNESS_SCOPES.filter(
      (scope) => document[`[${scope}]`] !== undefined,
    );
    if (present.length === 0) {
      return;
    }

    let text = this.cachedRaw ?? '';
    for (const scope of present) {
      text = applyEdits(
        text,
        modify(text, [`[${scope}]`], undefined, {
          formattingOptions: FORMATTING_OPTIONS,
        }),
      );
    }
    this.commitRaw(text);
  }

  /**
   * Make every harness block's `agents` and `categories` match the shared
   * base, so no harness can shadow the `global` scope. A key the base defines
   * replaces the harness copy wholesale; a key the base leaves undefined is
   * deleted from the harness block, because it would otherwise shadow a value
   * `global` adds later. Harness-only keys such as `agent_order` survive.
   */
  async copyBaseToHarnessBlocks(): Promise<void> {
    const document = this.readUserDocument();
    const internalBase = toInternalRoutingConfig(
      pickOmOConfig(document, 'global'),
    );

    const patches: Array<[JSONPath, unknown]> = [];
    for (const scope of HARNESS_SCOPES) {
      const blockKey = `[${scope}]`;
      const block = document[blockKey];
      const scopeKind = routingScopeKindForScope(scope);
      const base = toPublicRoutingConfig(
        internalBase,
        this.dialect,
        scopeKind,
      );
      for (const key of omoConfigKeysForScope('global')) {
        if (base[key] !== undefined) {
          patches.push([[blockKey, key], base[key]]);
        } else if (isPlainObject(block) && block[key] !== undefined) {
          patches.push([[blockKey, key], undefined]);
        }
      }
    }
    if (patches.length === 0) {
      return;
    }

    let text = this.cachedRaw ?? '';
    for (const [jsonPath, value] of patches) {
      text = applyEdits(
        text,
        modify(text, jsonPath, value, {
          formattingOptions: FORMATTING_OPTIONS,
        }),
      );
    }
    this.commitRaw(text);
  }

  // ---- File watching ----

  /** Start watching the resolved config file for on-disk changes. */
  startWatch(): void {
    const configPath = this.getConfigPath();
    // Don't double-watch
    if (this.watcher !== null) {
      return;
    }
    // Ensure directory exists (may not for first-run scenarios)
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    try {
      this.watcher = fs.watch(configPath, { persistent: false }, () => {
        if (this.suppressWatch) {
          return;
        }
        if (this.watcherDebounce !== null) {
          clearTimeout(this.watcherDebounce);
        }
        this.watcherDebounce = setTimeout(() => {
          this.watcherDebounce = null;
          this.cachedConfig = null;
          this.cachedRaw = null;
          this._emitter.emit('change');
        }, 150);
      });

      this.watcher.on('error', (err: NodeJS.ErrnoException) => {
        // If the file doesn't exist yet, that's fine — just clear the watcher
        // and it will be re-created on next startWatch
        if (err.code === 'ENOENT') {
          this.stopWatch();
        }
      });
    } catch {
      // File may not exist yet — that's fine for first-run
    }
  }

  /** Stop watching the config file. */
  stopWatch(): void {
    if (this.watcherDebounce !== null) {
      clearTimeout(this.watcherDebounce);
      this.watcherDebounce = null;
    }
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /** Release all resources. */
  dispose(): void {
    this.stopWatch();
    this._emitter.removeAllListeners();
  }
}
