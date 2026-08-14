import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { registerCommands } from './commands.js';
import { CONFIG_SCOPES } from './config/schema.js';

vi.mock('vscode', () => ({
  Uri: {
    file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
  },
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
  },
  workspace: {
    fs: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
    },
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
  ViewColumn: { One: 1 },
}));

vi.mock('./ui/agentEditorPanel.js', () => ({
  AgentEditorPanel: {
    show: vi.fn(),
    showProfileJson: vi.fn(),
    closeCurrentPanel: vi.fn(),
  },
}));

type FakeConfigStore = {
  getScope: ReturnType<typeof vi.fn>;
  setScope: ReturnType<typeof vi.fn>;
  getShadowingHarnessScopes: ReturnType<typeof vi.fn>;
  removeHarnessBlocks: ReturnType<typeof vi.fn>;
  copyBaseToHarnessBlocks: ReturnType<typeof vi.fn>;
  refreshFromDisk: ReturnType<typeof vi.fn>;
  onDidChange: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
};

type FakeProfileStore = {
  getConfigScope: ReturnType<typeof vi.fn>;
  setConfigScope: ReturnType<typeof vi.fn>;
  getActiveProfileName: ReturnType<typeof vi.fn>;
  createProfile: ReturnType<typeof vi.fn>;
  activateProfile: ReturnType<typeof vi.fn>;
  renameProfile: ReturnType<typeof vi.fn>;
  duplicateProfile: ReturnType<typeof vi.fn>;
  deleteProfile: ReturnType<typeof vi.fn>;
  saveActiveConfigToProfile: ReturnType<typeof vi.fn>;
  onDidChange: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
};

type FakeTreeProvider = {
  refresh: ReturnType<typeof vi.fn>;
  setView: ReturnType<typeof vi.fn>;
};

type FakeModelDiscovery = {
  discoverModels: ReturnType<typeof vi.fn>;
};

type Dependencies = {
  context: vscode.ExtensionContext;
  configStore: FakeConfigStore;
  profileStore: FakeProfileStore;
  treeProvider: FakeTreeProvider;
  modelDiscovery: FakeModelDiscovery;
};

function createDependencies(): Dependencies {
  return {
    context: {
      extensionPath: '/ext',
      subscriptions: [],
    } as unknown as vscode.ExtensionContext,
    configStore: {
      getScope: vi.fn(() => 'opencode'),
      setScope: vi.fn(),
      getShadowingHarnessScopes: vi.fn(() => []),
      removeHarnessBlocks: vi.fn(),
      copyBaseToHarnessBlocks: vi.fn(),
      refreshFromDisk: vi.fn(),
      onDidChange: { on: vi.fn(), emit: vi.fn() },
    },
    profileStore: {
      getConfigScope: vi.fn(),
      setConfigScope: vi.fn(),
      getActiveProfileName: vi.fn(),
      createProfile: vi.fn(),
      activateProfile: vi.fn(),
      renameProfile: vi.fn(),
      duplicateProfile: vi.fn(),
      deleteProfile: vi.fn(),
      saveActiveConfigToProfile: vi.fn(),
      onDidChange: { on: vi.fn(), emit: vi.fn() },
    },
    treeProvider: {
      refresh: vi.fn(),
      setView: vi.fn(),
    },
    modelDiscovery: {
      discoverModels: vi.fn(),
    },
  };
}

function register(
  deps: Dependencies,
): [string, (...args: unknown[]) => unknown][] {
  registerCommands(
    deps.context,
    deps.configStore as unknown as import('./config/configStore.js').ConfigStore,
    deps.profileStore as unknown as import('./config/profileStore.js').ProfileStore,
    deps.treeProvider as unknown as import('./ui/agentModelTreeProvider.js').AgentModelTreeProvider,
    deps.modelDiscovery as unknown as import('./opencode/modelDiscovery.js').ModelDiscovery,
  );

  return vi.mocked(vscode.commands.registerCommand).mock.calls as unknown as [
    string,
    (...args: unknown[]) => unknown,
  ][];
}

function getCommandHandler(
  id: string,
  calls: [string, (...args: unknown[]) => unknown][],
): (...args: unknown[]) => unknown {
  const call = calls.find(([commandId]) => commandId === id);
  expect(call).toBeDefined();
  return call![1];
}

describe('registerCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all 18 command IDs including selectConfigScope and selectRoutingDialect', () => {
    const calls = register(createDependencies());

    expect(calls.map(([id]) => id)).toEqual([
      'ohMyOpenAgent.openAgentManager',
      'ohMyOpenAgent.editAgent',
      'ohMyOpenAgent.editCategory',
      'ohMyOpenAgent.refresh',
      'ohMyOpenAgent.selectConfigScope',
      'ohMyOpenAgent.selectRoutingDialect',
      'ohMyOpenAgent.createProfile',
      'ohMyOpenAgent.activateProfile',
      'ohMyOpenAgent.renameProfile',
      'ohMyOpenAgent.duplicateProfile',
      'ohMyOpenAgent.deleteProfile',
      'ohMyOpenAgent.saveActiveProfile',
      'ohMyOpenAgent.importProfiles',
      'ohMyOpenAgent.exportAllProfiles',
      'ohMyOpenAgent.exportProfile',
      'ohMyOpenAgent.editProfileJson',
      'ohMyOpenAgent.editActiveProfileJson',
      'ohMyOpenAgent.createProfileFromConfig',
    ]);
  });
});

describe('selectConfigScope', () => {
  let deps: Dependencies;
  let handler: (...args: unknown[]) => unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDependencies();
    const calls = register(deps);
    handler = getCommandHandler('ohMyOpenAgent.selectConfigScope', calls);
  });

  it('shows four QuickPick items with the current scope marked', async () => {
    deps.configStore.getScope.mockReturnValue('senpi');

    await handler();

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as {
      label: string;
      picked?: boolean;
      description?: string;
    }[];
    expect(items).toHaveLength(4);
    expect(items.map((item) => item.label)).toEqual([...CONFIG_SCOPES]);
    expect(items.find((item) => item.label === 'senpi')).toEqual(
      expect.objectContaining({ picked: true, description: 'Current' }),
    );
    expect(items.filter((item) => item.picked)).toHaveLength(1);
  });

  it('is a no-op when the user cancels the QuickPick', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await handler();

    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(
      (await import('./ui/agentEditorPanel.js')).AgentEditorPanel
        .closeCurrentPanel,
    ).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('persists the scope, updates the store, closes the editor, and shows an info message', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'senpi',
    });

    await handler();

    expect(deps.profileStore.setConfigScope).toHaveBeenCalledWith('senpi');
    expect(deps.configStore.setScope).toHaveBeenCalledWith('senpi');
    expect(
      (await import('./ui/agentEditorPanel.js')).AgentEditorPanel
        .closeCurrentPanel,
    ).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'The config scope changed to "senpi". The agent editor was closed to avoid stale edits.',
    );
  });

  it('calls profileStore.setConfigScope before configStore.setScope', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'codex',
    });

    await handler();

    expect(deps.profileStore.setConfigScope).toHaveBeenCalledBefore(
      deps.configStore.setScope,
    );
  });

  it('shows an error when the sidecar write fails', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'global',
    });
    deps.profileStore.setConfigScope.mockRejectedValue(
      new Error('disk full'),
    );

    await handler();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Failed to set config scope: disk full',
    );
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when the user re-picks the current scope', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'opencode',
    });

    await handler();

    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  function mockModalChoice(choice: string | undefined): void {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      choice as never,
    );
  }

  it('removes the shadowing harness blocks before switching to global', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue([
      'opencode',
      'senpi',
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'global',
    });
    mockModalChoice('Remove Harness Blocks');

    await handler();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('[opencode], [senpi]'),
      { modal: true },
      'Remove Harness Blocks',
      'Copy Global to All Harnesses',
    );
    expect(deps.configStore.removeHarnessBlocks).toHaveBeenCalledTimes(1);
    expect(deps.configStore.copyBaseToHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.profileStore.setConfigScope).toHaveBeenCalledWith('global');
    expect(deps.configStore.setScope).toHaveBeenCalledWith('global');
  });

  it('copies the shared base into every harness block when asked', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue(['opencode']);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'global',
    });
    mockModalChoice('Copy Global to All Harnesses');

    await handler();

    expect(deps.configStore.copyBaseToHarnessBlocks).toHaveBeenCalledTimes(1);
    expect(deps.configStore.removeHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).toHaveBeenCalledWith('global');
  });

  it('keeps the current scope when the reconciliation prompt is cancelled', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue(['opencode']);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'global',
    });
    mockModalChoice(undefined);

    await handler();

    expect(deps.configStore.removeHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.copyBaseToHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not prompt when no harness block shadows the shared base', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue([]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'global',
    });

    await handler();

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(deps.configStore.removeHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).toHaveBeenCalledWith('global');
  });

  it('never reconciles omo.jsonc when switching to a harness scope', async () => {
    deps.configStore.getScope.mockReturnValue('global');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue(['opencode']);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'senpi',
    });

    await handler();

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(deps.configStore.removeHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.copyBaseToHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).toHaveBeenCalledWith('senpi');
  });

  it('reports a reconciliation failure and leaves the scope unchanged', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue(['opencode']);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: 'global',
    });
    mockModalChoice('Remove Harness Blocks');
    deps.configStore.removeHarnessBlocks.mockRejectedValue(
      new Error('disk full'),
    );

    await handler();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Failed to update omo.jsonc for the global scope: disk full',
    );
    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
  });
});
