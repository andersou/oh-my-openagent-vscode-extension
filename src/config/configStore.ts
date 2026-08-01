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
} from './schema.js';

// ---------------------------------------------------------------------------
// Candidate filenames checked in priority order (omo.dev unified config spec)
// ---------------------------------------------------------------------------
const CANDIDATE_FILES = ['omo.jsonc', 'omo.json'] as const;

/** Top-level key of the harness block the extension edits. */
const OPENCODE_KEY = '[opencode]';

/** OmOConfig keys — the editable surface the extension surfaces. */
const OMO_CONFIG_KEYS: ReadonlyArray<keyof OmOConfig> = [
  'agents',
  'categories',
  'agent_order',
  'disabled_agents',
];

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
  original: OmOConfig,
  draft: OmOConfig,
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
      patches.push(
        ...diffConfigs(
          origVal as unknown as OmOConfig,
          draftVal as unknown as OmOConfig,
          childPath,
        ),
      );
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
function pickOmOConfig(value: unknown): OmOConfig {
  const result: Record<string, unknown> = {};
  if (isPlainObject(value)) {
    for (const key of OMO_CONFIG_KEYS) {
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
  constructor(baseDir?: string, workspaceDir?: string) {
    this.baseDir = baseDir ?? defaultBaseDir();
    this.workspaceDir = workspaceDir ?? process.cwd();
    this.projectLayersEnabled = baseDir === undefined || workspaceDir !== undefined;
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
   * `[opencode]` block overlaid on the shared base. For `agents` and
   * `categories` the overlay deep-merges per entry; every other `[opencode]`
   * key overlays (arrays/scalars replace) the base too.
   */
  private computeEffectiveView(
    userRaw: string,
    userPath: string,
  ): OmOConfig {
    // Fold layers in two passes so the harness block keeps higher priority
    // than the shared base ACROSS layers, matching the documented resolution
    // order (shared base keys first, then the [harness] block; later layers
    // win within each pass). Pass 1 folds every layer's shared base (user
    // first, then projects farthest → nearest). Pass 2 folds every layer's
    // `[opencode]` block in the same order. A project layer's shared-base
    // value therefore cannot clobber the user layer's [opencode] harness
    // value for the same key.
    const baseFold: Record<string, unknown> = {};
    const harnessFold: Record<string, unknown> = {};
    const foldLayer = (doc: Record<string, unknown>): void => {
      const { [OPENCODE_KEY]: harness, ...base } = doc;
      deepMergeInto(baseFold, base);
      if (isPlainObject(harness)) {
        deepMergeInto(harnessFold, harness);
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
    return pickOmOConfig(baseFold);
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
   * USER file under the `['[opencode]', ...]` prefix. This means values
   * inherited from project layers are only written to the user file when the
   * updater actually changed them — project-layer content is never flattened
   * into the user layer. When the updater overrides a project-inherited
   * value, the new value lands in the user file's `[opencode]` block and
   * wins on subsequent reads (correct precedence).
   */
  async updateConfig(updater: (draft: OmOConfig) => void): Promise<void> {
    // Ensure cache is populated
    if (this.cachedConfig === null) {
      this.refresh();
    }
    const effective = this.cachedConfig!;
    const draft = deepClone(effective);
    updater(draft);

    // Diff effective view ↔ draft — only actual updater changes are written
    const patches = diffConfigs(effective, draft);
    if (patches.length === 0) {
      return; // nothing changed
    }

    // Ensure base directory exists (first write scenario)
    const configPath = this.getConfigPath();
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Apply edits sequentially — each modify generates edits relative to
    // the current text, and applyEdits produces the new base for the next.
    // All paths are prefixed with '[opencode]': writes ALWAYS target the
    // user file's harness block, never the shared base or project layers.
    // When the file is missing/empty, seed a minimal document so modify()
    // has a valid base; jsonc-parser creates the '[opencode]' block and any
    // intermediate objects automatically.
    let text = this.cachedRaw ?? '';
    if (!text.trim()) {
      text = `{\n  "${OPENCODE_KEY}": {}\n}`;
    }
    for (const [jsonPath, value] of patches) {
      const edits: EditResult = modify(text, [OPENCODE_KEY, ...jsonPath], value, {
        formattingOptions: {
          tabSize: 2,
          insertSpaces: true,
          eol: '\n',
          insertFinalNewline: true,
        },
      });
      text = applyEdits(text, edits);
    }

    // Write atomically via temp + rename — suppress watch to avoid
    // self-triggered change events.
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

    // Update cache
    this.cachedRaw = text;
    this.cachedConfig = draft;
    this._emitter.emit('change');
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
