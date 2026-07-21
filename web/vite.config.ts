import path from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The board's version (root package.json), baked into the bundle so the UI can show which build is loaded —
// a hard-refresh then visibly bumps the number, so you can tell a stale cached bundle from the current one.
const APP_VERSION = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")).version;

// Same-origin production build: the existing Node server serves ../public.
// `npm run build` emits there so the API and the app share an origin (cookie auth just works).
export default defineConfig({
  base: "/",
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Dev-only convenience: proxy the API to the already-running server.
    proxy: { "/api": "http://localhost:4610" },
  },
});
