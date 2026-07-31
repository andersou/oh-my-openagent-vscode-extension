import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ConfigStore } from './configStore.js';
import {
  MAX_PROFILE_TRANSFER_BYTES,
  parseConfigFragmentBytes,
  parseProfileTransfer,
} from './profileTransfer.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('profile transfer parsing', () => {
  it('characterizes ConfigStore parsing as best-effort and unsuitable for transfers', () => {
    // Given
    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'omo-transfer-parser-test-'),
    );
    fs.writeFileSync(
      path.join(tempDirectory, 'omo.jsonc'),
      '{"agents":{"sisyphus":{"model":"recovered/model"}}} trailing',
      'utf-8',
    );
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new ConfigStore(tempDirectory);

    try {
      // When
      const config = store.getConfig();

      // Then
      expect(config.agents?.sisyphus?.model).toBe('recovered/model');
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      store.dispose();
      warning.mockRestore();
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('parses strict JSON as an unvalidated fragment without normalization', () => {
    // Given
    const input = encode(
      '{"agents":{"custom":{"model":42}},"unrelated":{"keep":true}}',
    );

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toEqual({
      ok: true,
      root: {
        kind: 'fragment',
        value: {
          agents: { custom: { model: 42 } },
          unrelated: { keep: true },
        },
      },
    });
  });

  it('detects a sidecar only from its own profiles property', () => {
    // Given
    const input = encode('{"version":1,"profiles":null}');

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toEqual({
      ok: true,
      root: {
        kind: 'sidecar',
        value: { version: 1, profiles: null },
      },
    });
  });

  it('accepts JSONC comments', () => {
    // Given
    const input = encode(`{
      // transfer comment
      "categories": { "quick": { "model": "fast/model" } }
    }`);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: true,
      root: { kind: 'fragment' },
    });
  });

  it('accepts JSONC trailing commas', () => {
    // Given
    const input = encode('{"agents":{"explore":{},},}');

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: true,
      root: { kind: 'fragment' },
    });
  });

  it('accepts exactly one leading UTF-8 BOM', () => {
    // Given
    const json = encode('{"agents":{}}');
    const input = Uint8Array.from([0xef, 0xbb, 0xbf, ...json]);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: true,
      root: { kind: 'fragment' },
    });
  });

  it('rejects a second leading UTF-8 BOM', () => {
    // Given
    const json = encode('{"agents":{}}');
    const input = Uint8Array.from([
      0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, ...json,
    ]);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'syntax_error', path: [], line: 1, column: 1 },
    });
    expect(result).not.toHaveProperty('root');
  });

  it('accepts a valid transfer at the exact byte ceiling', () => {
    // Given
    const input = new Uint8Array(MAX_PROFILE_TRANSFER_BYTES);
    input.fill(0x20);
    input.set(encode('{"agents":{}}'));

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: true,
      root: { kind: 'fragment' },
    });
  });

  it('rejects 5 MiB plus one byte before decoding', () => {
    // Given
    const input = new Uint8Array(MAX_PROFILE_TRANSFER_BYTES + 1);
    input.fill(0xff);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'input_too_large', path: [] },
    });
    expect(result).not.toHaveProperty('root');
  });

  it('rejects invalid UTF-8 with fatal decoding', () => {
    // Given
    const input = Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d]);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'invalid_utf8', path: [] },
    });
    expect(result).not.toHaveProperty('root');
  });

  it('rejects malformed JSONC with the parser location and path', () => {
    // Given
    const input = encode(`{
  "agents": {
    "sisyphus":
  }
}`);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'syntax_error',
        path: ['agents', 'sisyphus'],
        line: 4,
        column: 3,
      },
    });
    expect(result).not.toHaveProperty('root');
  });

  it('reports bare-CR syntax errors with parser coordinates', () => {
    // Given
    const input = encode('{\r"agents":\r}');

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'syntax_error',
        path: ['agents'],
        line: 3,
        column: 1,
      },
    });
    expect(result).not.toHaveProperty('root');
  });

  it('rejects duplicate keys at the duplicate property location', () => {
    // Given
    const input = encode(`{
  "agents": {
    "sisyphus": {
      "model": "first",
      "model": "second"
    }
  }
}`);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'duplicate_key',
        path: ['agents', 'sisyphus', 'model'],
        line: 5,
        column: 7,
      },
    });
    expect(result).not.toHaveProperty('root');
  });

  it.each([
    { label: 'null', text: 'null' },
    { label: 'array', text: '[]' },
  ])('rejects a $label root', ({ text }) => {
    // Given
    const input = encode(text);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'root_not_object',
        path: [],
        line: 1,
        column: 1,
      },
    });
    expect(result).not.toHaveProperty('root');
  });

  it.each([
    { label: 'empty object', text: '{}' },
    { label: 'unrelated root keys', text: '{"version":1}' },
  ])('rejects $label without agents or categories', ({ text }) => {
    // Given
    const input = encode(text);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'missing_profile_sections',
        path: [],
        line: 1,
        column: 1,
      },
    });
    expect(result).not.toHaveProperty('root');
  });

  it.each([
    { label: 'empty object', text: '{}' },
    { label: 'unrelated root keys', text: '{"version":1}' },
  ])('rejects $label without agents or categories', ({ text }) => {
    // Given
    const input = encode(text);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'missing_profile_sections',
        path: [],
        line: 1,
        column: 1,
      },
    });
    expect(result).not.toHaveProperty('root');
  });

  it.each([
    {
      label: 'agents',
      text: '{\n  "profiles": [],\n  "agents": {}\n}',
      path: ['agents'],
      line: 3,
    },
    {
      label: 'categories',
      text: '{\n  "profiles": [],\n  "categories": {}\n}',
      path: ['categories'],
      line: 3,
    },
  ])('rejects a sidecar mixed with $label', ({ text, path: errorPath, line }) => {
    // Given
    const input = encode(text);

    // When
    const result = parseProfileTransfer(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'mixed_root',
        path: errorPath,
        line,
        column: 3,
      },
    });
    expect(result).not.toHaveProperty('root');
  });
});

describe('parseConfigFragmentBytes', () => {
  it('extracts agents and categories from a full oh-my-openagent config, dropping other top-level keys', () => {
    // Given
    const input = encode(`{
  "$schema": "https://omo.dev/schema/oh-my-openagent.json",
  "version": 1,
  "profiles": [],
  "lastActiveProfile": "fast",
  "agents": { "sisyphus": { "model": "custom/model" } },
  "categories": { "quick": { "model": "quick/model" } },
  "unknown": true
}`);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: {
        agents: { sisyphus: { model: 'custom/model' } },
        categories: { quick: { model: 'quick/model' } },
      },
    });
  });

  it('extracts agents and categories from a new-shape omo.jsonc config, dropping other top-level keys', () => {
    // Given
    const input = encode(`{
  "$schema": "https://omo.dev/schema/omo.schema.json",
  "models": { "sisyphus/model": {} },
  "_migrations": ["legacy-import"],
  "[opencode]": {
    "agents": { "sisyphus": { "model": "custom/model" } },
    "categories": { "quick": { "model": "quick/model" } }
  }
}`);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: {
        agents: { sisyphus: { model: 'custom/model' } },
        categories: { quick: { model: 'quick/model' } },
      },
    });
  });

  it('merges base and [opencode] sections base-first with [opencode] winning', () => {
    // Given: both root-level and [opencode]-nested agents/categories
    const input = encode(`{
  "agents": {
    "sisyphus": {
      "model": "base/model",
      "prompt": "base prompt",
      "tools": { "read": true, "write": true }
    },
    "explore": { "model": "base/explore" }
  },
  "categories": { "deep": { "model": "base/deep" } },
  "[opencode]": {
    "agents": {
      "sisyphus": {
        "model": "opencode/model",
        "tools": { "write": false }
      }
    },
    "categories": { "quick": { "model": "opencode/quick" } }
  }
}`);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then: [opencode] overrides per leaf, base-only entries survive
    expect(result).toEqual({
      ok: true,
      value: {
        agents: {
          sisyphus: {
            model: 'opencode/model',
            prompt: 'base prompt',
            tools: { read: true, write: false },
          },
          explore: { model: 'base/explore' },
        },
        categories: {
          deep: { model: 'base/deep' },
          quick: { model: 'opencode/quick' },
        },
      },
    });
  });

  it('replaces arrays and scalars instead of merging them when [opencode] overrides', () => {
    // Given
    const input = encode(`{
  "agents": { "sisyphus": { "fallback_models": ["a", "b"], "temperature": 0.1 } },
  "[opencode]": {
    "agents": { "sisyphus": { "fallback_models": ["c"], "temperature": 0.9 } }
  }
}`);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: {
        agents: {
          sisyphus: { fallback_models: ['c'], temperature: 0.9 },
        },
      },
    });
  });

  it('takes sections from [opencode] alone when the root has none', () => {
    // Given
    const input = encode('{"[opencode]":{"categories":{"quick":{"model":"b"}}}}');

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: { categories: { quick: { model: 'b' } } },
    });
  });

  it('ignores a non-object [opencode] block', () => {
    // Given
    const input = encode('{"agents":{"a":{"model":"m"}},"[opencode]":"junk"}');

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: { agents: { a: { model: 'm' } } },
    });
  });

  it('rejects a root with neither agents nor categories even inside [opencode]', () => {
    // Given
    const input = encode('{"version":1,"[opencode]":{"model":"provider/model"}}');

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'missing_profile_sections', path: [] },
    });
    expect(result).not.toHaveProperty('value');
  });

  it('extracts an agents-only fragment', () => {
    // Given
    const input = encode('{"agents":{"sisyphus":{"model":"a"}}}');

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: { agents: { sisyphus: { model: 'a' } } },
    });
  });

  it('extracts a categories-only fragment', () => {
    // Given
    const input = encode('{"categories":{"quick":{"model":"b"}}}');

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: { categories: { quick: { model: 'b' } } },
    });
  });

  it('rejects a root that has neither agents nor categories', () => {
    // Given
    const input = encode('{"version":1,"profiles":[]}');

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'missing_profile_sections',
        message: 'Config input must contain agents or categories',
        path: [],
        line: 1,
        column: 1,
      },
    });
    expect(result).not.toHaveProperty('value');
  });

  it('rejects malformed JSONC with the parser location and path', () => {
    // Given
    const input = encode(`{
  "agents": {
    "sisyphus":
  }
}`);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'syntax_error',
        path: ['agents', 'sisyphus'],
        line: 4,
        column: 3,
      },
    });
    expect(result).not.toHaveProperty('value');
  });

  it.each([
    { label: 'null', text: 'null' },
    { label: 'array', text: '[]' },
    { label: 'string', text: '"hi"' },
  ])('rejects a $label root', ({ text }) => {
    // Given
    const input = encode(text);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'root_not_object',
        path: [],
        line: 1,
        column: 1,
      },
    });
    expect(result).not.toHaveProperty('value');
  });

  it('rejects duplicate keys', () => {
    // Given
    const input = encode(`{
  "agents": {},
  "agents": {}
}`);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'duplicate_key',
        path: ['agents'],
        line: 3,
        column: 3,
      },
    });
    expect(result).not.toHaveProperty('value');
  });

  it('accepts a leading UTF-8 BOM', () => {
    // Given
    const json = encode('{"agents":{}}');
    const input = Uint8Array.from([0xef, 0xbb, 0xbf, ...json]);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: { agents: {} },
    });
  });

  it('rejects 5 MiB plus one byte before decoding', () => {
    // Given
    const input = new Uint8Array(MAX_PROFILE_TRANSFER_BYTES + 1);
    input.fill(0xff);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'input_too_large', path: [] },
    });
    expect(result).not.toHaveProperty('value');
  });

  it('accepts JSONC comments and trailing commas', () => {
    // Given
    const input = encode(`{
  // keep
  "categories": { "quick": { "model": "fast" } },
}`);

    // When
    const result = parseConfigFragmentBytes(input);

    // Then
    expect(result).toEqual({
      ok: true,
      value: { categories: { quick: { model: 'fast' } } },
    });
  });
});
