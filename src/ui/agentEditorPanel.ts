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
// and its content is swapped rather than spawning a second one.

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
import { validateAndClean } from './editorPayloadValidation.js';
import { serializeProfileTransfer } from '../config/profileTransferSerialization.js';
import {
  getProfileJsonInitText,
  parseProfileJsonTarget,
  profileJsonTargetMatches,
  saveProfileJson,
  type ProfileJsonTarget,
} from './profileJsonEditorHost.js';

export { validateAndClean } from './editorPayloadValidation.js';
export type { ProfileJsonTarget } from './profileJsonEditorHost.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Identifies which entity the editor is showing. */
export type EditorItem =
  | { type: 'agent'; name: string; profile?: string }
  | { type: 'category'; name: string; profile?: string }
  | ProfileJsonTarget;

type VersionedTarget =
  | { v: 1; type: 'agent'; name: string; profile: string | null }
  | { v: 1; type: 'category'; name: string; profile: string | null }
  | { v: 1; type: 'profileJson'; source: 'active' | 'saved'; profile: string | null };

// ---------------------------------------------------------------------------
// Internal constants & helpers
// ---------------------------------------------------------------------------

/** Allow-list of editable fields for an agent override. */
export const AGENT_FIELDS: ReadonlySet<string> = new Set<keyof AgentConfig>([
  'model',
  'variant',
  'fallback_models',
  'main_overrides',
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
  'main_overrides',
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

function versionedTargetFor(item: EditorItem): VersionedTarget {
  if (item.type === 'profileJson') {
    return {
      v: 1,
      type: 'profileJson',
      source: item.source,
      profile: item.source === 'saved' ? item.profile : null,
    };
  }
  return {
    v: 1,
    type: item.type,
    name: item.name,
    profile: item.profile ?? null,
  };
}

function parseAgentCategoryTarget(raw: unknown): VersionedTarget | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const target = raw as {
    type?: unknown;
    name?: unknown;
    profile?: unknown;
  };
  if (
    (target.type !== 'agent' && target.type !== 'category') ||
    typeof target.name !== 'string' ||
    (target.profile !== undefined && target.profile !== null && typeof target.profile !== 'string')
  ) {
    return undefined;
  }
  return {
    v: 1,
    type: target.type,
    name: target.name,
    profile: target.profile ?? null,
  };
}

function sameVersionedTarget(left: VersionedTarget, right: VersionedTarget): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'profileJson') {
    return (
      left.source === (right as { source: 'active' | 'saved' }).source &&
      left.profile === (right as { profile: string | null }).profile
    );
  }
  return (
    left.name === (right as { name: string }).name &&
    left.profile === (right as { profile: string | null }).profile
  );
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
  private _versionedTarget: VersionedTarget;
  private readonly _dirtyStates = new Map<string, boolean>();
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
    this._versionedTarget = versionedTargetFor(item);

    this._updateTitle();
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

  /**
   * Open a read-only JSON editor for a saved profile (when `profileName` is
   * given) or the active config's profile fragment (when omitted). This is the
   * host-side contract the transfer commands use; Todo 10 may replace the text
   * editor implementation with a dedicated webview panel without changing the
   * command handlers.
   */
  public static showProfileJson(
    configStore: ConfigStore,
    profileStore: ProfileStore,
    profileName?: string,
  ): void {
    const fragment =
      profileName !== undefined
        ? profileStore.getProfileFragment(profileName)
        : {
            agents: configStore.getConfig().agents,
            categories: configStore.getConfig().categories,
          };

    const content = serializeProfileTransfer(fragment);
    const title = profileName
      ? `${profileName}.profile.json`
      : 'active-config.profile.json';

    void (async () => {
      try {
        const document = await vscode.workspace.openTextDocument({
          content,
          language: 'json',
        });
        await vscode.window.showTextDocument(document, { preview: false });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          `Failed to open profile JSON: ${message}`,
        );
      }
    })();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private _getIsDirty(): boolean {
    return this._dirtyStates.get(this._targetKey) ?? false;
  }

  private _setDirty(dirty: boolean): void {
    this._dirtyStates.set(this._targetKey, dirty);
    this._updateTitle();
  }

  private get _targetKey(): string {
    return JSON.stringify(this._versionedTarget);
  }

  private static _titleFor(item: EditorItem): string {
    if (item.type === 'profileJson') {
      return item.source === 'active'
        ? 'Profile JSON: active config'
        : `Profile JSON: ${item.profile}`;
    }
    const prefix = item.type === 'agent' ? 'Agent Model' : 'Category Model';
    const suffix = item.profile ? ` (profile: ${item.profile})` : '';
    return `${prefix}: ${item.name}${suffix}`;
  }

  private _updateTitle(): void {
    const baseTitle = AgentEditorPanel._titleFor(this._item);
    this._panel.title = this._getIsDirty() ? `● ${baseTitle} (unsaved)` : baseTitle;
  }

  private _matchesCurrentTarget(rawTarget: unknown): boolean {
    const parsed = parseAgentCategoryTarget(rawTarget);
    return parsed !== undefined && sameVersionedTarget(parsed, this._versionedTarget);
  }

  private _matchesCurrentProfileJsonTarget(rawTarget: unknown): boolean {
    const parsed = parseProfileJsonTarget(rawTarget);
    return (
      parsed !== undefined &&
      this._item.type === 'profileJson' &&
      profileJsonTargetMatches(parsed, this._item)
    );
  }

  /** Switch the panel to a different item and refresh the HTML. */
  private _switchItem(item: EditorItem): void {
    this._item = item;
    this._versionedTarget = versionedTargetFor(item);
    this._dirtyStates.set(this._targetKey, false);
    this._updateTitle();
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
    if (item.type === 'profileJson') {
      const text = getProfileJsonInitText(item, this._profileStore, this._configStore);
      this._panel.webview.postMessage({
        command: 'init',
        type: 'profileJson',
        source: item.source,
        profile: item.source === 'saved' ? item.profile : null,
        text,
      });
      return;
    }
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
      profile: item.profile ?? null,
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
      if (this._item.type !== 'profileJson') {
        this._startModelDiscovery();
      }
      return;
    }
    if (command === 'save') {
      const payload = (msg as { payload?: unknown }).payload;
      const target = (msg as { target?: unknown }).target;
      if (this._item.type === 'profileJson') {
        if (!this._matchesCurrentProfileJsonTarget(target)) {
          return;
        }
        const item = this._item;
        await this._handleProfileJsonSave(item, payload, target);
        return;
      }
      if (!this._matchesCurrentTarget(target)) {
        return;
      }
      await this._handleSave(payload, parseAgentCategoryTarget(target));
      return;
    }
    if (command === 'dirtyState') {
      const dirty = (msg as { dirty?: unknown }).dirty;
      const target = (msg as { target?: unknown }).target;
      if (typeof dirty !== 'boolean') {
        return;
      }
      if (this._item.type === 'profileJson') {
        if (this._matchesCurrentProfileJsonTarget(target)) {
          this._setDirty(dirty);
        }
      } else if (this._matchesCurrentTarget(target)) {
        this._setDirty(dirty);
      }
      return;
    }
    if (command === 'reloadModels') {
      this._startModelDiscovery(true);
      return;
    }
    // Unknown command: ignore silently.
  }

  private async _handleProfileJsonSave(
    item: ProfileJsonTarget,
    rawPayload: unknown,
    rawTarget: unknown,
  ): Promise<void> {
    const text =
      typeof rawPayload === 'string'
        ? rawPayload
        : typeof rawPayload === 'object' && rawPayload !== null
          ? (rawPayload as { text?: unknown }).text
          : undefined;
    if (typeof text !== 'string') {
      this._panel.webview.postMessage({
        command: 'error',
        message: 'Expected text payload',
        target: rawTarget,
      });
      return;
    }

    const result = await saveProfileJson(
      item,
      text,
      this._profileStore,
      this._configStore,
    );
    if (!result.ok) {
      this._panel.webview.postMessage({
        command: 'error',
        message: result.message,
        target: rawTarget,
      });
      return;
    }

    this._setDirty(false);
    this._panel.webview.postMessage({
      command: 'saved',
      target: rawTarget,
      text: result.canonicalText,
    });
  }

  private async _handleSave(
    rawPayload: unknown,
    target: VersionedTarget | undefined,
  ): Promise<void> {
    if (target === undefined || target.type === 'profileJson') {
      return;
    }
    const item: Exclude<EditorItem, ProfileJsonTarget> = {
      type: target.type,
      name: target.name,
      ...(target.profile === null ? {} : { profile: target.profile }),
    };
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
          if (this._profileStore.getActiveProfileName() === item.profile) {
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
            await this._profileStore.saveActiveConfigToProfile();
          }
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
          if (this._profileStore.getActiveProfileName() === item.profile) {
            await this._configStore.updateConfig((draft) => {
              if (!draft.categories) {
                draft.categories = {};
              }
              const existing = draft.categories[categoryName] ?? {};
              draft.categories[categoryName] = { ...existing, ...validated };
              for (const key of nullKeys) {
                delete (draft.categories[categoryName] as Record<string, unknown>)[key];
              }
            });
            await this._profileStore.saveActiveConfigToProfile();
          }
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

      if (sameVersionedTarget(target, this._versionedTarget)) {
        this._setDirty(false);
      }
      this._panel.webview.postMessage({ command: 'saved', target });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Save failed';
      this._panel.webview.postMessage({
        command: 'error',
        message,
        target,
      });
    }
  }
}
