// Command handlers for the 12 Oh My OpenAgent VS Code commands declared in
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register all 12 commands declared in `package.json` and return a single
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
        AgentEditorPanel.show(context, configStore, profileStore, modelDiscovery, {
          type: 'agent',
          name: item.nodeName,
        });
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
        AgentEditorPanel.show(context, configStore, profileStore, modelDiscovery, {
          type: 'category',
          name: item.nodeName,
        });
      },
    ),

    // 4. Force the tree to re-query its data provider.
    vscode.commands.registerCommand('ohMyOpenAgent.refresh', () => {
      treeProvider.refresh();
    }),

    // 5. Create an empty override entry for a built-in agent.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.addAgentOverride',
      async (item: AgentModelTreeItem | undefined) => {
        if (!isAgentLikeItem(item)) {
          void vscode.window.showWarningMessage(
            'Select an agent in the Models view first.',
          );
          return;
        }
        const name = item.nodeName;
        try {
          await configStore.updateConfig((draft) => {
            if (!draft.agents) {
              draft.agents = {};
            }
            if (draft.agents[name] === undefined) {
              draft.agents[name] = {};
            }
          });
        } catch (err) {
          reportError('Failed to add agent override', err);
        }
      },
    ),

    // 6. Create an empty override entry for a built-in category.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.addCategoryOverride',
      async (item: AgentModelTreeItem | undefined) => {
        if (!isCategoryLikeItem(item)) {
          void vscode.window.showWarningMessage(
            'Select a category in the Models view first.',
          );
          return;
        }
        const name = item.nodeName;
        try {
          await configStore.updateConfig((draft) => {
            if (!draft.categories) {
              draft.categories = {};
            }
            if (draft.categories[name] === undefined) {
              draft.categories[name] = {};
            }
          });
        } catch (err) {
          reportError('Failed to add category override', err);
        }
      },
    ),

    // 7. Delete the override key for an agent or category.
    vscode.commands.registerCommand(
      'ohMyOpenAgent.removeOverride',
      async (item: AgentModelTreeItem | undefined) => {
        if (!isOverrideItem(item)) {
          void vscode.window.showWarningMessage(
            'Select an overridden agent or category first.',
          );
          return;
        }
        const name = item.nodeName;
        const group = item.group;
        try {
          await configStore.updateConfig((draft) => {
            if (group === 'agents' && draft.agents) {
              delete draft.agents[name];
            } else if (group === 'categories' && draft.categories) {
              delete draft.categories[name];
            }
          });
        } catch (err) {
          reportError('Failed to remove override', err);
        }
      },
    ),

    // 8. Create a new profile by snapshotting the current config.
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

    // 9. Activate a saved profile.
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

    // 10. Rename a saved profile.
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

    // 11. Duplicate a saved profile under a new name.
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

    // 12. Delete a saved profile (with a modal confirmation).
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
  ];

  return vscode.Disposable.from(...commands);
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

/**
 * An override leaf — `kind === 'override'`, but we also re-check the group
 * because the override kind is shared between the agents and categories
 * groups. The group tells us which map (`agents` vs `categories`) to delete
 * the key from.
 */
function isOverrideItem(
  item: AgentModelTreeItem | undefined,
): item is AgentModelTreeItem & { nodeName: string } {
  return (
    item !== undefined &&
    item.kind === 'override' &&
    (item.group === 'agents' || item.group === 'categories') &&
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
