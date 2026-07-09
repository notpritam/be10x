// ABOUTME: Vite build for the extension — CRXJS bundles the MV3 manifest, service worker, and popup.
// ABOUTME: React plugin for the popup UI; strict dev port so HMR is deterministic during load-unpacked work.
import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest';

// Chrome's content-script loader rejects any file containing a BOM (U+FEFF) or a Unicode noncharacter
// (U+FFFE / U+FFFF / U+FDD0-U+FDEF) with "isn't UTF-8 encoded" — even though the file IS valid UTF-8.
// rrweb-snapshot ships a literal U+FFFE (a BOM check) that lands in the bundled collector content script.
// This post-build pass escapes those code points to \uXXXX across every emitted .js: identical JS
// semantics (a string/regex literal keeps the same character), pure-ASCII on disk so Chrome accepts it.
// (Compared by numeric code point so this config file itself stays free of those characters.)
function escapeUnsafeUnicode() {
  const isUnsafe = (c) => c === 0xfeff || c === 0xfffe || c === 0xffff || (c >= 0xfdd0 && c <= 0xfdef);
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : e.name.endsWith('.js') ? [full] : [];
    });
  return {
    name: 'escape-unsafe-unicode',
    closeBundle() {
      const outDir = path.resolve('dist');
      if (!fs.existsSync(outDir)) return;
      for (const p of walk(outDir)) {
        const code = fs.readFileSync(p, 'utf8');
        let out = '';
        let changed = false;
        for (const ch of code) {
          const c = ch.codePointAt(0);
          if (isUnsafe(c)) {
            out += '\\u' + c.toString(16).padStart(4, '0');
            changed = true;
          } else {
            out += ch;
          }
        }
        if (changed) fs.writeFileSync(p, out);
      }
    },
  };
}

export default defineConfig({
  // net-hook is built as a self-contained IIFE: MAIN world has no chrome.runtime, so it cannot use
  // CRXJS's module loader, and it must run synchronously at document_start to wrap fetch/XHR in time.
  plugins: [react(), crx({ manifest, contentScripts: { standaloneFiles: ['src/content/net-hook.ts'] } }), escapeUnsafeUnicode()],
  server: { port: 5199, strictPort: true, hmr: { port: 5199 } },
});
