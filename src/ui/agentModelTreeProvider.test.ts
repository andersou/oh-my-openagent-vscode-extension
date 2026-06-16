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
  agents: Record<string, { model?: string }> = {},
  categories: Record<string, { model?: string }> = {},
): ConfigStore {
  return {
    onDidChange: new EventEmitter(),
    getAgent: (name: string) => agents[name],
    getCategory: (name: string) => categories[name],
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

  it('returns three top-level groups at the root', () => {
    const roots = provider.getChildren();
    expect(roots).toHaveLength(3);
    expect(roots.map((r) => r.label)).toEqual([
      'Agents',
      'Categories',
      'Profiles',
    ]);
    expect(roots.map((r) => r.group)).toEqual([
      'agents',
      'categories',
      'profiles',
    ]);
    expect(roots.every((r) => r.kind === 'group')).toBe(true);
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

  it('flips agent contextValue to "override" when an override is set', () => {
    configStore = makeConfigStoreStub({
      sisyphus: { model: 'openai/gpt-4' },
    });
    provider = new AgentModelTreeProvider(configStore, profileStore);
    const group = provider.getChildren()!.find((g) => g.group === 'agents')!;
    const leaves = provider.getChildren(group);
    const sisyphus = leaves.find((l) => l.nodeName === 'sisyphus')!;
    expect(sisyphus.contextValue).toBe('override');
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

  it('flips category contextValue to "override" when an override is set', () => {
    configStore = makeConfigStoreStub({}, {
      deep: { model: 'deep/model' },
    });
    provider = new AgentModelTreeProvider(configStore, profileStore);
    const group = provider
      .getChildren()!
      .find((g) => g.group === 'categories')!;
    const leaves = provider.getChildren(group);
    const deep = leaves.find((l) => l.nodeName === 'deep')!;
    expect(deep.contextValue).toBe('override');
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
});
