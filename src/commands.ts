// Command handlers for the 11 Oh My OpenAgent VS Code commands declared in
// `package.json`. All wiring lives here so `extension.ts` stays a thin
// activation shim: it instantiates the stores + tree provider, calls
// `registerCommands(...)`, and pushes the returned `Disposable` into
// `context.subscriptions`.
//
// The factory takes the live `vscode.ExtensionContext` plus the three
// collaborators (config store, profile store, tree provider) and returns a
// composite `Disposable`. Each `vscode.commands.registerCommand` returns its
// own disposable; we collect them and combine via `Disposable.from(...)`.
//
// Tree-item argument conventions
// --------------------------------
// Many of these commands are wired through the `view/item/context` menu in
// `package.json`, so VS Code passes the selected `AgentModelTreeItem` as the
// first argument. We accept `AgentModelTreeItem | undefined` so the same
// handlers can also be invoked from the command palette or a keybinding
// without breaking. The local `is*` type guards narrow the optional argument
// to a `nodeName`-bearing item and reject anything else with a user-visible
// warning.

import * as vscode from 'vscode';

import type { ConfigStore } from './config/configStore.js';
import type { ProfileStore } from './config/profileStore.js';
import { AgentEditorPanel } from './ui/agentEditorPanel.js';
import type {
  AgentModelTreeItem,
  AgentModelTreeProvider,
} from './ui/agentModelTreeProvider.js';
import type { ModelDiscovery } from './opencode/modelDiscovery.js';
import { CONFIG_SCOPES, type ConfigScope } from './config/schema.js';
import {
  createProfileTransferCommandContext,
  registerProfileTransferCommands,
} from './profileTransferCommands.js';

const REMOVE_HARNESS_BLOCKS = 'Remove Harness Blocks';
const COPY_BASE_TO_HARNESS_BLOCKS = 'Copy Global to All Harnesses';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register all 17 commands declared in `package.json` and return a single
 * `Disposable` that unregisters them all. The activation code pushes the
 * returned value into `context.subscriptions`.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  profileStore: ProfileStore,
  treeProvider: AgentModelTreeProvider,
  modelDiscovery: ModelDiscovery,
): vscode.Disposable {
  const commands: vscode.Disposable[] = [
    // 1. Open the sidebar models view.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.openAgentManager',
      () => {
        // Reveals the activity bar container AND focuses the inner view.
        // `<viewId>.focus` is the canonical VS Code-generated command for any
        // registered tree view.
        void vscode.commands.executeCommand('ohMyOpenAgent.models.focus');
      },
    ),

    // 2. Open the editor webview for an agent leaf.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.editAgent',
      (item: AgentModelTreeItem | undefined) => {
        if (!isAgentLikeItem(item)) {
          void vscode.window.showWarningMessage(
            'Select an agent in the Models view first.',
          );
          return;
        }
        AgentEditorPanel.show(
          context,
          configStore,
          profileStore,
          modelDiscovery,
          treeProvider,
          item.profileName === undefined
            ? { type: 'agent', name: item.nodeName }
            : { type: 'agent', name: item.nodeName, profile: item.profileName },
        );
      },
    ),

    // 3. Open the editor webview for a category leaf.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.editCategory',
      (item: AgentModelTreeItem | undefined) => {
        if (!isCategoryLikeItem(item)) {
          void vscode.window.showWarningMessage(
            'Select a category in the Models view first.',
          );
          return;
        }
        AgentEditorPanel.show(
          context,
          configStore,
          profileStore,
          modelDiscovery,
          treeProvider,
          item.profileName === undefined
            ? { type: 'category', name: item.nodeName }
            : { type: 'category', name: item.nodeName, profile: item.profileName },
        );
      },
    ),

    // 4. Force the tree to re-query its data provider from disk.
    vscode.commands.registerCommand('ohMyOpenAgent.refresh', () => {
      configStore.refreshFromDisk();
      treeProvider.refresh();
    }),

    // 5. Select the active config scope.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.selectConfigScope',
      async () => {
        const currentScope = configStore.getScope();
        const items = CONFIG_SCOPES.map((scope) => ({
          label: scope,
          picked: scope === currentScope,
          description: scope === currentScope ? 'Current' : undefined,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select the active config scope',
        });
        if (picked === undefined) {
          return; // user cancelled
        }
        const scope = picked.label as ConfigScope;
        if (scope === currentScope) {
          return;
        }
        if (
          scope === 'global' &&
          !(await reconcileForGlobalScope(configStore))
        ) {
          return;
        }
        try {
          await profileStore.setConfigScope(scope);
          configStore.setScope(scope);
          AgentEditorPanel.closeCurrentPanel();
          void vscode.window.showInformationMessage(
            `The config scope changed to "${scope}". The agent editor was closed to avoid stale edits.`,
          );
        } catch (err) {
          reportError('Failed to set config scope', err);
        }
      },
    ),

    // 6. Create a new profile by snapshotting the current config.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.createProfile',
      async () => {
        const name = await vscode.window.showInputBox({
          prompt: 'Name for the new profile',
          placeHolder: 'e.g. fast, careful, default',
          validateInput: (v) =>
            v.trim().length > 0
              ? null
              : 'Profile name cannot be empty',
        });
        if (name === undefined) {
          return; // user cancelled
        }
        const trimmedName = name.trim();

        const description = await vscode.window.showInputBox({
          prompt: 'Optional description for the new profile',
          placeHolder: 'Leave empty to skip',
        });

        try {
          await profileStore.createProfile(
            trimmedName,
            description && description.trim().length > 0
              ? description.trim()
              : undefined,
          );
        } catch (err) {
          reportError('Failed to create profile', err);
        }
      },
    ),

    // 7. Activate a saved profile.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.activateProfile',
      async (item: AgentModelTreeItem | undefined) => {
        if (!isProfileItem(item)) {
          void vscode.window.showWarningMessage(
            'Select a profile in the Models view first.',
          );
          return;
        }
        try {
          await profileStore.activateProfile(item.nodeName);
        } catch (err) {
          reportError('Failed to activate profile', err);
        }
      },
    ),

    // 8. Rename a saved profile.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.renameProfile',
      async (item: AgentModelTreeItem | undefined) => {
        if (!isProfileItem(item)) {
          void vscode.window.showWarningMessage(
            'Select a profile in the Models view first.',
          );
          return;
        }
        const oldName = item.nodeName;
        const newName = await vscode.window.showInputBox({
          prompt: `Rename profile "${oldName}" to`,
          value: oldName,
          validateInput: (v) =>
            v.trim().length > 0
              ? null
              : 'Profile name cannot be empty',
        });
        if (newName === undefined) {
          return;
        }
        const trimmed = newName.trim();
        if (trimmed === oldName) {
          return; // no-op
        }
        try {
          await profileStore.renameProfile(oldName, trimmed);
        } catch (err) {
          reportError('Failed to rename profile', err);
        }
      },
    ),

    // 9. Duplicate a saved profile under a new name.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.duplicateProfile',
      async (item: AgentModelTreeItem | undefined) => {
        if (!isProfileItem(item)) {
          void vscode.window.showWarningMessage(
            'Select a profile in the Models view first.',
          );
          return;
        }
        const oldName = item.nodeName;
        const newName = await vscode.window.showInputBox({
          prompt: `Name for the copy of "${oldName}"`,
          value: `${oldName}-copy`,
          validateInput: (v) =>
            v.trim().length > 0
              ? null
              : 'Profile name cannot be empty',
        });
        if (newName === undefined) {
          return;
        }
        const trimmed = newName.trim();
        try {
          await profileStore.duplicateProfile(oldName, trimmed);
        } catch (err) {
          reportError('Failed to duplicate profile', err);
        }
      },
    ),

    // 10. Delete a saved profile (with a modal confirmation).
    vscode.commands.registerCommand(
      'ohMyOpenAgent.deleteProfile',
      async (item: AgentModelTreeItem | undefined) => {
        if (!isProfileItem(item)) {
          void vscode.window.showWarningMessage(
            'Select a profile in the Models view first.',
          );
          return;
        }
        const name = item.nodeName;
        const confirm = await vscode.window.showWarningMessage(
          `Delete profile "${name}"? This cannot be undone.`,
          { modal: true },
          'Delete',
        );
        if (confirm !== 'Delete') {
          return; // user cancelled or hit Escape
        }
        try {
          await profileStore.deleteProfile(name);
        } catch (err) {
          reportError('Failed to delete profile', err);
        }
      },
    ),

  // 11. Snapshot the live config back into the active profile.
  vscode.commands.registerCommand(
    'ohMyOpenAgent.saveActiveProfile',
    async () => {
      const active = profileStore.getActiveProfileName();
      if (active === undefined) {
        void vscode.window.showWarningMessage(
          'No active profile to save into. Activate a profile first.',
        );
        return;
      }
      try {
        await profileStore.saveActiveConfigToProfile();
        void vscode.window.showInformationMessage(
          `Profile "${active}" updated from the active config.`,
        );
      } catch (err) {
        reportError('Failed to save active profile', err);
      }
    },
  ),
];

const profileTransferCommands = registerProfileTransferCommands(
  createProfileTransferCommandContext(context, configStore, profileStore, modelDiscovery, treeProvider),
);

return vscode.Disposable.from(...commands, profileTransferCommands);
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * An agent leaf — either a bare built-in (`kind === 'agent'`) or an overridden
 * one (`kind === 'override'`, `group === 'agents'`). Both carry the agent
 * name in `nodeName`, which the editor panel needs.
 */
function isAgentLikeItem(
  item: AgentModelTreeItem | undefined,
): item is AgentModelTreeItem & { nodeName: string } {
  return (
    item !== undefined &&
    item.group === 'agents' &&
    (item.kind === 'agent' || item.kind === 'override') &&
    typeof item.nodeName === 'string' &&
    item.nodeName.length > 0
  );
}

/** A category leaf — analogous to {@link isAgentLikeItem} for the categories group. */
function isCategoryLikeItem(
  item: AgentModelTreeItem | undefined,
): item is AgentModelTreeItem & { nodeName: string } {
  return (
    item !== undefined &&
    item.group === 'categories' &&
    (item.kind === 'category' || item.kind === 'override') &&
    typeof item.nodeName === 'string' &&
    item.nodeName.length > 0
  );
}

/** A profile leaf. */
function isProfileItem(
  item: AgentModelTreeItem | undefined,
): item is AgentModelTreeItem & { nodeName: string } {
  return (
    item !== undefined &&
    item.kind === 'profile' &&
    typeof item.nodeName === 'string' &&
    item.nodeName.length > 0
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Show a single-line error notification; never throw. */
function reportError(prefix: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  void vscode.window.showErrorMessage(`${prefix}: ${message}`);
}

/**
 * Bring `omo.jsonc` in line with a switch to the `global` scope and report
 * whether the switch may continue. Harness blocks win over the shared base,
 * so any block that defines `agents` or `categories` would swallow every
 * global edit; the user picks which of the two fixes to apply.
 */
async function reconcileForGlobalScope(
  configStore: ConfigStore,
): Promise<boolean> {
  const shadowing = configStore.getShadowingHarnessScopes();
  if (shadowing.length === 0) {
    return true;
  }

  const blocks = shadowing.map((scope) => `[${scope}]`).join(', ');
  const choice = await vscode.window.showWarningMessage(
    `Harness blocks take precedence over the shared base: ${blocks}. Edits made in the "global" scope would have no effect there. Removing deletes every harness block; copying replaces each block's agents and categories with the shared base's.`,
    { modal: true },
    REMOVE_HARNESS_BLOCKS,
    COPY_BASE_TO_HARNESS_BLOCKS,
  );
  if (choice === undefined) {
    return false;
  }

  try {
    if (choice === REMOVE_HARNESS_BLOCKS) {
      await configStore.removeHarnessBlocks();
    } else {
      await configStore.copyBaseToHarnessBlocks();
    }
  } catch (err) {
    reportError('Failed to update omo.jsonc for the global scope', err);
    return false;
  }
  return true;
}
