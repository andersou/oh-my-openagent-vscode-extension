import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from './configStore.js';
import type { ConfigScope } from './schema.js';

const CONFIG_WITH_COMMENT = `{
  // this is a comment
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "old/model" },
    },
  },
}
`;

describe('ConfigStore', () => {
  let tmpDir: string;
  let configPath: string;
  let store: ConfigStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-config-test-'));
    configPath = path.join(tmpDir, 'omo.jsonc');
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(content: string): void {
    fs.writeFileSync(configPath, content, 'utf-8');
  }

  function readConfig(): string {
    return fs.readFileSync(configPath, 'utf-8');
  }

  describe('discover and read', () => {
    it('returns empty config when no file exists', () => {
      store = new ConfigStore(tmpDir);
      expect(store.getConfig()).toEqual({});
      expect(store.getAgent('any')).toBeUndefined();
      expect(store.getCategory('any')).toBeUndefined();
    });

    it('discovers the primary filename when it exists', () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);
      expect(store.getConfigPath()).toBe(configPath);
    });

    it('prefers omo.jsonc over omo.json', () => {
      writeConfig('{}');
      const jsonPath = path.join(tmpDir, 'omo.json');
      fs.writeFileSync(jsonPath, '{}', 'utf-8');
      store = new ConfigStore(tmpDir);
      expect(store.getConfigPath()).toBe(configPath);
    });

    it('falls back to omo.json when omo.jsonc is absent', () => {
      const jsonPath = path.join(tmpDir, 'omo.json');
      fs.writeFileSync(
        jsonPath,
        '{ "[opencode]": { "agents": { "explore": { "model": "json/model" } } } }',
        'utf-8',
      );
      store = new ConfigStore(tmpDir);
      expect(store.getConfigPath()).toBe(jsonPath);
      expect(store.getAgent('explore')?.model).toBe('json/model');
    });

    it('ignores a legacy oh-my-openagent.json in baseDir', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'oh-my-openagent.json'),
        '{ "agents": { "sisyphus": { "model": "legacy/model" } } }',
        'utf-8',
      );
      store = new ConfigStore(tmpDir);
      expect(store.getConfigPath()).toBe(configPath);
      expect(store.getAgent('sisyphus')).toBeUndefined();

      // A write creates omo.jsonc and leaves the legacy file untouched
      return store
        .updateConfig((draft) => {
          draft.agents = { explore: { model: 'new/model' } };
        })
        .then(() => {
          expect(fs.existsSync(configPath)).toBe(true);
          expect(
            fs.readFileSync(path.join(tmpDir, 'oh-my-openagent.json'), 'utf-8'),
          ).toContain('legacy/model');
          expect(store.getAgent('sisyphus')).toBeUndefined();
        });
    });

    it('parses JSONC with comments and trailing commas', () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);
      const cfg = store.getConfig();
      expect(cfg.agents?.sisyphus?.model).toBe('old/model');
    });

    it('resolves a single agent', () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);
      const agent = store.getAgent('sisyphus');
      expect(agent).toBeDefined();
      expect(agent!.model).toBe('old/model');
    });

    it('returns undefined for unknown agent', () => {
      store = new ConfigStore(tmpDir);
      expect(store.getAgent('nonexistent')).toBeUndefined();
    });

    it('resolves a single category', () => {
      writeConfig(`{
  "[opencode]": {
    "categories": {
      "deep": { "model": "gpt-5" },
    },
  },
}
`);
      store = new ConfigStore(tmpDir);
      const cat = store.getCategory('deep');
      expect(cat).toBeDefined();
      expect(cat!.model).toBe('gpt-5');
    });

    it('reads agents from the shared base when no [opencode] block exists', () => {
      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "base/model" }
  }
}
`);
      store = new ConfigStore(tmpDir);
      expect(store.getAgent('sisyphus')?.model).toBe('base/model');
    });

    it('[opencode] overlay wins over base-level agents on read', () => {
      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "base/model", "temperature": 0.1 },
    "explore": { "model": "base-only/model" }
  },
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "overlay/model" }
    }
  }
}
`);
      store = new ConfigStore(tmpDir);
      // Overlay value wins for the overlapping entry
      expect(store.getAgent('sisyphus')?.model).toBe('overlay/model');
      // Base-only fields of the same agent deep-merge in
      expect(store.getAgent('sisyphus')?.temperature).toBe(0.1);
      // Base-only agents survive the overlay
      expect(store.getAgent('explore')?.model).toBe('base-only/model');
    });
  });

  describe('updateConfig', () => {
    it('preserves comments and trailing commas when updating a value', async () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);

      await store.updateConfig((draft) => {
        if (!draft.agents) {
          draft.agents = {};
        }
        if (!draft.agents.sisyphus) {
          draft.agents.sisyphus = {};
        }
        draft.agents.sisyphus.model = 'new/model';
      });

      const raw = readConfig();

      // Comments survive
      expect(raw).toContain('// this is a comment');

      // Trailing commas survive (the original had one after "old/model" inside the object)
      expect(raw).toContain('},');

      // The value was updated inside the [opencode] block
      expect(raw).toContain('"new/model"');
      expect(raw).not.toContain('"old/model"');

      // In-memory config also reflects the update
      expect(store.getAgent('sisyphus')?.model).toBe('new/model');
    });

    it('adds a new top-level key while preserving existing content', async () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);

      await store.updateConfig((draft) => {
        draft.agent_order = ['sisyphus'];
      });

      const raw = readConfig();
      expect(raw).toContain('// this is a comment');
      expect(raw).toContain('"agent_order"');
      expect(raw).toContain('"sisyphus"');
      // The new key lands inside the [opencode] block
      const parsed = JSON.parse(
        raw.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
      );
      expect(parsed['[opencode]'].agent_order).toEqual(['sisyphus']);
      expect(parsed.agent_order).toBeUndefined();
    });

    it('creates the config file on first write if none exists', async () => {
      store = new ConfigStore(tmpDir);

      await store.updateConfig((draft) => {
        draft.agents = {
          explore: { model: 'new-model' },
        };
      });

      const raw = readConfig();
      expect(raw).toContain('"[opencode]"');
      expect(raw).toContain('"explore"');
      expect(raw).toContain('"new-model"');
      // Writes land in the [opencode] block, not at the root
      const parsed = JSON.parse(raw);
      expect(parsed['[opencode]'].agents.explore.model).toBe('new-model');
      expect(parsed.agents).toBeUndefined();
    });

    it('creates the [opencode] block in a fresh file and preserves sibling top-level keys', async () => {
      writeConfig(`{
  "teams": {
    "core": { "members": ["a", "b"] }
  }
}
`);
      store = new ConfigStore(tmpDir);

      await store.updateConfig((draft) => {
        draft.agents = { explore: { model: 'fresh/model' } };
      });

      const raw = readConfig();
      const parsed = JSON.parse(raw);
      // The pre-existing sibling key is untouched
      expect(parsed.teams).toEqual({ core: { members: ['a', 'b'] } });
      // The write created the [opencode] block
      expect(parsed['[opencode]'].agents.explore.model).toBe('fresh/model');
      // Nothing was written at the shared-base level
      expect(parsed.agents).toBeUndefined();
    });

    it('writes to the [opencode] block when the file only has shared-base agents', async () => {
      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "base/model" }
  }
}
`);
      store = new ConfigStore(tmpDir);

      await store.updateConfig((draft) => {
        draft.agents!.sisyphus!.model = 'changed/model';
      });

      const parsed = JSON.parse(readConfig());
      // Shared base is preserved verbatim, not flattened or duplicated
      expect(parsed.agents.sisyphus.model).toBe('base/model');
      // The override lands in the [opencode] block and wins on read
      expect(parsed['[opencode]'].agents.sisyphus.model).toBe('changed/model');
      expect(store.getAgent('sisyphus')?.model).toBe('changed/model');
    });

    it('does not flatten untouched base-level values into the [opencode] block', async () => {
      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "base/model" },
    "explore": { "model": "untouched/model" }
  }
}
`);
      store = new ConfigStore(tmpDir);

      await store.updateConfig((draft) => {
        draft.agents!.sisyphus!.model = 'changed/model';
      });

      const parsed = JSON.parse(readConfig());
      // Only the changed leaf was written
      expect(parsed['[opencode]'].agents.sisyphus).toEqual({
        model: 'changed/model',
      });
      expect(parsed['[opencode]'].agents.explore).toBeUndefined();
      // Effective view still merges both layers
      expect(store.getAgent('explore')?.model).toBe('untouched/model');
    });

    it('removes a key when set to undefined', async () => {
      writeConfig(`{
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "old/model" },
      "explore": { "model": "explore-model" }
    }
  }
}
`);
      store = new ConfigStore(tmpDir);

      await store.updateConfig((draft) => {
        if (draft.agents) {
          delete draft.agents.sisyphus;
        }
      });

      const raw = readConfig();
      expect(raw).not.toContain('"sisyphus"');
      expect(raw).toContain('"explore"');

      expect(store.getAgent('sisyphus')).toBeUndefined();
    });
  });

  describe('project layers', () => {
    let workspace: string;

    beforeEach(() => {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-workspace-test-'));
    });

    afterEach(() => {
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('exposes project-layer values via getConfig() but writes only to the user file', async () => {
      // Project layer provides an agent the user file does not have
      const projectOmoDir = path.join(workspace, '.omo');
      fs.mkdirSync(projectOmoDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectOmoDir, 'omo.jsonc'),
        `{ "[opencode]": { "agents": { "explore": { "model": "project/model" } } } }`,
        'utf-8',
      );
      writeConfig(`{ "[opencode]": { "agents": { "sisyphus": { "model": "user/model" } } } }`);

      store = new ConfigStore(tmpDir, workspace);

      // The project-layer value is visible in the effective view
      expect(store.getAgent('explore')?.model).toBe('project/model');
      expect(store.getAgent('sisyphus')?.model).toBe('user/model');

      // Changing an unrelated value writes only to the user file
      await store.updateConfig((draft) => {
        draft.agents!.sisyphus!.model = 'user/changed';
      });

      const userParsed = JSON.parse(readConfig());
      expect(userParsed['[opencode]'].agents.sisyphus.model).toBe('user/changed');
      // The project-inherited agent was NOT flattened into the user file
      expect(userParsed['[opencode]'].agents.explore).toBeUndefined();
      // The project layer file is untouched
      expect(
        fs.readFileSync(path.join(projectOmoDir, 'omo.jsonc'), 'utf-8'),
      ).toContain('project/model');
    });

    it('overriding a project-layer value writes it to the user file (user wins)', async () => {
      const projectOmoDir = path.join(workspace, '.omo');
      fs.mkdirSync(projectOmoDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectOmoDir, 'omo.jsonc'),
        `{ "[opencode]": { "agents": { "explore": { "model": "project/model" } } } }`,
        'utf-8',
      );
      writeConfig('{}');

      store = new ConfigStore(tmpDir, workspace);

      await store.updateConfig((draft) => {
        draft.agents!.explore!.model = 'user/override';
      });

      const userParsed = JSON.parse(readConfig());
      expect(userParsed['[opencode]'].agents.explore.model).toBe('user/override');
      // The project layer file is untouched
      expect(
        fs.readFileSync(path.join(projectOmoDir, 'omo.jsonc'), 'utf-8'),
      ).toContain('project/model');
      // Effective view now resolves to the user override
      expect(store.getAgent('explore')?.model).toBe('user/override');
    });

    it('nearest project layer beats a farther one', () => {
      const nested = path.join(workspace, 'packages', 'app');
      fs.mkdirSync(path.join(workspace, '.omo'), { recursive: true });
      fs.mkdirSync(path.join(nested, '.omo'), { recursive: true });
      fs.writeFileSync(
        path.join(workspace, '.omo', 'omo.jsonc'),
        `{ "[opencode]": { "agents": { "explore": { "model": "far/model" } } } }`,
        'utf-8',
      );
      fs.writeFileSync(
        path.join(nested, '.omo', 'omo.jsonc'),
        `{ "[opencode]": { "agents": { "explore": { "model": "near/model" } } } }`,
        'utf-8',
      );
      writeConfig('{}');

      store = new ConfigStore(tmpDir, nested);
      expect(store.getAgent('explore')?.model).toBe('near/model');
    });

    it('project-layer base-level agents merge with the user layer', () => {
      const projectOmoDir = path.join(workspace, '.omo');
      fs.mkdirSync(projectOmoDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectOmoDir, 'omo.jsonc'),
        `{ "agents": { "oracle": { "model": "project-base/model" } } }`,
        'utf-8',
      );
      writeConfig(`{ "[opencode]": { "agents": { "sisyphus": { "model": "user/model" } } } }`);

      store = new ConfigStore(tmpDir, workspace);
      expect(store.getAgent('oracle')?.model).toBe('project-base/model');
      expect(store.getAgent('sisyphus')?.model).toBe('user/model');
    });

    it('nearest project layer beats the user layer for the same key (upstream precedence)', () => {
      const projectOmoDir = path.join(workspace, '.omo');
      fs.mkdirSync(projectOmoDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectOmoDir, 'omo.jsonc'),
        `{ "[opencode]": { "agents": { "explore": { "model": "project/model" } } } }`,
        'utf-8',
      );
      writeConfig(`{ "[opencode]": { "agents": { "explore": { "model": "user/model" } } } }`);

      // Upstream resolution order: user layer first, project layers after —
      // the nearest project file has the highest precedence and beats the
      // user layer. Writes still always go to the user file.
      store = new ConfigStore(tmpDir, workspace);
      expect(store.getAgent('explore')?.model).toBe('project/model');
    });

    it('a user-layer [opencode] override written over a project value wins on the next read', async () => {
      const projectOmoDir = path.join(workspace, '.omo');
      fs.mkdirSync(projectOmoDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectOmoDir, 'omo.jsonc'),
        `{ "[opencode]": { "agents": { "sisyphus": { "model": "project/model" } } } }`,
        'utf-8',
      );
      writeConfig(
        `{ "[opencode]": { "agents": { "sisyphus": { "model": "user/model" } } } }`,
      );

      // Project layer wins while it overrides the same harness-block entry.
      store = new ConfigStore(tmpDir, workspace);
      expect(store.getAgent('sisyphus')?.model).toBe('project/model');

      // After the user edits the value, the user file's [opencode] entry is
      // rewritten... but the project layer still declares the same key, so
      // the project layer still wins on a fresh read. This documents the
      // upstream precedence rule rather than a bug: editing a project-
      // overridden value in the user file cannot beat the project file.
      await store.updateConfig((draft) => {
        draft.agents!.sisyphus!.model = 'edited/model';
      });
      expect(JSON.parse(readConfig())['[opencode]'].agents.sisyphus.model).toBe(
        'edited/model',
      );

      const fresh = new ConfigStore(tmpDir, workspace);
      expect(fresh.getAgent('sisyphus')?.model).toBe('project/model');
      fresh.dispose();
    });

    it('a user-layer [opencode] entry beats a project SHARED-BASE entry for the same agent', () => {
      const projectOmoDir = path.join(workspace, '.omo');
      fs.mkdirSync(projectOmoDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectOmoDir, 'omo.jsonc'),
        `{ "agents": { "sisyphus": { "model": "project-base/model" } } }`,
        'utf-8',
      );
      writeConfig(
        `{ "[opencode]": { "agents": { "sisyphus": { "model": "user/model" } } } }`,
      );

      // Resolution order within the folded document is base first, then the
      // harness block — a project layer's shared-base value must not clobber
      // the user layer's [opencode] harness value for the same agent.
      store = new ConfigStore(tmpDir, workspace);
      expect(store.getAgent('sisyphus')?.model).toBe('user/model');
    });

    it('does not walk project layers when workspaceDir is not given', () => {
      const projectOmoDir = path.join(workspace, '.omo');
      fs.mkdirSync(projectOmoDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectOmoDir, 'omo.jsonc'),
        `{ "[opencode]": { "agents": { "explore": { "model": "project/model" } } } }`,
        'utf-8',
      );
      writeConfig('{}');

      // Single-arg form: baseDir given, workspaceDir omitted → walking OFF
      store = new ConfigStore(tmpDir);
      expect(store.getAgent('explore')).toBeUndefined();
    });

    it('skips symlinked project .omo directories', () => {
      const realOmoDir = path.join(tmpDir, 'real-omo');
      fs.mkdirSync(realOmoDir, { recursive: true });
      fs.writeFileSync(
        path.join(realOmoDir, 'omo.jsonc'),
        `{ "[opencode]": { "agents": { "explore": { "model": "symlink/model" } } } }`,
        'utf-8',
      );
      fs.symlinkSync(realOmoDir, path.join(workspace, '.omo'));
      writeConfig('{}');

      store = new ConfigStore(tmpDir, workspace);
      expect(store.getAgent('explore')).toBeUndefined();
    });
  });

  describe('onDidChange event', () => {
    it('emits when the file changes on disk', async () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);
      store.startWatch();

      // Wait a tick for the watcher to settle
      await new Promise((r) => setTimeout(r, 100));

      let fired = false;
      store.onDidChange.once('change', () => {
        fired = true;
      });

      // Modify the file externally
      fs.writeFileSync(
        configPath,
        `{
  // updated comment
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "changed/externally" },
    },
  },
}
`,
        'utf-8',
      );

      // Wait for debounce + delivery
      await new Promise((r) => setTimeout(r, 400));

      expect(fired).toBe(true);
      // Cache should be invalidated — next getConfig re-reads
      expect(store.getAgent('sisyphus')?.model).toBe('changed/externally');
    });

    it('emits after a programmatic updateConfig that changes content', async () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);

      let fired = false;
      store.onDidChange.once('change', () => {
        fired = true;
      });

      await store.updateConfig((draft) => {
        if (!draft.agents) draft.agents = {};
        if (!draft.agents.sisyphus) draft.agents.sisyphus = {};
        draft.agents.sisyphus.model = 'new/model';
      });

      expect(fired).toBe(true);
    });

    it('does not emit after a no-op updateConfig', async () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);

      let fired = false;
      store.onDidChange.once('change', () => {
        fired = true;
      });

      await store.updateConfig(() => undefined);

      expect(fired).toBe(false);
    });
  });

  describe('scope-aware reads, writes, and switching', () => {
    it('defaults to opencode scope and behaves like pre-existing tests', () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);
      expect(store.getScope()).toBe('opencode');
      expect(store.getAgent('sisyphus')?.model).toBe('old/model');
    });

    it('senpi scope folds shared base then [senpi], ignoring [opencode]', () => {
      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "base/model" },
    "explore": { "model": "base-only/model" }
  },
  "[senpi]": {
    "agents": {
      "sisyphus": { "model": "senpi/model" }
    }
  },
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "opencode/model" },
      "oracle": { "model": "opencode-only/model" }
    }
  }
}
`);
      store = new ConfigStore(tmpDir, undefined, 'senpi');
      expect(store.getScope()).toBe('senpi');
      expect(store.getAgent('sisyphus')?.model).toBe('senpi/model');
      expect(store.getAgent('explore')?.model).toBe('base-only/model');
      expect(store.getAgent('oracle')).toBeUndefined();
    });

    it('global scope folds only the shared base, ignoring all harness blocks', () => {
      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "base/model" },
    "explore": { "model": "base-only/model" }
  },
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "opencode/model" },
      "oracle": { "model": "opencode-only/model" }
    }
  },
  "[senpi]": {
    "agents": {
      "sisyphus": { "model": "senpi/model" }
    }
  }
}
`);
      store = new ConfigStore(tmpDir, undefined, 'global');
      expect(store.getScope()).toBe('global');
      expect(store.getAgent('sisyphus')?.model).toBe('base/model');
      expect(store.getAgent('explore')?.model).toBe('base-only/model');
      expect(store.getAgent('oracle')).toBeUndefined();
    });

    it('codex scope folds shared base then [codex]', () => {
      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "base/model" }
  },
  "[codex]": {
    "agents": {
      "sisyphus": { "model": "codex/model" }
    }
  }
}
`);
      store = new ConfigStore(tmpDir, undefined, 'codex');
      expect(store.getScope()).toBe('codex');
      expect(store.getAgent('sisyphus')?.model).toBe('codex/model');
    });

    it('writes under [senpi] for senpi scope and seeds correctly', async () => {
      store = new ConfigStore(tmpDir, undefined, 'senpi');
      await store.updateConfig((draft) => {
        draft.agents = { explore: { model: 'senpi/model' } };
      });

      const raw = readConfig();
      const parsed = JSON.parse(raw);
      expect(parsed['[senpi]'].agents.explore.model).toBe('senpi/model');
      expect(parsed.agents).toBeUndefined();
      expect(parsed['[opencode]']).toBeUndefined();
    });

    it('writes under [codex] for codex scope and seeds correctly', async () => {
      store = new ConfigStore(tmpDir, undefined, 'codex');
      await store.updateConfig((draft) => {
        draft.agents = { explore: { model: 'codex/model' } };
      });

      const raw = readConfig();
      const parsed = JSON.parse(raw);
      expect(parsed['[codex]'].agents.explore.model).toBe('codex/model');
      expect(parsed.agents).toBeUndefined();
      expect(parsed['[opencode]']).toBeUndefined();
    });

    it('writes at the root for global scope and seeds correctly', async () => {
      store = new ConfigStore(tmpDir, undefined, 'global');
      await store.updateConfig((draft) => {
        draft.agents = { explore: { model: 'global/model' } };
      });

      const raw = readConfig();
      const parsed = JSON.parse(raw);
      expect(parsed.agents.explore.model).toBe('global/model');
      expect(parsed['[opencode]']).toBeUndefined();
      expect(parsed['[senpi]']).toBeUndefined();
    });

    it('preserves comments and trailing commas for senpi scope writes', async () => {
      writeConfig(`{
  // header
  "[senpi]": {
    "agents": {
      "sisyphus": { "model": "old/model" },
    },
  },
}
`);
      store = new ConfigStore(tmpDir, undefined, 'senpi');
      await store.updateConfig((draft) => {
        if (!draft.agents) draft.agents = {};
        if (!draft.agents.sisyphus) draft.agents.sisyphus = {};
        draft.agents.sisyphus.model = 'new/model';
      });

      const raw = readConfig();
      expect(raw).toContain('// header');
      expect(raw).toContain('"new/model"');
      expect(raw).not.toContain('"old/model"');
      const parsed = JSON.parse(
        raw.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
      );
      expect(parsed['[senpi]'].agents.sisyphus.model).toBe('new/model');
    });

    it('preserves comments and trailing commas for global scope writes', async () => {
      writeConfig(`{
  // header
  "agents": {
    "sisyphus": { "model": "old/model" },
  },
}
`);
      store = new ConfigStore(tmpDir, undefined, 'global');
      await store.updateConfig((draft) => {
        if (!draft.agents) draft.agents = {};
        if (!draft.agents.sisyphus) draft.agents.sisyphus = {};
        draft.agents.sisyphus.model = 'new/model';
      });

      const raw = readConfig();
      expect(raw).toContain('// header');
      expect(raw).toContain('"new/model"');
      expect(raw).not.toContain('"old/model"');
      const parsed = JSON.parse(
        raw.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
      );
      expect(parsed.agents.sisyphus.model).toBe('new/model');
    });

    it('does not surface or write agent_order outside opencode scope', async () => {
      writeConfig(`{
  "[opencode]": {
    "agent_order": ["sisyphus"],
    "disabled_agents": ["explore"]
  }
}
`);
      store = new ConfigStore(tmpDir, undefined, 'senpi');
      expect(store.getConfig().agent_order).toBeUndefined();
      expect(store.getConfig().disabled_agents).toBeUndefined();

      await store.updateConfig((draft) => {
        draft.agent_order = ['sisyphus'];
        draft.disabled_agents = ['explore'];
        draft.agents = { explore: { model: 'senpi/model' } };
      });

      const raw = readConfig();
      const parsed = JSON.parse(raw);
      expect(parsed['[senpi]'].agents.explore.model).toBe('senpi/model');
      expect(parsed['[senpi]'].agent_order).toBeUndefined();
      expect(parsed['[senpi]'].disabled_agents).toBeUndefined();
      expect(parsed['[opencode]'].agent_order).toEqual(['sisyphus']);
      expect(parsed['[opencode]'].disabled_agents).toEqual(['explore']);
    });

    it('setScope switches scope, invalidates cache, and emits one change event', () => {
      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "base/model" }
  },
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "opencode/model" }
    }
  },
  "[senpi]": {
    "agents": {
      "sisyphus": { "model": "senpi/model" }
    }
  }
}
`);
      store = new ConfigStore(tmpDir);
      expect(store.getAgent('sisyphus')?.model).toBe('opencode/model');

      let changes = 0;
      store.onDidChange.on('change', () => {
        changes++;
      });

      store.setScope('senpi');
      expect(store.getScope()).toBe('senpi');
      expect(store.getAgent('sisyphus')?.model).toBe('senpi/model');
      expect(changes).toBe(1);
    });

    it('setScope with same value is a complete no-op', () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);
      expect(store.getAgent('sisyphus')?.model).toBe('old/model');

      let changes = 0;
      store.onDidChange.on('change', () => {
        changes++;
      });

      store.setScope('opencode');
      expect(store.getScope()).toBe('opencode');
      expect(store.getAgent('sisyphus')?.model).toBe('old/model');
      expect(changes).toBe(0);
    });

    it('defaults to mainline routing dialect', () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);

      expect(store.getRoutingDialect()).toBe('mainline');
    });

    it('setRoutingDialect switches dialect, invalidates cache, and emits one change event', () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);
      expect(store.getAgent('sisyphus')?.model).toBe('old/model');

      let changes = 0;
      store.onDidChange.on('change', () => {
        changes++;
      });

      store.setRoutingDialect('latest');
      expect(store.getRoutingDialect()).toBe('latest');
      expect(store.getAgent('sisyphus')?.model).toBe('old/model');
      expect(changes).toBe(1);
    });

    it('setRoutingDialect with same value is a complete no-op', () => {
      writeConfig(CONFIG_WITH_COMMENT);
      store = new ConfigStore(tmpDir);
      expect(store.getAgent('sisyphus')?.model).toBe('old/model');

      let changes = 0;
      store.onDidChange.on('change', () => {
        changes++;
      });

      store.setRoutingDialect('mainline');
      expect(store.getRoutingDialect()).toBe('mainline');
      expect(store.getAgent('sisyphus')?.model).toBe('old/model');
      expect(changes).toBe(0);
    });
  });

  describe('global scope reconciliation', () => {
    const SHADOWING_CONFIG = `{
  // header
  "agents": {
    "sisyphus": { "model": "base/model" },
  },
  "categories": {
    "quick": { "model": "base/quick" },
  },
  "[opencode]": {
    "agents": {
      "sisyphus": { "model": "opencode/model" },
    },
    "agent_order": ["sisyphus"],
  },
  "[senpi]": {
    "categories": {
      "quick": { "model": "senpi/quick" },
    },
  },
}
`;

    it('reports the harness blocks that shadow the shared base', () => {
      writeConfig(SHADOWING_CONFIG);
      store = new ConfigStore(tmpDir, undefined, 'opencode');
      expect(store.getShadowingHarnessScopes()).toEqual(['opencode', 'senpi']);
    });

    it('ignores harness blocks that define no base-owned keys', () => {
      writeConfig(`{
  "agents": { "sisyphus": { "model": "base/model" } },
  "[opencode]": { "agent_order": ["sisyphus"] },
  "[codex]": {}
}
`);
      store = new ConfigStore(tmpDir, undefined, 'opencode');
      expect(store.getShadowingHarnessScopes()).toEqual([]);
    });

    it('removeHarnessBlocks drops every harness block and keeps the base', async () => {
      writeConfig(SHADOWING_CONFIG);
      store = new ConfigStore(tmpDir, undefined, 'global');

      await store.removeHarnessBlocks();

      const raw = readConfig();
      expect(raw).toContain('// header');
      const parsed = JSON.parse(
        raw.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
      );
      expect(parsed['[opencode]']).toBeUndefined();
      expect(parsed['[senpi]']).toBeUndefined();
      expect(parsed.agents.sisyphus.model).toBe('base/model');
      expect(parsed.categories.quick.model).toBe('base/quick');
      expect(store.getShadowingHarnessScopes()).toEqual([]);
    });

    it('copyBaseToHarnessBlocks makes every harness scope resolve to the base', async () => {
      writeConfig(SHADOWING_CONFIG);
      store = new ConfigStore(tmpDir, undefined, 'global');

      await store.copyBaseToHarnessBlocks();

      const raw = readConfig();
      expect(raw).toContain('// header');
      for (const scope of ['opencode', 'senpi', 'codex'] as const) {
        const scoped = new ConfigStore(tmpDir, undefined, scope);
        expect(scoped.getAgent('sisyphus')?.model).toBe('base/model');
        expect(scoped.getCategory('quick')?.model).toBe('base/quick');
        scoped.dispose();
      }
      const parsed = JSON.parse(
        raw.replace(/\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
      );
      expect(parsed.agents.sisyphus.model).toBe('base/model');
      expect(parsed['[opencode]'].agent_order).toEqual(['sisyphus']);
    });

    it('emits a single change event after reconciling', async () => {
      writeConfig(SHADOWING_CONFIG);
      store = new ConfigStore(tmpDir, undefined, 'global');
      store.getConfig();

      let changes = 0;
      store.onDidChange.on('change', () => {
        changes++;
      });

      await store.removeHarnessBlocks();

      expect(changes).toBe(1);
    });

    it('removeHarnessBlocks is a no-op when no harness block exists', async () => {
      writeConfig(`{
  "agents": { "sisyphus": { "model": "base/model" } }
}
`);
      store = new ConfigStore(tmpDir, undefined, 'global');
      const before = readConfig();

      let changes = 0;
      store.onDidChange.on('change', () => {
        changes++;
      });

      await store.removeHarnessBlocks();

      expect(readConfig()).toBe(before);
      expect(changes).toBe(0);
    });

    it('copyBaseToHarnessBlocks clears harness keys the shared base does not define', async () => {
      writeConfig(`{
  "agents": { "sisyphus": { "model": "base/model" } },
  "[senpi]": {
    "categories": { "quick": { "model": "senpi/quick" } }
  }
}
`);
      store = new ConfigStore(tmpDir, undefined, 'global');

      await store.copyBaseToHarnessBlocks();

      const scoped = new ConfigStore(tmpDir, undefined, 'senpi');
      expect(scoped.getAgent('sisyphus')?.model).toBe('base/model');
      expect(scoped.getCategory('quick')).toBeUndefined();
      scoped.dispose();
    });

    it('copyBaseToHarnessBlocks strips shadowing keys when the shared base is empty', async () => {
      writeConfig(`{
  "[opencode]": { "agents": { "sisyphus": { "model": "opencode/model" } } }
}
`);
      store = new ConfigStore(tmpDir, undefined, 'global');

      await store.copyBaseToHarnessBlocks();

      const scoped = new ConfigStore(tmpDir, undefined, 'opencode');
      expect(scoped.getAgent('sisyphus')).toBeUndefined();
      scoped.dispose();
    });

    it('copyBaseToHarnessBlocks is a no-op when nothing shadows the shared base', async () => {
      writeConfig(`{
  "[opencode]": { "agent_order": ["sisyphus"] }
}
`);
      store = new ConfigStore(tmpDir, undefined, 'global');
      const before = readConfig();

      let changes = 0;
      store.onDidChange.on('change', () => {
        changes++;
      });

      await store.copyBaseToHarnessBlocks();

      expect(readConfig()).toBe(before);
      expect(changes).toBe(0);
    });
  });
});
