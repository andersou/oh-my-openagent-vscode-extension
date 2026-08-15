import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import * as vscode from 'vscode';
import { registerCommands } from './commands.js';
import { CONFIG_SCOPES } from './config/schema.js';
import { AgentEditorPanel } from './ui/agentEditorPanel.js';

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
  getRoutingDialect: ReturnType<typeof vi.fn>;
  setRoutingDialect: ReturnType<typeof vi.fn>;
  getShadowingHarnessScopes: ReturnType<typeof vi.fn>;
  removeHarnessBlocks: ReturnType<typeof vi.fn>;
  copyBaseToHarnessBlocks: ReturnType<typeof vi.fn>;
  refreshFromDisk: ReturnType<typeof vi.fn>;
  onDidChange: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
};

type FakeProfileStore = {
  getConfigScope: ReturnType<typeof vi.fn>;
  setConfigScope: ReturnType<typeof vi.fn>;
  setRoutingDialect: ReturnType<typeof vi.fn>;
  getActiveProfileName: ReturnType<typeof vi.fn>;
  getProfile: Mock;
  createProfile: ReturnType<typeof vi.fn>;
  activateProfile: ReturnType<typeof vi.fn>;
  renameProfile: ReturnType<typeof vi.fn>;
  duplicateProfile: ReturnType<typeof vi.fn>;
  deleteProfile: ReturnType<typeof vi.fn>;
  saveActiveConfigToProfile: ReturnType<typeof vi.fn>;
  projectActiveProfileToConfig: Mock;
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
      getRoutingDialect: vi.fn(() => 'latest'),
      setRoutingDialect: vi.fn(),
      getShadowingHarnessScopes: vi.fn(() => []),
      removeHarnessBlocks: vi.fn(),
      copyBaseToHarnessBlocks: vi.fn(),
      refreshFromDisk: vi.fn(),
      onDidChange: { on: vi.fn(), emit: vi.fn() },
    },
    profileStore: {
      getConfigScope: vi.fn(),
      setConfigScope: vi.fn(),
      setRoutingDialect: vi.fn(),
      getActiveProfileName: vi.fn(),
      getProfile: vi.fn(),
      createProfile: vi.fn(),
      activateProfile: vi.fn(),
      renameProfile: vi.fn(),
      duplicateProfile: vi.fn(),
      deleteProfile: vi.fn(),
      saveActiveConfigToProfile: vi.fn(),
      projectActiveProfileToConfig: vi.fn(),
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

  it('registers all 17 command IDs including configureSettings', () => {
    const calls = register(createDependencies());

    expect(calls.map(([id]) => id)).toEqual([
      'ohMyOpenAgent.openAgentManager',
      'ohMyOpenAgent.editAgent',
      'ohMyOpenAgent.editCategory',
      'ohMyOpenAgent.refresh',
      'ohMyOpenAgent.configureSettings',
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

describe('configureSettings', () => {
  let deps: Dependencies;
  let handler: (...args: unknown[]) => unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createDependencies();
    const calls = register(deps);
    handler = getCommandHandler('ohMyOpenAgent.configureSettings', calls);
  });

  function pickSettings(scope: string, dialect: string): void {
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: scope } as never)
      .mockResolvedValueOnce({ label: dialect } as never);
  }

  function mockModalChoice(choice: string | undefined): void {
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce(
      choice as never,
    );
  }

  it('sequentially shows harness and routing model QuickPicks with current values marked', async () => {
    deps.configStore.getScope.mockReturnValue('senpi');
    deps.configStore.getRoutingDialect.mockReturnValue('mainline');
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: 'senpi' } as never)
      .mockResolvedValueOnce(undefined);

    await handler();

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(2);
    const scopeItems = vi.mocked(vscode.window.showQuickPick).mock.calls[0][0] as {
      label: string;
      picked?: boolean;
      description?: string;
    }[];
    expect(scopeItems).toHaveLength(4);
    expect(scopeItems.map((item) => item.label)).toEqual([...CONFIG_SCOPES]);
    expect(scopeItems.find((item) => item.label === 'senpi')).toEqual(
      expect.objectContaining({ picked: true, description: 'Current' }),
    );
    expect(scopeItems.filter((item) => item.picked)).toHaveLength(1);
    expect(vi.mocked(vscode.window.showQuickPick).mock.calls[0][1]).toEqual({
      placeHolder: '1/2 Select the active harness',
    });

    const dialectItems = vi.mocked(vscode.window.showQuickPick).mock.calls[1][0] as {
      label: string;
      picked?: boolean;
      description?: string;
    }[];
    expect(dialectItems.map((item) => item.label)).toEqual([
      'latest',
      'mainline',
    ]);
    expect(dialectItems.find((item) => item.label === 'mainline')).toEqual(
      expect.objectContaining({ picked: true, description: 'Current' }),
    );
    expect(vi.mocked(vscode.window.showQuickPick).mock.calls[1][1]).toEqual({
      placeHolder: '2/2 Select the routing model',
    });
  });

  it('is a no-op when the user cancels the harness QuickPick', async () => {
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(undefined);

    await handler();

    expect(vscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.profileStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(deps.configStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('is a no-op when the user cancels the routing model QuickPick', async () => {
    vi.mocked(vscode.window.showQuickPick)
      .mockResolvedValueOnce({ label: 'senpi' } as never)
      .mockResolvedValueOnce(undefined);

    await handler();

    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.profileStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(deps.configStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('persists changed harness and routing model, closes stale editor, refreshes, and reports both values', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getRoutingDialect.mockReturnValue('latest');
    pickSettings('senpi', 'mainline');

    await handler();

    expect(deps.profileStore.setConfigScope).toHaveBeenCalledWith('senpi');
    expect(deps.configStore.setScope).toHaveBeenCalledWith('senpi');
    expect(deps.profileStore.setRoutingDialect).toHaveBeenCalledWith('mainline');
    expect(deps.configStore.setRoutingDialect).toHaveBeenCalledWith('mainline');
    expect(deps.profileStore.setConfigScope).toHaveBeenCalledBefore(
      deps.configStore.setScope,
    );
    expect(deps.profileStore.setRoutingDialect).toHaveBeenCalledBefore(
      deps.configStore.setRoutingDialect,
    );
    expect(AgentEditorPanel.closeCurrentPanel).toHaveBeenCalled();
    expect(deps.treeProvider.refresh).toHaveBeenCalled();
    expect(deps.profileStore.projectActiveProfileToConfig).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Settings updated: harness "senpi", routing model "mainline". The agent editor was closed to avoid stale edits.',
    );
  });

  it('updates only the routing model when the harness is unchanged', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getRoutingDialect.mockReturnValue('latest');
    pickSettings('opencode', 'mainline');

    await handler();

    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(AgentEditorPanel.closeCurrentPanel).not.toHaveBeenCalled();
    expect(deps.profileStore.setRoutingDialect).toHaveBeenCalledWith('mainline');
    expect(deps.configStore.setRoutingDialect).toHaveBeenCalledWith('mainline');
    expect(deps.treeProvider.refresh).toHaveBeenCalled();
    expect(deps.profileStore.projectActiveProfileToConfig).toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
      'Settings updated: harness "opencode", routing model "mainline".',
    );
  });

  it('is a no-op when both selections are current', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getRoutingDialect.mockReturnValue('latest');
    pickSettings('opencode', 'latest');

    await handler();

    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.profileStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(deps.configStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(deps.treeProvider.refresh).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('removes shadowing harness blocks before switching to global', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue([
      'opencode',
      'senpi',
    ]);
    pickSettings('global', 'latest');
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
    pickSettings('global', 'latest');
    mockModalChoice('Copy Global to All Harnesses');

    await handler();

    expect(deps.configStore.copyBaseToHarnessBlocks).toHaveBeenCalledTimes(1);
    expect(deps.configStore.removeHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).toHaveBeenCalledWith('global');
  });

  it('keeps the current settings when the reconciliation prompt is cancelled', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue(['opencode']);
    pickSettings('global', 'mainline');
    mockModalChoice(undefined);

    await handler();

    expect(deps.configStore.removeHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.copyBaseToHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.profileStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(deps.configStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('does not prompt when no harness block shadows the shared base', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue([]);
    pickSettings('global', 'latest');

    await handler();

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(deps.configStore.removeHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).toHaveBeenCalledWith('global');
  });

  it('warns when global latest projection hides active-profile fallbacks', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue([]);
    deps.profileStore.getActiveProfileName.mockReturnValue('truth');
    deps.profileStore.getProfile.mockReturnValue({
      name: 'truth',
      agents: {
        sisyphus: {
          model: 'main/model',
          fallback_models: ['fallback/model'],
        },
      },
    });
    pickSettings('global', 'latest');

    await handler();

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      'The active profile contains fallback chains. omo 4.x cannot represent them in global output, so omo.jsonc will omit them; the profile keeps them for other harnesses and routing models.',
    );
    expect(deps.profileStore.projectActiveProfileToConfig).toHaveBeenCalledOnce();
  });

  it('never reconciles omo.jsonc when switching to a harness scope', async () => {
    deps.configStore.getScope.mockReturnValue('global');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue(['opencode']);
    pickSettings('senpi', 'latest');

    await handler();

    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    expect(deps.configStore.removeHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.copyBaseToHarnessBlocks).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).toHaveBeenCalledWith('senpi');
  });

  it('reports a settings failure and leaves later updates unapplied', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getRoutingDialect.mockReturnValue('latest');
    pickSettings('senpi', 'mainline');
    deps.profileStore.setConfigScope.mockRejectedValue(
      new Error('disk full'),
    );

    await handler();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Failed to update settings: disk full',
    );
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(deps.profileStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(deps.configStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it('reports a reconciliation failure and leaves settings unchanged', async () => {
    deps.configStore.getScope.mockReturnValue('opencode');
    deps.configStore.getShadowingHarnessScopes.mockReturnValue(['opencode']);
    pickSettings('global', 'mainline');
    mockModalChoice('Remove Harness Blocks');
    deps.configStore.removeHarnessBlocks.mockRejectedValue(
      new Error('disk full'),
    );

    await handler();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      'Failed to update omo.jsonc for the global scope: disk full',
    );
    expect(deps.profileStore.setConfigScope).not.toHaveBeenCalled();
    expect(deps.profileStore.setRoutingDialect).not.toHaveBeenCalled();
    expect(deps.configStore.setScope).not.toHaveBeenCalled();
    expect(deps.configStore.setRoutingDialect).not.toHaveBeenCalled();
  });
});
