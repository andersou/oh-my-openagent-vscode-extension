import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore } from './configStore.js';

const CONFIG_WITH_COMMENT = `{
  // this is a comment
  "agents": {
    "sisyphus": { "model": "old/model" },
  },
}
`;

describe('ConfigStore', () => {
  let tmpDir: string;
  let configPath: string;
  let store: ConfigStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-config-test-'));
    configPath = path.join(tmpDir, 'oh-my-openagent.json');
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
  "categories": {
    "deep": { "model": "gpt-5" },
  },
}
`);
      store = new ConfigStore(tmpDir);
      const cat = store.getCategory('deep');
      expect(cat).toBeDefined();
      expect(cat!.model).toBe('gpt-5');
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

      // The value was updated
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
    });

    it('creates the config file on first write if none exists', async () => {
      store = new ConfigStore(tmpDir);

      await store.updateConfig((draft) => {
        draft.agents = {
          explore: { model: 'new-model' },
        };
      });

      const raw = readConfig();
      expect(raw).toContain('"explore"');
      expect(raw).toContain('"new-model"');
    });

    it('removes a key when set to undefined', async () => {
      writeConfig(`{
  "agents": {
    "sisyphus": { "model": "old/model" },
    "explore": { "model": "explore-model" }
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
  "agents": {
    "sisyphus": { "model": "changed/externally" },
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
  });
});
