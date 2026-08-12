import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

function createFakeConfigStore() {
  return {
    getScope: vi.fn(() => 'opencode'),
    setScope: vi.fn(),
    getConfigPath: vi.fn(() => '/home/.omo/omo.jsonc'),
    getBaseDir: vi.fn(() => '/home/.omo'),
    getAgent: vi.fn(),
    getCategory: vi.fn(),
    getAgents: vi.fn(),
    getCategories: vi.fn(),
    getConfig: vi.fn(),
    getRawConfig: vi.fn(),
    updateConfig: vi.fn(),
    refreshFromDisk: vi.fn(),
    startWatch: vi.fn(),
    stopWatch: vi.fn(),
    onDidChange: { on: vi.fn(), emit: vi.fn() },
    dispose: vi.fn(),
  };
}

function createFakeProfileStore() {
  return {
    getConfigScope: vi.fn(),
    setConfigScope: vi.fn(),
    createProfile: vi.fn(),
    activateProfile: vi.fn(),
    renameProfile: vi.fn(),
    duplicateProfile: vi.fn(),
    deleteProfile: vi.fn(),
    saveActiveConfigToProfile: vi.fn(),
    getProfile: vi.fn(),
    getProfileFragment: vi.fn(),
    getProfilesFileSnapshot: vi.fn(),
    getActiveProfileName: vi.fn(),
    importSingleProfile: vi.fn(),
    importProfiles: vi.fn(),
    onDidChange: { on: vi.fn(), emit: vi.fn() },
  };
}

function createFakeTreeProvider() {
  return {
    refresh: vi.fn(),
    setView: vi.fn(),
    dispose: vi.fn(),
  };
}

function createFakeModelDiscovery() {
  return {
    discoverModels: vi.fn(),
  };
}

vi.mock('vscode', () => ({
  window: {
    createTreeView: vi.fn(() => ({ dispose: vi.fn() })),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    executeCommand: vi.fn(),
  },
  Disposable: {
    from: vi.fn((...disposables: unknown[]) => ({
      dispose: vi.fn(),
      disposables,
    })),
  },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }) },
  ViewColumn: { One: 1 },
}));

vi.mock('./config/configStore.js', () => ({
  ConfigStore: vi.fn(function () {
    return createFakeConfigStore();
  }),
}));

vi.mock('./config/profileStore.js', () => ({
  ProfileStore: vi.fn(function () {
    return createFakeProfileStore();
  }),
}));

vi.mock('./ui/agentModelTreeProvider.js', () => ({
  AgentModelTreeProvider: vi.fn(function () {
    return createFakeTreeProvider();
  }),
}));

vi.mock('./commands.js', () => ({
  registerCommands: vi.fn(function () {
    return { dispose: vi.fn() };
  }),
}));

vi.mock('./opencode/modelDiscovery.js', () => ({
  ModelDiscovery: vi.fn(function () {
    return createFakeModelDiscovery();
  }),
  createDefaultProcessExecutor: vi.fn(function () {
    return vi.fn();
  }),
}));

import { activate } from './extension.js';
import { ConfigStore } from './config/configStore.js';
import { ProfileStore } from './config/profileStore.js';
import { AgentModelTreeProvider } from './ui/agentModelTreeProvider.js';
import { registerCommands } from './commands.js';

describe('activate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores the persisted config scope before the tree provider and startWatch', () => {
    const fakeConfigStore = createFakeConfigStore();
    const fakeProfileStore = createFakeProfileStore();
    fakeProfileStore.getConfigScope.mockReturnValue('senpi');
    vi.mocked(ConfigStore).mockImplementation(function () {
      return fakeConfigStore as never;
    });
    vi.mocked(ProfileStore).mockImplementation(function () {
      return fakeProfileStore as never;
    });

    activate({
      extensionPath: '/ext',
      subscriptions: [],
    } as vscode.ExtensionContext);

    expect(fakeProfileStore.getConfigScope).toHaveBeenCalled();
    expect(fakeConfigStore.setScope).toHaveBeenCalledWith('senpi');
    expect(fakeConfigStore.setScope).toHaveBeenCalledBefore(
      AgentModelTreeProvider,
    );
    expect(fakeConfigStore.setScope).toHaveBeenCalledBefore(
      fakeConfigStore.startWatch,
    );
  });

  it('falls back to the default scope when no scope is persisted', () => {
    const fakeConfigStore = createFakeConfigStore();
    const fakeProfileStore = createFakeProfileStore();
    fakeProfileStore.getConfigScope.mockReturnValue(undefined);
    vi.mocked(ConfigStore).mockImplementation(function () {
      return fakeConfigStore as never;
    });
    vi.mocked(ProfileStore).mockImplementation(function () {
      return fakeProfileStore as never;
    });

    activate({
      extensionPath: '/ext',
      subscriptions: [],
    } as vscode.ExtensionContext);

    expect(fakeConfigStore.setScope).toHaveBeenCalledWith('opencode');
  });

  it('starts watching and registers commands after restoring the scope', () => {
    const fakeConfigStore = createFakeConfigStore();
    const fakeProfileStore = createFakeProfileStore();
    fakeProfileStore.getConfigScope.mockReturnValue('codex');
    vi.mocked(ConfigStore).mockImplementation(function () {
      return fakeConfigStore as never;
    });
    vi.mocked(ProfileStore).mockImplementation(function () {
      return fakeProfileStore as never;
    });

    activate({
      extensionPath: '/ext',
      subscriptions: [],
    } as vscode.ExtensionContext);

    expect(fakeConfigStore.setScope).toHaveBeenCalledBefore(
      fakeConfigStore.startWatch,
    );
    expect(fakeConfigStore.startWatch).toHaveBeenCalledBefore(registerCommands);
  });
});
