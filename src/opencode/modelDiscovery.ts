import { execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public API: ModelDiscovery service
//
// Discovers available models by running `opencode models` via an injected
// ProcessExecutor. On success it parses one model ID per line from stdout,
// trims whitespace, skips blank lines, deduplicates preserving first-occurrence
// order, and returns `{ models: [{ modelId }], source: 'cli' }`.
//
// On any error (command not found, non-zero exit, timeout, exception) it
// returns `{ models: [], source: 'fallback', error: 'human-readable message' }`
// and never throws.
// ---------------------------------------------------------------------------

/** A single model parsed from `opencode models` output. */
export interface ModelInfo {
  modelId: string;
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
   * - One model ID per line in stdout → `{ modelId }`.
   * - Trims whitespace, skips blank / whitespace-only lines.
   * - Deduplicates (case-sensitive) preserving first-occurrence order.
   * - Returns `source: 'cli'` + models on success (exit code 0).
   * - Returns `source: 'fallback'` + error message on any failure.
   * - **Never throws.**
   */
  async discoverModels(): Promise<ModelDiscoveryResult> {
    try {
      let result: ProcessResult;

      if (this.timeoutMs !== undefined) {
        result = await this.executor.exec('opencode', ['models'], {
          timeout: this.timeoutMs,
        });
      } else {
        result = await this.executor.exec('opencode', ['models']);
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

      // Parse stdout: split lines, trim, skip blanks, deduplicate
      const lines = result.stdout.split('\n');
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
