import * as vscode from 'vscode';
import { ConfigStore } from '../config/configStore.js';
import { ProfileStore } from '../config/profileStore.js';
import {
  BUILTIN_AGENTS,
  BUILTIN_CATEGORIES,
} from '../config/schema.js';
import type { AgentConfig, CategoryConfig, FallbackModels, Profile } from '../config/schema.js';
import * as path from 'node:path';

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
  | 'profile'
  | 'detail'
  | 'fallbackGroup'
  | 'fallback'
  | 'configFile'
  | 'activeProfile'
  | 'noActiveProfile';

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
  /** Profile context for profile-nested agent/category leaves. */
  profileName?: string;
  children?: AgentModelTreeItem[];
  /** For fallback model entries: the index within the parent's fallback_models array. */
  fallbackIndex?: number;
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
      const roots: AgentModelTreeItem[] = [this.createConfigFileItem()];
      const activeProfile = this.createActiveProfileItem();
      if (activeProfile) {
        roots.push(activeProfile);
      }
      roots.push(
        this.createGroup('Agents', 'agents'),
        this.createGroup('Categories', 'categories'),
        this.createGroup('Profiles', 'profiles'),
      );
      return roots;
    }
    if (element.children) {
      return element.children;
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
    const effectiveModel = override?.model;
    const children = this.createConfigChildren('agents', name, override);
    return this.createLeaf({
      group: 'agents',
      kind: hasOverride ? 'override' : 'agent',
      name,
      label: this.formatModelLabel(name, effectiveModel),
      contextValue: hasOverride ? 'agentOverride' : 'agent',
      icon: hasOverride ? 'edit' : 'person',
      tooltip: this.formatTooltip(name, effectiveModel, override),
      children,
    });
  }

  private createCategoryLeaf(name: string): AgentModelTreeItem {
    const override = this.configStore.getCategory(name);
    const hasOverride = override !== undefined;
    const effectiveModel = override?.model;
    const children = this.createConfigChildren('categories', name, override);
    return this.createLeaf({
      group: 'categories',
      kind: hasOverride ? 'override' : 'category',
      name,
      label: this.formatModelLabel(name, effectiveModel),
      contextValue: hasOverride ? 'categoryOverride' : 'category',
      icon: hasOverride ? 'edit' : 'tag',
      tooltip: this.formatTooltip(name, effectiveModel, override),
      children,
    });
  }

  private createProfileLeaves(): AgentModelTreeItem[] {
    const profiles = this.profileStore.listProfiles();
    const active = this.profileStore.getActiveProfileName();
    const items: AgentModelTreeItem[] = [];
    if (active === undefined) {
      items.push(this.createNoActiveProfileItem());
    }
    for (const profile of profiles) {
      const isActive = profile.name === active;
      const children = this.createProfileContentChildren(profile);
      const item = new vscode.TreeItem(
        profile.name,
        children.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      ) as AgentModelTreeItem;
      item.kind = 'profile';
      item.group = 'profiles';
      item.nodeName = profile.name;
      item.id = profile.name;
      item.contextValue = 'profile';
      item.iconPath = new vscode.ThemeIcon(isActive ? 'check' : 'file');
      item.description = isActive ? '(active)' : undefined;
      item.tooltip = profile.description ?? profile.name;
      item.children = children;
      items.push(item);
    }
    return items;
  }

  private createLeaf(args: {
    group: Exclude<AgentModelGroupKind, 'profiles'>;
    kind: 'agent' | 'category' | 'override';
    name: string;
    label: string;
    contextValue: 'agent' | 'category' | 'agentOverride' | 'categoryOverride';
    icon: string;
    tooltip: string;
    children: AgentModelTreeItem[];
  }): AgentModelTreeItem {
    const item = new vscode.TreeItem(
      args.label,
      args.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    ) as AgentModelTreeItem;
    item.kind = args.kind;
    item.group = args.group;
    item.nodeName = args.name;
    item.id = args.name;
    item.contextValue = args.contextValue;
    item.iconPath = new vscode.ThemeIcon(args.icon);
    item.tooltip = args.tooltip;
    item.children = args.children;
    return item;
  }

  private createConfigFileItem(): AgentModelTreeItem {
    const configPath = this.configStore.getConfigPath();
    const item = new vscode.TreeItem(
      path.basename(configPath),
      vscode.TreeItemCollapsibleState.None,
    ) as AgentModelTreeItem;
    item.kind = 'configFile';
    item.id = '__omo_config_file__';
    item.contextValue = 'configFile';
    item.iconPath = new vscode.ThemeIcon('file-code');
    item.tooltip = configPath;
    return item;
  }

  private createActiveProfileItem(): AgentModelTreeItem | undefined {
    const active = this.profileStore.getActiveProfileName();
    if (active === undefined) return undefined;
    const profile = this.profileStore.getProfile(active);
    if (profile === undefined) return undefined;

    const modified = this.profileStore.isActiveProfileModified();
    const item = new vscode.TreeItem(
      modified ? `${active} *` : active,
      vscode.TreeItemCollapsibleState.None,
    ) as AgentModelTreeItem;
    item.kind = 'activeProfile';
    item.id = '__omo_active_profile__';
    item.nodeName = active;
    item.contextValue = modified ? 'activeProfileModified' : 'activeProfile';
    item.iconPath = new vscode.ThemeIcon('check');
    item.description = modified ? 'unsaved changes' : '(active)';
    item.tooltip = modified
      ? `Active profile "${active}" has unsaved config changes. Use Save Active Profile to persist them.`
      : `Active profile: ${active}`;
    return item;
  }

  private createNoActiveProfileItem(): AgentModelTreeItem {
    const item = new vscode.TreeItem(
      'No active profile',
      vscode.TreeItemCollapsibleState.None,
    ) as AgentModelTreeItem;
    item.kind = 'noActiveProfile';
    item.id = '__omo_no_active_profile__';
    item.contextValue = 'noActiveProfile';
    item.iconPath = new vscode.ThemeIcon('circle-slash');
    item.tooltip = 'No profile is currently active';
    return item;
  }

  private createProfileContentChildren(profile: Profile): AgentModelTreeItem[] {
    const agents = profile.agents ?? {};
    const categories = profile.categories ?? {};
    const hasAgents = Object.keys(agents).length > 0;
    const hasCategories = Object.keys(categories).length > 0;
    if (!hasAgents && !hasCategories) return [];
    const children: AgentModelTreeItem[] = [];
    if (hasAgents) {
      children.push(this.createProfileGroup(profile.name, 'agents', agents));
    }
    if (hasCategories) {
      children.push(this.createProfileGroup(profile.name, 'categories', categories));
    }
    return children;
  }

  private createProfileGroup(
    profileName: string,
    group: 'agents' | 'categories',
    configs: Record<string, AgentConfig | CategoryConfig>,
  ): AgentModelTreeItem {
    const label = group === 'agents' ? 'Agents' : 'Categories';
    const items = Object.keys(configs).sort().map((name) =>
      this.createProfileConfigChild(profileName, group, name, configs[name]),
    );
    const item = new vscode.TreeItem(
      label,
      vscode.TreeItemCollapsibleState.Collapsed,
    ) as AgentModelTreeItem;
    item.kind = 'group';
    item.group = 'profiles';
    item.nodeName = `${profileName}:${group}`;
    item.id = `profile:${profileName}:${group}`;
    item.contextValue = 'profileGroup';
    item.iconPath = new vscode.ThemeIcon(group === 'agents' ? 'robot' : 'symbol-class');
    item.children = items;
    return item;
  }

  private createProfileConfigChild(
    profileName: string,
    group: 'agents' | 'categories',
    name: string,
    config: AgentConfig | CategoryConfig,
  ): AgentModelTreeItem {
    const model = config.model;
    const label = `${name} \u2192 ${model ?? 'default'}`;
    const children = this.createConfigChildren(group, name, config);
    const item = new vscode.TreeItem(
      label,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    ) as AgentModelTreeItem;
    item.kind = group === 'agents' ? 'agent' : 'category';
    item.group = group;
    item.nodeName = name;
    item.profileName = profileName;
    item.id = `profile:${profileName}:${group === 'agents' ? 'agent' : 'category'}:${name}`;
    item.contextValue = group === 'agents' ? 'agent' : 'category';
    item.iconPath = new vscode.ThemeIcon(group === 'agents' ? 'person' : 'tag');
    const params = this.formatParams(config);
    item.tooltip = [
      `${group === 'agents' ? 'Agent' : 'Category'}: ${name}`,
      `Model: ${model ?? 'default'}`,
      ...(params.length > 0 ? [params] : []),
    ].join('\n');
    item.command = {
      command: group === 'agents' ? 'ohMyOpenAgent.editAgent' : 'ohMyOpenAgent.editCategory',
      title: 'Edit',
      arguments: [{ kind: item.kind, nodeName: name, group, profileName }],
    };
    item.children = children;
    return item;
  }

  private createConfigChildren(
    group: Exclude<AgentModelGroupKind, 'profiles'>,
    name: string,
    override: AgentConfig | CategoryConfig | undefined,
  ): AgentModelTreeItem[] {
    if (!override) return [];
    const children: AgentModelTreeItem[] = [];
    if (override.variant !== undefined) {
      children.push(this.createDetailChild(group, name, 'variant', override.variant));
    }
    if (override.reasoningEffort !== undefined) {
      children.push(this.createDetailChild(group, name, 'reasoning', override.reasoningEffort));
    }
    if (override.temperature !== undefined) {
      children.push(this.createDetailChild(group, name, 'temperature', String(override.temperature)));
    }
    if (override.top_p !== undefined) {
      children.push(this.createDetailChild(group, name, 'top_p', String(override.top_p)));
    }
    if (override.maxTokens !== undefined) {
      children.push(this.createDetailChild(group, name, 'maxTokens', String(override.maxTokens)));
    }
    if (override.thinking !== undefined) {
      const value = override.thinking.type === 'enabled'
        ? override.thinking.budgetTokens !== undefined
          ? `enabled, budget ${override.thinking.budgetTokens}`
          : 'enabled'
        : 'disabled';
      children.push(this.createDetailChild(group, name, 'thinking', value));
    }
    if (override.textVerbosity !== undefined) {
      children.push(this.createDetailChild(group, name, 'verbosity', override.textVerbosity));
    }
    if (override.disable === true) {
      children.push(this.createDetailChild(group, name, 'disabled', 'true'));
    }
    if (override.fallback_models !== undefined) {
      const fallbackChildren = this.createFallbackChildren(group, name, override.fallback_models);
      if (fallbackChildren.length > 0) {
        children.push(this.createFallbackGroup(group, name, fallbackChildren));
      }
    }
    return children;
  }

  private createDetailChild(
    group: Exclude<AgentModelGroupKind, 'profiles'>,
    name: string,
    key: string,
    value: string,
  ): AgentModelTreeItem {
    const item = new vscode.TreeItem(
      `${key}: ${value}`,
      vscode.TreeItemCollapsibleState.None,
    ) as AgentModelTreeItem;
    item.kind = 'detail';
    item.group = group;
    item.nodeName = name;
    item.id = `${group}:${name}:detail:${key}`;
    item.contextValue = 'detail';
    item.iconPath = new vscode.ThemeIcon('settings-gear');
    item.tooltip = `${key}: ${value}`;
    return item;
  }

  private createFallbackGroup(
    group: Exclude<AgentModelGroupKind, 'profiles'>,
    name: string,
    children: AgentModelTreeItem[],
  ): AgentModelTreeItem {
    const item = new vscode.TreeItem(
      `fallbacks (${children.length})`,
      vscode.TreeItemCollapsibleState.Collapsed,
    ) as AgentModelTreeItem;
    item.kind = 'fallbackGroup';
    item.group = group;
    item.nodeName = name;
    item.id = `${group}:${name}:fallbacks`;
    item.contextValue = 'detail';
    item.iconPath = new vscode.ThemeIcon('references');
    item.children = children;
    return item;
  }

  private createFallbackChildren(
    group: Exclude<AgentModelGroupKind, 'profiles'>,
    name: string,
    fallbacks: FallbackModels,
  ): AgentModelTreeItem[] {
    const entries = typeof fallbacks === 'string' ? [fallbacks] : fallbacks;
    if (!Array.isArray(entries)) return [];
    return entries.map((entry, index) => {
      const model = typeof entry === 'string' ? entry : entry.model;
      const details = typeof entry === 'string' ? [] : this.formatFallbackDetails(entry);
      const item = new vscode.TreeItem(
        details.length > 0 ? `${model} — ${details.join(', ')}` : model,
        vscode.TreeItemCollapsibleState.None,
      ) as AgentModelTreeItem;
      item.kind = 'fallback';
      item.group = group;
      item.nodeName = name;
      item.fallbackIndex = index;
      item.id = `${group}:${name}:fallback:${index}`;
      item.contextValue = 'fallbackModel';
      item.iconPath = new vscode.ThemeIcon('debug-step-over');
      item.tooltip = details.length > 0 ? `${model}\n${details.join('\n')}` : model;
      return item;
    });
  }

  private formatFallbackDetails(entry: Exclude<Exclude<FallbackModels, string>[number], string>): string[] {
    const details: string[] = [];
    if (entry.variant !== undefined) details.push(`variant=${entry.variant}`);
    if (entry.reasoningEffort !== undefined) details.push(`reasoning=${entry.reasoningEffort}`);
    if (entry.temperature !== undefined) details.push(`temperature=${entry.temperature}`);
    if (entry.top_p !== undefined) details.push(`top_p=${entry.top_p}`);
    if (entry.maxTokens !== undefined) details.push(`maxTokens=${entry.maxTokens}`);
    if (entry.thinking !== undefined) {
      details.push(
        entry.thinking.type === 'enabled' && entry.thinking.budgetTokens !== undefined
          ? `thinking=enabled (${entry.thinking.budgetTokens})`
          : `thinking=${entry.thinking.type}`,
      );
    }
    return details;
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
