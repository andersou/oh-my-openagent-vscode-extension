import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// vscode mock — must be set up before importing the panel module.
// ---------------------------------------------------------------------------

vi.mock('vscode', () => {
  // Minimal stubs so agentEditorPanel.ts can be imported without errors.
  // Vitest hoists vi.mock calls, so this runs before any imports.
  class Disposable {
    dispose(): void {
      /* no-op */
    }
  }
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void): Disposable => {
      this.listeners.push(listener);
      return new Disposable();
    };
    fire(data: T): void {
      for (const l of this.listeners) l(data);
    }
  }
  return {
    Disposable,
    EventEmitter,
    TreeItem: class {
      label: string | undefined;
      collapsibleState: number;
      constructor(label: string, collapsibleState?: number) {
        this.label = label;
        this.collapsibleState = collapsibleState ?? 0;
      }
    },
    ThemeIcon: class {
      readonly id: string;
      constructor(id: string) {
        this.id = id;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
      parse: (u: string) => ({ scheme: 'file', path: u, fsPath: u }),
    },
    window: {
      activeTextEditor: undefined,
      createWebviewPanel: vi.fn(),
      showInputBox: vi.fn(),
    },
    ViewColumn: { One: 1, Two: 2, Three: 3 },
    ExtensionContext: class {},
    WebviewPanel: class {},
  };
});

import {
  validateAndClean,
  AGENT_FIELDS,
  CATEGORY_FIELDS,
} from './agentEditorPanel.js';
import { AgentEditorPanel } from './agentEditorPanel.js';
import { AgentModelTreeProvider } from './agentModelTreeProvider.js';
import type { AgentConfig, CategoryConfig } from '../config/schema.js';
import type { ConfigStore } from '../config/configStore.js';
import type { ProfileStore } from '../config/profileStore.js';
import type { ModelDiscovery } from '../opencode/modelDiscovery.js';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

function getNullKeys(raw: unknown): Set<string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return new Set();
  }
  const nullKeys = new Set<string>();
  for (const [key, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (value === null) {
      nullKeys.add(key);
    }
  }
  return nullKeys;
}

function mergeAgentSave(
  existing: AgentConfig,
  rawPayload: unknown,
): AgentConfig {
  const validated = validateAndClean<AgentConfig>(rawPayload, AGENT_FIELDS);
  const nullKeys = getNullKeys(rawPayload);
  const merged: Record<string, unknown> = { ...existing, ...validated };
  for (const key of nullKeys) {
    delete merged[key];
  }
  return merged as AgentConfig;
}

function mergeCategorySave(
  existing: CategoryConfig,
  rawPayload: unknown,
): CategoryConfig {
  const validated = validateAndClean<CategoryConfig>(rawPayload, CATEGORY_FIELDS);
  const nullKeys = getNullKeys(rawPayload);
  const merged: Record<string, unknown> = { ...existing, ...validated };
  for (const key of nullKeys) {
    delete merged[key];
  }
  return merged as CategoryConfig;
}

// ---------------------------------------------------------------------------
// Tests — merge-based save preserves existing config fields
// ---------------------------------------------------------------------------

describe('AgentEditorPanel._handleSave field preservation', () => {
  // ---- Agents ----

  it('preserves permission when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      permission: { edit: 'ask', bash: 'deny' },
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    expect(result.permission).toEqual({ edit: 'ask', bash: 'deny' });
  });

  it('preserves tools when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      tools: { read: true, write: false },
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // tools should be preserved
    expect(result.tools).toEqual({ read: true, write: false });
  });

  it('preserves disable when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      disable: true,
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // disable should be preserved
    expect(result.disable).toBe(true);
  });

  it('preserves prompt when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      prompt: 'You are a helpful assistant.',
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // prompt should be preserved
    expect(result.prompt).toBe('You are a helpful assistant.');
  });

  it('preserves providerOptions when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      providerOptions: { apiKey: 'sk-secret', org: 'my-org' },
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // providerOptions should be preserved
    expect(result.providerOptions).toEqual({
      apiKey: 'sk-secret',
      org: 'my-org',
    });
  });

  it('preserves category when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      category: 'quick',
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // category should be preserved
    expect(result.category).toBe('quick');
  });

  it('preserves mode when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      mode: 'subagent',
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // mode should be preserved
    expect(result.mode).toBe('subagent');
  });

  it('preserves color when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      color: '#ff0000',
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // color should be preserved
    expect(result.color).toBe('#ff0000');
  });

  it('preserves textVerbosity when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      textVerbosity: 'high',
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // textVerbosity should be preserved
    expect(result.textVerbosity).toBe('high');
  });

  it('preserves ALL non-model fields simultaneously when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      permission: { edit: 'ask' },
      tools: { read: true },
      disable: false,
      prompt: 'You are an expert coder.',
      providerOptions: { org: 'my-org' },
      category: 'quick',
      mode: 'primary',
      color: 'blue',
      textVerbosity: 'medium',
      variant: 'v2',
      temperature: 0.7,
      top_p: 0.9,
      maxTokens: 4096,
      reasoningEffort: 'high',
      thinking: { type: 'enabled', budgetTokens: 8000 },
      prompt_append: 'Always use TypeScript.',
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // every single non-model field should survive
    expect(result.permission).toEqual({ edit: 'ask' });
    expect(result.tools).toEqual({ read: true });
    expect(result.disable).toBe(false);
    expect(result.prompt).toBe('You are an expert coder.');
    expect(result.providerOptions).toEqual({ org: 'my-org' });
    expect(result.category).toBe('quick');
    expect(result.mode).toBe('primary');
    expect(result.color).toBe('blue');
    expect(result.textVerbosity).toBe('medium');
    expect(result.variant).toBe('v2');
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
    expect(result.maxTokens).toBe(4096);
    expect(result.reasoningEffort).toBe('high');
    expect(result.thinking).toEqual({ type: 'enabled', budgetTokens: 8000 });
    expect(result.prompt_append).toBe('Always use TypeScript.');
  });

  // ---- fallback_models (agent) ----

  it('preserves fallback_models as string when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      fallback_models: 'openai/gpt-4o',
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // fallback_models should be preserved when not edited
    expect(result.fallback_models).toBe('openai/gpt-4o');
  });

  it('preserves fallback_models as array of strings when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      fallback_models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet'],
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // fallback_models should be preserved when not edited
    expect(result.fallback_models).toEqual([
      'openai/gpt-4o',
      'anthropic/claude-3.5-sonnet',
    ]);
  });

  it('preserves fallback_models as array of objects when only model is saved', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      fallback_models: [
        { model: 'openai/gpt-4o', temperature: 0.3 },
        {
          model: 'anthropic/claude-3.5-sonnet',
          reasoningEffort: 'high',
          thinking: { type: 'enabled', budgetTokens: 16000 },
        },
      ],
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // fallback_models (rich object form) should be preserved
    expect(result.fallback_models).toEqual([
      { model: 'openai/gpt-4o', temperature: 0.3 },
      {
        model: 'anthropic/claude-3.5-sonnet',
        reasoningEffort: 'high',
        thinking: { type: 'enabled', budgetTokens: 16000 },
      },
    ]);
  });

  it('updates fallback_models when explicitly included in save payload', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      fallback_models: 'openai/gpt-4o',
    };
    const result = mergeAgentSave(existing, {
      model: 'new-model',
      fallback_models: 'openai/gpt-4-turbo',
    });
    // This should work with current code: fallback_models is in the payload, so
    // it appears in validated and replaces the old value. GREEN.
    expect(result.fallback_models).toBe('openai/gpt-4-turbo');
  });

  // ---- Categories ----

  it('preserves description on category when only model is saved', () => {
    const existing: CategoryConfig = {
      model: 'old-model',
      description: 'Fast, lightweight tasks under 1 second.',
    };
    const result = mergeCategorySave(existing, { model: 'new-model' });
    // description should be preserved
    expect(result.description).toBe(
      'Fast, lightweight tasks under 1 second.',
    );
  });

  it('preserves is_unstable_agent on category when only model is saved', () => {
    const existing: CategoryConfig = {
      model: 'old-model',
      is_unstable_agent: true,
    };
    const result = mergeCategorySave(existing, { model: 'new-model' });
    // is_unstable_agent should be preserved
    expect(result.is_unstable_agent).toBe(true);
  });

  it('preserves max_prompt_tokens on category when only model is saved', () => {
    const existing: CategoryConfig = {
      model: 'old-model',
      max_prompt_tokens: 100000,
    };
    const result = mergeCategorySave(existing, { model: 'new-model' });
    // max_prompt_tokens should be preserved
    expect(result.max_prompt_tokens).toBe(100000);
  });

  it('preserves ALL non-model fields on category when only model is saved', () => {
    const existing: CategoryConfig = {
      model: 'old-model',
      description: 'Heavy reasoning tasks.',
      is_unstable_agent: true,
      max_prompt_tokens: 200000,
      variant: 'v3',
      temperature: 0.5,
      top_p: 0.95,
      maxTokens: 8192,
      reasoningEffort: 'max',
      thinking: { type: 'disabled' },
      textVerbosity: 'low',
      tools: { bash: true },
      prompt_append: 'Be concise.',
      disable: false,
    };
    const result = mergeCategorySave(existing, { model: 'new-model' });
    // all non-model fields should be preserved
    expect(result.description).toBe('Heavy reasoning tasks.');
    expect(result.is_unstable_agent).toBe(true);
    expect(result.max_prompt_tokens).toBe(200000);
    expect(result.variant).toBe('v3');
    expect(result.temperature).toBe(0.5);
    expect(result.top_p).toBe(0.95);
    expect(result.maxTokens).toBe(8192);
    expect(result.reasoningEffort).toBe('max');
    expect(result.thinking).toEqual({ type: 'disabled' });
    expect(result.textVerbosity).toBe('low');
    expect(result.tools).toEqual({ bash: true });
    expect(result.prompt_append).toBe('Be concise.');
    expect(result.disable).toBe(false);
  });

  // ---- fallback_models (category) ----

  it('preserves fallback_models on category when only model is saved', () => {
    const existing: CategoryConfig = {
      model: 'old-model',
      fallback_models: [
        { model: 'openai/gpt-4o', temperature: 0.2 },
      ],
    };
    const result = mergeCategorySave(existing, { model: 'new-model' });
    // fallback_models should be preserved on categories too
    expect(result.fallback_models).toEqual([
      { model: 'openai/gpt-4o', temperature: 0.2 },
    ]);
  });

  // ---- model still updates correctly ----

  it('still updates model value when saving', () => {
    const existing: AgentConfig = {
      model: 'old-model',
      permission: { edit: 'ask' },
    };
    const result = mergeAgentSave(existing, { model: 'new-model' });
    // Model should be updated (this works in current code — GREEN)
    expect(result.model).toBe('new-model');
  });
});

// ---------------------------------------------------------------------------
// validateAndClean — correctness tests (should currently pass)
// ---------------------------------------------------------------------------

describe('validateAndClean', () => {
  it('returns only fields present in the payload', () => {
    const raw = { model: 'gpt-4' };
    const result = validateAndClean<AgentConfig>(raw, AGENT_FIELDS);
    expect(Object.keys(result).sort()).toEqual(['model']);
    expect(result.model).toBe('gpt-4');
  });

  it('rejects unknown fields', () => {
    expect(() =>
      validateAndClean<AgentConfig>(
        { model: 'gpt-4', unknownField: 42 },
        AGENT_FIELDS,
      ),
    ).toThrow('Unknown field: unknownField');
  });

  it('rejects non-object payloads (array)', () => {
    expect(() =>
      validateAndClean<AgentConfig>(['not-an-object'], AGENT_FIELDS),
    ).toThrow('Save payload must be an object');
  });

  it('rejects non-object payloads (null)', () => {
    expect(() =>
      validateAndClean<AgentConfig>(null, AGENT_FIELDS),
    ).toThrow('Save payload must be an object');
  });

  it('rejects non-object payloads (primitive)', () => {
    expect(() =>
      validateAndClean<AgentConfig>('string', AGENT_FIELDS),
    ).toThrow('Save payload must be an object');
  });

  it('omits null-valued keys from cleaned result', () => {
    const raw = { model: 'gpt-4', prompt: null, tools: null };
    const result = validateAndClean<AgentConfig>(raw, AGENT_FIELDS);
    expect(result).toEqual({ model: 'gpt-4' });
    expect(result).not.toHaveProperty('prompt');
    expect(result).not.toHaveProperty('tools');
  });

  it('clamps temperature below 0 to 0', () => {
    const result = validateAndClean<AgentConfig>(
      { temperature: -1 },
      AGENT_FIELDS,
    );
    expect(result.temperature).toBe(0);
  });

  it('clamps temperature above 2 to 2', () => {
    const result = validateAndClean<AgentConfig>(
      { temperature: 3 },
      AGENT_FIELDS,
    );
    expect(result.temperature).toBe(2);
  });

  it('passes through valid temperature', () => {
    const result = validateAndClean<AgentConfig>(
      { temperature: 0.7 },
      AGENT_FIELDS,
    );
    expect(result.temperature).toBe(0.7);
  });

  it('passes through non-numeric temperature unchanged', () => {
    const result = validateAndClean<AgentConfig>(
      { temperature: 'warm' } as unknown as Record<string, unknown>,
      AGENT_FIELDS,
    );
    expect(result).toHaveProperty('temperature');
  });
});

function makeMockWebviewPanel() {
  const messages: unknown[] = [];
  const listeners: Array<(e: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  let disposed = false;

  const webview = {
    postMessage: (msg: unknown) => {
      messages.push(msg);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (fn: (e: unknown) => void) => {
      listeners.push(fn);
      return { dispose: () => {} };
    },
    asWebviewUri: (uri: { toString: () => string }) => ({ toString: () => uri.toString() }),
    cspSource: 'self',
  };

  const panel = {
    webview,
    title: '',
    onDidDispose: (fn: () => void) => {
      disposeListeners.push(fn);
      return { dispose: () => {} };
    },
    reveal: () => {},
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const fn of disposeListeners) fn();
    },
  };

  function sendReady(): void {
    for (const listener of listeners) {
      listener({ command: 'ready' });
    }
  }

  return { panel, webview, messages, listeners, disposeListeners, sendReady };
}

function makeMockConfigStore(): ConfigStore {
  const emitter = new EventEmitter();
  let agents: Record<string, AgentConfig> = {};
  return {
    onDidChange: emitter,
    getAgent: (name: string) => agents[name],
    getCategory: () => undefined,
    updateConfig: async (updater: (draft: { agents?: Record<string, AgentConfig> }) => void) => {
      const draft = { agents: { ...agents } };
      updater(draft);
      agents = draft.agents ?? {};
      emitter.emit('change');
    },
  } as unknown as ConfigStore;
}

function makeProfileAwareConfigStore(): ConfigStore & {
  readonly getAgentMock: ReturnType<typeof vi.fn>;
  readonly updateConfigMock: ReturnType<typeof vi.fn>;
} {
  const getAgentMock = vi.fn(() => ({ model: 'active-config/model' }));
  const updateConfigMock = vi.fn(async () => {});
  return {
    onDidChange: new EventEmitter(),
    getAgent: getAgentMock,
    getCategory: vi.fn(() => undefined),
    updateConfig: updateConfigMock,
    getAgentMock,
    updateConfigMock,
  } as unknown as ConfigStore & {
    readonly getAgentMock: ReturnType<typeof vi.fn>;
    readonly updateConfigMock: ReturnType<typeof vi.fn>;
  };
}

function makeProfileAwareProfileStore(): ProfileStore & {
  readonly getProfileMock: ReturnType<typeof vi.fn>;
  readonly updateProfileEntryMock: ReturnType<typeof vi.fn>;
} {
  const getProfileMock = vi.fn((name: string) =>
    name === 'fast'
      ? {
          name: 'fast',
          agents: {
            sisyphus: { model: 'profile/model', prompt: 'from profile' },
          },
          categories: {
            quick: { model: 'profile/category' },
          },
        }
      : undefined,
  );
  const updateProfileEntryMock = vi.fn(async () => ({ name: 'fast' }));
  return {
    onDidChange: new EventEmitter(),
    listProfiles: () => [],
    getActiveProfileName: () => undefined,
    getProfile: getProfileMock,
    updateProfileEntry: updateProfileEntryMock,
    getProfileMock,
    updateProfileEntryMock,
  } as unknown as ProfileStore & {
    readonly getProfileMock: ReturnType<typeof vi.fn>;
    readonly updateProfileEntryMock: ReturnType<typeof vi.fn>;
  };
}

function makeMockProfileStore(): ProfileStore {
  return {
    onDidChange: new EventEmitter(),
    listProfiles: () => [],
    getActiveProfileName: () => undefined,
  } as unknown as ProfileStore;
}

function makeMockModelDiscovery(): ModelDiscovery {
  return {
    discoverModels: vi.fn().mockResolvedValue({
      models: [{ modelId: 'openai/gpt-4' }],
      source: 'cli',
    }),
  } as unknown as ModelDiscovery;
}

function makeExtensionContext(extensionPath: string) {
  return {
    extensionPath,
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
}

describe('AgentEditorPanel integration', () => {
  let extensionPath: string;

  beforeEach(() => {
    extensionPath = fs.mkdtempSync('/tmp/omo-panel-test-');
    fs.mkdirSync(path.join(extensionPath, 'out'), { recursive: true });
    fs.mkdirSync(path.join(extensionPath, 'src', 'ui', 'webview'), { recursive: true });
    fs.writeFileSync(path.join(extensionPath, 'src', 'ui', 'webview', 'webview.html'), '<html></html>');
    fs.writeFileSync(path.join(extensionPath, 'src', 'ui', 'webview', 'webview.css'), '');
    AgentEditorPanel.currentPanel = undefined;
  });

  afterEach(() => {
    fs.rmSync(extensionPath, { recursive: true, force: true });
  });

  it('loads model IDs first, then capabilities in the background', async () => {
    const { panel, sendReady, messages } = makeMockWebviewPanel();
    const configStore = makeMockConfigStore();
    const profileStore = makeMockProfileStore();
    const modelDiscovery = makeMockModelDiscovery();
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as import('vscode').WebviewPanel);

    AgentEditorPanel.show(
      makeExtensionContext(extensionPath),
      configStore,
      profileStore,
      modelDiscovery,
      treeProvider,
      { type: 'agent', name: 'sisyphus' },
    );

    sendReady();
    await new Promise((r) => setTimeout(r, 10));

    expect(vi.mocked(modelDiscovery.discoverModels)).toHaveBeenCalledWith({ verbose: false, forceRefresh: false });
    expect(vi.mocked(modelDiscovery.discoverModels)).toHaveBeenCalledWith({ verbose: true, forceRefresh: false });

    const loadedMessages = messages.filter(
      (m): m is { command: string; models: Array<{ modelId: string }> } =>
        typeof m === 'object' && m !== null && (m as { command?: unknown }).command === 'modelsLoaded',
    );
    expect(loadedMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('forces refresh when reloadModels is received', async () => {
    const { panel, listeners } = makeMockWebviewPanel();
    const configStore = makeMockConfigStore();
    const profileStore = makeMockProfileStore();
    const modelDiscovery = makeMockModelDiscovery();
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as import('vscode').WebviewPanel);

    AgentEditorPanel.show(
      makeExtensionContext(extensionPath),
      configStore,
      profileStore,
      modelDiscovery,
      treeProvider,
      { type: 'agent', name: 'sisyphus' },
    );

    await new Promise((r) => setTimeout(r, 10));
    vi.mocked(modelDiscovery.discoverModels).mockClear();

    for (const listener of listeners) {
      listener({ command: 'reloadModels' });
    }
    await new Promise((r) => setTimeout(r, 10));

    const calls = vi.mocked(modelDiscovery.discoverModels).mock.calls;
    expect(calls).toContainEqual([{ verbose: false, forceRefresh: true }]);
    expect(calls).toContainEqual([{ verbose: true, forceRefresh: true }]);
  });

  it('initializes profile-context agent edits from ProfileStore', async () => {
    const { panel, sendReady, messages } = makeMockWebviewPanel();
    const configStore = makeProfileAwareConfigStore();
    const profileStore = makeProfileAwareProfileStore();
    const modelDiscovery = makeMockModelDiscovery();
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as import('vscode').WebviewPanel);

    AgentEditorPanel.show(
      makeExtensionContext(extensionPath),
      configStore,
      profileStore,
      modelDiscovery,
      treeProvider,
      { type: 'agent', name: 'sisyphus', profile: 'fast' },
    );

    sendReady();

    const initMessage = messages.find(
      (message): message is { command: string; config: AgentConfig | null } =>
        typeof message === 'object' &&
        message !== null &&
        (message as { command?: unknown }).command === 'init',
    );
    expect(initMessage?.config).toEqual({
      model: 'profile/model',
      prompt: 'from profile',
    });
    expect(profileStore.getProfileMock).toHaveBeenCalledWith('fast');
    expect(configStore.getAgentMock).not.toHaveBeenCalled();
  });

  it('saves profile-context agent edits through ProfileStore only', async () => {
    const { panel, listeners, messages } = makeMockWebviewPanel();
    const configStore = makeProfileAwareConfigStore();
    const profileStore = makeProfileAwareProfileStore();
    const modelDiscovery = makeMockModelDiscovery();
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as import('vscode').WebviewPanel);

    AgentEditorPanel.show(
      makeExtensionContext(extensionPath),
      configStore,
      profileStore,
      modelDiscovery,
      treeProvider,
      { type: 'agent', name: 'sisyphus', profile: 'fast' },
    );

    for (const listener of listeners) {
      listener({ command: 'save', payload: { model: 'profile/new', prompt: null } });
    }
    await new Promise((resolve) => setImmediate(resolve));

    expect(profileStore.updateProfileEntryMock).toHaveBeenCalledWith(
      'fast',
      'agents',
      'sisyphus',
      { model: 'profile/new' },
      new Set(['prompt']),
    );
    expect(configStore.updateConfigMock).not.toHaveBeenCalled();
    expect(messages).toContainEqual({ command: 'saved' });
  });

});
