// Profile transfer command handlers: import, export, and JSON editing.
// These functions receive all dependencies through `ProfileTransferCommandContext`
// so tests can invoke them directly with mocks.

import * as path from 'node:path';
import * as vscode from 'vscode';

import type { ConfigStore } from './config/configStore.js';
import type {
  NormalizedProfileTransferRoot,
  ProfileFragment,
  ProfileValidationResult,
  NormalizedProfilesFile,
} from './config/profileValidation.js';
import type { ProfileStore } from './config/profileStore.js';
import type {
  ProfileFragmentParseResult,
  ProfileTransferParseResult,
  ProfileTransferRoot,
} from './config/profileTransfer.js';
import type { AgentModelTreeItem } from './ui/agentModelTreeProvider.js';
import type {
  OpenedTransferFile,
  OpenTransferFileOptions,
  TransferFileResult,
} from './vscode/profileTransferFiles.js';

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ProfileTransferCommandContext {
  readonly configStore: ConfigStore;
  readonly profileStore: ProfileStore;
  readonly showProfileJson: (profileName?: string) => void;
  readonly openTransferFile: (
    options?: OpenTransferFileOptions,
  ) => Promise<TransferFileResult<OpenedTransferFile>>;
  readonly saveTransferFile: (
    bytes: Uint8Array,
    options?: vscode.SaveDialogOptions,
  ) => Promise<TransferFileResult<vscode.Uri>>;
  readonly parseProfileTransferBytes: (
    input: Uint8Array,
  ) => ProfileTransferParseResult;
  readonly validateProfileTransfer: (
    root: ProfileTransferRoot,
  ) => ProfileValidationResult<NormalizedProfileTransferRoot>;
  readonly serializeProfileTransfer: (value: unknown) => string;
  readonly containsProviderOptions: (fragment: ProfileFragment) => boolean;
  readonly sanitizeExportBasename: (profileName: string) => string;
  readonly showInformationMessage: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
  readonly showWarningMessage: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
  readonly showWarningMessageModal: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
  readonly showErrorMessage: (
    message: string,
    ...items: string[]
  ) => Thenable<string | undefined>;
  readonly showQuickPick: <T extends vscode.QuickPickItem>(
    items: readonly T[],
    options?: { placeHolder?: string },
  ) => Thenable<T | undefined>;
  readonly parseConfigFragmentBytes: (
    input: Uint8Array,
  ) => ProfileFragmentParseResult;
  readonly validateProfileFragment: (
    value: unknown,
  ) => ProfileValidationResult<ProfileFragment>;
  readonly deriveProfileNameFromSource: (sourceName: string) => string;
  readonly showInputBox: (
    options?: {
      value?: string;
      prompt?: string;
      validateInput?: (
        value: string,
      ) => string | undefined | Thenable<string | undefined>;
    },
  ) => Thenable<string | undefined>;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export async function handleImportProfiles(
  context: ProfileTransferCommandContext,
): Promise<void> {
  const fileResult = await context.openTransferFile({
    filters: {
      'JSON/JSONC files': ['json', 'jsonc'],
      'All files': ['*'],
    },
  });

  if (fileResult.status === 'cancelled') {
    return;
  }
  if (fileResult.status === 'error') {
    void context.showErrorMessage(`Import failed: ${fileResult.error.message}`);
    return;
  }

  const { uri, bytes } = fileResult.value;
  const filename = path.basename(uri.fsPath);

  const parseResult = context.parseProfileTransferBytes(bytes);
  if (!parseResult.ok) {
    void context.showErrorMessage(`Import failed: ${parseResult.error.message}`);
    return;
  }

  const validationResult = context.validateProfileTransfer(parseResult.root);
  if (!validationResult.ok) {
    void context.showErrorMessage(
      `Import failed: ${validationResult.error.message}`,
    );
    return;
  }

  if (validationResult.value.kind === 'fragment') {
    await importSingleFragment(context, validationResult.value.value, filename);
    return;
  }

  await importSidecar(context, validationResult.value.value, filename);
}

export async function handleCreateProfileFromConfig(
  context: ProfileTransferCommandContext,
): Promise<void> {
  const fileResult = await context.openTransferFile({
    filters: {
      'JSON/JSONC files': ['json', 'jsonc'],
      'All files': ['*'],
    },
  });

  if (fileResult.status === 'cancelled') {
    return;
  }
  if (fileResult.status === 'error') {
    void context.showErrorMessage(
      `Create profile failed: ${fileResult.error.message}`,
    );
    return;
  }

  const { uri, bytes } = fileResult.value;
  const filename = path.basename(uri.fsPath);

  const parseResult = context.parseConfigFragmentBytes(bytes);
  if (!parseResult.ok) {
    void context.showErrorMessage(
      `Create profile failed: ${parseResult.error.message}`,
    );
    return;
  }

  const validationResult = context.validateProfileFragment(parseResult.value);
  if (!validationResult.ok) {
    void context.showErrorMessage(
      `Create profile failed: ${validationResult.error.message}`,
    );
    return;
  }

  const fragment = validationResult.value;
  const suggestedName = context.deriveProfileNameFromSource(filename);

  const name = await context.showInputBox({
    value: suggestedName,
    prompt: 'Profile name',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed === '') {
        return 'Profile name is required';
      }
      if (context.profileStore.getProfile(trimmed) !== undefined) {
        return `Profile "${trimmed}" already exists`;
      }
      return undefined;
    },
  });

  if (name === undefined) {
    return;
  }

  const trimmedName = name.trim();
  try {
    const profile = await context.profileStore.createProfileFromFragment(
      trimmedName,
      fragment,
    );
    void context.showInformationMessage(
      `Created profile "${profile.name}" from "${filename}".`,
    );
  } catch (err) {
    reportTransferError(context, 'Create profile failed', err);
  }
}

async function importSingleFragment(
  context: ProfileTransferCommandContext,
  fragment: ProfileFragment,
  filename: string,
): Promise<void> {
  try {
    const profile = await context.profileStore.importSingleProfile(
      fragment,
      filename,
    );
    void context.showInformationMessage(`Imported profile "${profile.name}".`);
  } catch (err) {
    reportTransferError(context, 'Import failed', err);
  }
}

async function importSidecar(
  context: ProfileTransferCommandContext,
  sidecar: NormalizedProfilesFile,
  filename: string,
): Promise<void> {
  const mode = await pickImportMode(context, filename);
  if (mode === undefined) {
    return;
  }

  if (mode === 'replace') {
    const confirmed = await context.showWarningMessageModal(
      `Replace all existing profiles with profiles from "${filename}"? This cannot be undone.`,
      'Replace',
    );
    if (confirmed !== 'Replace') {
      return;
    }
  }

  try {
    const result = await context.profileStore.importProfiles(
      sidecar,
      mode,
    );
    void context.showInformationMessage(
      `Imported ${result.added} profile${result.added === 1 ? '' : 's'} (${result.mode} mode).`,
    );
  } catch (err) {
    reportTransferError(context, 'Import failed', err);
  }
}

async function pickImportMode(
  context: ProfileTransferCommandContext,
  filename: string,
): Promise<'extend' | 'replace' | undefined> {
  const selected = await context.showQuickPick(
    [
      {
        label: 'Extend',
        description: 'Append imported profiles to the existing list',
        picked: true,
      },
      {
        label: 'Replace',
        description: 'Replace existing profiles with imported profiles',
      },
    ],
    { placeHolder: `Import "${filename}" as` },
  );

  if (selected === undefined) {
    return undefined;
  }
  if (selected.label === 'Extend') {
    return 'extend';
  }
  if (selected.label === 'Replace') {
    return 'replace';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function handleExportAllProfiles(
  context: ProfileTransferCommandContext,
): Promise<void> {
  const sidecar = context.profileStore.getProfilesFileSnapshot();

  const hasProviderOptions = sidecar.profiles.some((profile) =>
    context.containsProviderOptions({
      agents: profile.agents,
      categories: profile.categories,
    }),
  );

  if (hasProviderOptions) {
    const proceed = await context.showWarningMessage(
      'One or more profiles contain providerOptions. Export and continue?',
      'Export',
    );
    if (proceed !== 'Export') {
      return;
    }
  }

  const bytes = Buffer.from(
    context.serializeProfileTransfer(sidecar),
    'utf8',
  );
  const result = await context.saveTransferFile(bytes, {
    defaultUri: vscode.Uri.file('omo.profiles.json'),
    filters: {
      'JSON files': ['json'],
      'JSONC files': ['jsonc'],
      'All files': ['*'],
    },
  });

  if (result.status === 'cancelled') {
    return;
  }
  if (result.status === 'error') {
    void context.showErrorMessage(`Export failed: ${result.error.message}`);
    return;
  }

  void context.showInformationMessage(
    `Exported ${sidecar.profiles.length} profile${sidecar.profiles.length === 1 ? '' : 's'}.`,
  );
}

export async function handleExportProfile(
  context: ProfileTransferCommandContext,
  item: AgentModelTreeItem | undefined,
): Promise<void> {
  if (!isProfileItem(item)) {
    void context.showWarningMessage(
      'Select a profile in the Models view first.',
    );
    return;
  }

  const profileName = item.nodeName;
  const fragment = context.profileStore.getProfileFragment(profileName);

  if (context.containsProviderOptions(fragment)) {
    const proceed = await context.showWarningMessage(
      'This profile contains providerOptions. Export and continue?',
      'Export',
    );
    if (proceed !== 'Export') {
      return;
    }
  }

  const basename = `${context.sanitizeExportBasename(profileName)}.profile.json`;
  const bytes = Buffer.from(
    context.serializeProfileTransfer(fragment),
    'utf8',
  );
  const result = await context.saveTransferFile(bytes, {
    defaultUri: vscode.Uri.file(basename),
    filters: {
      'JSON files': ['json'],
      'JSONC files': ['jsonc'],
      'All files': ['*'],
    },
  });

  if (result.status === 'cancelled') {
    return;
  }
  if (result.status === 'error') {
    void context.showErrorMessage(`Export failed: ${result.error.message}`);
    return;
  }

  void context.showInformationMessage(`Exported profile "${profileName}".`);
}

// ---------------------------------------------------------------------------
// Edit JSON
// ---------------------------------------------------------------------------

export function handleEditProfileJson(
  context: ProfileTransferCommandContext,
  item: AgentModelTreeItem | undefined,
): void {
  if (!isProfileItem(item)) {
    void context.showWarningMessage(
      'Select a profile in the Models view first.',
    );
    return;
  }
  context.showProfileJson(item.nodeName);
}

export function handleEditActiveProfileJson(
  context: ProfileTransferCommandContext,
  item: AgentModelTreeItem | undefined,
): void {
  if (!isConfigFileItem(item)) {
    void context.showWarningMessage(
      'Select the active config file in the Models view first.',
    );
    return;
  }
  context.showProfileJson();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isProfileItem(
  item: AgentModelTreeItem | undefined,
): item is AgentModelTreeItem & { nodeName: string } {
  return (
    item !== undefined &&
    item.kind === 'profile' &&
    item.contextValue === 'profile' &&
    typeof item.nodeName === 'string' &&
    item.nodeName.length > 0
  );
}

function isConfigFileItem(
  item: AgentModelTreeItem | undefined,
): item is AgentModelTreeItem {
  return (
    item !== undefined &&
    item.kind === 'configFile' &&
    item.contextValue === 'configFile'
  );
}

function reportTransferError(
  context: ProfileTransferCommandContext,
  prefix: string,
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  void context.showErrorMessage(`${prefix}: ${message}`);
}
