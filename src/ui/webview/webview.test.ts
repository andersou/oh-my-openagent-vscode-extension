import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Window,
  type HTMLInputElement,
  type HTMLButtonElement,
  type HTMLDataListElement,
  type HTMLOptionElement,
  type HTMLElement,
} from 'happy-dom';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Webview integration test
//
// Loads the bundled `out/webview.js` (built by esbuild from
// `src/ui/webview/main.js`) into a happy-dom `Window`, injects the
// `src/ui/webview/webview.html` template with template placeholders
// replaced by test values, and exercises the host <-> webview message
// protocol that powers the lazy model picker:
//
//   host -> webview: { command: 'init',            type, name, config, ... }
//                     { command: 'modelsLoading' }
//                     { command: 'modelsLoaded',   models: [{ modelId }] }
//                     { command: 'modelsUnavailable', error }
//
//   webview -> host: { command: 'ready' }
// ---------------------------------------------------------------------------

const HTML_PATH = path.resolve(__dirname, 'webview.html');
const JS_PATH = path.resolve(__dirname, '../../../out/webview.js');

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
  setState: (state: unknown) => void;
  getState: () => unknown;
}

interface WebviewTestEnv {
  window: Window;
  messages: unknown[];
  states: unknown[];
}

/**
 * Build a fresh happy-dom Window with the webview HTML + bundled script
 * loaded. Returns the window and arrays that record every message sent
 * to the host and every state snapshot persisted.
 */
async function createWebviewWindow(): Promise<WebviewTestEnv> {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const js = fs.readFileSync(JS_PATH, 'utf8');

  const window = new Window({ url: 'https://example.invalid/' });

  const messages: unknown[] = [];
  const states: unknown[] = [];
  let currentState: unknown = undefined;

  const mockApi: VsCodeApi = {
    postMessage: (msg: unknown) => {
      messages.push(msg);
    },
    setState: (state: unknown) => {
      states.push(state);
      currentState = state;
    },
    getState: () => currentState,
  };

  // The webview reads `globalThis.acquireVsCodeApi` and then *calls* it
  // to obtain the API surface. We expose a factory that returns the mock.
  (window as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi =
    () => mockApi;

  // Replace template placeholders. The CSP nonce and cspSource are only
  // meaningful inside a real VS Code webview; we use inert values so the
  // template still parses. The `{{webviewCss}}` slot becomes an empty
  // string — we don't need real styles for these behavioral assertions.
  const processedHtml = html
    .replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{cspSource}}', "'self'")
    .replaceAll('{{webviewCss}}', '')
    .replaceAll('{{webviewJsUri}}', './webview.js');

  // Strip the external <script src="..."> tag — we evaluate the bundle
  // ourselves so happy-dom doesn't try to fetch a non-existent URL.
  const htmlNoScript = processedHtml.replace(
    /<script\s+[^>]*src="[^"]*"[^>]*>\s*<\/script>/i,
    '',
  );

  // Inject the HTML body. After close(), the document is in 'complete'
  // state, so the webview's boot() runs synchronously when we eval below.
  window.document.open();
  window.document.write(htmlNoScript);
  window.document.close();

  await new Promise((resolve) => setTimeout(resolve, 10));
  await window.happyDOM.waitUntilComplete();

  // Run the bundled webview in the window's global scope. The bundle is
  // an IIFE that wires up event listeners and calls boot().
  window.eval(js);

  return { window, messages, states };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webview lazy model picker (end-to-end)', () => {
  let env: WebviewTestEnv;

  beforeEach(async () => {
    env = await createWebviewWindow();
  });

  afterEach(async () => {
    await env.window.happyDOM.close();
  });

  it('announces ready on boot', async () => {
    // The bundle's boot() posts { command: 'ready' } synchronously when
    // vscode is available. Verify the host would receive it.
    expect(env.messages).toContainEqual({ command: 'ready' });
  });

  it('handles init -> modelsLoading -> modelsLoaded -> modelsUnavailable', async () => {
    const { window, messages } = env;
    const document = window.document;

    // ---- 1. init: form values populated from config ----
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'custom/model' },
    });
    await window.happyDOM.waitUntilComplete();

    const modelInput = document.getElementById('f-model') as HTMLInputElement;
    expect(modelInput).not.toBeNull();
    expect(modelInput.value).toBe('custom/model');

    // The init also enables the action buttons.
    const btnSave = document.getElementById('btn-save') as HTMLButtonElement;
    expect(btnSave.disabled).toBe(false);
    const btnCreateProfile = document.getElementById(
      'btn-create-profile',
    ) as HTMLButtonElement;
    expect(btnCreateProfile.disabled).toBe(false);

    // Sanity: the host should NOT have received a 'save' yet.
    expect(
      messages.some(
        (m): m is { command: string } =>
          typeof m === 'object' &&
          m !== null &&
          (m as { command?: unknown }).command === 'save',
      ),
    ).toBe(false);

    // ---- 2. modelsLoading: status element shows loading text ----
    window.postMessage({ command: 'modelsLoading' });
    await window.happyDOM.waitUntilComplete();

    const modelStatus = document.getElementById('model-status') as HTMLElement;
    expect(modelStatus).not.toBeNull();
    expect(modelStatus.hidden).toBe(false);
    expect(modelStatus.textContent).toBe('Loading available models…');
    expect(modelStatus.className).toContain('field__model-status--loading');

    // Datalist should still be empty before models arrive.
    const datalist = document.getElementById(
      'model-datalist',
    ) as HTMLDataListElement;
    expect(datalist.querySelectorAll('option')).toHaveLength(0);

    // ---- 3. modelsLoaded: datalist populated, status updates ----
    window.postMessage({
      command: 'modelsLoaded',
      models: [
        { modelId: 'openai/gpt-4.1' },
        { modelId: 'anthropic/claude-sonnet-4-20250514' },
        { modelId: 'google/gemini-2.5-pro' },
      ],
    });
    await window.happyDOM.waitUntilComplete();

    const options = datalist.querySelectorAll('option');
    expect(options).toHaveLength(3);
    expect(options[0]?.value).toBe('openai/gpt-4.1');
    expect(options[1]?.value).toBe('anthropic/claude-sonnet-4-20250514');
    expect(options[2]?.value).toBe('google/gemini-2.5-pro');

    // Each option is a real <option> element with the expected value.
    for (const opt of Array.from(options)) {
      expect((opt as HTMLOptionElement).tagName).toBe('OPTION');
    }

    expect(modelStatus.textContent).toBe(
      '3 models available \u2014 type to filter.',
    );
    expect(modelStatus.className).toContain('field__model-status--loaded');
    expect(modelStatus.hidden).toBe(false);

    // The user-typed value should not be clobbered by the model list.
    expect(modelInput.value).toBe('custom/model');

    // ---- 4. modelsUnavailable: status shows fallback, input preserved ----
    window.postMessage({
      command: 'modelsUnavailable',
      error: 'opencode CLI not found',
    });
    await window.happyDOM.waitUntilComplete();

    expect(modelStatus.textContent).toBe(
      'Model list unavailable (opencode CLI not found). You can type any model identifier.',
    );
    expect(modelStatus.className).toContain('field__model-status--unavailable');
    expect(modelStatus.hidden).toBe(false);

    // The datalist still holds the last successfully-loaded models so the
    // user keeps the benefit of autocomplete from the earlier load.
    expect(datalist.querySelectorAll('option')).toHaveLength(3);

    // The user-entered value must not be touched.
    expect(modelInput.value).toBe('custom/model');

    // And the host still has not received a 'save' — availability messages
    // are display-only and must not mutate or submit the form.
    const saveMessages = messages.filter(
      (m): m is { command: string } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { command?: unknown }).command === 'save',
    );
    expect(saveMessages).toHaveLength(0);
  });

  it('renders a reload button that posts reloadModels', async () => {
    const { window, messages } = env;
    const document = window.document;
    await window.happyDOM.waitUntilComplete();

    const btnReload = document.getElementById('btn-reload-models') as HTMLButtonElement;
    expect(btnReload).not.toBeNull();
    expect(btnReload.title.length).toBeGreaterThan(0);

    btnReload.click();
    await window.happyDOM.waitUntilComplete();

    expect(messages).toContainEqual({ command: 'reloadModels' });
  });

  it('posts modelChanged when the model input changes', async () => {
    const { window, messages } = env;
    const document = window.document;

    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'custom/model' },
    });
    await window.happyDOM.waitUntilComplete();

    const modelInput = document.getElementById('f-model') as HTMLInputElement;
    modelInput.value = 'openai/gpt-4.1';
    modelInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    modelInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    expect(messages).toContainEqual({ command: 'modelChanged', modelId: 'openai/gpt-4.1' });
  });

  it('updates dynamic fields based on selected model capabilities', async () => {
    const { window } = env;
    const document = window.document;

    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'no-temp/model' },
    });
    await window.happyDOM.waitUntilComplete();

    window.postMessage({
      command: 'modelsLoaded',
      models: [
        {
          modelId: 'no-temp/model',
          capabilities: { temperature: false, reasoning: true },
          variants: { low: { reasoningEffort: 'low' } },
        },
      ],
    });
    await window.happyDOM.waitUntilComplete();

    const temperatureInput = document.getElementById('f-temperature') as HTMLInputElement;
    expect(temperatureInput.disabled).toBe(true);
    expect(temperatureInput.title).toContain('temperature');

    const reasoningSelect = document.getElementById('f-reasoning') as HTMLSelectElement;
    expect(reasoningSelect.disabled).toBe(false);

    const variantSelect = document.getElementById('f-variant') as HTMLSelectElement;
    const variantOptions = Array.from(variantSelect.options).map((o) => o.value);
    expect(variantOptions).toContain('low');
  });

  it('enables inputs when the model supports the capability', async () => {
    const { window } = env;
    const document = window.document;

    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'full/model' },
    });
    await window.happyDOM.waitUntilComplete();

    window.postMessage({
      command: 'modelsLoaded',
      models: [
        {
          modelId: 'full/model',
          capabilities: { temperature: true, reasoning: true },
        },
      ],
    });
    await window.happyDOM.waitUntilComplete();

    const temperatureInput = document.getElementById('f-temperature') as HTMLInputElement;
    expect(temperatureInput.disabled).toBe(false);
  });

  it('adds a fallback card when the Add button is clicked', async () => {
    const { window } = env;
    await new Promise((r) => setTimeout(r, 50));
    await window.happyDOM.waitUntilComplete();

    const btnAdd = window.document.getElementById('btn-add-fallback') as HTMLButtonElement;
    expect(btnAdd).not.toBeNull();
    const list = window.document.getElementById('fallback-list');
    expect(list).not.toBeNull();

    btnAdd.click();
    await window.happyDOM.waitUntilComplete();
    await new Promise((r) => setTimeout(r, 50));

    const cards = window.document.querySelectorAll('.fallback-card');
    expect(cards).toHaveLength(1);
  });

  it('renders existing fallback models as cards on init', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: {
        model: 'main/model',
        fallback_models: [
          'openai/gpt-4o',
          { model: 'anthropic/claude-haiku', temperature: 0.3 },
        ],
      },
    });
    await window.happyDOM.waitUntilComplete();

    const cards = window.document.querySelectorAll('.fallback-card');
    expect(cards).toHaveLength(2);
  });

  it('removes a fallback card when Remove is clicked', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'main/model', fallback_models: ['a', 'b'] },
    });
    await window.happyDOM.waitUntilComplete();

    const removeBtn = window.document.querySelector('.fallback-card__remove') as HTMLButtonElement;
    removeBtn.click();
    await window.happyDOM.waitUntilComplete();

    const cards = window.document.querySelectorAll('.fallback-card');
    expect(cards).toHaveLength(1);
  });

  it('serializes fallback cards into the save payload', async () => {
    const { window, messages } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: {
        model: 'main/model',
        fallback_models: [{ model: 'openai/gpt-4o', temperature: 0.3 }],
      },
    });
    await window.happyDOM.waitUntilComplete();

    const saveBtn = window.document.getElementById('btn-save') as HTMLButtonElement;
    saveBtn.click();
    await window.happyDOM.waitUntilComplete();

    const saveMessage = messages.find(
      (m): m is { command: string; payload: { fallback_models?: unknown } } =>
        typeof m === 'object' &&
        m !== null &&
        (m as { command?: unknown }).command === 'save',
    );
    expect(saveMessage).toBeDefined();
    expect(saveMessage?.payload.fallback_models).toEqual([
      { model: 'openai/gpt-4o', temperature: 0.3 },
    ]);
  });

  it('debounces modelChanged messages while typing', async () => {
    const { window, messages } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: '' },
    });
    await new Promise((r) => setTimeout(r, 50));

    const modelInput = window.document.getElementById('f-model') as HTMLInputElement;
    modelInput.value = 'o';
    modelInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    modelInput.value = 'op';
    modelInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    modelInput.value = 'openai/gpt-4';
    modelInput.dispatchEvent(new window.Event('input', { bubbles: true }));

    await new Promise((r) => setTimeout(r, 50));
    const immediate = messages.filter(
      (m): m is { command: string; modelId: string } =>
        typeof m === 'object' && m !== null && (m as { command?: unknown }).command === 'modelChanged',
    );
    expect(immediate).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 300));
    const after = messages.filter(
      (m): m is { command: string; modelId: string } =>
        typeof m === 'object' && m !== null && (m as { command?: unknown }).command === 'modelChanged',
    );
    expect(after).toHaveLength(1);
    expect(after[0].modelId).toBe('openai/gpt-4');
  });

  it('populates reasoning options from verbose metadata variants', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'deepseek/model' },
    });
    await window.happyDOM.waitUntilComplete();

    window.postMessage({
      command: 'modelsLoaded',
      models: [
        {
          modelId: 'deepseek/model',
          capabilities: { temperature: true, reasoning: true },
          variants: {
            low: { reasoningEffort: 'low' },
            max: { reasoningEffort: 'max' },
          },
        },
      ],
    });
    await window.happyDOM.waitUntilComplete();

    const reasoningSelect = window.document.getElementById('f-reasoning') as HTMLSelectElement;
    const values = Array.from(reasoningSelect.options).map((o) => o.value);
    expect(values).toContain('low');
    expect(values).toContain('max');

    const variantSelect = window.document.getElementById('f-variant') as HTMLSelectElement;
    const variantValues = Array.from(variantSelect.options).map((o) => o.value);
    expect(variantValues).toContain('low');
    expect(variantValues).toContain('max');
  });

  it('shows only the default variant when the model has no variants', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'kimi-k2.6' },
    });
    await window.happyDOM.waitUntilComplete();

    window.postMessage({
      command: 'modelsLoaded',
      models: [
        {
          modelId: 'kimi-k2.6',
          capabilities: { temperature: true, reasoning: true },
          variants: {},
        },
      ],
    });
    await window.happyDOM.waitUntilComplete();

    const variantSelect = window.document.getElementById('f-variant') as HTMLSelectElement;
    const variantValues = Array.from(variantSelect.options).map((o) => o.value);
    expect(variantValues).toEqual(['']);
  });

  it('shows only the default variant when the model metadata has no variants field', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'no-variants/model' },
    });
    await window.happyDOM.waitUntilComplete();

    window.postMessage({
      command: 'modelsLoaded',
      models: [
        {
          modelId: 'no-variants/model',
          capabilities: { temperature: true, reasoning: true },
        },
      ],
    });
    await window.happyDOM.waitUntilComplete();

    const variantSelect = window.document.getElementById('f-variant') as HTMLSelectElement;
    const variantValues = Array.from(variantSelect.options).map((o) => o.value);
    expect(variantValues).toEqual(['']);
  });
});
