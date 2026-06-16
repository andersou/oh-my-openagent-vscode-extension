// esbuild build script for the extension host and the webview.
// Run via `npm run compile` (one-shot) or `npm run watch` (rebuild on change).
// The two entry points are independent: extension.js is a CommonJS module
// loaded by VS Code as the extension entry, webview.js is an IIFE loaded
// inside a <script> tag in a webview HTML document.

import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  mainFields: ['module', 'main'],
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['src/ui/webview/main.js'],
  bundle: true,
  outfile: 'out/webview.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
};

const configs = [extensionConfig, webviewConfig];

if (watch) {
  const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('esbuild: watching for changes...');
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
  console.log('esbuild: build complete');
}
