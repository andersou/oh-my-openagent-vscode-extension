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
// Candidate filenames checked in priority order
// ---------------------------------------------------------------------------
const CANDIDATE_FILES = [
  'oh-my-openagent.json',
  'oh-my-openagent.jsonc',
  'oh-my-opencode.json',
  'oh-my-opencode.jsonc',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default base directory: ~/.config/opencode on Unix, %APPDATA%/opencode on Windows. */
function defaultBaseDir(): string {
  if (process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'opencode');
  }
  return path.join(os.homedir(), '.config', 'opencode');
}

/** Deep-clone via JSON round-trip. Safe for OmOConfig shapes (no Date, Map, etc.). */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    } else if (
      typeof draftVal === 'object' &&
      draftVal !== null &&
      typeof origVal === 'object' &&
      origVal !== null &&
      !Array.isArray(draftVal) &&
      !Array.isArray(origVal)
    ) {
      // Both are plain objects — recurse
      patches.push(
        ...diffConfigs(
          origVal as Record<string, unknown>,
          draftVal as Record<string, unknown>,
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

// ---------------------------------------------------------------------------
// ConfigStore
// ---------------------------------------------------------------------------

export class ConfigStore {
  private readonly baseDir: string;
  private configPath: string | null = null;
  private cachedConfig: OmOConfig | null = null;
  private cachedRaw: string | null = null;

  private readonly _emitter = new EventEmitter();
  private watcher: fs.FSWatcher | null = null;
  private watcherDebounce: ReturnType<typeof setTimeout> | null = null;
  private suppressWatch = false;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? defaultBaseDir();
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

  /** Return the active config path, resolving on first call. */
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

  /** Return the search directory for potential configs. */
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

  /** Parse JSONC text into OmOConfig, returning empty config on empty input. */
  private parseConfig(raw: string): OmOConfig {
    if (!raw.trim()) {
      return {};
    }
    const errors: import('jsonc-parser').ParseError[] = [];
    const config = parse(raw, errors, {
      allowTrailingComma: true,
    }) as OmOConfig;
    // Log parse errors but don't throw — best-effort parsing
    if (errors.length > 0) {
      console.warn(
        `[OhMyOpenAgent] JSONC parse warnings (${this.getConfigPath()}):`,
        errors,
      );
    }
    return config ?? {};
  }

  /** Refresh the in-memory cache from disk. */
  private refresh(): void {
    this.cachedRaw = this.readRaw();
    this.cachedConfig = this.parseConfig(this.cachedRaw);
  }

  /** Return the parsed config (cached). */
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
   * Apply mutations to a draft copy of the current config, compute minimal
   * jsonc-parser edits against the original raw text, and write the result
   * back to disk. Comments, trailing commas, and formatting are preserved.
   */
  async updateConfig(updater: (draft: OmOConfig) => void): Promise<void> {
    // Ensure cache is populated
    if (this.cachedConfig === null) {
      this.refresh();
    }
    const original = this.cachedConfig!;
    const draft = deepClone(original);
    updater(draft);

    // Diff original ↔ draft
    const patches = diffConfigs(original, draft);
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
    let text = this.cachedRaw ?? '';
    for (const [jsonPath, value] of patches) {
      const edits: EditResult = modify(text, jsonPath, value, {
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
