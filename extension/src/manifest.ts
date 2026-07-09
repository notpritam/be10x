// ABOUTME: MV3 manifest for the be10x QA bug-capture extension. CRXJS consumes this at build time.
// ABOUTME: <all_urls> lets QA capture any internal app; the board origin is reached from the SW (CORS-exempt).
import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'be10x Bug Capture',
  version: '0.1.0',
  description: 'File QA bugs into be10x with screenshot, DOM, network, and identity attached.',
  action: { default_popup: 'src/popup/index.html', default_title: 'Report a bug to be10x' },
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  permissions: ['storage', 'tabs', 'cookies', 'activeTab', 'scripting'],
  host_permissions: ['<all_urls>'],
});
