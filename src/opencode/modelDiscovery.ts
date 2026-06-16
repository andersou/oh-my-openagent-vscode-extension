import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public API: ModelDiscovery service
//
// Discovers available models by running `opencode models` via an injected
// ProcessExecutor. By default it parses one model ID per line; with
// `{ verbose: true }` it also parses the JSON metadata block that follows
// each ID, exposing capabilities and variants.
//
// Results are cached in memory after the first successful CLI call. Pass
// `{ forceRefresh: true }` to bypass the cache and re-run discovery.
//
// On any error (command not found, non-zero exit, timeout, exception) it
// returns `{ models: [], source: 'fallback', error: 'human-readable message' }`
// and never throws.
// ---------------------------------------------------------------------------

/** Capabilities object returned by `opencode models --verbose`. */
export interface ModelCapabilities {
  temperature?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  toolcall?: boolean;
  input?: Record<string, boolean>;
  output?: Record<string, boolean>;
  interleaved?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A single model parsed from `opencode models` output. */
export interface ModelInfo {
  modelId: string;
  capabilities?: ModelCapabilities;
  variants?: Record<string, unknown>;
}

/** Options controlling a single discovery call. */
export interface DiscoverModelsOptions {
  /** When true, runs `opencode models --verbose` and parses metadata. */
  verbose?: boolean;
  /** When true, ignores any cached result and re-runs the CLI. */
  forceRefresh?: boolean;
}

/** The shape returned by discoverModels(). */
export interface ModelDiscoveryResult {
  models: ModelInfo[];
  source: 'cli' | 'fallback';
  error?: string;
}

/** The result returned by a ProcessExecutor call. */
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Dependency-injection interface for executing OS processes.
 * Tests supply a stub so no real `opencode` binary is spawned.
 */
export interface ProcessExecutor {
  exec(
    command: string,
    args: string[],
    options?: {
      timeout?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): Promise<ProcessResult>;
}

/**
 * Discovers available models by shelling out to the `opencode` CLI.
 *
 * Constructor accepts an injected ProcessExecutor for testability and an
 * optional timeout in milliseconds that is forwarded to the executor call.
 */
export class ModelDiscovery {
  private readonly executor: ProcessExecutor;
  private readonly baseDir: string;
  private readonly timeoutMs?: number;
  private readonly cache = new Map<string, ModelDiscoveryResult>();

  constructor(
    executor: ProcessExecutor,
    baseDir: string,
    timeoutMs?: number,
  ) {
    this.executor = executor;
    this.baseDir = baseDir;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Runs `opencode models` and parses the output.
   *
   * - With `verbose: false` (default), parses one model ID per line.
   * - With `verbose: true`, runs `opencode models --verbose` and parses each
   *   model ID followed by its JSON metadata block, exposing capabilities
   *   and variants.
   * - Results are cached in memory. Use `forceRefresh: true` to invalidate.
   * - Returns `source: 'cli'` + models on success (exit code 0).
   * - Returns `source: 'fallback'` + error message on any failure.
   * - **Never throws.**
   */
  async discoverModels(
    options: DiscoverModelsOptions = {},
  ): Promise<ModelDiscoveryResult> {
    const cacheKey = this.buildCacheKey(options);

    if (!options.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const result = await this.runDiscovery(options);

    // Cache successful CLI results and graceful fallbacks so the UI stays
    // stable across repeated calls. Fallbacks are cached too because they
    // represent a valid "no models available" state.
    this.cache.set(cacheKey, result);
    return result;
  }

  private async runDiscovery(
    options: DiscoverModelsOptions,
  ): Promise<ModelDiscoveryResult> {
    try {
      const args = options.verbose ? ['models', '--verbose'] : ['models'];
      let result: ProcessResult;

      if (this.timeoutMs !== undefined) {
        result = await this.executor.exec('opencode', args, {
          timeout: this.timeoutMs,
        });
      } else {
        result = await this.executor.exec('opencode', args);
      }

      if (result.exitCode !== 0) {
        const stderrPreview = result.stderr
          ? `: ${result.stderr.trim()}`
          : '';
        return {
          models: [],
          source: 'fallback',
          error: `opencode models exited with code ${result.exitCode}${stderrPreview}`,
        };
      }

      const models = options.verbose
        ? parseVerboseOutput(result.stdout)
        : parseIdOnlyOutput(result.stdout);

      return { models, source: 'cli' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        models: [],
        source: 'fallback',
        error: `Failed to discover models: ${message}`,
      };
    }
  }

  private buildCacheKey(options: DiscoverModelsOptions): string {
    // forceRefresh is behavior, not cache identity.
    return JSON.stringify({ verbose: options.verbose ?? false });
  }
}

/**
 * Parse the plain `opencode models` output: one model ID per line.
 * Trims whitespace, skips blank lines, deduplicates preserving order.
 */
function parseIdOnlyOutput(stdout: string): ModelInfo[] {
  const lines = stdout.split('\n');
  const seen = new Set<string>();
  const models: ModelInfo[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    models.push({ modelId: trimmed });
  }

  return models;
}

/**
 * Parse `opencode models --verbose` output.
 *
 * Each model is an ID line followed by a JSON object. The JSON object may
 * span multiple lines. We accumulate lines after an ID until the brace
 * depth returns to zero, then the next non-blank line is a new model ID.
 */
function parseVerboseOutput(stdout: string): ModelInfo[] {
  const lines = stdout.split('\n');
  const models: ModelInfo[] = [];

  let currentId: string | null = null;
  let currentJsonLines: string[] = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;

  function flushCurrentModel(): void {
    if (currentId === null) {
      return;
    }
    const model: ModelInfo = { modelId: currentId };
    if (currentJsonLines.length > 0) {
      const jsonText = currentJsonLines.join('\n');
      try {
        const parsed = JSON.parse(jsonText) as Record<string, unknown>;
        if (
          parsed.capabilities !== undefined &&
          typeof parsed.capabilities === 'object' &&
          parsed.capabilities !== null
        ) {
          model.capabilities = parsed.capabilities as ModelCapabilities;
        }
        if (
          parsed.variants !== undefined &&
          typeof parsed.variants === 'object' &&
          parsed.variants !== null
        ) {
          model.variants = parsed.variants as Record<string, unknown>;
        }
      } catch {
        // Malformed JSON for this model: keep the ID and discard metadata.
      }
    }
    models.push(model);
    currentId = null;
    currentJsonLines = [];
    braceDepth = 0;
    bracketDepth = 0;
    inString = false;
    escape = false;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (currentId !== null) {
        currentJsonLines.push(line);
      }
      continue;
    }

    if (currentId === null) {
      currentId = trimmed;
      continue;
    }

    currentJsonLines.push(line);
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (inString) {
        if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        braceDepth++;
      } else if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0 && bracketDepth === 0) {
          flushCurrentModel();
        }
      } else if (ch === '[') {
        bracketDepth++;
      } else if (ch === ']') {
        if (bracketDepth > 0) bracketDepth--;
      }
    }
  }

  flushCurrentModel();

  // Deduplicate preserving first-occurrence order.
  const seen = new Set<string>();
  return models.filter((m) => {
    if (seen.has(m.modelId)) {
      return false;
    }
    seen.add(m.modelId);
    return true;
  });
}

/**
 * Creates a default ProcessExecutor backed by Node's `child_process.execFile`.
 *
 * `execFile` is used instead of `exec` to avoid spawning a shell (`shell: false`
 * is the default). The returned executor handles timeout, cwd, and env options
 * by forwarding them to `execFile`.
 */
export function createDefaultProcessExecutor(): ProcessExecutor {
  return {
    exec(
      command: string,
      args: string[],
      options?: { timeout?: number; cwd?: string; env?: Record<string, string> },
    ): Promise<ProcessResult> {
      return new Promise<ProcessResult>((resolve, reject) => {
        const execOpts: {
          timeout?: number;
          cwd?: string;
          env?: Record<string, string>;
        } = {};

        if (options?.timeout !== undefined) {
          execOpts.timeout = options.timeout;
        }
        if (options?.cwd !== undefined) {
          execOpts.cwd = options.cwd;
        }
        if (options?.env !== undefined) {
          execOpts.env = options.env;
        }

        execFile(command, args, execOpts, (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: 0,
          });
        });
      });
    },
  };
}
