import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from './config/configStore.js';
import { ProfileStore } from './config/profileStore.js';
import { AgentModelTreeProvider } from './ui/agentModelTreeProvider.js';
import { AgentEditorPanel } from './ui/agentEditorPanel.js';
import { ModelDiscovery } from './opencode/modelDiscovery.js';

const INITIAL_CONFIG = `{
  // initial comment
  "agents": {
    "sisyphus": { "model": "old/model" },
  },
}
`;

function stubExecutor(models: Array<{ modelId: string; capabilities?: Record<string, unknown> }>) {
  return {
    exec: vi.fn(async () => ({
      stdout: models.map((m) => m.modelId).join('\n') + '\n',
      stderr: '',
      exitCode: 0,
    })),
  };
}

function makeMockWebviewPanel() {
  const messages: unknown[] = [];
  const messageListeners: Array<(e: unknown) => void> = [];
  const disposeListeners: Array<() => void> = [];
  let disposed = false;

  const webview = {
    postMessage: (msg: unknown) => {
      messages.push(msg);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (fn: (e: unknown) => void) => {
      messageListeners.push(fn);
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

  function sendToWebview(command: string, payload?: Record<string, unknown>) {
    for (const listener of messageListeners) {
      listener({ command, ...(payload ?? {}) });
    }
  }

  return { panel, webview, messages, messageListeners, disposeListeners, sendToWebview };
}

function makeExtensionContext(extensionPath: string) {
  return {
    extensionPath,
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
}

vi.mock('vscode', () => {
  class Disposable {
    dispose(): void {}
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
      constructor(id: string) { this.id = id; }
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

import * as vscode from 'vscode';

describe('smoke: end-to-end editor flow', () => {
  let tmpDir: string;
  let configPath: string;
  let extensionPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-smoke-'));
    configPath = path.join(tmpDir, 'oh-my-openagent.json');
    fs.writeFileSync(configPath, INITIAL_CONFIG, 'utf-8');

    extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-smoke-ext-'));
    fs.mkdirSync(path.join(extensionPath, 'out'), { recursive: true });
    fs.mkdirSync(path.join(extensionPath, 'src', 'ui', 'webview'), { recursive: true });
    fs.writeFileSync(path.join(extensionPath, 'src', 'ui', 'webview', 'webview.html'), '<html><body><div id="app"></div></body></html>');
    fs.writeFileSync(path.join(extensionPath, 'src', 'ui', 'webview', 'webview.css'), '');

    AgentEditorPanel.currentPanel = undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(extensionPath, { recursive: true, force: true });
  });

  it('opens editor, loads models, saves new model + fallback, preserves JSONC', async () => {
    const configStore = new ConfigStore(tmpDir);
    const profileStore = new ProfileStore(configStore);
    const executor = stubExecutor([
      { modelId: 'openai/gpt-4' },
      { modelId: 'anthropic/claude-haiku' },
    ]);
    const modelDiscovery = new ModelDiscovery(executor as never, extensionPath);
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

    const { panel, sendToWebview, messages } = makeMockWebviewPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as import('vscode').WebviewPanel);

    AgentEditorPanel.show(
      makeExtensionContext(extensionPath),
      configStore,
      profileStore,
      modelDiscovery,
      treeProvider,
      { type: 'agent', name: 'sisyphus' },
    );

    sendToWebview('ready');
    await new Promise((r) => setTimeout(r, 30));

    const initMsg = messages.find(
      (m): m is { command: string; type: string; name: string; config: Record<string, unknown> } =>
        typeof m === 'object' && m !== null && (m as { command?: unknown }).command === 'init',
    );
    expect(initMsg).toBeDefined();
    expect(initMsg?.type).toBe('agent');
    expect(initMsg?.name).toBe('sisyphus');
    expect(initMsg?.config.model).toBe('old/model');

    sendToWebview('modelsLoaded', {
      models: [
        { modelId: 'openai/gpt-4', capabilities: { temperature: true, reasoning: true } },
        { modelId: 'anthropic/claude-haiku' },
      ],
    });
    await new Promise((r) => setTimeout(r, 10));

    sendToWebview('save', {
      payload: {
        model: 'anthropic/claude-haiku',
        temperature: 0.5,
        fallback_models: [
          { model: 'openai/gpt-4', temperature: 0.3 },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).toContain('// initial comment');
    expect(raw).toContain('"anthropic/claude-haiku"');
    expect(raw).toContain('"temperature": 0.5');
    expect(raw).toContain('"fallback_models"');
    expect(raw).toContain('"openai/gpt-4"');
    expect(raw).not.toContain('"old/model"');

    const agent = configStore.getAgent('sisyphus');
    expect(agent?.model).toBe('anthropic/claude-haiku');
    expect(agent?.temperature).toBe(0.5);
    expect(agent?.fallback_models).toEqual([
      { model: 'openai/gpt-4', temperature: 0.3 },
    ]);

    configStore.dispose();
  });

});
