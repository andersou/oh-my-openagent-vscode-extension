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
function createWebviewWindow(): WebviewTestEnv {
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

  beforeEach(() => {
    env = createWebviewWindow();
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
});
