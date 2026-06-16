import * as vscode from 'vscode';
import { ConfigStore } from '../config/configStore.js';
import { ProfileStore } from '../config/profileStore.js';
import {
  BUILTIN_AGENTS,
  BUILTIN_CATEGORIES,
} from '../config/schema.js';
import type { AgentConfig, CategoryConfig, FallbackModels } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Item shape
// ---------------------------------------------------------------------------

/** Logical top-level group a leaf belongs to. */
export type AgentModelGroupKind = 'agents' | 'categories' | 'profiles';

/** Discriminator for every tree item this provider can produce. */
export type AgentModelItemKind =
  | 'group'
  | 'agent'
  | 'category'
  | 'override'
  | 'profile';

/**
 * Extends `vscode.TreeItem` with a `kind` discriminator, the top-level
 * group, and a `nodeName` for leaves. `nodeName` is the agent / category /
 * profile key — the built-in `TreeItem.name` field is not available on
 * `@types/vscode@1.85`, so we expose our own. The same value is also
 * written to `TreeItem.id` so VS Code preserves selection / expansion
 * state across refreshes.
 */
export interface AgentModelTreeItem extends vscode.TreeItem {
  /** Discriminator for the kind of tree item. */
  kind: AgentModelItemKind;
  /** Top-level group this item belongs to. Undefined for the root call. */
  group?: AgentModelGroupKind;
  /** Stable identifier for the underlying config / profile entry. */
  nodeName?: string;
}

/** Transient preview of a model override shown before the user saves. */
interface ModelPreview {
  model: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Tree data provider for the Oh My OpenAgent sidebar (`ohMyOpenAgent.models`).
 *
 * Exposes three collapsible groups — Agents, Categories, Profiles — whose
 * leaves mirror the live config / sidecar state:
 *
 *  - Agent / category leaves: `name → model` (or `name → default`).
 *  - Profile leaves: the profile name; the active profile (per
 *    `ProfileStore.getActiveProfileName()`) gets a checkmark icon and an
 *    `(active)` description.
 *
 * `contextValue` follows the manifest's menu wiring:
 *  - `agent` / `category`         — built-in with no override (offers edit + add).
 *  - `agentOverride` / `categoryOverride` — built-in with an override
 *    (offers edit + remove).
 *  - `profile`                    — saved profile (offers activate / rename / ...).
 *
 * The provider re-fires its `onDidChangeTreeData` event whenever the config
 * store or the profile store emits `change`. The caller owns disposal of
 * the provider (via `dispose()`), which removes those listeners.
 */
export class AgentModelTreeProvider
  implements vscode.TreeDataProvider<AgentModelTreeItem>
{
  private readonly _onDidChangeTreeData =
    new vscode.EventEmitter<AgentModelTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<
    AgentModelTreeItem | undefined | null | void
  > = this._onDidChangeTreeData.event;

  /**
   * Bound handler for store change events. Kept as a stable arrow-property
   * reference so `dispose()` can pass the exact same function to
   * `removeListener`.
   */
  private readonly handleStoreChange = (): void => {
    this.refresh();
  };

  /** Backing tree view, set by the caller after `createTreeView`. */
  private view: vscode.TreeView<AgentModelTreeItem> | undefined;

  /** In-memory previews keyed by group:nodeName, updated by the editor. */
  private readonly previews = new Map<string, ModelPreview>();

  constructor(
    private readonly configStore: ConfigStore,
    private readonly profileStore: ProfileStore,
  ) {
    this.configStore.onDidChange.on('change', this.handleStoreChange);
    this.profileStore.onDidChange.on('change', this.handleStoreChange);
  }

  // ---- Public API ----

  /**
   * Bind the underlying `vscode.TreeView` so `reveal()` can delegate to it.
   * Must be called by the activation code right after `createTreeView`.
   */
  setView(view: vscode.TreeView<AgentModelTreeItem>): void {
    this.view = view;
  }

  /** Fire `onDidChangeTreeData` so VS Code re-queries `getChildren()`. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Set a transient model preview for a leaf. The preview overrides the
   * displayed model in the tree until it is cleared by `clearPreview`, a
   * config change, or provider disposal. Used by the editor to show the
   * selected model before the user clicks Save.
   */
  setPreview(
    group: Exclude<AgentModelGroupKind, 'profiles'>,
    nodeName: string,
    model: string,
  ): void {
    this.previews.set(`${group}:${nodeName}`, { model });
    this.refresh();
  }

  /** Remove any transient preview for the given leaf. */
  clearPreview(
    group: Exclude<AgentModelGroupKind, 'profiles'>,
    nodeName: string,
  ): void {
    this.previews.delete(`${group}:${nodeName}`);
    this.refresh();
  }

  /** Remove all transient previews. */
  clearAllPreviews(): void {
    this.previews.clear();
    this.refresh();
  }

  /**
   * Reveal a tree item in the sidebar. No-op when no view has been bound.
   * If `item` is not currently in the tree, VS Code's `reveal` will reject
   * the returned promise — callers should refresh first if the tree may
   * have changed since the item was constructed.
   */
  reveal(
    item: AgentModelTreeItem,
    options?: { select?: boolean; focus?: boolean; expand?: boolean | number },
  ): Thenable<void> {
    if (!this.view) {
      return Promise.resolve();
    }
    return this.view.reveal(item, options);
  }

  /** Remove all store listeners and dispose the change emitter. */
  dispose(): void {
    this.configStore.onDidChange.removeListener(
      'change',
      this.handleStoreChange,
    );
    this.profileStore.onDidChange.removeListener(
      'change',
      this.handleStoreChange,
    );
    this._onDidChangeTreeData.dispose();
  }

  // ---- TreeDataProvider ----

  getTreeItem(element: AgentModelTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: AgentModelTreeItem): AgentModelTreeItem[] {
    if (!element) {
      return [
        this.createGroup('Agents', 'agents'),
        this.createGroup('Categories', 'categories'),
        this.createGroup('Profiles', 'profiles'),
      ];
    }
    if (element.kind !== 'group') {
      return [];
    }
    switch (element.group) {
      case 'agents':
        return BUILTIN_AGENTS.map((name) => this.createAgentLeaf(name));
      case 'categories':
        return BUILTIN_CATEGORIES.map((name) => this.createCategoryLeaf(name));
      case 'profiles':
        return this.createProfileLeaves();
      default:
        return [];
    }
  }

  // ---- Item builders ----

  private createGroup(
    label: string,
    group: AgentModelGroupKind,
  ): AgentModelTreeItem {
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.Collapsed,
    ) as AgentModelTreeItem;
    item.kind = 'group';
    item.group = group;
    item.contextValue = `${group}Group`;
    item.iconPath = new vscode.ThemeIcon(this.groupIcon(group));
    return item;
  }

  private createAgentLeaf(name: string): AgentModelTreeItem {
    const override = this.configStore.getAgent(name);
    const hasOverride = override !== undefined;
    const preview = this.previews.get(`agents:${name}`);
    const effectiveModel = preview?.model ?? override?.model;
    return this.createLeaf({
      group: 'agents',
      kind: hasOverride ? 'override' : 'agent',
      name,
      label: this.formatModelLabel(name, effectiveModel),
      contextValue: hasOverride ? 'agentOverride' : 'agent',
      icon: hasOverride ? 'edit' : 'person',
      tooltip: this.formatTooltip(name, effectiveModel, override),
    });
  }

  private createCategoryLeaf(name: string): AgentModelTreeItem {
    const override = this.configStore.getCategory(name);
    const hasOverride = override !== undefined;
    const preview = this.previews.get(`categories:${name}`);
    const effectiveModel = preview?.model ?? override?.model;
    return this.createLeaf({
      group: 'categories',
      kind: hasOverride ? 'override' : 'category',
      name,
      label: this.formatModelLabel(name, effectiveModel),
      contextValue: hasOverride ? 'categoryOverride' : 'category',
      icon: hasOverride ? 'edit' : 'tag',
      tooltip: this.formatTooltip(name, effectiveModel, override),
    });
  }

  private createProfileLeaves(): AgentModelTreeItem[] {
    const profiles = this.profileStore.listProfiles();
    const active = this.profileStore.getActiveProfileName();
    return profiles.map((profile) => {
      const isActive = profile.name === active;
      const item = new vscode.TreeItem(
        profile.name,
        vscode.TreeItemCollapsibleState.None,
      ) as AgentModelTreeItem;
      item.kind = 'profile';
      item.group = 'profiles';
      item.nodeName = profile.name;
      item.id = profile.name;
      item.contextValue = 'profile';
      item.iconPath = new vscode.ThemeIcon(isActive ? 'check' : 'file');
      item.description = isActive ? '(active)' : undefined;
      item.tooltip = profile.description ?? profile.name;
      return item;
    });
  }

  private createLeaf(args: {
    group: Exclude<AgentModelGroupKind, 'profiles'>;
    kind: 'agent' | 'category' | 'override';
    name: string;
    label: string;
    contextValue: 'agent' | 'category' | 'agentOverride' | 'categoryOverride';
    icon: string;
    tooltip: string;
  }): AgentModelTreeItem {
    const item = new vscode.TreeItem(
      args.label,
      vscode.TreeItemCollapsibleState.None,
    ) as AgentModelTreeItem;
    item.kind = args.kind;
    item.group = args.group;
    item.nodeName = args.name;
    item.id = args.name;
    item.contextValue = args.contextValue;
    item.iconPath = new vscode.ThemeIcon(args.icon);
    item.tooltip = args.tooltip;
    return item;
  }

  // ---- Formatting helpers ----

  private formatModelLabel(name: string, model: string | undefined): string {
    return `${name} \u2192 ${model ?? 'default'}`;
  }

  private formatTooltip(
    name: string,
    model: string | undefined,
    override: AgentConfig | CategoryConfig | undefined,
  ): string {
    const lines: string[] = [
      model ? `${name} — model: ${model}` : `${name} — using default model`,
    ];

    const params = this.formatParams(override);
    if (params.length > 0) {
      lines.push('');
      lines.push(params);
    }

    const fallbackSummary = this.formatFallbackSummary(override?.fallback_models);
    if (fallbackSummary !== undefined) {
      lines.push('');
      lines.push(`Fallback models: ${fallbackSummary}`);
    }

    return lines.join('\n');
  }

  private formatParams(
    override: AgentConfig | CategoryConfig | undefined,
  ): string {
    if (!override) return '';
    const parts: string[] = [];

    if (override.variant !== undefined) parts.push(`variant=${override.variant}`);
    if (override.temperature !== undefined) {
      parts.push(`temperature=${override.temperature}`);
    }
    if (override.top_p !== undefined) parts.push(`top_p=${override.top_p}`);
    if (override.maxTokens !== undefined) {
      parts.push(`maxTokens=${override.maxTokens}`);
    }
    if (override.reasoningEffort !== undefined) {
      parts.push(`reasoning=${override.reasoningEffort}`);
    }
    if (override.thinking !== undefined) {
      const thinking =
        override.thinking.type === 'enabled'
          ? override.thinking.budgetTokens !== undefined
            ? `enabled (${override.thinking.budgetTokens})`
            : 'enabled'
          : 'disabled';
      parts.push(`thinking=${thinking}`);
    }
    if (override.textVerbosity !== undefined) {
      parts.push(`verbosity=${override.textVerbosity}`);
    }
    if (override.disable === true) parts.push('disabled');

    return parts.join(', ');
  }

  private formatFallbackSummary(fallbacks: FallbackModels | undefined): string | undefined {
    if (fallbacks === undefined || fallbacks === null) return undefined;
    if (typeof fallbacks === 'string') return fallbacks;
    if (!Array.isArray(fallbacks)) return undefined;
    if (fallbacks.length === 0) return 'none';

    const ids = fallbacks.map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && 'model' in entry) {
        return String(entry.model);
      }
      return '(unknown)';
    });

    return ids.join(', ');
  }

  private groupIcon(group: AgentModelGroupKind): string {
    switch (group) {
      case 'agents':
        return 'robot';
      case 'categories':
        return 'symbol-class';
      case 'profiles':
        return 'files';
    }
  }
}
