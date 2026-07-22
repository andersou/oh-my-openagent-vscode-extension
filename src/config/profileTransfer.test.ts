import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ConfigStore } from './configStore.js';
import {
  MAX_PROFILE_TRANSFER_BYTES,
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
      path.join(tempDirectory, 'oh-my-openagent.json'),
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
