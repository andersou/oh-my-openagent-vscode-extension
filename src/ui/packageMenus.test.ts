import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

type ViewItemContextMenuEntry = {
  command: string;
  when: string;
  group?: string;
};

type CommandEntry = {
  command: string;
};

type CommandPaletteEntry = {
  command: string;
  when: string;
};

type PackageManifest = {
  activationEvents?: unknown;
  contributes?: {
    commands?: CommandEntry[];
    menus?: {
      'view/item/context'?: ViewItemContextMenuEntry[];
      commandPalette?: CommandPaletteEntry[];
    };
  };
};

function readPackageJson(): PackageManifest {
  const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8');
  return JSON.parse(raw) as PackageManifest;
}

describe('package.json command contributions', () => {
  it('contributes exactly the registered command handlers', () => {
    const commands = readPackageJson().contributes?.commands ?? [];

    expect(commands.map(({ command }) => command)).toEqual([
      'ohMyOpenAgent.openAgentManager',
      'ohMyOpenAgent.editAgent',
      'ohMyOpenAgent.editCategory',
      'ohMyOpenAgent.refresh',
      'ohMyOpenAgent.removeOverride',
      'ohMyOpenAgent.createProfile',
      'ohMyOpenAgent.activateProfile',
      'ohMyOpenAgent.renameProfile',
      'ohMyOpenAgent.duplicateProfile',
      'ohMyOpenAgent.deleteProfile',
      'ohMyOpenAgent.saveActiveProfile',
      'ohMyOpenAgent.importProfiles',
      'ohMyOpenAgent.exportAllProfiles',
      'ohMyOpenAgent.exportProfile',
      'ohMyOpenAgent.editProfileJson',
      'ohMyOpenAgent.editActiveProfileJson',
    ]);
  });

  it('does not contribute removed commands or context-menu entries', () => {
    const manifest = readPackageJson();
    const commands = manifest.contributes?.commands ?? [];
    const contextMenuEntries =
      manifest.contributes?.menus?.['view/item/context'] ?? [];
    const removedCommands = new Set([
      'ohMyOpenAgent.addAgentOverride',
      'ohMyOpenAgent.addCategoryOverride',
      'ohMyOpenAgent.switchMainModel',
    ]);

    expect(
      [...commands, ...contextMenuEntries]
        .map(({ command }) => command)
        .filter((command) => removedCommands.has(command)),
    ).toEqual([]);
  });

  it('relies on implicit activation for contributed commands and views', () => {
    expect(readPackageJson().activationEvents).toBeUndefined();
  });

  it('hides contextual commands from the Command Palette', () => {
    const entries = readPackageJson().contributes?.menus?.commandPalette ?? [];

    expect(entries).toEqual([
      { command: 'ohMyOpenAgent.editAgent', when: 'false' },
      { command: 'ohMyOpenAgent.editCategory', when: 'false' },
      { command: 'ohMyOpenAgent.removeOverride', when: 'false' },
      { command: 'ohMyOpenAgent.activateProfile', when: 'false' },
      { command: 'ohMyOpenAgent.renameProfile', when: 'false' },
      { command: 'ohMyOpenAgent.duplicateProfile', when: 'false' },
      { command: 'ohMyOpenAgent.deleteProfile', when: 'false' },
      { command: 'ohMyOpenAgent.saveActiveProfile', when: 'false' },
      { command: 'ohMyOpenAgent.exportProfile', when: 'false' },
      { command: 'ohMyOpenAgent.editProfileJson', when: 'false' },
      { command: 'ohMyOpenAgent.editActiveProfileJson', when: 'false' },
    ]);
  });
});

describe('package.json view/item/context menus', () => {
  it('wires edit and remove commands for override agent items', () => {
    const entries = readPackageJson().contributes?.menus?.['view/item/context'] ?? [];

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'ohMyOpenAgent.editAgent',
          when:
            'view == ohMyOpenAgent.models && (viewItem == agent || viewItem == agentOverride)',
        }),
        expect.objectContaining({
          command: 'ohMyOpenAgent.removeOverride',
          when:
            'view == ohMyOpenAgent.models && (viewItem == agentOverride || viewItem == categoryOverride)',
        }),
      ]),
    );
  });

  it('wires edit and remove commands for override category items', () => {
    const entries = readPackageJson().contributes?.menus?.['view/item/context'] ?? [];

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: 'ohMyOpenAgent.editCategory',
          when:
            'view == ohMyOpenAgent.models && (viewItem == category || viewItem == categoryOverride)',
        }),
        expect.objectContaining({
          command: 'ohMyOpenAgent.removeOverride',
          when:
            'view == ohMyOpenAgent.models && (viewItem == agentOverride || viewItem == categoryOverride)',
        }),
      ]),
    );
  });
});
