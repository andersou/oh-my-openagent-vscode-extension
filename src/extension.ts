// Activation entry point. Wires up the config / profile stores, the sidebar
// tree view, the editor webview command surface, and pushes every disposable
// into `context.subscriptions` so VS Code cleans up on deactivation.
//
// Layout:
//   1. Create `ConfigStore` (reads / writes the active OmO config file).
//   2. Create `ProfileStore` (sidecar file holding named snapshots).
//   3. Create the `AgentModelTreeProvider`, wire it to the live stores.
//   4. Start `configStore.startWatch()` so external edits to the config file
//      trigger a tree refresh (debounced inside ConfigStore).
//   5. Create the `vscode.TreeView` and bind it back to the provider so
//      `reveal()` works inside command handlers.
//   6. Register the 12 commands declared in `package.json` via
//      `registerCommands()`.
//   7. Push every disposable onto `context.subscriptions`. VS Code disposes
//      them in reverse order on deactivation, which closes the tree view,
//      unregisters the commands, detaches the store listeners, and stops
//      the file watcher.

import * as vscode from 'vscode';

import { ConfigStore } from './config/configStore.js';
import { ProfileStore } from './config/profileStore.js';
import { registerCommands } from './commands.js';
import { AgentModelTreeProvider } from './ui/agentModelTreeProvider.js';

export function activate(context: vscode.ExtensionContext): void {
  // ---- Stores ----
  const configStore = new ConfigStore();
  const profileStore = new ProfileStore(configStore);

  // ---- Tree provider ----
  // The provider subscribes to both stores' `change` events and re-fires
  // its `onDidChangeTreeData` so VS Code re-queries `getChildren()`.
  const treeProvider = new AgentModelTreeProvider(configStore, profileStore);

  // ---- File watcher ----
  // Start watching the resolved config file. Debounced 150ms inside
  // ConfigStore, with a `suppressWatch` flag that ignores self-triggered
  // events from our own atomic writes.
  configStore.startWatch();

  // ---- Tree view ----
  // `ohMyOpenAgent.models` is the view id declared in `package.json`
  // `contributes.views`. The provider was constructed above.
  const treeView = vscode.window.createTreeView('ohMyOpenAgent.models', {
    treeDataProvider: treeProvider,
  });
  // `setView` binds the live `TreeView` to the provider so `reveal()` inside
  // command handlers (e.g. `openAgentManager`) can delegate to it.
  treeProvider.setView(treeView);

  // ---- Commands ----
  const commandsDisposable = registerCommands(
    context,
    configStore,
    profileStore,
    treeProvider,
  );

  // ---- Dispose order ----
  // Pushing to `context.subscriptions` lets VS Code dispose in LIFO order
  // on deactivation. We order them so listeners come off before resources
  // they observe are torn down (though all of these are idempotent and
  // order is not strictly required — it's the safe default).
  //
  // `profileStore` is intentionally NOT pushed: it owns no listeners,
  // timers, or file handles, and has no `dispose()` method. Its only
  // mutable state is the `EventEmitter` referenced by the tree provider
  // and `commands.ts`; both hold short-lived references, and the GC
  // reclaims the emitter when those references are released.
  context.subscriptions.push(
    commandsDisposable,
    treeView,
    treeProvider,
    configStore,
  );
}

export function deactivate(): void {
  // No explicit teardown needed: every resource is registered with
  // `context.subscriptions` and VS Code disposes them in LIFO order on
  // extension deactivation. This stub is kept so the manifest's optional
  // `extensionUnloaded` hook has a target if future work needs one.
}
