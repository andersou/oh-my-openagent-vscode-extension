// Profile transfer command registration and dependency context. Handlers live
// in `profileTransferCommandHandlers.ts` so this module stays small and the
// command surface remains easy to test in isolation.

import * as vscode from 'vscode';
import type { ConfigStore } from './config/configStore.js';
import type { ProfileStore } from './config/profileStore.js';
import {
  containsProviderOptions,
  deriveProfileNameFromSource,
  parseConfigFragmentBytes,
  parseProfileTransferBytes,
  sanitizeExportBasename,
  serializeProfileTransfer,
  validateProfileTransfer,
} from './config/profileTransfer.js';
import { validateProfileFragment } from './config/profileValidation.js';
import { AgentEditorPanel } from './ui/agentEditorPanel.js';
import type { AgentModelTreeProvider, AgentModelTreeItem } from './ui/agentModelTreeProvider.js';
import type { ModelDiscovery } from './opencode/modelDiscovery.js';
import {
  openTransferFile,
  saveTransferFile,
} from './vscode/profileTransferFiles.js';
import {
  handleCreateProfileFromConfig,
  handleEditActiveProfileJson,
  handleEditProfileJson,
  handleExportAllProfiles,
  handleExportProfile,
  handleImportProfiles,
  type ProfileTransferCommandContext,
} from './profileTransferCommandHandlers.js';

export type { ProfileTransferCommandContext } from './profileTransferCommandHandlers.js';
export {
  handleCreateProfileFromConfig,
  handleEditActiveProfileJson,
  handleEditProfileJson,
  handleExportAllProfiles,
  handleExportProfile,
  handleImportProfiles,
};

/**
 * Build a context backed by the real VS Code API and the extension stores.
 * `commands.ts` passes this into `registerProfileTransferCommands(...)`.
 */
export function createProfileTransferCommandContext(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  profileStore: ProfileStore,
  modelDiscovery: ModelDiscovery,
  treeProvider: AgentModelTreeProvider,
): ProfileTransferCommandContext {
  return {
    configStore,
    profileStore,
    showProfileJson: (profileName?: string) => {
      AgentEditorPanel.showProfileJson(
        context,
        configStore,
        profileStore,
        modelDiscovery,
        treeProvider,
        profileName,
      );
    },
    openTransferFile,
    saveTransferFile,
    parseProfileTransferBytes,
    parseConfigFragmentBytes,
    validateProfileTransfer,
    validateProfileFragment,
    serializeProfileTransfer,
    containsProviderOptions,
    sanitizeExportBasename,
    deriveProfileNameFromSource,
    showInformationMessage: (message, ...items) =>
      vscode.window.showInformationMessage(message, ...items),
    showWarningMessage: (message, ...items) =>
      vscode.window.showWarningMessage(message, ...items),
    showWarningMessageModal: (message, ...items) =>
      vscode.window.showWarningMessage(
        message,
        { modal: true },
        ...items,
      ),
    showErrorMessage: (message, ...items) =>
      vscode.window.showErrorMessage(message, ...items),
    showQuickPick: (items, options) =>
      vscode.window.showQuickPick(items, options),
    showInputBox: (options) => vscode.window.showInputBox(options),
  };
}

/**
 * Register the six profile transfer command IDs and return a composite
 * disposable.
 */
export function registerProfileTransferCommands(
  context: ProfileTransferCommandContext,
): vscode.Disposable {
  const commands: vscode.Disposable[] = [
    vscode.commands.registerCommand('ohMyOpenAgent.importProfiles', () =>
      handleImportProfiles(context),
    ),
    vscode.commands.registerCommand('ohMyOpenAgent.exportAllProfiles', () =>
      handleExportAllProfiles(context),
    ),
    vscode.commands.registerCommand(
      'ohMyOpenAgent.exportProfile',
      (item: AgentModelTreeItem | undefined) =>
        handleExportProfile(context, item),
    ),
    vscode.commands.registerCommand(
      'ohMyOpenAgent.editProfileJson',
      (item: AgentModelTreeItem | undefined) =>
        handleEditProfileJson(context, item),
    ),
    vscode.commands.registerCommand(
      'ohMyOpenAgent.editActiveProfileJson',
      (item: AgentModelTreeItem | undefined) =>
        handleEditActiveProfileJson(context, item),
    ),
    vscode.commands.registerCommand(
      'ohMyOpenAgent.createProfileFromConfig',
      () => handleCreateProfileFromConfig(context),
    ),
  ];

  return vscode.Disposable.from(...commands);
}
