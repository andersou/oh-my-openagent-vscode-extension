import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

type ViewItemContextMenuEntry = {
  command: string;
  when: string;
  group?: string;
};

function readPackageJson(): { contributes?: { menus?: { 'view/item/context'?: ViewItemContextMenuEntry[] } } } {
  const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf-8');
  return JSON.parse(raw) as { contributes?: { menus?: { 'view/item/context'?: ViewItemContextMenuEntry[] } } };
}

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
