// ABOUTME: Vite build for the extension — CRXJS bundles the MV3 manifest, service worker, and popup.
// ABOUTME: React plugin for the popup UI; strict dev port so HMR is deterministic during load-unpacked work.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

export default defineConfig({
  // net-hook is built as a self-contained IIFE: MAIN world has no chrome.runtime, so it cannot use
  // CRXJS's module loader, and it must run synchronously at document_start to wrap fetch/XHR in time.
  plugins: [react(), crx({ manifest, contentScripts: { standaloneFiles: ['src/content/net-hook.ts'] } })],
  server: { port: 5199, strictPort: true, hmr: { port: 5199 } },
});
