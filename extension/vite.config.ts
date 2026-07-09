// ABOUTME: Vite build for the extension — CRXJS bundles the MV3 manifest, service worker, and popup.
// ABOUTME: React plugin for the popup UI; strict dev port so HMR is deterministic during load-unpacked work.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: { port: 5199, strictPort: true, hmr: { port: 5199 } },
});
