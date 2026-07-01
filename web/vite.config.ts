import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Same-origin production build: the existing Node server serves ../public.
// `npm run build` emits there so the API and the app share an origin (cookie auth just works).
export default defineConfig({
  base: "/",
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
