import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';

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
    openTextDocument: vi.fn(),
    fs: {
      readFile: vi.fn(),
      writeFile: vi.fn(),
      rename: vi.fn(),
      delete: vi.fn(),
    },
  },
  commands: {
    registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  },
  Disposable: {
    from: vi.fn((...disposables: unknown[]) => ({
      dispose: vi.fn(),
      disposables,
    })),
  },
}));

vi.mock('./ui/agentEditorPanel.js', () => ({
  AgentEditorPanel: {
    showProfileJson: vi.fn(),
  },
}));

import {
  registerProfileTransferCommands,
  handleCreateProfileFromConfig,
  handleImportProfiles,
  handleExportAllProfiles,
  handleExportProfile,
  handleEditProfileJson,
  handleEditActiveProfileJson,
  type ProfileTransferCommandContext,
} from './profileTransferCommands.js';
import type { AgentModelTreeItem } from './ui/agentModelTreeProvider.js';
import type {
  NormalizedProfilesFile,
  ProfileFragment,
  ProfileValidationResult,
} from './config/profileValidation.js';
import type {
  ProfileFragmentParseResult,
  ProfileTransferParseResult,
  ProfileTransferRoot,
} from './config/profileTransfer.js';
import {
  deriveProfileNameFromSource,
  parseConfigFragmentBytes,
} from './config/profileTransfer.js';
import type {
  ImportProfilesResult,
  Profile,
} from './config/schema.js';
import type {
  TransferFileResult,
  OpenedTransferFile,
} from './vscode/profileTransferFiles.js';

type MockedContext = ProfileTransferCommandContext & {
  configStore: object;
  profileStore: {
    importSingleProfile: ReturnType<typeof vi.fn>;
    importProfiles: ReturnType<typeof vi.fn>;
    getProfileFragment: ReturnType<typeof vi.fn>;
    getProfilesFileSnapshot: ReturnType<typeof vi.fn>;
    getProfile: ReturnType<typeof vi.fn>;
    createProfileFromFragment: ReturnType<typeof vi.fn>;
  };
  showProfileJson: ReturnType<typeof vi.fn>;
  openTransferFile: ReturnType<typeof vi.fn>;
  saveTransferFile: ReturnType<typeof vi.fn>;
  parseProfileTransferBytes: ReturnType<typeof vi.fn>;
  parseConfigFragmentBytes: ReturnType<typeof vi.fn>;
  validateProfileTransfer: ReturnType<typeof vi.fn>;
  validateProfileFragment: ReturnType<typeof vi.fn>;
  serializeProfileTransfer: ReturnType<typeof vi.fn>;
  containsProviderOptions: ReturnType<typeof vi.fn>;
  sanitizeExportBasename: ReturnType<typeof vi.fn>;
  deriveProfileNameFromSource: ReturnType<typeof vi.fn>;
  showInformationMessage: ReturnType<typeof vi.fn>;
  showWarningMessage: ReturnType<typeof vi.fn>;
  showWarningMessageModal: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  showQuickPick: ReturnType<typeof vi.fn>;
  showInputBox: ReturnType<typeof vi.fn>;
};

function createFakeContext(): MockedContext {
  return {
    configStore: {},
    profileStore: {
      importSingleProfile: vi.fn(),
      importProfiles: vi.fn(),
      getProfileFragment: vi.fn(),
      getProfilesFileSnapshot: vi.fn(),
      getProfile: vi.fn(),
      createProfileFromFragment: vi.fn(),
    },
    showProfileJson: vi.fn(),
    openTransferFile: vi.fn(),
    saveTransferFile: vi.fn(),
    parseProfileTransferBytes: vi.fn(),
    parseConfigFragmentBytes: vi.fn((input: Uint8Array) =>
      parseConfigFragmentBytes(input),
    ),
    validateProfileTransfer: vi.fn(),
    validateProfileFragment: vi.fn(),
    serializeProfileTransfer: vi.fn(
      (value: unknown) => JSON.stringify(value, null, 2) + '\n',
    ),
    containsProviderOptions: vi.fn(),
    sanitizeExportBasename: vi.fn((name: string) => name),
    deriveProfileNameFromSource: vi.fn((name: string) =>
      deriveProfileNameFromSource(name),
    ),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showWarningMessageModal: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
  } as unknown as MockedContext;
}

function makeProfileItem(name: string): AgentModelTreeItem {
  return {
    kind: 'profile',
    contextValue: 'profile',
    nodeName: name,
  } as unknown as AgentModelTreeItem;
}

function makeConfigFileItem(): AgentModelTreeItem {
  return {
    kind: 'configFile',
    contextValue: 'configFile',
  } as unknown as AgentModelTreeItem;
}

function openedFile(path: string): TransferFileResult<OpenedTransferFile> {
  return {
    status: 'success',
    value: {
      uri: vscode.Uri.file(path) as vscode.Uri,
      bytes: new Uint8Array(),
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registerProfileTransferCommands', () => {
  it('registers all six profile transfer command IDs', () => {
    registerProfileTransferCommands(createFakeContext());

    const calls = vi.mocked(vscode.commands.registerCommand).mock.calls;
    expect(calls.map(([id]) => id)).toEqual([
      'ohMyOpenAgent.importProfiles',
      'ohMyOpenAgent.exportAllProfiles',
      'ohMyOpenAgent.exportProfile',
      'ohMyOpenAgent.editProfileJson',
      'ohMyOpenAgent.editActiveProfileJson',
      'ohMyOpenAgent.createProfileFromConfig',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

describe('handleImportProfiles', () => {
  let context: MockedContext;

  beforeEach(() => {
    context = createFakeContext();
  });

  it('imports a fragment directly and reports the resolved profile name', async () => {
    context.openTransferFile.mockResolvedValue(openedFile('/path/to/file.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: true,
      root: { kind: 'fragment', value: { agents: {} } },
    } as ProfileTransferParseResult);
    context.validateProfileTransfer.mockReturnValue({
      ok: true,
      value: { kind: 'fragment', value: { agents: {} } },
    } as ProfileValidationResult<NormalizedProfileTransferRoot>);
    context.profileStore.importSingleProfile.mockResolvedValue({
      name: 'file',
    } as Profile);

    await handleImportProfiles(context);

    expect(context.profileStore.importSingleProfile).toHaveBeenCalledWith(
      { agents: {} },
      'file.json',
    );
    expect(context.showInformationMessage).toHaveBeenCalledWith(
      'Imported profile "file".',
    );
  });

  it('imports a sidecar in extend mode by default', async () => {
    const sidecar: NormalizedProfilesFile = {
      version: 1,
      profiles: [{ name: 'imported' }],
    };
    context.openTransferFile.mockResolvedValue(openedFile('/path/to/sidecar.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: true,
      root: { kind: 'sidecar', value: sidecar },
    } as ProfileTransferParseResult);
    context.validateProfileTransfer.mockReturnValue({
      ok: true,
      value: { kind: 'sidecar', value: sidecar },
    } as ProfileValidationResult<NormalizedProfileTransferRoot>);
    context.showQuickPick.mockResolvedValue({ label: 'Extend' });
    context.profileStore.importProfiles.mockResolvedValue({
      mode: 'extend',
      added: 1,
      importedNames: ['imported'],
    } as ImportProfilesResult);

    await handleImportProfiles(context);

    expect(context.profileStore.importProfiles).toHaveBeenCalledWith(
      sidecar,
      'extend',
    );
    expect(context.showInformationMessage).toHaveBeenCalledWith(
      'Imported 1 profile (extend mode).',
    );
  });

  it('requires a second destructive confirmation for replace', async () => {
    const sidecar: NormalizedProfilesFile = {
      version: 1,
      profiles: [{ name: 'imported' }],
    };
    context.openTransferFile.mockResolvedValue(openedFile('/path/to/sidecar.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: true,
      root: { kind: 'sidecar', value: sidecar },
    } as ProfileTransferParseResult);
    context.validateProfileTransfer.mockReturnValue({
      ok: true,
      value: { kind: 'sidecar', value: sidecar },
    } as ProfileValidationResult<NormalizedProfileTransferRoot>);
    context.showQuickPick.mockResolvedValue({ label: 'Replace' });
    context.showWarningMessageModal.mockResolvedValue('Replace');
    context.profileStore.importProfiles.mockResolvedValue({
      mode: 'replace',
      added: 1,
      importedNames: ['imported'],
    } as ImportProfilesResult);

    await handleImportProfiles(context);

    expect(context.showWarningMessageModal).toHaveBeenCalledWith(
      expect.stringContaining('Replace all existing profiles'),
      'Replace',
    );
    expect(context.profileStore.importProfiles).toHaveBeenCalledWith(
      sidecar,
      'replace',
    );
  });

  it('is a no-op when the file dialog is cancelled', async () => {
    context.openTransferFile.mockResolvedValue({ status: 'cancelled' });

    await handleImportProfiles(context);

    expect(context.parseProfileTransferBytes).not.toHaveBeenCalled();
    expect(context.profileStore.importSingleProfile).not.toHaveBeenCalled();
    expect(context.profileStore.importProfiles).not.toHaveBeenCalled();
  });

  it('is a no-op when the import mode quick-pick is cancelled', async () => {
    const sidecar: NormalizedProfilesFile = {
      version: 1,
      profiles: [{ name: 'imported' }],
    };
    context.openTransferFile.mockResolvedValue(openedFile('/path/to/sidecar.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: true,
      root: { kind: 'sidecar', value: sidecar },
    } as ProfileTransferParseResult);
    context.validateProfileTransfer.mockReturnValue({
      ok: true,
      value: { kind: 'sidecar', value: sidecar },
    } as ProfileValidationResult<NormalizedProfileTransferRoot>);
    context.showQuickPick.mockResolvedValue(undefined);

    await handleImportProfiles(context);

    expect(context.profileStore.importProfiles).not.toHaveBeenCalled();
  });

  it('is a no-op when replace confirmation is dismissed', async () => {
    const sidecar: NormalizedProfilesFile = {
      version: 1,
      profiles: [{ name: 'imported' }],
    };
    context.openTransferFile.mockResolvedValue(openedFile('/path/to/sidecar.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: true,
      root: { kind: 'sidecar', value: sidecar },
    } as ProfileTransferParseResult);
    context.validateProfileTransfer.mockReturnValue({
      ok: true,
      value: { kind: 'sidecar', value: sidecar },
    } as ProfileValidationResult<NormalizedProfileTransferRoot>);
    context.showQuickPick.mockResolvedValue({ label: 'Replace' });
    context.showWarningMessageModal.mockResolvedValue(undefined);

    await handleImportProfiles(context);

    expect(context.profileStore.importProfiles).not.toHaveBeenCalled();
  });

  it('shows a path-independent error on parse failure', async () => {
    context.openTransferFile.mockResolvedValue(openedFile('/secret/path.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: false,
      error: {
        code: 'syntax_error',
        message: 'Invalid JSONC',
        path: [],
      },
    } as ProfileTransferParseResult);

    await handleImportProfiles(context);

    expect(context.showErrorMessage).toHaveBeenCalledWith(
      'Import failed: Invalid JSONC',
    );
    expect(context.showErrorMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('/secret/path.json'),
    );
  });

  it('shows a path-independent error on validation failure', async () => {
    context.openTransferFile.mockResolvedValue(openedFile('/secret/path.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: true,
      root: { kind: 'fragment', value: {} },
    } as ProfileTransferParseResult);
    context.validateProfileTransfer.mockReturnValue({
      ok: false,
      error: { code: 'missing_field', message: 'Missing sections', path: [] },
    } as ProfileValidationResult<NormalizedProfileTransferRoot>);

    await handleImportProfiles(context);

    expect(context.showErrorMessage).toHaveBeenCalledWith(
      'Import failed: Missing sections',
    );
  });

  it('shows a path-independent error when the store throws', async () => {
    context.openTransferFile.mockResolvedValue(openedFile('/secret/path.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: true,
      root: { kind: 'fragment', value: { agents: {} } },
    } as ProfileTransferParseResult);
    context.validateProfileTransfer.mockReturnValue({
      ok: true,
      value: { kind: 'fragment', value: { agents: {} } },
    } as ProfileValidationResult<NormalizedProfileTransferRoot>);
    context.profileStore.importSingleProfile.mockRejectedValue(
      new Error('sidecar locked'),
    );

    await handleImportProfiles(context);

    expect(context.showErrorMessage).toHaveBeenCalledWith(
      'Import failed: sidecar locked',
    );
  });
});

describe('handleCreateProfileFromConfig', () => {
  let context: MockedContext;

  beforeEach(() => {
    context = createFakeContext();
  });

  it('is a no-op when the file dialog is cancelled', async () => {
    context.openTransferFile.mockResolvedValue({ status: 'cancelled' });

    await handleCreateProfileFromConfig(context);

    expect(context.parseConfigFragmentBytes).not.toHaveBeenCalled();
    expect(context.profileStore.createProfileFromFragment).not.toHaveBeenCalled();
    expect(context.showInformationMessage).not.toHaveBeenCalled();
    expect(context.showErrorMessage).not.toHaveBeenCalled();
  });

  it('shows a path-independent error on parse failure', async () => {
    context.openTransferFile.mockResolvedValue(openedFile('/secret/path.jsonc'));
    context.parseConfigFragmentBytes.mockReturnValue({
      ok: false,
      error: {
        code: 'syntax_error',
        message: 'Invalid JSONC',
        path: [],
      },
    } as ProfileFragmentParseResult);

    await handleCreateProfileFromConfig(context);

    expect(context.showErrorMessage).toHaveBeenCalledWith(
      'Create profile failed: Invalid JSONC',
    );
    expect(context.showErrorMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('/secret/path.jsonc'),
    );
    expect(context.profileStore.createProfileFromFragment).not.toHaveBeenCalled();
  });

  it('shows a path-independent error on validation failure', async () => {
    context.openTransferFile.mockResolvedValue(openedFile('/secret/path.jsonc'));
    context.parseConfigFragmentBytes.mockReturnValue({
      ok: true,
      value: { agents: {} },
    } as ProfileFragmentParseResult);
    context.validateProfileFragment.mockReturnValue({
      ok: false,
      error: {
        code: 'missing_field',
        message: 'Missing sections',
        path: [],
      },
    } as ProfileValidationResult<ProfileFragment>);

    await handleCreateProfileFromConfig(context);

    expect(context.showErrorMessage).toHaveBeenCalledWith(
      'Create profile failed: Missing sections',
    );
    expect(context.profileStore.createProfileFromFragment).not.toHaveBeenCalled();
  });

  it('is a no-op when the input box is cancelled', async () => {
    context.openTransferFile.mockResolvedValue(openedFile('/path/to/file.jsonc'));
    context.parseConfigFragmentBytes.mockReturnValue({
      ok: true,
      value: { agents: {}, categories: {} },
    } as ProfileFragmentParseResult);
    context.validateProfileFragment.mockReturnValue({
      ok: true,
      value: { agents: {}, categories: {} },
    } as ProfileValidationResult<ProfileFragment>);
    context.showInputBox.mockResolvedValue(undefined);

    await handleCreateProfileFromConfig(context);

    expect(context.profileStore.createProfileFromFragment).not.toHaveBeenCalled();
    expect(context.showInformationMessage).not.toHaveBeenCalled();
  });

  it('creates a profile from the filename-derived name and reports success', async () => {
    context.openTransferFile.mockResolvedValue(
      openedFile('/path/to/oh-my-openagent.jsonc'),
    );
    context.parseConfigFragmentBytes.mockReturnValue({
      ok: true,
      value: { agents: { sisyphus: { model: 'gpt-4' } }, categories: {} },
    } as ProfileFragmentParseResult);
    context.validateProfileFragment.mockReturnValue({
      ok: true,
      value: { agents: { sisyphus: { model: 'gpt-4' } }, categories: {} },
    } as ProfileValidationResult<ProfileFragment>);
    context.showInputBox.mockResolvedValue('oh-my-openagent');
    context.profileStore.createProfileFromFragment.mockResolvedValue({
      name: 'oh-my-openagent',
    } as Profile);

    await handleCreateProfileFromConfig(context);

    expect(context.deriveProfileNameFromSource).toHaveBeenCalledWith(
      'oh-my-openagent.jsonc',
    );
    expect(context.showInputBox).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'oh-my-openagent',
        prompt: 'Profile name',
      }),
    );
    expect(context.profileStore.createProfileFromFragment).toHaveBeenCalledWith(
      'oh-my-openagent',
      { agents: { sisyphus: { model: 'gpt-4' } }, categories: {} },
    );
    expect(context.showInformationMessage).toHaveBeenCalledWith(
      'Created profile "oh-my-openagent" from "oh-my-openagent.jsonc".',
    );
  });

  it('trims the user-edited name before creating the profile', async () => {
    context.openTransferFile.mockResolvedValue(openedFile('/path/to/file.jsonc'));
    context.parseConfigFragmentBytes.mockReturnValue({
      ok: true,
      value: { agents: {}, categories: {} },
    } as ProfileFragmentParseResult);
    context.validateProfileFragment.mockReturnValue({
      ok: true,
      value: { agents: {}, categories: {} },
    } as ProfileValidationResult<ProfileFragment>);
    context.showInputBox.mockResolvedValue('  custom-name  ');
    context.profileStore.createProfileFromFragment.mockResolvedValue({
      name: 'custom-name',
    } as Profile);

    await handleCreateProfileFromConfig(context);

    expect(context.profileStore.createProfileFromFragment).toHaveBeenCalledWith(
      'custom-name',
      { agents: {}, categories: {} },
    );
    expect(context.showInformationMessage).toHaveBeenCalledWith(
      'Created profile "custom-name" from "file.jsonc".',
    );
  });

  it('validates the input name against existing profiles', async () => {
    context.openTransferFile.mockResolvedValue(openedFile('/path/to/file.jsonc'));
    context.parseConfigFragmentBytes.mockReturnValue({
      ok: true,
      value: { agents: {}, categories: {} },
    } as ProfileFragmentParseResult);
    context.validateProfileFragment.mockReturnValue({
      ok: true,
      value: { agents: {}, categories: {} },
    } as ProfileValidationResult<ProfileFragment>);
    context.profileStore.getProfile.mockImplementation((name: string) => {
      if (name === 'existing') {
        return { name: 'existing' } as Profile;
      }
      return undefined;
    });
    context.showInputBox.mockResolvedValue('fresh');
    context.profileStore.createProfileFromFragment.mockResolvedValue({
      name: 'fresh',
    } as Profile);

    await handleCreateProfileFromConfig(context);

    const inputOptions = context.showInputBox.mock.calls[0][0] as {
      validateInput: (value: string) => string | undefined;
    };
    expect(inputOptions.validateInput('existing')).toBe(
      'Profile "existing" already exists',
    );
    expect(inputOptions.validateInput('fresh')).toBeUndefined();
    expect(context.profileStore.createProfileFromFragment).toHaveBeenCalledWith(
      'fresh',
      { agents: {}, categories: {} },
    );
  });

  it('extracts only agents and categories from a full config fixture', async () => {
    const fullConfig = JSON.stringify({
      $schema: 'https://omo.dev/schema.json',
      agents: { sisyphus: { model: 'gpt-4' } },
      categories: {},
      other: 'ignored',
    });
    const bytes = new TextEncoder().encode(fullConfig);
    const parsed = parseConfigFragmentBytes(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    context.openTransferFile.mockResolvedValue({
      status: 'success',
      value: {
        uri: vscode.Uri.file('/path/to/oh-my-openagent.json') as vscode.Uri,
        bytes,
      },
    });
    context.parseConfigFragmentBytes.mockReturnValue(
      parsed as ProfileFragmentParseResult,
    );
    context.validateProfileFragment.mockReturnValue({
      ok: true,
      value: parsed.value,
    } as ProfileValidationResult<ProfileFragment>);
    context.showInputBox.mockResolvedValue('oh-my-openagent');
    context.profileStore.createProfileFromFragment.mockResolvedValue({
      name: 'oh-my-openagent',
    } as Profile);

    await handleCreateProfileFromConfig(context);

    expect(context.profileStore.createProfileFromFragment).toHaveBeenCalledWith(
      'oh-my-openagent',
      { agents: { sisyphus: { model: 'gpt-4' } }, categories: {} },
    );
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('handleExportAllProfiles', () => {
  let context: MockedContext;

  beforeEach(() => {
    context = createFakeContext();
  });

  it('exports the sidecar snapshot and reports the profile count', async () => {
    const sidecar: NormalizedProfilesFile = {
      version: 1,
      profiles: [{ name: 'one' }, { name: 'two' }],
    };
    context.profileStore.getProfilesFileSnapshot.mockReturnValue(sidecar);
    context.containsProviderOptions.mockReturnValue(false);
    context.saveTransferFile.mockResolvedValue({
      status: 'success',
      value: vscode.Uri.file('/out.json') as vscode.Uri,
    });
    context.serializeProfileTransfer.mockReturnValue('sidecar-json');

    await handleExportAllProfiles(context);

    const savedBytes = context.saveTransferFile.mock.calls[0][0] as Uint8Array;
    expect(Buffer.from(savedBytes).toString()).toBe('sidecar-json');
    expect(context.showInformationMessage).toHaveBeenCalledWith(
      'Exported 2 profiles.',
    );
  });

  it('warns when any profile contains providerOptions and cancels if dismissed', async () => {
    context.profileStore.getProfilesFileSnapshot.mockReturnValue({
      version: 1,
      profiles: [{ name: 'one' }],
    });
    context.containsProviderOptions.mockReturnValue(true);
    context.showWarningMessage.mockResolvedValue(undefined);

    await handleExportAllProfiles(context);

    expect(context.showWarningMessage).toHaveBeenCalledWith(
      'One or more profiles contain providerOptions. Export and continue?',
      'Export',
    );
    expect(context.saveTransferFile).not.toHaveBeenCalled();
  });

  it('is a no-op when the save dialog is cancelled', async () => {
    context.profileStore.getProfilesFileSnapshot.mockReturnValue({
      version: 1,
      profiles: [{ name: 'one' }],
    });
    context.containsProviderOptions.mockReturnValue(false);
    context.saveTransferFile.mockResolvedValue({ status: 'cancelled' });

    await handleExportAllProfiles(context);

    expect(context.showInformationMessage).not.toHaveBeenCalled();
  });

  it('shows an error when writing the export file fails', async () => {
    context.profileStore.getProfilesFileSnapshot.mockReturnValue({
      version: 1,
      profiles: [{ name: 'one' }],
    });
    context.containsProviderOptions.mockReturnValue(false);
    context.saveTransferFile.mockResolvedValue({
      status: 'error',
      error: { message: 'disk full' } as Error,
    });

    await handleExportAllProfiles(context);

    expect(context.showErrorMessage).toHaveBeenCalledWith(
      'Export failed: disk full',
    );
  });
});

describe('handleExportProfile', () => {
  let context: MockedContext;

  beforeEach(() => {
    context = createFakeContext();
  });

  it('exports the selected profile fragment and reports the name', async () => {
    const fragment: ProfileFragment = { agents: { sisyphus: { model: 'gpt-4' } } };
    context.profileStore.getProfileFragment.mockReturnValue(fragment);
    context.containsProviderOptions.mockReturnValue(false);
    context.saveTransferFile.mockResolvedValue({
      status: 'success',
      value: vscode.Uri.file('/out.json') as vscode.Uri,
    });
    context.serializeProfileTransfer.mockReturnValue('fragment-json');

    await handleExportProfile(context, makeProfileItem('my-profile'));

    expect(context.profileStore.getProfileFragment).toHaveBeenCalledWith(
      'my-profile',
    );
    const savedBytes = context.saveTransferFile.mock.calls[0][0] as Uint8Array;
    expect(Buffer.from(savedBytes).toString()).toBe('fragment-json');
    expect(context.showInformationMessage).toHaveBeenCalledWith(
      'Exported profile "my-profile".',
    );
  });

  it('warns when the profile contains providerOptions and cancels if dismissed', async () => {
    context.profileStore.getProfileFragment.mockReturnValue({ agents: {} });
    context.containsProviderOptions.mockReturnValue(true);
    context.showWarningMessage.mockResolvedValue(undefined);

    await handleExportProfile(context, makeProfileItem('my-profile'));

    expect(context.showWarningMessage).toHaveBeenCalledWith(
      'This profile contains providerOptions. Export and continue?',
      'Export',
    );
    expect(context.saveTransferFile).not.toHaveBeenCalled();
  });

  it('warns when invoked without a profile item', async () => {
    await handleExportProfile(context, undefined);

    expect(context.showWarningMessage).toHaveBeenCalledWith(
      'Select a profile in the Models view first.',
    );
    expect(context.saveTransferFile).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Edit JSON
// ---------------------------------------------------------------------------

describe('handleEditProfileJson', () => {
  let context: MockedContext;

  beforeEach(() => {
    context = createFakeContext();
  });

  it('opens profile JSON for the selected saved profile', () => {
    handleEditProfileJson(context, makeProfileItem('my-profile'));

    expect(context.showProfileJson).toHaveBeenCalledWith('my-profile');
  });

  it('warns when invoked without a profile item', () => {
    handleEditProfileJson(context, undefined);

    expect(context.showWarningMessage).toHaveBeenCalledWith(
      'Select a profile in the Models view first.',
    );
    expect(context.showProfileJson).not.toHaveBeenCalled();
  });
});

describe('handleEditActiveProfileJson', () => {
  let context: MockedContext;

  beforeEach(() => {
    context = createFakeContext();
  });

  it('opens profile JSON for the active config file', () => {
    handleEditActiveProfileJson(context, makeConfigFileItem());

    expect(context.showProfileJson).toHaveBeenCalledWith();
  });

  it('warns when invoked without the active config file item', () => {
    handleEditActiveProfileJson(context, undefined);

    expect(context.showWarningMessage).toHaveBeenCalledWith(
      'Select the active config file in the Models view first.',
    );
    expect(context.showProfileJson).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Safety invariants
// ---------------------------------------------------------------------------

describe('payload safety', () => {
  it('never logs the transfer payload', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const context = createFakeContext();
    context.openTransferFile.mockResolvedValue(openedFile('/secret.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: true,
      root: { kind: 'fragment', value: { agents: { secret: 'payload' } } },
    } as ProfileTransferParseResult);
    context.validateProfileTransfer.mockReturnValue({
      ok: true,
      value: {
        kind: 'fragment',
        value: { agents: { secret: 'payload' } },
      },
    } as ProfileValidationResult<NormalizedProfileTransferRoot>);
    context.profileStore.importSingleProfile.mockResolvedValue({
      name: 'secret',
    } as Profile);

    await handleImportProfiles(context);

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe('tree refresh', () => {
  it('handlers never call treeProvider.refresh directly', async () => {
    const context = createFakeContext();
    const refresh = vi.fn();
    (context as unknown as { treeProvider: { refresh: typeof refresh } }).treeProvider = {
      refresh,
    };
    context.openTransferFile.mockResolvedValue(openedFile('/path.json'));
    context.parseProfileTransferBytes.mockReturnValue({
      ok: true,
      root: { kind: 'fragment', value: { agents: {} } },
    } as ProfileTransferParseResult);
    context.validateProfileTransfer.mockReturnValue({
      ok: true,
      value: { kind: 'fragment', value: { agents: {} } },
    } as ProfileValidationResult<NormalizedProfileTransferRoot>);
    context.profileStore.importSingleProfile.mockResolvedValue({
      name: 'imported',
    } as Profile);

    await handleImportProfiles(context);

    expect(refresh).not.toHaveBeenCalled();
  });
});
