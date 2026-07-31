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
async function createWebviewWindow(initialState?: unknown): Promise<WebviewTestEnv> {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const js = fs.readFileSync(JS_PATH, 'utf8');

  const window = new Window({ url: 'https://example.invalid/' });
  Object.assign(window, { structuredClone });

  const messages: unknown[] = [];
  const states: unknown[] = [];
  let currentState: unknown = initialState;

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
    expect(document.getElementById('btn-create-profile')).toBeNull();

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

  it('does not post modelChanged when the model input changes', async () => {
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

    expect(messages).not.toContainEqual({ command: 'modelChanged', modelId: 'openai/gpt-4.1' });
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
    const list = window.document.getElementById('model-list');
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

  it('promotes a rich fallback to main through drag and preserves ordered rich fallbacks on save', async () => {
    const { window, messages } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: {
        model: 'main/model',
        variant: 'main-variant',
        reasoningEffort: 'high',
        temperature: 0.7,
        top_p: 0.8,
        maxTokens: 8192,
        thinking: { type: 'enabled', budgetTokens: 2048 },
        fallback_models: [
          {
            model: 'promoted/model',
            variant: 'promoted-variant',
            reasoningEffort: 'low',
            temperature: 0.25,
            top_p: 0.3,
            maxTokens: 4096,
            thinking: { type: 'enabled', budgetTokens: 512 },
          },
          'legacy/fallback',
          {
            model: 'last/model',
            variant: 'last-variant',
            reasoningEffort: 'medium',
            temperature: 1,
            top_p: 0.9,
            maxTokens: 1024,
          },
        ],
      },
    });
    await window.happyDOM.waitUntilComplete();

    const fallbackHandle = window.document.querySelector<HTMLButtonElement>(
      '.fallback-card .fallback-card__handle',
    );
    fallbackHandle?.dispatchEvent(new window.Event('dragstart', { bubbles: true }));

    const mainModel = window.document.querySelector<HTMLElement>(
      '[data-section="model"]',
    );
    mainModel?.dispatchEvent(
      new window.Event('drop', { bubbles: true, cancelable: true }),
    );
    await window.happyDOM.waitUntilComplete();

    const saveBtn = window.document.getElementById('btn-save') as HTMLButtonElement;
    saveBtn.click();
    await window.happyDOM.waitUntilComplete();

    const saveMessage = messages.find(
      (message): message is { command: 'save'; payload: unknown } =>
        typeof message === 'object' &&
        message !== null &&
        'command' in message &&
        message.command === 'save' &&
        'payload' in message,
    );
    expect(saveMessage).toMatchObject({
      command: 'save',
      target: { type: 'agent', name: 'sisyphus', profile: null },
      payload: {
        model: 'promoted/model',
        variant: 'main-variant',
        reasoningEffort: 'high',
        temperature: 0.7,
        top_p: 0.8,
        maxTokens: 8192,
        thinking: { type: 'enabled', budgetTokens: 2048 },
        fallback_models: [
          {
            model: 'main/model',
            variant: 'main-variant',
            reasoningEffort: 'high',
            temperature: 0.7,
            top_p: 0.8,
            maxTokens: 8192,
            thinking: { type: 'enabled', budgetTokens: 2048 },
          },
          'legacy/fallback',
          {
            model: 'last/model',
            variant: 'last-variant',
            reasoningEffort: 'medium',
            temperature: 1,
            top_p: 0.9,
            maxTokens: 1024,
          },
        ],
      },
    });
  });

  it('promotes a rich fallback to main with keyboard drag and announces each state', async () => {
    const { window, messages } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: {
        model: 'main/model',
        variant: 'main-variant',
        reasoningEffort: 'high',
        temperature: 0.7,
        top_p: 0.8,
        maxTokens: 8192,
        thinking: { type: 'enabled', budgetTokens: 2048 },
        fallback_models: [
          {
            model: 'promoted/model',
            variant: 'promoted-variant',
            reasoningEffort: 'low',
            temperature: 0.25,
            top_p: 0.3,
            maxTokens: 4096,
            thinking: { type: 'enabled', budgetTokens: 512 },
          },
          'legacy/fallback',
        ],
      },
    });
    await window.happyDOM.waitUntilComplete();

    const fallbackHandle = window.document.querySelector<HTMLButtonElement>(
      '.fallback-card .fallback-card__handle',
    );
    expect(fallbackHandle).not.toBeNull();
    if (!fallbackHandle) throw new Error('Fallback handle did not render');
    fallbackHandle.focus();
    expect(window.document.activeElement).toBe(fallbackHandle);

    fallbackHandle.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    await window.happyDOM.waitUntilComplete();

    const dragStatus = window.document.getElementById('model-drag-status');
    expect(dragStatus?.textContent).toContain('Fallback 1 picked up');
    expect(fallbackHandle.getAttribute('aria-grabbed')).toBe('true');

    fallbackHandle.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    await window.happyDOM.waitUntilComplete();

    expect(dragStatus?.textContent).toBe('Moved to Main model.');
    const mainHandle = window.document.querySelector<HTMLButtonElement>(
      '[data-section="model"] .fallback-card__handle',
    );
    expect(mainHandle).not.toBeNull();
    if (!mainHandle) throw new Error('Main handle did not render');
    expect(mainHandle.getAttribute('aria-grabbed')).toBe('true');
    expect(window.document.activeElement).toBe(mainHandle);

    const focusedHandle = window.document.activeElement;
    if (!(focusedHandle instanceof window.HTMLButtonElement)) {
      throw new Error('Promoted handle did not retain focus');
    }
    focusedHandle.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    await window.happyDOM.waitUntilComplete();

    expect(dragStatus?.textContent).toBe('Dropped at Main model.');
    expect(mainHandle.getAttribute('aria-grabbed')).toBe('false');

    const saveBtn = window.document.getElementById('btn-save') as HTMLButtonElement;
    saveBtn.click();
    await window.happyDOM.waitUntilComplete();

    const saveMessage = messages.find(
      (message): message is { command: 'save'; payload: unknown } =>
        typeof message === 'object' &&
        message !== null &&
        'command' in message &&
        message.command === 'save' &&
        'payload' in message,
    );
    expect(saveMessage).toMatchObject({
      command: 'save',
      target: { type: 'agent', name: 'sisyphus', profile: null },
      payload: {
        model: 'promoted/model',
        variant: 'main-variant',
        reasoningEffort: 'high',
        temperature: 0.7,
        top_p: 0.8,
        maxTokens: 8192,
        thinking: { type: 'enabled', budgetTokens: 2048 },
        fallback_models: [
          {
            model: 'main/model',
            variant: 'main-variant',
            reasoningEffort: 'high',
            temperature: 0.7,
            top_p: 0.8,
            maxTokens: 8192,
            thinking: { type: 'enabled', budgetTokens: 2048 },
          },
          'legacy/fallback',
        ],
      },
    });
  });

  it('cancels keyboard drag and restores the original model order', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'main/model', fallback_models: ['fallback/model'] },
    });
    await window.happyDOM.waitUntilComplete();

    const fallbackHandle = window.document.querySelector<HTMLButtonElement>(
      '.fallback-card .fallback-card__handle',
    );
    expect(fallbackHandle).not.toBeNull();
    if (!fallbackHandle) throw new Error('Fallback handle did not render');
    fallbackHandle.focus();

    fallbackHandle.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    fallbackHandle.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    await window.happyDOM.waitUntilComplete();

    const mainHandle = window.document.querySelector<HTMLButtonElement>(
      '[data-section="model"] .fallback-card__handle',
    );
    expect(mainHandle).not.toBeNull();
    if (!mainHandle) throw new Error('Main handle did not render');
    expect(window.document.activeElement).toBe(mainHandle);
    mainHandle.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await window.happyDOM.waitUntilComplete();

    const mainModelInput = window.document.getElementById('f-model') as HTMLInputElement;
    expect(mainModelInput.value).toBe('main/model');
    expect(window.document.getElementById('model-drag-status')?.textContent).toBe(
      'Move canceled. Restored to Fallback 1.',
    );
    const restoredHandle = window.document.querySelector<HTMLButtonElement>(
      '.fallback-card .fallback-card__handle',
    );
    expect(restoredHandle).not.toBeNull();
    expect(window.document.activeElement).toBe(restoredHandle);
    expect(restoredHandle?.getAttribute('aria-grabbed')).toBe('false');
  });

  it('uses drag as the only model-order control', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'main/model', fallback_models: ['fallback/model'] },
    });
    await window.happyDOM.waitUntilComplete();

    expect(window.document.querySelector('.fallback-card__switch')).toBeNull();
    expect(window.document.querySelector('.fallback-card__move')).toBeNull();
    expect(
      window.document.querySelector('[data-model-position="main"]')?.textContent,
    ).toContain('MAIN');
  });

  it('does not post modelChanged messages while typing', async () => {
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
    expect(after).toHaveLength(0);
  });

  it('edits the Reasoning setting through the defaults select and saves it', async () => {
    const { window, messages } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'main/model' },
    });
    await window.happyDOM.waitUntilComplete();

    const select = window.document.getElementById('f-new-reasoning') as HTMLSelectElement;
    expect(select).not.toBeNull();
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).toEqual(['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']);

    select.value = 'high';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    const saveBtn = window.document.getElementById('btn-save') as HTMLButtonElement;
    saveBtn.click();
    await window.happyDOM.waitUntilComplete();

    const saveMessage = messages.find(
      (message): message is { command: 'save'; payload: { reasoning?: unknown } } =>
        typeof message === 'object' &&
        message !== null &&
        'command' in message &&
        message.command === 'save',
    );
    expect(saveMessage?.payload.reasoning).toBe('high');
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

  it('renders every configured model in one semantic ordered list with accessible promotion guidance', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'main/model', fallback_models: ['first/fallback', 'second/fallback'] },
    });
    await window.happyDOM.waitUntilComplete();

    const modelList = window.document.querySelector<HTMLOListElement>('ol#model-list');
    expect(modelList).not.toBeNull();
    expect(modelList?.querySelectorAll(':scope > li')).toHaveLength(3);
    expect(modelList?.querySelector('[data-model-position="main"]')?.textContent).toContain('MAIN');
    expect(modelList?.querySelector('[data-model-position="fallback-1"]')?.textContent).toContain('FALLBACK 1');

    const handle = modelList?.querySelector<HTMLButtonElement>('[data-model-card-uid]');
    expect(handle?.title).toBe('Drag to reorder. Drop in the first position to replace the Main model.');
    expect(handle?.getAttribute('aria-describedby')).toContain('model-drag-instructions');
    expect(window.document.querySelector('[data-section="fallback"]')).toBeNull();
  });

  it('keeps fallback settings in inherit mode and sends null after removing the final fallback', async () => {
    const { window, messages } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'main/model', temperature: 0.4, fallback_models: ['fallback/model'] },
    });
    await window.happyDOM.waitUntilComplete();

    const inheritMode = window.document.querySelector<HTMLSelectElement>(
      '[data-model-position="fallback-1"] select[name="temperature-mode"]',
    );
    expect(inheritMode?.value).toBe('inherit');

    const removeButton = window.document.querySelector<HTMLButtonElement>(
      '[data-model-position="fallback-1"] .model-card__remove',
    );
    removeButton?.click();
    await window.happyDOM.waitUntilComplete();

    const saveButton = window.document.getElementById('btn-save') as HTMLButtonElement;
    saveButton.click();
    await window.happyDOM.waitUntilComplete();

    const saveMessage = messages.find(
      (message): message is { command: 'save'; payload: { fallback_models: unknown } } =>
        typeof message === 'object' &&
        message !== null &&
        'command' in message &&
        message.command === 'save' &&
        'payload' in message,
    );
    expect(saveMessage?.payload.fallback_models).toBeNull();
  });

  it('renders advanced inherit and override controls for Main without a remove action', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'main/model', temperature: 0.7 },
    });
    await window.happyDOM.waitUntilComplete();

    const main = window.document.querySelector('[data-model-position="main"]');
    expect(main?.querySelector('details.model-card__advanced')).not.toBeNull();
    expect(main?.querySelector<HTMLSelectElement>('select[name="temperature-mode"]')?.value).toBe('inherit');
    expect(main?.querySelector('.model-card__remove')).toBeNull();
  });

  it('shows defaults while any card setting inherits and hides them when every setting is explicit', async () => {
    const { window } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: { model: 'main/model' },
    });
    await window.happyDOM.waitUntilComplete();

    expect(window.document.querySelector('[data-section="defaults"]')).not.toBeNull();

    for (const name of ['variant-mode', 'reasoning-mode', 'reasoningEffort-mode', 'temperature-mode', 'top_p-mode', 'maxTokens-mode', 'thinking-mode']) {
      const mode = window.document.querySelector<HTMLSelectElement>(`[data-model-position="main"] select[name="${name}"]`);
      expect(mode).not.toBeNull();
      if (!mode) throw new Error(`${name} control did not render`);
      mode.value = 'override';
      mode.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
    await window.happyDOM.waitUntilComplete();

    expect(window.document.querySelector('[data-section="defaults"]')).toBeNull();

    const temperatureMode = window.document.querySelector<HTMLSelectElement>(
      '[data-model-position="main"] select[name="temperature-mode"]',
    );
    if (!temperatureMode) throw new Error('Temperature mode control did not render');
    temperatureMode.value = 'inherit';
    temperatureMode.dispatchEvent(new window.Event('change', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    expect(window.document.querySelector('[data-section="defaults"]')).not.toBeNull();
  });

  it('announces that promotion preserves model settings and shared defaults', async () => {
    const { window, messages } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      config: {
        model: 'main/model',
        temperature: 0.7,
        fallback_models: [{ model: 'fallback/model', temperature: 0.2 }],
      },
    });
    await window.happyDOM.waitUntilComplete();

    const fallbackHandle = window.document.querySelector<HTMLButtonElement>(
      '[data-model-position="fallback-1"] [data-model-card-uid]',
    );
    fallbackHandle?.dispatchEvent(new window.Event('dragstart', { bubbles: true }));
    window.document.querySelector('[data-model-position="main"]')?.dispatchEvent(
      new window.Event('drop', { bubbles: true, cancelable: true }),
    );
    await window.happyDOM.waitUntilComplete();

    expect(window.document.getElementById('model-routing-status')?.textContent).toContain(
      'Model-specific settings and shared defaults were preserved.',
    );
    (window.document.getElementById('btn-save') as HTMLButtonElement).click();
    await window.happyDOM.waitUntilComplete();

    const saveMessage = messages.find(
      (message): message is { command: 'save'; payload: { model: string; temperature: number } } =>
        typeof message === 'object' &&
        message !== null &&
        'command' in message &&
        message.command === 'save' &&
        'payload' in message,
    );
    expect(saveMessage?.payload).toMatchObject({
      model: 'fallback/model',
      temperature: 0.7,
      fallback_models: [{ model: 'main/model', temperature: 0.7 }],
    });
  });

  it('restores dirty routing modes and ignores the matching host init', async () => {
    const { window, states } = env;
    window.postMessage({ command: 'init', type: 'agent', name: 'sisyphus', config: { model: 'main', fallback_models: ['fallback'] } });
    await window.happyDOM.waitUntilComplete();
    const mode = window.document.querySelector<HTMLSelectElement>('[data-model-position="fallback-1"] select[name="temperature-mode"]');
    if (!mode) throw new Error('Temperature mode did not render');
    mode.value = 'override';
    mode.dispatchEvent(new window.Event('change', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();
    const savedState = states.at(-1);
    const restored = await createWebviewWindow(savedState);
    restored.window.postMessage({ command: 'init', type: 'agent', name: 'sisyphus', config: { model: 'host', fallback_models: [] } });
    await restored.window.happyDOM.waitUntilComplete();
    expect(restored.window.document.querySelector<HTMLSelectElement>('[data-model-position="fallback-1"] select[name="temperature-mode"]')?.value).toBe('override');
    await restored.window.happyDOM.close();
  });

  it('retains fallback override modes through Main to Fallback to Main transitions', async () => {
    const { window } = env;
    window.postMessage({ command: 'init', type: 'agent', name: 'sisyphus', config: { model: 'a', temperature: 0.7, top_p: 0.8, fallback_models: [{ model: 'b', temperature: 0.2 }] } });
    await window.happyDOM.waitUntilComplete();
    const promote = (selector: string) => {
      const handle = window.document.querySelector<HTMLButtonElement>(`${selector} [data-model-card-uid]`);
      handle?.dispatchEvent(new window.Event('dragstart', { bubbles: true }));
      window.document.querySelector('[data-model-position="main"]')?.dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true }));
    };
    promote('[data-model-position="fallback-1"]');
    await window.happyDOM.waitUntilComplete();
    promote('[data-model-position="fallback-1"]');
    await window.happyDOM.waitUntilComplete();
    const fallback = window.document.querySelector('[data-model-position="fallback-1"]');
    expect(fallback?.querySelector<HTMLSelectElement>('select[name="temperature-mode"]')?.value).toBe('override');
    expect(fallback?.querySelector<HTMLSelectElement>('select[name="top_p-mode"]')?.value).toBe('inherit');
  });

  it('keeps unsupported configured defaults operable so they can be cleared before save', async () => {
    const { window, messages } = env;
    window.postMessage({ command: 'init', type: 'agent', name: 'sisyphus', config: { model: 'no-temp', temperature: 0.4 } });
    window.postMessage({ command: 'modelsLoaded', models: [{ modelId: 'no-temp', capabilities: { temperature: false } }] });
    await window.happyDOM.waitUntilComplete();
    const temperature = window.document.getElementById('f-temperature') as HTMLInputElement;
    expect(temperature.disabled).toBe(false);
    temperature.value = '';
    temperature.dispatchEvent(new window.Event('input', { bubbles: true }));
    (window.document.getElementById('btn-save') as HTMLButtonElement).click();
    await window.happyDOM.waitUntilComplete();
    expect(messages.some((message) => typeof message === 'object' && message !== null && 'command' in message && message.command === 'save')).toBe(true);
  });

  function lastStateForTarget(states: unknown[], target: Record<string, unknown>) {
    const state = states.at(-1);
    if (
      typeof state !== 'object' ||
      state === null ||
      (state as { v?: unknown }).v !== 1 ||
      typeof (state as { targets?: unknown }).targets !== 'object' ||
      (state as { targets?: unknown }).targets === null
    ) {
      return null;
    }
    const key = JSON.stringify(target);
    const found = (state as { targets: Record<string, unknown> }).targets[key];
    if (typeof found !== 'object' || found === null) return null;
    return found as Record<string, unknown>;
  }

  it('marks collapsed fallback capability errors and keeps dirty state after a host error', async () => {
    const { window, states } = env;
    window.postMessage({ command: 'init', type: 'agent', name: 'sisyphus', config: { model: 'main', temperature: 0.4, fallback_models: ['no-temp'] } });
    window.postMessage({ command: 'modelsLoaded', models: [{ modelId: 'no-temp', capabilities: { temperature: false } }] });
    await window.happyDOM.waitUntilComplete();
    const summary = window.document.querySelector('[data-model-position="fallback-1"] summary');
    expect(summary?.textContent).toContain('Needs attention');
    expect(summary?.querySelector('.model-card__error-marker.sr-only')).toBeNull();
    const temperature = window.document.getElementById('f-temperature') as HTMLInputElement;
    temperature.value = '';
    temperature.dispatchEvent(new window.Event('input', { bubbles: true }));
    (window.document.getElementById('btn-save') as HTMLButtonElement).click();
    window.postMessage({ command: 'error', message: 'save failed' });
    await window.happyDOM.waitUntilComplete();
    const targetState = lastStateForTarget(states, { type: 'agent', name: 'sisyphus', profile: null });
    expect(targetState?.dirty).toBe(true);
  });

  it('uses target-aware dirty and save messages, retaining dirty state until a matching acknowledgement', async () => {
    const { window, messages, states } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      profile: 'fast',
      config: { model: 'main' },
    });
    await window.happyDOM.waitUntilComplete();

    const modelInput = window.document.getElementById('f-model') as HTMLInputElement;
    modelInput.value = 'changed';
    modelInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    expect(messages).toContainEqual({
      command: 'dirtyState',
      target: { type: 'agent', name: 'sisyphus', profile: 'fast' },
      dirty: true,
    });
    const targetState = lastStateForTarget(states, { type: 'agent', name: 'sisyphus', profile: 'fast' });
    expect(targetState?.profile).toBe('fast');

    window.postMessage({
      command: 'saved',
      target: { type: 'agent', name: 'sisyphus', profile: 'careful' },
    });
    await window.happyDOM.waitUntilComplete();
    expect(lastStateForTarget(states, { type: 'agent', name: 'sisyphus', profile: 'fast' })?.dirty).toBe(true);

    window.postMessage({
      command: 'error',
      message: 'save failed',
      target: { type: 'agent', name: 'sisyphus', profile: 'fast' },
    });
    await window.happyDOM.waitUntilComplete();
    expect(lastStateForTarget(states, { type: 'agent', name: 'sisyphus', profile: 'fast' })?.dirty).toBe(true);

    window.postMessage({
      command: 'saved',
      target: { type: 'agent', name: 'sisyphus', profile: 'fast' },
    });
    await window.happyDOM.waitUntilComplete();
    expect(lastStateForTarget(states, { type: 'agent', name: 'sisyphus', profile: 'fast' })?.dirty).toBe(false);
  });

  it('discards restored dirty state when the same entity arrives for a different profile', async () => {
    const { window, states } = env;
    window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      profile: 'fast',
      config: { model: 'main' },
    });
    await window.happyDOM.waitUntilComplete();
    const modelInput = window.document.getElementById('f-model') as HTMLInputElement;
    modelInput.value = 'dirty-model';
    modelInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    const restored = await createWebviewWindow(states.at(-1));
    restored.window.postMessage({
      command: 'init',
      type: 'agent',
      name: 'sisyphus',
      profile: 'careful',
      config: { model: 'host-model' },
    });
    await restored.window.happyDOM.waitUntilComplete();

    expect((restored.window.document.getElementById('f-model') as HTMLInputElement).value).toBe('host-model');
    expect(lastStateForTarget(restored.states, { type: 'agent', name: 'sisyphus', profile: 'careful' })?.dirty).toBe(false);
    await restored.window.happyDOM.close();
  });

  it.each([
    { ctrlKey: true, metaKey: false, key: 's' },
    { ctrlKey: false, metaKey: true, key: 's' },
    { ctrlKey: true, metaKey: false, key: 'Enter' },
    { ctrlKey: false, metaKey: true, key: 'Enter' },
  ])('saves exactly once and prevents the browser shortcut for %o', async (keys) => {
    const { window, messages } = env;
    window.postMessage({ command: 'init', type: 'agent', name: 'sisyphus', profile: null, config: { model: 'main' } });
    await window.happyDOM.waitUntilComplete();

    const event = new window.KeyboardEvent('keydown', { ...keys, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    await window.happyDOM.waitUntilComplete();

    expect(event.defaultPrevented).toBe(true);
    expect(messages.filter((message) => typeof message === 'object' && message !== null && 'command' in message && message.command === 'save')).toHaveLength(1);
  });

  it('leaves plain s and Enter available to existing controls', async () => {
    const { window, messages } = env;
    window.postMessage({ command: 'init', type: 'agent', name: 'sisyphus', profile: null, config: { model: 'main' } });
    await window.happyDOM.waitUntilComplete();

    for (const key of ['s', 'Enter']) {
      const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(messages.filter((message) => typeof message === 'object' && message !== null && 'command' in message && message.command === 'save')).toHaveLength(0);
  });
});

describe('profile JSON editor', () => {
  let env: WebviewTestEnv;

  beforeEach(async () => {
    env = await createWebviewWindow();
  });

  afterEach(async () => {
    await env.window.happyDOM.close();
  });

  function getTextarea() {
    return env.window.document.getElementById('profile-json-text') as HTMLTextAreaElement;
  }

  function getStatus() {
    return env.window.document.getElementById('profile-json-status') as HTMLElement;
  }

  it('renders the active profile JSON heading and labelled textarea', async () => {
    const { window } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'active', profile: null, text: '{"agents":{}}' });
    await window.happyDOM.waitUntilComplete();

    expect(window.document.querySelector('.editor__title')?.textContent).toBe('Profile JSON');
    expect(window.document.querySelector('.editor__subtitle')?.textContent).toBe('Active config fragment');

    const textarea = getTextarea();
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('{"agents":{}}');
    expect(textarea.getAttribute('aria-describedby')).toBe('profile-json-help');

    const label = window.document.querySelector('label[for="profile-json-text"]');
    expect(label).not.toBeNull();
  });

  it('renders the textarea with an initial height of 14 rows', async () => {
    const { window } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'active', profile: null, text: '{"agents":{}}' });
    await window.happyDOM.waitUntilComplete();

    const textarea = getTextarea();
    expect(textarea.getAttribute('rows')).toBe('14');
    expect(textarea.classList.contains('field__textarea')).toBe(true);
    expect(textarea.classList.contains('field__textarea--code')).toBe(true);
  });

  it('renders the saved profile JSON heading', async () => {
    const { window } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'saved', profile: 'fast', text: '{"categories":{}}' });
    await window.happyDOM.waitUntilComplete();

    expect(window.document.querySelector('.editor__subtitle')?.textContent).toBe('fast');
    expect(getTextarea().value).toBe('{"categories":{}}');
  });

  it('does not render model controls in JSON mode', async () => {
    const { window } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'active', profile: null, text: '{}' });
    await window.happyDOM.waitUntilComplete();

    expect(window.document.getElementById('model-list')).toBeNull();
    expect(window.document.getElementById('btn-add-fallback')).toBeNull();
    expect(window.document.getElementById('btn-reload-models')).toBeNull();
    expect(window.document.getElementById('model-datalist')).toBeNull();
  });

  it('posts save with target and text payload on button click', async () => {
    const { window, messages } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'active', profile: null, text: '{}' });
    await window.happyDOM.waitUntilComplete();

    const textarea = getTextarea();
    textarea.value = '{"agents":{}}';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    const saveBtn = env.window.document.getElementById('btn-save') as HTMLButtonElement;
    saveBtn.click();
    await window.happyDOM.waitUntilComplete();

    expect(messages).toContainEqual({
      command: 'save',
      target: { type: 'profileJson', source: 'active', profile: null },
      payload: { text: '{"agents":{}}' },
    });
  });

  it.each([
    { ctrlKey: true, metaKey: false, key: 's' },
    { ctrlKey: false, metaKey: true, key: 's' },
  ])('saves on keyboard shortcut %o', async (keys) => {
    const { window, messages } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'active', profile: null, text: '{}' });
    await window.happyDOM.waitUntilComplete();

    const textarea = getTextarea();
    textarea.value = '{"agents":{}}';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    const event = new window.KeyboardEvent('keydown', { ...keys, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    await window.happyDOM.waitUntilComplete();

    expect(event.defaultPrevented).toBe(true);
    expect(messages).toContainEqual({
      command: 'save',
      target: { type: 'profileJson', source: 'active', profile: null },
      payload: { text: '{"agents":{}}' },
    });
  });

  it('announces saved status and replaces textarea with canonical text', async () => {
    const { window } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'active', profile: null, text: '{"agents":{}}' });
    await window.happyDOM.waitUntilComplete();

    const textarea = getTextarea();
    textarea.value = '{"agents":{},"categories":{}}';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    window.postMessage({ command: 'saved', target: { type: 'profileJson', source: 'active', profile: null }, text: '{\n  "agents": {},\n  "categories": {}\n}\n' });
    await window.happyDOM.waitUntilComplete();

    expect(getStatus().textContent).toContain('Saved.');
    expect(textarea.value).toBe('{\n  "agents": {},\n  "categories": {}\n}\n');
    expect(textarea.classList.contains('is-dirty')).toBe(false);
  });

  it('displays host parse/validation errors with path/line/column', async () => {
    const { window } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'active', profile: null, text: '{}' });
    await window.happyDOM.waitUntilComplete();

    window.postMessage({
      command: 'error',
      target: { type: 'profileJson', source: 'active', profile: null },
      message: 'Invalid JSON',
      path: 'agents.sisyphus.model',
      line: 3,
      column: 12,
    });
    await window.happyDOM.waitUntilComplete();

    const status = getStatus();
    expect(status.textContent).toContain('Invalid JSON');
    expect(status.textContent).toContain('agents.sisyphus.model');
    expect(status.textContent).toContain('3');
    expect(status.textContent).toContain('12');
  });

  it('announces dirty state for the current target only', async () => {
    const { window, messages } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'saved', profile: 'fast', text: '{}' });
    await window.happyDOM.waitUntilComplete();

    const textarea = getTextarea();
    textarea.value = '{"agents":{}}';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    expect(messages).toContainEqual({
      command: 'dirtyState',
      target: { type: 'profileJson', source: 'saved', profile: 'fast' },
      dirty: true,
    });
  });

  it('restores dirty drafts when switching targets A -> B -> A', async () => {
    const { window, messages, states } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'saved', profile: 'A', text: '{}' });
    await window.happyDOM.waitUntilComplete();

    const textareaA = getTextarea();
    textareaA.value = '{"agents":{}}';
    textareaA.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    const savedState = states.at(-1);
    const restored = await createWebviewWindow(savedState);
    restored.window.postMessage({ command: 'init', type: 'profileJson', source: 'saved', profile: 'B', text: '{"categories":{}}' });
    await restored.window.happyDOM.waitUntilComplete();

    const textareaB = restored.window.document.getElementById('profile-json-text') as HTMLTextAreaElement;
    expect(textareaB.value).toBe('{"categories":{}}');
    textareaB.value = '{"categories":{"x":{}}}';
    textareaB.dispatchEvent(new restored.window.Event('input', { bubbles: true }));
    await restored.window.happyDOM.waitUntilComplete();

    restored.window.postMessage({ command: 'init', type: 'profileJson', source: 'saved', profile: 'A', text: '{}' });
    await restored.window.happyDOM.waitUntilComplete();

    const textareaARestored = restored.window.document.getElementById('profile-json-text') as HTMLTextAreaElement;
    expect(textareaARestored.value).toBe('{"agents":{}}');
    expect(restored.messages).toContainEqual({
      command: 'dirtyState',
      target: { type: 'profileJson', source: 'saved', profile: 'A' },
      dirty: true,
    });

    await restored.window.happyDOM.close();
  });

  it('ignores saved/error messages for a different target', async () => {
    const { window } = env;
    window.postMessage({ command: 'init', type: 'profileJson', source: 'saved', profile: 'A', text: '{}' });
    await window.happyDOM.waitUntilComplete();

    const textarea = getTextarea();
    textarea.value = '{"agents":{}}';
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    window.postMessage({ command: 'saved', target: { type: 'profileJson', source: 'saved', profile: 'B' }, text: '{}' });
    window.postMessage({ command: 'error', target: { type: 'profileJson', source: 'saved', profile: 'B' }, message: 'wrong target' });
    await window.happyDOM.waitUntilComplete();

    const status = getStatus();
    expect(status.textContent?.trim()).toBe('');
    expect(status.hidden).toBe(true);
    expect(textarea.value).toBe('{"agents":{}}');
  });

  it('does not clobber agent dirty state when editing profile JSON', async () => {
    const { window, states } = env;
    window.postMessage({ command: 'init', type: 'agent', name: 'sisyphus', config: { model: 'main' } });
    await window.happyDOM.waitUntilComplete();

    const modelInput = window.document.getElementById('f-model') as HTMLInputElement;
    modelInput.value = 'dirty-model';
    modelInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await window.happyDOM.waitUntilComplete();

    const savedState = states.at(-1);
    const restored = await createWebviewWindow(savedState);
    restored.window.postMessage({ command: 'init', type: 'profileJson', source: 'active', profile: null, text: '{}' });
    await restored.window.happyDOM.waitUntilComplete();

    const textarea = restored.window.document.getElementById('profile-json-text') as HTMLTextAreaElement;
    textarea.value = '{"agents":{}}';
    textarea.dispatchEvent(new restored.window.Event('input', { bubbles: true }));
    await restored.window.happyDOM.waitUntilComplete();

    restored.window.postMessage({ command: 'init', type: 'agent', name: 'sisyphus', config: { model: 'host-model' } });
    await restored.window.happyDOM.waitUntilComplete();

    const modelInputRestored = restored.window.document.getElementById('f-model') as HTMLInputElement;
    expect(modelInputRestored.value).toBe('dirty-model');
    expect(restored.messages).toContainEqual({
      command: 'dirtyState',
      target: { type: 'agent', name: 'sisyphus', profile: null },
      dirty: true,
    });

    await restored.window.happyDOM.close();
  });

  it('ignores old flat persisted state without corrupting JSON mode init', async () => {
    const flatState = { kind: 'profileJson', name: 'legacy', profile: null, text: 'legacy-text', dirty: true };
    const restored = await createWebviewWindow(flatState);
    restored.window.postMessage({ command: 'init', type: 'profileJson', source: 'active', profile: null, text: '{"agents":{}}' });
    await restored.window.happyDOM.waitUntilComplete();

    const textarea = restored.window.document.getElementById('profile-json-text') as HTMLTextAreaElement;
    expect(textarea.value).toBe('{"agents":{}}');
    await restored.window.happyDOM.close();
  });
});

