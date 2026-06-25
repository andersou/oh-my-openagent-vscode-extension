import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AgentModelTreeProvider } from './agentModelTreeProvider.js';
import { BUILTIN_AGENTS, BUILTIN_CATEGORIES } from '../config/schema.js';
import type { ConfigStore } from '../config/configStore.js';
import type { ProfileStore } from '../config/profileStore.js';
import type { Profile } from '../config/schema.js';

// ---------------------------------------------------------------------------
// vscode mock — must be set up before importing the provider.
// ---------------------------------------------------------------------------

vi.mock('vscode', () => {
  class TreeItem {
    label: string | undefined;
    collapsibleState: number;
    name: string | undefined;
    contextValue: string | undefined;
    description: string | undefined;
    tooltip: string | undefined;
    iconPath: unknown;
    id: string | undefined;
    command: unknown;
    resourceUri: unknown;
    constructor(label: string, collapsibleState?: number) {
      this.label = label;
      this.collapsibleState = collapsibleState ?? 0;
    }
  }
  class ThemeIcon {
    readonly id: string;
    constructor(id: string) {
      this.id = id;
    }
  }
  class VSCodeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): (() => void) => {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    };
    fire(data: T): void {
      for (const l of this.listeners) l(data);
    }
    dispose(): void {
      this.listeners = [];
    }
  }
  return {
    TreeItem,
    ThemeIcon,
    EventEmitter: VSCodeEventEmitter,
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
  };
});

// ---------------------------------------------------------------------------
// Test doubles for the stores
// ---------------------------------------------------------------------------

function makeConfigStoreStub(
  agents: Record<string, object> = {},
  categories: Record<string, object> = {},
  configPath: string = '/fake/path/oh-my-openagent.json',
): ConfigStore {
  return {
    onDidChange: new EventEmitter(),
    getAgent: (name: string) => agents[name] as { model?: string } | undefined,
    getCategory: (name: string) => categories[name] as { model?: string } | undefined,
    getConfigPath: () => configPath,
  } as unknown as ConfigStore;
}

function makeProfileStoreStub(
  profiles: Profile[] = [],
  active: string | undefined = undefined,
): ProfileStore {
  return {
    onDidChange: new EventEmitter(),
    listProfiles: () => profiles,
    getActiveProfileName: () => active,
  } as unknown as ProfileStore;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentModelTreeProvider', () => {
  let configStore: ConfigStore;
  let profileStore: ProfileStore;
  let provider: AgentModelTreeProvider;

  beforeEach(() => {
    configStore = makeConfigStoreStub();
    profileStore = makeProfileStoreStub();
    provider = new AgentModelTreeProvider(configStore, profileStore);
  });

  it('returns four top-level items at the root', () => {
    const roots = provider.getChildren();
    expect(roots).toHaveLength(4);
    expect(roots[0].kind).toBe('configFile');
    expect(roots[0].label).toBe('oh-my-openagent.json');
    expect(roots[0].tooltip).toBe('/fake/path/oh-my-openagent.json');
    expect(roots.slice(1).map((r) => r.label)).toEqual([
      'Agents',
      'Categories',
      'Profiles',
    ]);
    expect(roots.slice(1).map((r) => r.group)).toEqual([
      'agents',
      'categories',
      'profiles',
    ]);
    expect(roots.slice(1).every((r) => r.kind === 'group')).toBe(true);
  });

  it('returns one leaf per built-in agent with contextValue "agent" by default', () => {
    const group = provider.getChildren()!.find((g) => g.group === 'agents')!;
    const leaves = provider.getChildren(group);
    expect(leaves).toHaveLength(BUILTIN_AGENTS.length);
    for (const leaf of leaves) {
      expect(leaf.kind).toBe('agent');
      expect(leaf.contextValue).toBe('agent');
      expect(leaf.label).toBe(`${leaf.nodeName} \u2192 default`);
    }
  });

  it('flips agent contextValue to "agentOverride" when an override is set', () => {
    configStore = makeConfigStoreStub({
      sisyphus: { model: 'openai/gpt-4' },
    });
    provider = new AgentModelTreeProvider(configStore, profileStore);
    const group = provider.getChildren()!.find((g) => g.group === 'agents')!;
    const leaves = provider.getChildren(group);
    const sisyphus = leaves.find((l) => l.nodeName === 'sisyphus')!;
    expect(sisyphus.contextValue).toBe('agentOverride');
    expect(sisyphus.label).toBe('sisyphus \u2192 openai/gpt-4');
  });

  it('uses contextValue "category" for built-in categories without overrides', () => {
    const group = provider
      .getChildren()!
      .find((g) => g.group === 'categories')!;
    const leaves = provider.getChildren(group);
    expect(leaves).toHaveLength(BUILTIN_CATEGORIES.length);
    for (const leaf of leaves) {
      expect(leaf.kind).toBe('category');
      expect(leaf.contextValue).toBe('category');
    }
  });

  it('flips category contextValue to "categoryOverride" when an override is set', () => {
    configStore = makeConfigStoreStub({}, {
      deep: { model: 'deep/model' },
    });
    provider = new AgentModelTreeProvider(configStore, profileStore);
    const group = provider
      .getChildren()!
      .find((g) => g.group === 'categories')!;
    const leaves = provider.getChildren(group);
    const deep = leaves.find((l) => l.nodeName === 'deep')!;
    expect(deep.contextValue).toBe('categoryOverride');
    expect(deep.label).toBe('deep \u2192 deep/model');
  });

  it('returns one profile leaf per profile with contextValue "profile"', () => {
    const profiles: Profile[] = [
      { name: 'fast', description: 'Quick tasks' },
      { name: 'careful', description: 'Thoughtful work' },
    ];
    profileStore = makeProfileStoreStub(profiles, 'fast');
    provider = new AgentModelTreeProvider(configStore, profileStore);

    const group = provider.getChildren()!.find((g) => g.group === 'profiles')!;
    const leaves = provider.getChildren(group);
    expect(leaves.map((l) => l.nodeName)).toEqual(['fast', 'careful']);
    for (const leaf of leaves) {
      expect(leaf.kind).toBe('profile');
      expect(leaf.contextValue).toBe('profile');
    }
  });

  it('shows a "No active profile" indicator when profiles exist but none is active', () => {
    const profiles: Profile[] = [{ name: 'fast' }];
    profileStore = makeProfileStoreStub(profiles, undefined);
    provider = new AgentModelTreeProvider(configStore, profileStore);

    const group = provider.getChildren()!.find((g) => g.group === 'profiles')!;
    const leaves = provider.getChildren(group);
    expect(leaves[0].kind).toBe('noActiveProfile');
    expect(leaves[0].label).toBe('No active profile');
    expect(leaves.slice(1).map((l) => l.nodeName)).toEqual(['fast']);
  });

  it('does not show "No active profile" when a profile is active', () => {
    const profiles: Profile[] = [{ name: 'fast' }];
    profileStore = makeProfileStoreStub(profiles, 'fast');
    provider = new AgentModelTreeProvider(configStore, profileStore);

    const group = provider.getChildren()!.find((g) => g.group === 'profiles')!;
    const leaves = provider.getChildren(group);
    expect(leaves.some((l) => l.kind === 'noActiveProfile')).toBe(false);
    expect(leaves.map((l) => l.nodeName)).toEqual(['fast']);
  });

  it('shows "No active profile" even when there are no profiles', () => {
    profileStore = makeProfileStoreStub([], undefined);
    provider = new AgentModelTreeProvider(configStore, profileStore);

    const group = provider.getChildren()!.find((g) => g.group === 'profiles')!;
    const leaves = provider.getChildren(group);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].kind).toBe('noActiveProfile');
    expect(leaves[0].label).toBe('No active profile');
  });

  it('renders profile content as nested Agents/Categories groups', () => {
    const profiles: Profile[] = [
      {
        name: 'fast',
        agents: {
          sisyphus: { model: 'openai/gpt-4', temperature: 0.7 },
        },
        categories: {
          quick: { model: 'openai/gpt-3.5' },
        },
      },
    ];
    profileStore = makeProfileStoreStub(profiles, 'fast');
    provider = new AgentModelTreeProvider(configStore, profileStore);

    const group = provider.getChildren()!.find((g) => g.group === 'profiles')!;
    const fast = provider.getChildren(group).find((l) => l.nodeName === 'fast')!;
    expect(fast.collapsibleState).toBe(1);

    const subGroups = provider.getChildren(fast);
    expect(subGroups.map((c) => ({ label: c.label, nodeName: c.nodeName, kind: c.kind }))).toEqual([
      { label: 'Agents', nodeName: 'fast:agents', kind: 'group' },
      { label: 'Categories', nodeName: 'fast:categories', kind: 'group' },
    ]);

    const agentsGroup = subGroups.find((c) => c.nodeName === 'fast:agents')!;
    const agentItems = provider.getChildren(agentsGroup);
    expect(agentItems.map((c) => c.label)).toEqual(['sisyphus \u2192 openai/gpt-4']);
    expect(agentItems[0].kind).toBe('agent');
    expect(agentItems[0].contextValue).toBe('agent');
    expect(agentItems[0].profileName).toBe('fast');
    expect(agentItems[0].command).toEqual({
      command: 'ohMyOpenAgent.editAgent',
      title: 'Edit',
      arguments: [
        {
          kind: 'agent',
          nodeName: 'sisyphus',
          group: 'agents',
          profileName: 'fast',
        },
      ],
    });
    expect((agentItems[0].iconPath as { id: string }).id).toBe('person');

    const categoriesGroup = subGroups.find((c) => c.nodeName === 'fast:categories')!;
    const categoryItems = provider.getChildren(categoriesGroup);
    expect(categoryItems.map((c) => c.label)).toEqual(['quick \u2192 openai/gpt-3.5']);
    expect(categoryItems[0].kind).toBe('category');
    expect(categoryItems[0].contextValue).toBe('category');
    expect(categoryItems[0].profileName).toBe('fast');
    expect(categoryItems[0].command).toEqual({
      command: 'ohMyOpenAgent.editCategory',
      title: 'Edit',
      arguments: [
        {
          kind: 'category',
          nodeName: 'quick',
          group: 'categories',
          profileName: 'fast',
        },
      ],
    });
    expect((categoryItems[0].iconPath as { id: string }).id).toBe('tag');
  });

  it('marks the active profile with a check icon and "(active)" description', () => {
    const profiles: Profile[] = [
      { name: 'fast' },
      { name: 'careful' },
    ];
    profileStore = makeProfileStoreStub(profiles, 'careful');
    provider = new AgentModelTreeProvider(configStore, profileStore);

    const group = provider.getChildren()!.find((g) => g.group === 'profiles')!;
    const leaves = provider.getChildren(group);
    const fast = leaves.find((l) => l.nodeName === 'fast')!;
    const careful = leaves.find((l) => l.nodeName === 'careful')!;
    expect(fast.description).toBeUndefined();
    expect(careful.description).toBe('(active)');
    // Icons are ThemeIcon instances; we only check ids here via the mock class.
    expect((fast.iconPath as { id: string }).id).toBe('file');
    expect((careful.iconPath as { id: string }).id).toBe('check');
  });

  it('returns an empty list when the active profile is not in the list', () => {
    profileStore = makeProfileStoreStub(
      [{ name: 'fast' }],
      'ghost', // not in the list
    );
    provider = new AgentModelTreeProvider(configStore, profileStore);
    const group = provider.getChildren()!.find((g) => g.group === 'profiles')!;
    const leaves = provider.getChildren(group);
    expect(leaves[0].description).toBeUndefined();
  });

  it('emits onDidChangeTreeData when refresh() is called', () => {
    const seen: number[] = [];
    provider.onDidChangeTreeData(() => seen.push(1));
    provider.refresh();
    provider.refresh();
    expect(seen).toHaveLength(2);
  });

  it('refreshes the tree when configStore emits "change"', () => {
    const seen: number[] = [];
    provider.onDidChangeTreeData(() => seen.push(1));
    (configStore.onDidChange as EventEmitter).emit('change');
    expect(seen).toHaveLength(1);
  });

  it('refreshes the tree when profileStore emits "change"', () => {
    const seen: number[] = [];
    provider.onDidChangeTreeData(() => seen.push(1));
    (profileStore.onDidChange as EventEmitter).emit('change');
    expect(seen).toHaveLength(1);
  });

  it('detaches listeners on dispose()', () => {
    const seen: number[] = [];
    provider.onDidChangeTreeData(() => seen.push(1));
    provider.dispose();
    (configStore.onDidChange as EventEmitter).emit('change');
    (profileStore.onDidChange as EventEmitter).emit('change');
    expect(seen).toHaveLength(0);
  });

  it('returns no children for leaf elements', () => {
    const agentGroup = provider
      .getChildren()!
      .find((g) => g.group === 'agents')!;
    const [firstAgent] = provider.getChildren(agentGroup);
    expect(provider.getChildren(firstAgent)).toEqual([]);
  });

  it('returns the same item from getTreeItem', () => {
    const group = provider.getChildren()![0];
    expect(provider.getTreeItem(group)).toBe(group);
  });

  describe('sidebar metadata display', () => {
    it('shows configured params in the tooltip for an agent override', () => {
      configStore = makeConfigStoreStub({
        sisyphus: {
          model: 'openai/gpt-4',
          variant: 'max',
          temperature: 0.7,
          reasoningEffort: 'high',
          thinking: { type: 'enabled', budgetTokens: 8192 },
        },
      });
      provider = new AgentModelTreeProvider(configStore, profileStore);
      const group = provider.getChildren()!.find((g) => g.group === 'agents')!;
      const sisyphus = provider.getChildren(group).find((l) => l.nodeName === 'sisyphus')!;
      expect(sisyphus.tooltip).toContain('model: openai/gpt-4');
      expect(sisyphus.tooltip).toContain('variant=max');
      expect(sisyphus.tooltip).toContain('temperature=0.7');
      expect(sisyphus.tooltip).toContain('reasoning=high');
      expect(sisyphus.tooltip).toContain('thinking=enabled (8192)');
    });

    it('shows fallback model IDs in the tooltip', () => {
      configStore = makeConfigStoreStub({
        sisyphus: {
          model: 'openai/gpt-4',
          fallback_models: ['openai/gpt-4o', 'anthropic/claude-haiku'],
        },
      });
      provider = new AgentModelTreeProvider(configStore, profileStore);
      const group = provider.getChildren()!.find((g) => g.group === 'agents')!;
      const sisyphus = provider.getChildren(group).find((l) => l.nodeName === 'sisyphus')!;
      expect(sisyphus.tooltip).toContain('Fallback models: openai/gpt-4o, anthropic/claude-haiku');
    });

    it('shows fallback model summary for rich object entries', () => {
      configStore = makeConfigStoreStub({
        sisyphus: {
          model: 'openai/gpt-4',
          fallback_models: [
            { model: 'openai/gpt-4o', temperature: 0.3 },
            { model: 'anthropic/claude-opus' },
          ],
        },
      });
      provider = new AgentModelTreeProvider(configStore, profileStore);
      const group = provider.getChildren()!.find((g) => g.group === 'agents')!;
      const sisyphus = provider.getChildren(group).find((l) => l.nodeName === 'sisyphus')!;
      expect(sisyphus.tooltip).toContain('Fallback models: openai/gpt-4o, anthropic/claude-opus');
    });

    it('renders configured agent params and fallbacks as expandable child nodes', () => {
      configStore = makeConfigStoreStub({
        sisyphus: {
          model: 'openai/gpt-4',
          variant: 'max',
          temperature: 0.7,
          top_p: 0.9,
          maxTokens: 4096,
          reasoningEffort: 'high',
          thinking: { type: 'enabled', budgetTokens: 8192 },
          textVerbosity: 'medium',
          fallback_models: [
            'openai/gpt-4o',
            {
              model: 'anthropic/claude-haiku',
              temperature: 0.3,
              reasoningEffort: 'low',
            },
          ],
        },
      });
      provider = new AgentModelTreeProvider(configStore, profileStore);

      const group = provider.getChildren()!.find((g) => g.group === 'agents')!;
      const sisyphus = provider.getChildren(group).find((l) => l.nodeName === 'sisyphus')!;
      expect(sisyphus.collapsibleState).toBe(1);

      const children = provider.getChildren(sisyphus);
      expect(children.map((child) => child.label)).toEqual([
        'variant: max',
        'reasoning: high',
        'temperature: 0.7',
        'top_p: 0.9',
        'maxTokens: 4096',
        'thinking: enabled, budget 8192',
        'verbosity: medium',
        'fallbacks (2)',
      ]);
      expect(children.every((child) => child.contextValue === 'detail')).toBe(true);

      const fallbacks = children.find((child) => child.kind === 'fallbackGroup')!;
      expect(fallbacks.collapsibleState).toBe(1);
      expect(provider.getChildren(fallbacks).map((child) => child.label)).toEqual([
        'openai/gpt-4o',
        'anthropic/claude-haiku — reasoning=low, temperature=0.3',
      ]);
    });

    it('shows category params and fallbacks in the tooltip', () => {
      configStore = makeConfigStoreStub({}, {
        deep: {
          model: 'deep/model',
          top_p: 0.9,
          maxTokens: 4096,
          disable: true,
          fallback_models: 'fallback/model',
        },
      });
      provider = new AgentModelTreeProvider(configStore, profileStore);
      const group = provider.getChildren()!.find((g) => g.group === 'categories')!;
      const deep = provider.getChildren(group).find((l) => l.nodeName === 'deep')!;
      expect(deep.tooltip).toContain('model: deep/model');
      expect(deep.tooltip).toContain('top_p=0.9');
      expect(deep.tooltip).toContain('maxTokens=4096');
      expect(deep.tooltip).toContain('disabled');
      expect(deep.tooltip).toContain('Fallback models: fallback/model');
    });

    it('renders configured category params and string fallback as child nodes', () => {
      configStore = makeConfigStoreStub({}, {
        deep: {
          model: 'deep/model',
          top_p: 0.9,
          maxTokens: 4096,
          disable: true,
          fallback_models: 'fallback/model',
        },
      });
      provider = new AgentModelTreeProvider(configStore, profileStore);

      const group = provider.getChildren()!.find((g) => g.group === 'categories')!;
      const deep = provider.getChildren(group).find((l) => l.nodeName === 'deep')!;
      expect(deep.collapsibleState).toBe(1);

      const children = provider.getChildren(deep);
      expect(children.map((child) => child.label)).toEqual([
        'top_p: 0.9',
        'maxTokens: 4096',
        'disabled: true',
        'fallbacks (1)',
      ]);
      const fallbackGroup = children.find((child) => child.kind === 'fallbackGroup')!;
      expect(provider.getChildren(fallbackGroup).map((child) => child.label)).toEqual([
        'fallback/model',
      ]);
    });
  });

});
