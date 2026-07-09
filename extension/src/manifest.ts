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
  // net-hook runs in the page's MAIN world so it can wrap fetch/XHR before the app fires requests;
  // content (recorder + widget + collector) runs in the default ISOLATED world where chrome.runtime
  // is available to answer the SW and coordinate the report upload.
  content_scripts: [
    { matches: ['<all_urls>'], js: ['src/content/net-hook.ts'], run_at: 'document_start', world: 'MAIN', all_frames: false },
    { matches: ['<all_urls>'], js: ['src/content/content.ts'], run_at: 'document_start', all_frames: false },
  ],
  permissions: ['storage', 'tabs', 'cookies', 'activeTab', 'scripting'],
  host_permissions: ['<all_urls>'],
});
