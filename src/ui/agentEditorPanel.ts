// Reusable VS Code webview panel for editing an agent or category model
// override. Loads the bundled `out/webview.js` (built by esbuild from
// `src/ui/webview/main.js`) inside inline-generated HTML, and communicates
// with the webview via `postMessage` / `onDidReceiveMessage`.
//
// Usage:
//   AgentEditorPanel.show(context, configStore, profileStore, {
//     type: 'agent', name: 'sisyphus',
//   });
//
// The panel is singleton-style: at most one editor is open at a time. When
// `show()` is invoked for a different item, the existing panel is reused
// and its content swapped rather than spawning a second one.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';

import type { ConfigStore } from '../config/configStore.js';
import type { ProfileStore } from '../config/profileStore.js';
import type { AgentConfig, CategoryConfig } from '../config/schema.js';
import { BUILTIN_AGENTS, BUILTIN_CATEGORIES } from '../config/schema.js';
import type { ModelDiscovery } from '../opencode/modelDiscovery.js';
import type { AgentModelTreeProvider } from './agentModelTreeProvider.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Identifies which entity the editor is showing. */
export type EditorItem =
  | { type: 'agent'; name: string; profile?: string }
  | { type: 'category'; name: string; profile?: string };

// ---------------------------------------------------------------------------
// Internal constants & helpers
// ---------------------------------------------------------------------------

/** Allow-list of editable fields for an agent override. */
export const AGENT_FIELDS: ReadonlySet<string> = new Set<keyof AgentConfig>([
  'model',
  'variant',
  'fallback_models',
  'temperature',
  'top_p',
  'maxTokens',
  'reasoningEffort',
  'thinking',
  'prompt',
  'prompt_append',
  'tools',
  'disable',
  'permission',
  'category',
  'mode',
  'color',
  'textVerbosity',
  'providerOptions',
]);

/** Allow-list of editable fields for a category override. */
export const CATEGORY_FIELDS: ReadonlySet<string> = new Set<keyof CategoryConfig>([
  'model',
  'variant',
  'fallback_models',
  'temperature',
  'top_p',
  'maxTokens',
  'reasoningEffort',
  'thinking',
  'textVerbosity',
  'tools',
  'prompt_append',
  'description',
  'is_unstable_agent',
  'disable',
  'max_prompt_tokens',
]);

/** Generate a fresh CSP nonce for this panel render. */
function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** Minimal HTML escape for interpolated strings. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate the save payload:
 *   - Must be a plain object (rejects arrays, null, primitives).
 *   - Reject any field not in the allow-list.
 *   - Treat `null` values as "remove" (omit from the cleaned result so
 *     the downstream diff produces a removal patch in jsonc-parser).
 *   - Clamp `temperature` to [0, 2] when numeric.
 */
export function validateAndClean<T extends object>(
  raw: unknown,
  allowedFields: ReadonlySet<string>,
): T {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Save payload must be an object');
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!allowedFields.has(key)) {
      throw new Error(`Unknown field: ${key}`);
    }
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) {
      // Null = remove the field from the override.
      continue;
    }
    if (key === 'temperature' && typeof value === 'number') {
      cleaned[key] = Math.max(0, Math.min(2, value));
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned as T;
}

/**
 * Collect which top-level keys in the raw payload are explicitly set to
 * `null`. These keys must be deleted from the existing config during a
 * merge-based save so that the user can clear a previously-set field.
 */
function getNullKeys(raw: unknown): Set<string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return new Set();
  }
  const nullKeys = new Set<string>();
  for (const [key, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (value === null) {
      nullKeys.add(key);
    }
  }
  return nullKeys;
}

// ---------------------------------------------------------------------------
// AgentEditorPanel
// ---------------------------------------------------------------------------

/**
 * Reusable webview panel for editing an agent or category model override.
 */
export class AgentEditorPanel implements vscode.Disposable {
  /** Currently-visible editor panel, or `undefined` when none is open. */
  public static currentPanel: AgentEditorPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _configStore: ConfigStore;
  private readonly _profileStore: ProfileStore;
  private readonly _modelDiscovery: ModelDiscovery;
  private readonly _treeProvider: AgentModelTreeProvider;
  private readonly _extensionPath: string;
  private _item: EditorItem;
  private readonly _disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    extensionPath: string,
    configStore: ConfigStore,
    profileStore: ProfileStore,
    modelDiscovery: ModelDiscovery,
    treeProvider: AgentModelTreeProvider,
    item: EditorItem,
  ) {
    this._panel = panel;
    this._extensionPath = extensionPath;
    this._configStore = configStore;
    this._profileStore = profileStore;
    this._modelDiscovery = modelDiscovery;
    this._treeProvider = treeProvider;
    this._item = item;

    this._panel.title = AgentEditorPanel._titleFor(item);
    this._panel.webview.html = this._renderHtml();

    this._panel.onDidDispose(
      () => this.dispose(),
      null,
      this._disposables,
    );
    this._panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        void this._handleMessage(message);
      },
      null,
      this._disposables,
    );
  }

  /**
   * Show (or reuse) the editor panel for the given agent or category. If
   * a panel is already open, its content is swapped to the new item and
   * it is revealed; otherwise a fresh panel is created.
   */
  public static show(
    context: vscode.ExtensionContext,
    configStore: ConfigStore,
    profileStore: ProfileStore,
    modelDiscovery: ModelDiscovery,
    treeProvider: AgentModelTreeProvider,
    item: EditorItem,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn;

    if (AgentEditorPanel.currentPanel) {
      const existing = AgentEditorPanel.currentPanel;
      existing._switchItem(item);
      existing._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'ohMyOpenAgent.agentEditor',
      AgentEditorPanel._titleFor(item),
      column ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.file(path.join(context.extensionPath, 'out')),
        ],
      },
    );

    const instance = new AgentEditorPanel(
      panel,
      context.extensionPath,
      configStore,
      profileStore,
      modelDiscovery,
      treeProvider,
      item,
    );
    AgentEditorPanel.currentPanel = instance;
    context.subscriptions.push(instance);
  }

  public dispose(): void {
    if (AgentEditorPanel.currentPanel === this) {
      AgentEditorPanel.currentPanel = undefined;
    }
    this._panel.dispose();
    while (this._disposables.length > 0) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private static _titleFor(item: EditorItem): string {
    const prefix = item.type === 'agent' ? 'Agent Model' : 'Category Model';
    const suffix = item.profile ? ` (profile: ${item.profile})` : '';
    return `${prefix}: ${item.name}${suffix}`;
  }

  /** Switch the panel to a different item and refresh the HTML. */
  private _switchItem(item: EditorItem): void {
    this._item = item;
    this._panel.title = AgentEditorPanel._titleFor(item);
    this._panel.webview.html = this._renderHtml();
  }

  private _renderHtml(): string {
    const webview = this._panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(path.join(this._extensionPath, 'out', 'webview.js')),
    );
    const nonce = generateNonce();
    const cspSource = webview.cspSource;

    const templatePath = path.join(
      this._extensionPath,
      'src',
      'ui',
      'webview',
      'webview.html',
    );
    const cssPath = path.join(
      this._extensionPath,
      'src',
      'ui',
      'webview',
      'webview.css',
    );
    const template = fs.readFileSync(templatePath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');

    return template
      .replaceAll('{{nonce}}', nonce)
      .replaceAll('{{cspSource}}', cspSource)
      .replaceAll('{{webviewJsUri}}', scriptUri.toString())
      .replaceAll('{{webviewCss}}', css);
  }

  private _sendInit(): void {
    const item = this._item;
    const profile = item.profile
      ? this._profileStore.getProfile(item.profile)
      : undefined;
    const current = item.profile
      ? item.type === 'agent'
        ? profile?.agents?.[item.name]
        : profile?.categories?.[item.name]
      : item.type === 'agent'
        ? this._configStore.getAgent(item.name)
        : this._configStore.getCategory(item.name);

    this._panel.webview.postMessage({
      command: 'init',
      type: item.type,
      name: item.name,
      config: current ?? null,
      builtinAgents: [...BUILTIN_AGENTS],
      builtinCategories: [...BUILTIN_CATEGORIES],
    });
  }

  private _startModelDiscovery(forceRefresh = false): void {
    this._panel.webview.postMessage({ command: 'modelsLoading' });

    void (async () => {
      try {
        const idsResult = await this._modelDiscovery.discoverModels({
          verbose: false,
          forceRefresh,
        });
        if (this._panel.webview === undefined) return;
        if (idsResult.source === 'fallback') {
          this._panel.webview.postMessage({
            command: 'modelsUnavailable',
            error: idsResult.error,
          });
          return;
        }
        this._panel.webview.postMessage({
          command: 'modelsLoaded',
          models: idsResult.models.map((m) => ({ modelId: m.modelId })),
        });

        void this._loadCapabilitiesInBackground(forceRefresh);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          this._panel.webview.postMessage({
            command: 'modelsUnavailable',
            error: message,
          });
        } catch {
          // panel disposed mid-flight
        }
      }
    })();
  }

  private async _loadCapabilitiesInBackground(forceRefresh: boolean): Promise<void> {
    try {
      const verboseResult = await this._modelDiscovery.discoverModels({
        verbose: true,
        forceRefresh,
      });
      if (this._panel.webview === undefined) return;
      if (verboseResult.source === 'fallback') {
        return;
      }
      this._panel.webview.postMessage({
        command: 'modelsLoaded',
        models: verboseResult.models,
      });
    } catch {
      // best-effort
    }
  }

  private async _handleMessage(message: unknown): Promise<void> {
    if (
      typeof message !== 'object' ||
      message === null ||
      Array.isArray(message)
    ) {
      return;
    }
    const msg = message as { command?: unknown };
    const command = msg.command;

    if (command === 'ready') {
      this._sendInit();
      this._startModelDiscovery();
      return;
    }
    if (command === 'save') {
      const payload = (msg as { payload?: unknown }).payload;
      await this._handleSave(payload);
      return;
    }
    if (command === 'createProfile') {
      await this._handleCreateProfile();
      return;
    }
    if (command === 'reloadModels') {
      this._startModelDiscovery(true);
      return;
    }
    // Unknown command: ignore silently.
  }

  private async _handleSave(rawPayload: unknown): Promise<void> {
    const item = this._item;
    try {
      const nullKeys = getNullKeys(rawPayload);

      if (item.type === 'agent') {
        const validated = validateAndClean<AgentConfig>(
          rawPayload,
          AGENT_FIELDS,
        );
        const agentName = item.name;
        if (item.profile) {
          await this._profileStore.updateProfileEntry(
            item.profile,
            'agents',
            agentName,
            validated,
            nullKeys,
          );
        } else {
          await this._configStore.updateConfig((draft) => {
            if (!draft.agents) {
              draft.agents = {};
            }
            const existing = draft.agents[agentName] ?? {};
            draft.agents[agentName] = { ...existing, ...validated };
            for (const key of nullKeys) {
              delete (draft.agents[agentName] as Record<string, unknown>)[key];
            }
          });
        }
      } else {
        const validated = validateAndClean<CategoryConfig>(
          rawPayload,
          CATEGORY_FIELDS,
        );
        const categoryName = item.name;
        if (item.profile) {
          await this._profileStore.updateProfileEntry(
            item.profile,
            'categories',
            categoryName,
            validated,
            nullKeys,
          );
        } else {
          await this._configStore.updateConfig((draft) => {
            if (!draft.categories) {
              draft.categories = {};
            }
            const existing = draft.categories[categoryName] ?? {};
            draft.categories[categoryName] = { ...existing, ...validated };
            for (const key of nullKeys) {
              delete (draft.categories[categoryName] as Record<string, unknown>)[
                key
              ];
            }
          });
        }
      }

      this._panel.webview.postMessage({ command: 'saved' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Save failed';
      this._panel.webview.postMessage({
        command: 'error',
        message,
      });
    }
  }

  private async _handleCreateProfile(): Promise<void> {
    const item = this._item;
    const defaultName =
      item.type === 'agent'
        ? `agent-${item.name}`
        : `category-${item.name}`;

    const name = await vscode.window.showInputBox({
      prompt: 'Name for the new profile',
      value: defaultName,
      validateInput: (v) =>
        v.trim().length > 0 ? null : 'Profile name cannot be empty',
    });
    if (name === undefined) {
      return; // user cancelled
    }

    const description = await vscode.window.showInputBox({
      prompt: 'Optional description for the new profile',
      placeHolder: 'Leave empty to skip',
    });

    try {
      const profile = await this._profileStore.createProfile(
        name.trim(),
        description && description.trim().length > 0
          ? description.trim()
          : undefined,
      );
      this._panel.webview.postMessage({
        command: 'profileCreated',
        name: profile.name,
      });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to create profile';
      this._panel.webview.postMessage({
        command: 'error',
        message,
      });
    }
  }
}
