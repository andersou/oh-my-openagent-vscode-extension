import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from './config/configStore.js';
import { ProfileStore } from './config/profileStore.js';
import { AgentModelTreeProvider } from './ui/agentModelTreeProvider.js';
import { AgentEditorPanel } from './ui/agentEditorPanel.js';
import { ModelDiscovery } from './opencode/modelDiscovery.js';
import {
  handleImportProfiles,
  handleExportProfile,
  handleExportAllProfiles,
  type ProfileTransferCommandContext,
} from './profileTransferCommands.js';
import {
  parseProfileTransferBytes,
  serializeProfileTransfer,
  containsProviderOptions,
  sanitizeExportBasename,
  MAX_PROFILE_TRANSFER_BYTES,
} from './config/profileTransfer.js';
import { validateProfileTransfer } from './config/profileValidation.js';
import type { TransferFileResult, OpenedTransferFile } from './vscode/profileTransferFiles.js';
import type { AgentModelTreeItem } from './ui/agentModelTreeProvider.js';
import type { Profile } from './config/schema.js';

const INITIAL_CONFIG = `{
  // initial comment
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "old/model" },
    },
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

function makeProfileItem(name: string): AgentModelTreeItem {
  return {
    kind: 'profile',
    contextValue: 'profile',
    nodeName: name,
  } as unknown as AgentModelTreeItem;
}

function readSidecar(tmpDir: string): { profiles: Profile[]; lastActiveProfile?: string; version: number } {
  const sidecarPath = path.join(tmpDir, 'omo.profiles.json');
  if (!fs.existsSync(sidecarPath)) {
    return { profiles: [], version: 1 };
  }
  const raw = fs.readFileSync(sidecarPath, 'utf-8');
  return JSON.parse(raw) as { profiles: Profile[]; lastActiveProfile?: string; version: number };
}

function createCommandContext(
  configStore: ConfigStore,
  profileStore: ProfileStore,
  treeProvider: AgentModelTreeProvider,
  extensionPath: string,
  overrides: Partial<ProfileTransferCommandContext>,
): ProfileTransferCommandContext {
  return {
    configStore,
    profileStore,
    showProfileJson: (profileName?: string) => {
      AgentEditorPanel.showProfileJson(
        makeExtensionContext(extensionPath),
        configStore,
        profileStore,
        new ModelDiscovery(stubExecutor([]) as never, extensionPath),
        treeProvider,
        profileName,
      );
    },
    openTransferFile: overrides.openTransferFile ?? (async () => ({ status: 'cancelled' } as TransferFileResult<OpenedTransferFile>)),
    saveTransferFile: overrides.saveTransferFile ?? (async () => ({ status: 'cancelled' } as TransferFileResult<import('vscode').Uri>)),
    parseProfileTransferBytes,
    validateProfileTransfer,
    serializeProfileTransfer,
    containsProviderOptions,
    sanitizeExportBasename,
    showInformationMessage: overrides.showInformationMessage ?? (async () => undefined),
    showWarningMessage: overrides.showWarningMessage ?? (async () => undefined),
    showWarningMessageModal: overrides.showWarningMessageModal ?? (async () => undefined),
    showErrorMessage: overrides.showErrorMessage ?? (async () => undefined),
    showQuickPick: overrides.showQuickPick ?? (async () => undefined),
  };
}

function makeSaveCapture() {
  const captured: { bytes?: Uint8Array } = {};
  return {
    captured,
    saveTransferFile: async (bytes: Uint8Array): Promise<TransferFileResult<import('vscode').Uri>> => {
      captured.bytes = bytes;
      return { status: 'success', value: { fsPath: '/out.json', scheme: 'file', path: '/out.json' } as unknown as import('vscode').Uri };
    },
  };
}

function makeMessageCapture() {
  const info: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    info,
    warnings,
    errors,
    showInformationMessage: async (message: string): Promise<string | undefined> => {
      info.push(message);
      return undefined;
    },
    showWarningMessage: async (message: string): Promise<string | undefined> => {
      warnings.push(message);
      return undefined;
    },
    showWarningMessageModal: async (message: string, ...items: string[]): Promise<string | undefined> => {
      warnings.push(message);
      return items[0];
    },
    showErrorMessage: async (message: string): Promise<string | undefined> => {
      errors.push(message);
      return undefined;
    },
  };
}

function openedFileResult(bytes: Uint8Array, filePath: string): TransferFileResult<OpenedTransferFile> {
  return {
    status: 'success',
    value: {
      uri: { fsPath: filePath, scheme: 'file', path: filePath } as unknown as import('vscode').Uri,
      bytes,
    },
  };
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
    configPath = path.join(tmpDir, 'omo.jsonc');
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
      target: { type: 'agent', name: 'sisyphus', profile: null },
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
    expect(raw).toContain('"models"');
    expect(raw).toContain('"openai/gpt-4"');
    expect(raw).not.toContain('"old/model"');
    expect(raw).not.toContain('"fallback_models"');
    expect(raw).not.toContain('"main_overrides"');

    const agent = configStore.getAgent('sisyphus');
    expect(agent?.model).toBe('anthropic/claude-haiku');
    expect(agent?.temperature).toBe(0.5);
    expect(agent?.fallback_models).toEqual([
      { model: 'openai/gpt-4', temperature: 0.3 },
    ]);

    configStore.dispose();
  });

  it('projects the active profile after saving its agent from the editor', async () => {
    // Given: a live config that diverged from its active profile before an editor save
    const configStore = new ConfigStore(tmpDir);
    const profileStore = new ProfileStore(configStore);
    await profileStore.createProfile('fast');
    await profileStore.activateProfile('fast');
    await configStore.updateConfig((draft) => {
      const agent = draft.agents?.sisyphus;
      if (agent) {
        agent.permission = { edit: 'ask' };
      }
    });
    const modelDiscovery = new ModelDiscovery(stubExecutor([]) as never, extensionPath);
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);
    const { panel, sendToWebview } = makeMockWebviewPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as import('vscode').WebviewPanel);

    AgentEditorPanel.show(
      makeExtensionContext(extensionPath),
      configStore,
      profileStore,
      modelDiscovery,
      treeProvider,
      { type: 'agent', name: 'sisyphus', profile: 'fast' },
    );

    // When: the active profile's agent is saved through the editor
    sendToWebview('save', {
      target: { type: 'agent', name: 'sisyphus', profile: 'fast' },
      payload: { model: 'new/model' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    // Then: the profile remains authoritative and replaces unrelated config drift
    expect(profileStore.getProfile('fast')?.agents?.sisyphus).toEqual({
      model: 'new/model',
    });
    expect(profileStore.isActiveProfileModified()).toBe(false);

    configStore.dispose();
  });

  it('imports a fragment, exports it, and re-imports with collision', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

      const configStore = new ConfigStore(tmpDir);
      const profileStore = new ProfileStore(configStore);
      const treeProvider = new AgentModelTreeProvider(configStore, profileStore);
      const messages = makeMessageCapture();

      const fragmentText = JSON.stringify({
        version: 1,
        agent_order: ['sisyphus'],
        unrelated: 'keep',
        agents: { sisyphus: { model: 'm1' } },
        categories: { quick: { model: 'm2' } },
      }, null, 2);

      const ctx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        {
          ...messages,
          openTransferFile: async () => openedFileResult(new TextEncoder().encode(fragmentText), '/tmp/import-me.json'),
        },
      );

      await handleImportProfiles(ctx);

      expect(messages.info).toContain('Imported profile "import-me".');
      expect(profileStore.getProfile('import-me')).toEqual({
        name: 'import-me',
        agents: { sisyphus: { model: 'm1' } },
        categories: { quick: { model: 'm2' } },
        createdAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-01-02T03:04:05.000Z',
      });
      expect(configStore.getAgent('sisyphus')?.model).toBe('old/model');
      expect(profileStore.getActiveProfileName()).toBeUndefined();
      expect(readSidecar(tmpDir).profiles).toHaveLength(1);

      const freshProfileStore = new ProfileStore(new ConfigStore(tmpDir));
      expect(freshProfileStore.getProfile('import-me')).toEqual(profileStore.getProfile('import-me'));

      const saveCapture = makeSaveCapture();
      const exportCtx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        { ...messages, saveTransferFile: saveCapture.saveTransferFile },
      );
      await handleExportProfile(exportCtx, makeProfileItem('import-me'));
      expect(messages.info).toContain('Exported profile "import-me".');
      expect(saveCapture.captured.bytes).toBeDefined();
      const exportedText = new TextDecoder().decode(saveCapture.captured.bytes!);
      expect(exportedText).toBe('{\n  "agents": {\n    "sisyphus": {\n      "model": "m1"\n    }\n  },\n  "categories": {\n    "quick": {\n      "model": "m2"\n    }\n  }\n}\n');

      const reimportCtx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        {
          ...messages,
          openTransferFile: async () => openedFileResult(saveCapture.captured.bytes!, '/tmp/import-me.json'),
        },
      );
      await handleImportProfiles(reimportCtx);
      expect(messages.info).toContain('Imported profile "import-me-2".');
      const names = profileStore.listProfiles().map((p) => p.name);
      expect(names).toEqual(['import-me', 'import-me-2']);

      configStore.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exports all profiles and replace/extend imports with marker policy', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

      const configStore = new ConfigStore(tmpDir);
      const profileStore = new ProfileStore(configStore);
      await profileStore.createProfile('local-a');
      await profileStore.createProfile('local-b');
      await profileStore.activateProfile('local-b');
      const treeProvider = new AgentModelTreeProvider(configStore, profileStore);
      const messages = makeMessageCapture();

      const saveCapture = makeSaveCapture();
      const exportCtx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        { ...messages, saveTransferFile: saveCapture.saveTransferFile },
      );
      await handleExportAllProfiles(exportCtx);
      expect(messages.info).toContain('Exported 2 profiles.');
      expect(saveCapture.captured.bytes).toBeDefined();
      const exportedText = new TextDecoder().decode(saveCapture.captured.bytes!);
      expect(exportedText).toContain('"version": 1');
      expect(exportedText).toContain('"lastActiveProfile": "local-b"');
      expect(exportedText).toContain('"local-a"');
      expect(exportedText).toContain('"local-b"');

      const sidecar = readSidecar(tmpDir);
      expect(sidecar.lastActiveProfile).toBe('local-b');
      expect(sidecar.profiles.map((p) => p.name)).toEqual(['local-a', 'local-b']);

      const sidecarWithoutActive = JSON.parse(exportedText) as { version: number; profiles: Profile[]; lastActiveProfile?: string };
      delete sidecarWithoutActive.lastActiveProfile;
      sidecarWithoutActive.profiles = sidecarWithoutActive.profiles.filter((p) => p.name !== 'local-b');
      const sidecarBytes = new TextEncoder().encode(JSON.stringify(sidecarWithoutActive, null, 2));

      const replaceCtx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        {
          ...messages,
          openTransferFile: async () => openedFileResult(sidecarBytes, '/tmp/sidecar.json'),
          showQuickPick: async () =>
            ({ label: 'Replace' }) as import('vscode').QuickPickItem,
          showWarningMessageModal: async () =>
            'Replace',
        },
      );
    await handleImportProfiles(replaceCtx);
      expect(messages.info).toContain('Imported 1 profile (replace mode).');
      expect(readSidecar(tmpDir).profiles.map((p) => p.name)).toEqual(['local-a']);
      expect(readSidecar(tmpDir).lastActiveProfile).toBeUndefined();
      expect(profileStore.getActiveProfileName()).toBeUndefined();

      const extendCtx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        {
          ...messages,
          openTransferFile: async () => openedFileResult(sidecarBytes, '/tmp/sidecar.json'),
          showQuickPick: async () =>
            ({ label: 'Extend' }) as import('vscode').QuickPickItem,
        },
      );
      await handleImportProfiles(extendCtx);
      expect(messages.info).toContain('Imported 1 profile (extend mode).');
      expect(readSidecar(tmpDir).profiles.map((p) => p.name)).toEqual(['local-a', 'local-a-2']);
      expect(profileStore.getActiveProfileName()).toBeUndefined();

      configStore.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('edits saved-profile and active-config JSON through the panel', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

      const configStore = new ConfigStore(tmpDir);
      const profileStore = new ProfileStore(configStore);
      await profileStore.createProfile('editable');
      await configStore.updateConfig((draft) => {
        if (!draft.agents) draft.agents = {};
        draft.agents.sisyphus = { model: 'fresh/model' };
      });
      const treeProvider = new AgentModelTreeProvider(configStore, profileStore);
      const modelDiscovery = new ModelDiscovery(stubExecutor([]) as never, extensionPath);

      const { panel, sendToWebview, messages } = makeMockWebviewPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as import('vscode').WebviewPanel);

      AgentEditorPanel.showProfileJson(
        makeExtensionContext(extensionPath),
        configStore,
        profileStore,
        modelDiscovery,
        treeProvider,
        'editable',
      );
      sendToWebview('ready');
      await new Promise((r) => setTimeout(r, 30));
      const initMsg = messages.find(
        (m): m is { command: string; type: string; source: string; profile: string | null; text: string } =>
          typeof m === 'object' && m !== null && (m as { command?: unknown }).command === 'init',
      );
      expect(initMsg).toBeDefined();
      expect(initMsg?.type).toBe('profileJson');
      expect(initMsg?.source).toBe('saved');
      expect(initMsg?.profile).toBe('editable');

      sendToWebview('save', {
        target: { type: 'profileJson', source: 'saved', profile: 'editable' },
        payload: '{\n  "agents": {\n    "sisyphus": {\n      "model": "from/profile"\n    }\n  }\n}',
      });
      await new Promise((r) => setTimeout(r, 30));
      const savedMsg = messages.find(
        (m): m is { command: string; target: unknown; text: string } =>
          typeof m === 'object' && m !== null && (m as { command?: unknown }).command === 'saved',
      );
      expect(savedMsg).toBeDefined();
      expect(savedMsg?.text).toBe('{\n  "agents": {\n    "sisyphus": {\n      "model": "from/profile"\n    }\n  }\n}\n');
      expect(profileStore.getProfile('editable')?.agents?.sisyphus?.model).toBe('from/profile');
      expect(readSidecar(tmpDir).profiles[0]?.agents?.sisyphus?.model).toBe('from/profile');

      AgentEditorPanel.currentPanel?.dispose();
      AgentEditorPanel.currentPanel = undefined;

      const { panel: activePanel, sendToWebview: sendActive, messages: activeMessages } = makeMockWebviewPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(activePanel as unknown as import('vscode').WebviewPanel);
      AgentEditorPanel.showProfileJson(
        makeExtensionContext(extensionPath),
        configStore,
        profileStore,
        modelDiscovery,
        treeProvider,
      );
      sendActive('ready');
      await new Promise((r) => setTimeout(r, 30));
      sendActive('save', {
        target: { type: 'profileJson', source: 'active', profile: null },
        payload: '{\n  "agents": {\n    "sisyphus": {\n      "model": "active/model"\n    }\n  }\n}',
      });
      await new Promise((r) => setTimeout(r, 30));

      const activeRaw = fs.readFileSync(configPath, 'utf-8');
      expect(activeRaw).toContain('// initial comment');
      expect(activeRaw).toContain('"active/model"');
      expect(configStore.getAgent('sisyphus')?.model).toBe('active/model');
      expect(profileStore.getProfile('editable')?.agents?.sisyphus?.model).toBe('from/profile');

      const freshConfigStore = new ConfigStore(tmpDir);
      expect(freshConfigStore.getAgent('sisyphus')?.model).toBe('active/model');
      const freshProfileStore = new ProfileStore(freshConfigStore);
      expect(freshProfileStore.getProfile('editable')?.agents?.sisyphus?.model).toBe('from/profile');

      configStore.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the tree after import and warns on providerOptions export', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

      const configStore = new ConfigStore(tmpDir);
      const profileStore = new ProfileStore(configStore);
      await profileStore.createProfile('has-opts');
      await profileStore.updateProfile('has-opts', {
        agents: { sisyphus: { model: 'm', providerOptions: { key: 'value' } } },
      });
      const treeProvider = new AgentModelTreeProvider(configStore, profileStore);
      const messages = makeMessageCapture();

      const { panel: importPanel } = makeMockWebviewPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(importPanel as unknown as import('vscode').WebviewPanel);
      const fragmentText = JSON.stringify({ agents: { sisyphus: { model: 'imported' } } }, null, 2);
      const ctx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        {
          ...messages,
          openTransferFile: async () =>
            openedFileResult(new TextEncoder().encode(fragmentText), '/tmp/frag.json'),
        },
      );
      await handleImportProfiles(ctx);

      const freshTreeProvider = new AgentModelTreeProvider(new ConfigStore(tmpDir), new ProfileStore(new ConfigStore(tmpDir)));
      const profileGroup = freshTreeProvider.getChildren().find((c) => c.kind === 'group' && c.group === 'profiles');
      expect(profileGroup).toBeDefined();
      const profileLeaves = freshTreeProvider.getChildren(profileGroup);
      expect(profileLeaves.map((p) => p.nodeName)).toContain('frag');
      expect(profileLeaves.map((p) => p.nodeName)).toContain('has-opts');

      const saveCapture = makeSaveCapture();
      let warningReturn: string | undefined = undefined;
      const cancelCtx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        {
          ...messages,
          saveTransferFile: saveCapture.saveTransferFile,
          showWarningMessage: async (message: string) => {
            messages.warnings.push(message);
            return warningReturn;
          },
        },
      );
      await handleExportProfile(cancelCtx, makeProfileItem('has-opts'));
      expect(messages.warnings).toContain('This profile contains providerOptions. Export and continue?');
      expect(saveCapture.captured.bytes).toBeUndefined();

      warningReturn = 'Export';
      const confirmCtx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        {
          ...messages,
          saveTransferFile: saveCapture.saveTransferFile,
          showWarningMessage: async (message: string) => {
            messages.warnings.push(message);
            return warningReturn;
          },
        },
      );
      await handleExportProfile(confirmCtx, makeProfileItem('has-opts'));
      expect(saveCapture.captured.bytes).toBeDefined();
      expect(new TextDecoder().decode(saveCapture.captured.bytes!)).toContain('providerOptions');

      configStore.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed, oversized, and unsupported transfer inputs', async () => {
    const configStore = new ConfigStore(tmpDir);
    const profileStore = new ProfileStore(configStore);
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

    const cases: Array<{ bytes: Uint8Array; errorContains: string }> = [
      { label: 'invalid JSONC', bytes: new TextEncoder().encode('{'), errorContains: 'Invalid JSONC' },
      { label: 'root is array', bytes: new TextEncoder().encode('[]'), errorContains: 'root must be a JSON object' },
      { label: 'mixed root', bytes: new TextEncoder().encode('{\n  "profiles": [],\n  "agents": {}\n}'), errorContains: 'A sidecar root cannot contain fragment sections' },
      { label: 'missing sections', bytes: new TextEncoder().encode('{ "foo": 1 }'), errorContains: 'must contain agents, categories, or profiles' },
      { label: 'duplicate key', bytes: new TextEncoder().encode('{\n  "agents": {},\n  "agents": {}\n}'), errorContains: 'duplicate JSON key' },
      { label: 'unsupported version', bytes: new TextEncoder().encode('{\n  "version": 2,\n  "profiles": []\n}'), errorContains: 'only version 1 is supported' },
    ];
    for (const { bytes, errorContains } of cases) {
      const messages = makeMessageCapture();
      const ctx = createCommandContext(
        configStore,
        profileStore,
        treeProvider,
        extensionPath,
        {
          ...messages,
          openTransferFile: async () =>
            openedFileResult(bytes, '/tmp/case.json'),
        },
      );
      await handleImportProfiles(ctx);
      expect(messages.errors.some((m) => m.includes(errorContains))).toBe(true);
      expect(readSidecar(tmpDir).profiles).toHaveLength(0);
    }

    const messages = makeMessageCapture();
    const huge = new Uint8Array(MAX_PROFILE_TRANSFER_BYTES + 1);
    const ctx = createCommandContext(
      configStore,
      profileStore,
      treeProvider,
      extensionPath,
      {
        ...messages,
        openTransferFile: async () => openedFileResult(huge, '/tmp/huge.json'),
      },
    );
    await handleImportProfiles(ctx);
    expect(messages.errors.some((m) => /exceeds/.test(m))).toBe(true);
    expect(readSidecar(tmpDir).profiles).toHaveLength(0);

    configStore.dispose();
  });

  it('reports file-open and file-save errors without mutation', async () => {
    const configStore = new ConfigStore(tmpDir);
    const profileStore = new ProfileStore(configStore);
    await profileStore.createProfile('x');
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);
    const messages = makeMessageCapture();

    const openErr = createCommandContext(
      configStore,
      profileStore,
      treeProvider,
      extensionPath,
      {
        ...messages,
        openTransferFile: async () => ({ status: 'error', error: { message: 'disk full' } } as TransferFileResult<OpenedTransferFile>),
      },
    );
    await handleImportProfiles(openErr);
    expect(messages.errors).toContain('Import failed: disk full');
    expect(readSidecar(tmpDir).profiles.map((p) => p.name)).toEqual(['x']);

    const saveErr = async (): Promise<TransferFileResult<import('vscode').Uri>> =>
      ({ status: 'error', error: { message: 'no space' } } as TransferFileResult<import('vscode').Uri>);
    const exportErr = createCommandContext(
      configStore,
      profileStore,
      treeProvider,
      extensionPath,
      { ...messages, saveTransferFile: saveErr },
    );
    await handleExportProfile(exportErr, makeProfileItem('x'));
    expect(messages.errors).toContain('Export failed: no space');

    const allExportErr = createCommandContext(
      configStore,
      profileStore,
      treeProvider,
      extensionPath,
      { ...messages, saveTransferFile: saveErr },
    );
    await handleExportAllProfiles(allExportErr);
    expect(messages.errors).toContain('Export failed: no space');

    configStore.dispose();
  });

  it('keeps a saved profile authoritative when projecting it to config fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

      const configStore = new ConfigStore(tmpDir);
      const profileStore = new ProfileStore(configStore);
      await profileStore.createProfile('active');
      await profileStore.activateProfile('active');
      const treeProvider = new AgentModelTreeProvider(configStore, profileStore);
      const modelDiscovery = new ModelDiscovery(stubExecutor([]) as never, extensionPath);

      const { panel, sendToWebview, messages } = makeMockWebviewPanel();
      vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as import('vscode').WebviewPanel);

      const spy = vi.spyOn(profileStore, 'projectActiveProfileToConfig').mockRejectedValueOnce(new Error('config locked'));

      AgentEditorPanel.showProfileJson(
        makeExtensionContext(extensionPath),
        configStore,
        profileStore,
        modelDiscovery,
        treeProvider,
        'active',
      );
      sendToWebview('ready');
      const ready = Promise.withResolvers<void>();
      setImmediate(ready.resolve);
      await ready.promise;
      sendToWebview('save', {
        target: { type: 'profileJson', source: 'saved', profile: 'active' },
        payload: '{\n  "agents": {\n    "sisyphus": {\n      "model": "updated"\n    }\n  }\n}',
      });
      const saved = Promise.withResolvers<void>();
      setImmediate(saved.resolve);
      await saved.promise;

      const errorMsg = messages.find(
        (message): message is { command: string; message: string } =>
          typeof message === 'object' &&
          message !== null &&
          'command' in message &&
          message.command === 'error' &&
          'message' in message &&
          typeof message.message === 'string',
      );
      expect(errorMsg?.message).toContain(
        'Profile saved but failed to update active config',
      );
      expect(errorMsg?.message).toContain('config locked');
      expect(configStore.getAgent('sisyphus')?.model).toBe('old/model');
      expect(fs.readFileSync(configPath, 'utf-8')).toContain('"old/model"');
      expect(readSidecar(tmpDir).profiles[0]?.agents?.sisyphus?.model).toBe('updated');
      expect(profileStore.isActiveProfileModified()).toBe(true);

      spy.mockRestore();
      configStore.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

});

describe('smoke: per-scope end-to-end writes', () => {
  let tmpDir: string;
  let configPath: string;
  let extensionPath: string;

  const SCOPED_CONFIG = `{
  // shared base comment
  "categories": {
    "deep": { "model": "shared/deep" }, // deep comment
  },
  // opencode block comment
  "[opencode]": {
    // opencode agents comment
    "agents": {
      "sisyphus": { "model": "opencode/sisyphus" }, // opencode sisyphus comment
    },
  },
  // senpi block comment
  "[senpi]": {
    // senpi agents comment
    "agents": {
      "sisyphus": { "model": "senpi/sisyphus" }, // senpi sisyphus comment
    },
  },
}
`;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-scope-'));
    configPath = path.join(tmpDir, 'omo.jsonc');
    fs.writeFileSync(configPath, SCOPED_CONFIG, 'utf-8');

    extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-scope-ext-'));
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

  async function openAgentEditorAndSave(
    configStore: ConfigStore,
    profileStore: ProfileStore,
    model: string,
  ): Promise<void> {
    const modelDiscovery = new ModelDiscovery(stubExecutor([]) as never, extensionPath);
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

    const { panel, sendToWebview } = makeMockWebviewPanel();
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

    sendToWebview('save', {
      target: { type: 'agent', name: 'sisyphus', profile: null },
      payload: { model },
    });
    await new Promise((r) => setTimeout(r, 30));
  }

  async function openCategoryEditorAndSave(
    configStore: ConfigStore,
    profileStore: ProfileStore,
    model: string,
  ): Promise<void> {
    const modelDiscovery = new ModelDiscovery(stubExecutor([]) as never, extensionPath);
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

    const { panel, sendToWebview } = makeMockWebviewPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValue(panel as unknown as import('vscode').WebviewPanel);

    AgentEditorPanel.show(
      makeExtensionContext(extensionPath),
      configStore,
      profileStore,
      modelDiscovery,
      treeProvider,
      { type: 'category', name: 'deep' },
    );

    sendToWebview('ready');
    await new Promise((r) => setTimeout(r, 30));

    sendToWebview('save', {
      target: { type: 'category', name: 'deep', profile: null },
      payload: { model },
    });
    await new Promise((r) => setTimeout(r, 30));
  }

  async function openAgentEditorAndSavePayload(
    configStore: ConfigStore,
    profileStore: ProfileStore,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const modelDiscovery = new ModelDiscovery(stubExecutor([]) as never, extensionPath);
    const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

    const { panel, sendToWebview } = makeMockWebviewPanel();
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

    sendToWebview('save', {
      target: { type: 'agent', name: 'sisyphus', profile: null },
      payload,
    });
    await new Promise((r) => setTimeout(r, 30));
  }

  it('default opencode scope writes agent under [opencode] and preserves comments/trailing commas', async () => {
    const configStore = new ConfigStore(tmpDir);
    const profileStore = new ProfileStore(configStore);

    await openAgentEditorAndSave(configStore, profileStore, 'opencode/new');

    const raw = fs.readFileSync(configPath, 'utf-8');
    const opencodeStart = raw.indexOf('"[opencode]"');
    const senpiStart = raw.indexOf('"[senpi]"');
    const newValuePos = raw.indexOf('"opencode/new"');

    expect(newValuePos).toBeGreaterThan(opencodeStart);
    expect(newValuePos).toBeLessThan(senpiStart);
    expect(raw).toContain('// opencode agents comment');
    expect(raw).toContain('// opencode sisyphus comment');
    expect(raw).toContain('// senpi agents comment');
    expect(raw).toContain('// senpi sisyphus comment');
    expect(raw).toContain('// shared base comment');
    expect(raw).toContain('// deep comment');
    expect(raw).not.toContain('configScope');
    expect(configStore.getAgent('sisyphus')?.model).toBe('opencode/new');

    configStore.dispose();
  });

  it('senpi scope writes agent under [senpi] and preserves [opencode]', async () => {
    const configStore = new ConfigStore(tmpDir);
    const profileStore = new ProfileStore(configStore);
    configStore.setScope('senpi');

    await openAgentEditorAndSave(configStore, profileStore, 'senpi/new');

    const raw = fs.readFileSync(configPath, 'utf-8');
    const senpiStart = raw.indexOf('"[senpi]"');
    const newValuePos = raw.indexOf('"senpi/new"');

    expect(newValuePos).toBeGreaterThan(senpiStart);
    expect(raw).toContain('"opencode/sisyphus"');
    expect(raw).toContain('// opencode agents comment');
    expect(raw).toContain('// opencode sisyphus comment');
    expect(raw).toContain('// senpi agents comment');
    expect(raw).toContain('// senpi sisyphus comment');
    expect(raw).toContain('// shared base comment');
    expect(raw).toContain('// deep comment');
    expect(raw).not.toContain('configScope');
    expect(configStore.getAgent('sisyphus')?.model).toBe('senpi/new');

    configStore.dispose();
  });

  it('global scope writes category at root and preserves existing blocks', async () => {
    const configStore = new ConfigStore(tmpDir);
    const profileStore = new ProfileStore(configStore);
    configStore.setScope('global');

    await openCategoryEditorAndSave(configStore, profileStore, 'global/deep-new');

    const raw = fs.readFileSync(configPath, 'utf-8');
    const categoriesStart = raw.indexOf('"categories"');
    const opencodeStart = raw.indexOf('"[opencode]"');
    const newValuePos = raw.indexOf('"global/deep-new"');

    expect(newValuePos).toBeGreaterThan(categoriesStart);
    expect(newValuePos).toBeLessThan(opencodeStart);
    expect(raw).toContain('"opencode/sisyphus"');
    expect(raw).toContain('"senpi/sisyphus"');
    expect(raw).toContain('// opencode agents comment');
    expect(raw).toContain('// senpi agents comment');
    expect(raw).toContain('// shared base comment');
    expect(raw).toContain('// deep comment');
    expect(raw).not.toContain('configScope');
    expect(configStore.getCategory('deep')?.model).toBe('global/deep-new');

    configStore.dispose();
  });

  it('configScope lives in sidecar and never leaks into omo.jsonc', async () => {
    const configStore = new ConfigStore(tmpDir);
    const profileStore = new ProfileStore(configStore);

    await profileStore.setConfigScope('codex');
    configStore.setScope('codex');

    await configStore.updateConfig((draft) => {
      draft.agents = { sisyphus: { model: 'codex/sisyphus' } };
      draft.categories = { deep: { model: 'codex/deep' } };
    });
    await profileStore.createProfile('codex-profile');
    await profileStore.activateProfile('codex-profile');

    const raw = fs.readFileSync(configPath, 'utf-8');
    const codexStart = raw.indexOf('"[codex]"');
    const sisyphusPos = raw.indexOf('"codex/sisyphus"');
    const deepPos = raw.indexOf('"codex/deep"');

    expect(codexStart).toBeGreaterThan(-1);
    expect(sisyphusPos).toBeGreaterThan(codexStart);
    expect(deepPos).toBeGreaterThan(codexStart);
    expect(raw).not.toContain('configScope');

    const sidecar = readSidecar(tmpDir);
    expect(sidecar.configScope).toBe('codex');
    expect(sidecar.profiles).toHaveLength(1);
    expect(sidecar.profiles[0]?.agents?.sisyphus?.model).toBe('codex/sisyphus');

    configStore.dispose();
  });

  it('allows agent_order/disabled_agents only under opencode scope', async () => {
    const configStore = new ConfigStore(tmpDir);

    await configStore.updateConfig((draft) => {
      draft.agent_order = ['sisyphus'];
      draft.disabled_agents = ['explore'];
    });

    let raw = fs.readFileSync(configPath, 'utf-8');
    const opencodeStart = raw.indexOf('"[opencode]"');
    const senpiStart = raw.indexOf('"[senpi]"');
    const agentOrderPos = raw.indexOf('"agent_order"');
    const disabledAgentsPos = raw.indexOf('"disabled_agents"');

    expect(agentOrderPos).toBeGreaterThan(opencodeStart);
    expect(agentOrderPos).toBeLessThan(senpiStart);
    expect(disabledAgentsPos).toBeGreaterThan(opencodeStart);
    expect(disabledAgentsPos).toBeLessThan(senpiStart);

    configStore.setScope('senpi');
    await configStore.updateConfig((draft) => {
      draft.agent_order = ['sisyphus'];
      draft.disabled_agents = ['explore'];
    });
    raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw.match(/"agent_order"/g)?.length).toBe(1);
    expect(raw.match(/"disabled_agents"/g)?.length).toBe(1);

    configStore.setScope('global');
    await configStore.updateConfig((draft) => {
      draft.agent_order = ['sisyphus'];
      draft.disabled_agents = ['explore'];
    });
    raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw.match(/"agent_order"/g)?.length).toBe(1);
    expect(raw.match(/"disabled_agents"/g)?.length).toBe(1);
    expect(raw).not.toContain('configScope');

    configStore.dispose();
  });

  it('latest + opencode writes fallback_models and never models for a chain', async () => {
    const configStore = new ConfigStore(tmpDir, undefined, 'opencode', 'latest');
    const profileStore = new ProfileStore(configStore);

    await openAgentEditorAndSavePayload(configStore, profileStore, {
      model: 'a/one',
      fallback_models: ['b/two'],
    });

    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).toContain('"fallback_models"');
    expect(raw).not.toContain('"models"');
    expect(configStore.getAgent('sisyphus')).toEqual({
      model: 'a/one',
      fallback_models: ['b/two'],
    });

    configStore.dispose();
  });

  it('latest + senpi writes the models array', async () => {
    const configStore = new ConfigStore(tmpDir, undefined, 'senpi', 'latest');
    const profileStore = new ProfileStore(configStore);

    await openAgentEditorAndSavePayload(configStore, profileStore, {
      model: 'a/one',
      fallback_models: ['b/two'],
    });

    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).toContain('"[senpi]"');
    expect(raw).toContain('"models"');
    expect(configStore.getAgent('sisyphus')).toEqual({
      model: 'a/one',
      fallback_models: ['b/two'],
    });

    configStore.dispose();
  });

  it('latest + global writes model-only and drops chain keys', async () => {
    const configStore = new ConfigStore(tmpDir, undefined, 'global', 'latest');
    const profileStore = new ProfileStore(configStore);

    await openAgentEditorAndSavePayload(configStore, profileStore, {
      model: 'a/one',
      fallback_models: ['b/two'],
    });

    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).not.toContain('fallback_models');
    expect(raw).not.toContain('"models"');
    expect(configStore.getAgent('sisyphus')).toEqual({ model: 'a/one' });

    configStore.dispose();
  });

  it('warns before saving a fallback chain to global scope in latest dialect', async () => {
    const configStore = new ConfigStore(tmpDir, undefined, 'global', 'latest');
    const profileStore = new ProfileStore(configStore);
    const { warnings, showWarningMessage } = makeMessageCapture();
    (vscode.window as unknown as { showWarningMessage: typeof showWarningMessage }).showWarningMessage =
      showWarningMessage;

    await openAgentEditorAndSavePayload(configStore, profileStore, {
      model: 'a/one',
      fallback_models: ['b/two'],
    });

    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('omo 4.x cannot store fallback chains');
    expect(raw).not.toContain('fallback_models');
    expect(raw).not.toContain('"models"');
    expect(configStore.getAgent('sisyphus')).toEqual({ model: 'a/one' });
  });
});
