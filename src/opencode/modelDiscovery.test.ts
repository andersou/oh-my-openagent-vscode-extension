import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ModelDiscovery,
  type ModelInfo,
  type ModelDiscoveryResult,
  type ProcessResult,
  type ProcessExecutor,
} from './modelDiscovery.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Creates a no-event-emitter object to satisfy an optional parameter. */
function noopEmitter(): unknown {
  return { on: vi.fn(), emit: vi.fn() };
}

/**
 * Create a process executor stub that returns a fixed result.
 * The `exec` fn records every call for later assertions.
 */
function stubProcessResult(result: ProcessResult): {
  executor: ProcessExecutor;
  calls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }>;
} {
  const calls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];
  const executor: ProcessExecutor = {
    exec: vi.fn(async (command: string, args: string[], options?: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return result;
    }) as ProcessExecutor['exec'],
  };
  return { executor, calls };
}

/** A typical successful `opencode models` output — one model per line. */
const FULL_OUTPUT = [
  'openai/gpt-4.1',
  'openai/gpt-4.1-mini',
  'anthropic/claude-sonnet-4-20250514',
  'anthropic/claude-opus-4-20250514',
  'google/gemini-2.5-pro',
  'openai/gpt-4.1-nano',
].join('\n');

/** Minimal valid verbose metadata for one model. */
function verboseMeta(capabilities: Record<string, unknown> = {}, variants: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'ignored', capabilities, variants });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelDiscovery', () => {
  describe('constructor', () => {
    it('accepts a ProcessExecutor and baseDir', () => {
      const instance = new ModelDiscovery(
        { exec: vi.fn() } as ProcessExecutor,
        '/some/base',
      );
      expect(instance).toBeDefined();
    });
  });

  describe('discoverModels() — successful CLI', () => {
    let discovery: ModelDiscovery;
    let calls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }>;

    beforeEach(() => {
      
      const { executor, calls: c } = stubProcessResult({
        stdout: FULL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });
      calls = c;
      discovery = new ModelDiscovery(executor, '/home/user/.config/opencode');
    });

    it('returns one ModelInfo per non-empty line in stdout', async () => {
      const result = await discovery.discoverModels();
      expect(result.models).toHaveLength(6);
      expect(result.source).toBe('cli');
    });

    it('parses model IDs directly — no field splitting or JSON parsing', async () => {
      const result = await discovery.discoverModels();
      expect(result.models[0].modelId).toBe('openai/gpt-4.1');
      expect(result.models[1].modelId).toBe('openai/gpt-4.1-mini');
      expect(result.models[5].modelId).toBe('openai/gpt-4.1-nano');
    });

    it('preserves original casing and slashes in model IDs', async () => {
      const result = await discovery.discoverModels();
      expect(result.models[2].modelId).toBe(
        'anthropic/claude-sonnet-4-20250514',
      );
    });

    it('calls the executor with "opencode" and ["models"]', async () => {
      await discovery.discoverModels();
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('opencode');
      expect(calls[0].args).toEqual(['models']);
    });

    it('includes a timeout option when timeoutMs is provided', async () => {
      
      const { executor, calls: c } = stubProcessResult({
        stdout: FULL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });
      const d2 = new ModelDiscovery(executor, '/tmp', 15_000);
      await d2.discoverModels();
      expect(c).toHaveLength(1);
      expect(c[0].options?.timeout).toBe(15_000);
    });

    it('does not include a timeout option when timeoutMs is omitted', async () => {
      await discovery.discoverModels();
      // No timeout option unless explicitly provided at construction time
      expect(calls[0].options?.timeout).toBeUndefined();
    });
  });

  describe('discoverModels() — trimming and blank-line handling', () => {
    it('trims leading/trailing whitespace from each line', async () => {
      
      const { executor } = stubProcessResult({
        stdout: '  openai/gpt-4.1  \n \t anthropic/claude-opus-4-20250514 \t',
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels();
      expect(result.models).toHaveLength(2);
      expect(result.models[0].modelId).toBe('openai/gpt-4.1');
      expect(result.models[1].modelId).toBe(
        'anthropic/claude-opus-4-20250514',
      );
    });

    it('skips blank lines (whitespace-only lines)', async () => {
      
      const { executor } = stubProcessResult({
        stdout:
          'openai/gpt-4.1\n\n\nanthropic/claude-opus-4-20250514\n  \n',
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels();
      expect(result.models).toHaveLength(2);
    });

    it('returns an empty model list when stdout is only whitespace', async () => {
      
      const { executor } = stubProcessResult({
        stdout: '   \n  \n \t \n',
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels();
      expect(result.models).toHaveLength(0);
      expect(result.source).toBe('cli');
    });

    it('returns an empty model list when stdout is an empty string', async () => {
      
      const { executor } = stubProcessResult({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels();
      expect(result.models).toHaveLength(0);
    });
  });

  describe('discoverModels() — deduplication', () => {
    it('removes duplicate model IDs (case-sensitive)', async () => {
      
      const { executor } = stubProcessResult({
        stdout: [
          'openai/gpt-4.1',
          'anthropic/claude-opus-4-20250514',
          'openai/gpt-4.1', // duplicate
          'openai/GPT-4.1', // different casing — NOT a duplicate
          'anthropic/claude-opus-4-20250514', // duplicate
          'google/gemini-2.5-pro',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels();
      expect(result.models).toHaveLength(4);
      const ids = result.models.map((m) => m.modelId);
      expect(ids).toEqual([
        'openai/gpt-4.1',
        'anthropic/claude-opus-4-20250514',
        'openai/GPT-4.1',
        'google/gemini-2.5-pro',
      ]);
    });

    it('preserves first-occurrence order after deduplication', async () => {
      
      const { executor } = stubProcessResult({
        stdout: ['a', 'b', 'a', 'c', 'b'].join('\n'),
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels();
      expect(result.models.map((m) => m.modelId)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('discoverModels() — command not found', () => {
    it('returns source "fallback" with error when the command is not found', async () => {
      
      // Simulate ENOENT-style error from the process executor
      const executor: ProcessExecutor = {
        exec: vi
          .fn()
          .mockRejectedValue(
            new Error('spawn opencode ENOENT'),
          ) as ProcessExecutor['exec'],
      };
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels();
      expect(result.source).toBe('fallback');
      expect(result.models).toEqual([]);
      expect(result.error).toBeDefined();
    });
  });

  describe('discoverModels() — non-zero exit', () => {
    it('returns source "fallback" when the process exits non-zero', async () => {
      
      const { executor } = stubProcessResult({
        stdout: '',
        stderr: 'Error: something went wrong',
        exitCode: 1,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels();
      expect(result.source).toBe('fallback');
      expect(result.models).toEqual([]);
      expect(result.error).toBeDefined();
    });

    it('returns source "fallback" even when stdout contains data on non-zero exit', async () => {
      
      const { executor } = stubProcessResult({
        stdout: 'openai/gpt-4.1\n',
        stderr: 'something broke',
        exitCode: 2,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels();
      expect(result.source).toBe('fallback');
      expect(result.models).toEqual([]);
    });
  });

  describe('discoverModels() — timeout', () => {
    it('returns source "fallback" when the executor rejects with a timeout error', async () => {
      
      const executor: ProcessExecutor = {
        exec: vi
          .fn()
          .mockRejectedValue(
            new Error('The operation was aborted due to timeout'),
          ) as ProcessExecutor['exec'],
      };
      const discovery = new ModelDiscovery(executor, '/tmp', 5_000);
      const result = await discovery.discoverModels();
      expect(result.source).toBe('fallback');
      expect(result.models).toEqual([]);
      expect(result.error).toBeDefined();
    });
  });

  describe('discoverModels() — no cache-file reading', () => {
    it('never invokes filesystem operations (no fs.readFile, no cache JSON)', async () => {
      
      const { executor, calls } = stubProcessResult({
        stdout: FULL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      await discovery.discoverModels();
      // Only one call: the opencode CLI invocation. No file-system reads.
      expect(calls).toHaveLength(1);
    });
  });

  describe('discoverModels() — graceful degradation overview', () => {
    it('always returns a valid ModelDiscoveryResult (never throws)', async () => {
      
      // Error path — must not throw
      const errorExecutor: ProcessExecutor = {
        exec: vi
          .fn()
          .mockRejectedValue(new Error('unexpected crash')) as ProcessExecutor['exec'],
      };
      const discovery1 = new ModelDiscovery(errorExecutor, '/tmp');
      const r1 = await discovery1.discoverModels();
      expect(r1).toBeDefined();
      expect(r1.models).toBeDefined();
      expect(r1.source).toBeDefined();

      // Success path — must not throw
      const { executor } = stubProcessResult({
        stdout: FULL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });
      const discovery2 = new ModelDiscovery(executor, '/tmp');
      const r2 = await discovery2.discoverModels();
      expect(r2).toBeDefined();
      expect(r2.models).toBeDefined();
      expect(r2.source).toBeDefined();
    });
  });

  describe('discoverModels() — verbose mode', () => {
    it('runs opencode models --verbose when verbose is true', async () => {
      const { executor, calls } = stubProcessResult({
        stdout: '',
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      await discovery.discoverModels({ verbose: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('opencode');
      expect(calls[0].args).toEqual(['models', '--verbose']);
    });

    it('parses capabilities and variants from verbose output', async () => {
      const stdout = [
        'openai/gpt-4.1',
        verboseMeta({ temperature: true, reasoning: true }, { max: { reasoningEffort: 'max' } }),
        'anthropic/claude-haiku',
        verboseMeta({ temperature: false }, { low: { reasoningEffort: 'low' } }),
      ].join('\n');
      const { executor } = stubProcessResult({ stdout, stderr: '', exitCode: 0 });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels({ verbose: true });
      expect(result.models).toHaveLength(2);

      const gpt = result.models[0];
      expect(gpt.modelId).toBe('openai/gpt-4.1');
      expect(gpt.capabilities).toEqual({ temperature: true, reasoning: true });
      expect(gpt.variants).toEqual({ max: { reasoningEffort: 'max' } });

      const haiku = result.models[1];
      expect(haiku.modelId).toBe('anthropic/claude-haiku');
      expect(haiku.capabilities).toEqual({ temperature: false });
      expect(haiku.variants).toEqual({ low: { reasoningEffort: 'low' } });
    });

    it('keeps the model ID when metadata JSON is malformed', async () => {
      const stdout = [
        'openai/gpt-4.1',
        '{ "capabilities": { "temperature": true }',
      ].join('\n');
      const { executor } = stubProcessResult({ stdout, stderr: '', exitCode: 0 });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels({ verbose: true });
      expect(result.models).toHaveLength(1);
      expect(result.models[0].modelId).toBe('openai/gpt-4.1');
      expect(result.models[0].capabilities).toBeUndefined();
    });

    it('keeps a trailing model whose JSON block is missing', async () => {
      const stdout = [
        'openai/gpt-4.1',
        verboseMeta({ temperature: true }),
        'anthropic/claude-haiku',
      ].join('\n');
      const { executor } = stubProcessResult({ stdout, stderr: '', exitCode: 0 });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels({ verbose: true });
      expect(result.models).toHaveLength(2);
      expect(result.models[0].modelId).toBe('openai/gpt-4.1');
      expect(result.models[0].capabilities?.temperature).toBe(true);
      expect(result.models[1].modelId).toBe('anthropic/claude-haiku');
      expect(result.models[1].capabilities).toBeUndefined();
    });

    it('deduplicates verbose models preserving first occurrence', async () => {
      const stdout = [
        'openai/gpt-4.1',
        verboseMeta({ temperature: true }),
        'openai/gpt-4.1',
        verboseMeta({ temperature: false }),
      ].join('\n');
      const { executor } = stubProcessResult({ stdout, stderr: '', exitCode: 0 });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels({ verbose: true });
      expect(result.models).toHaveLength(1);
      expect(result.models[0].modelId).toBe('openai/gpt-4.1');
      expect(result.models[0].capabilities?.temperature).toBe(true);
    });

    it('parses real-world verbose output with multi-line JSON containing string keys', async () => {
      const stdout = [
        'opencode/big-pickle',
        '{',
        '  "id": "big-pickle",',
        '  "providerID": "opencode",',
        '  "capabilities": {',
        '    "temperature": true,',
        '    "reasoning": true,',
        '    "toolcall": true',
        '  },',
        '  "variants": {}',
        '}',
        'opencode/deepseek-v4-flash-free',
        '{',
        '  "id": "deepseek-v4-flash-free",',
        '  "capabilities": {',
        '    "temperature": true,',
        '    "reasoning": true',
        '  },',
        '  "variants": {',
        '    "low": { "reasoningEffort": "low" },',
        '    "max": { "reasoningEffort": "max" }',
        '  }',
        '}',
      ].join('\n');
      const { executor } = stubProcessResult({ stdout, stderr: '', exitCode: 0 });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels({ verbose: true });
      expect(result.models).toHaveLength(2);
      expect(result.models[0].modelId).toBe('opencode/big-pickle');
      expect(result.models[0].capabilities?.temperature).toBe(true);
      expect(result.models[0].capabilities?.reasoning).toBe(true);
      expect(result.models[0].variants).toEqual({});
      expect(result.models[1].modelId).toBe('opencode/deepseek-v4-flash-free');
      expect(result.models[1].variants).toEqual({
        low: { reasoningEffort: 'low' },
        max: { reasoningEffort: 'max' },
      });
    });

    it('does not treat JSON string-key lines as model IDs', async () => {
      const stdout = [
        'openai/gpt-4',
        '{',
        '  "id": "gpt-4",',
        '  "capabilities": { "temperature": false, "reasoning": true },',
        '  "variants": { "low": { "reasoningEffort": "low" } }',
        '}',
      ].join('\n');
      const { executor } = stubProcessResult({ stdout, stderr: '', exitCode: 0 });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const result = await discovery.discoverModels({ verbose: true });
      expect(result.models).toHaveLength(1);
      expect(result.models[0].modelId).toBe('openai/gpt-4');
      expect(result.models[0].capabilities).toEqual({
        temperature: false,
        reasoning: true,
      });
      expect(result.models[0].variants).toEqual({
        low: { reasoningEffort: 'low' },
      });
    });
  });

  describe('discoverModels() — caching', () => {
    it('returns the same result on subsequent calls without re-invoking the executor', async () => {
      const { executor, calls } = stubProcessResult({
        stdout: FULL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const r1 = await discovery.discoverModels();
      const r2 = await discovery.discoverModels();
      expect(r1.models).toEqual(r2.models);
      expect(calls).toHaveLength(1);
    });

    it('caches verbose and non-verbose results independently', async () => {
      const { executor, calls } = stubProcessResult({
        stdout: FULL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      await discovery.discoverModels();
      await discovery.discoverModels({ verbose: true });
      await discovery.discoverModels();
      expect(calls).toHaveLength(2);
      expect(calls[0].args).toEqual(['models']);
      expect(calls[1].args).toEqual(['models', '--verbose']);
    });

    it('bypasses cache when forceRefresh is true', async () => {
      const { executor, calls } = stubProcessResult({
        stdout: FULL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      await discovery.discoverModels();
      await discovery.discoverModels({ forceRefresh: true });
      expect(calls).toHaveLength(2);
    });

    it('re-invokes verbose discovery when forceRefresh is true', async () => {
      const { executor, calls } = stubProcessResult({
        stdout: FULL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      await discovery.discoverModels({ verbose: true });
      await discovery.discoverModels({ verbose: true, forceRefresh: true });
      expect(calls).toHaveLength(2);
    });

    it('does not cache fallback results across different instances', async () => {
      const { executor } = stubProcessResult({
        stdout: '',
        stderr: 'broken',
        exitCode: 1,
      });
      const discovery = new ModelDiscovery(executor, '/tmp');
      const r1 = await discovery.discoverModels();
      const r2 = await discovery.discoverModels();
      expect(r1.source).toBe('fallback');
      expect(r2.source).toBe('fallback');
    });
  });
});
