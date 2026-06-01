import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev server proxies the Worker API surfaces (Hono routes from MNEMO-01+) to the
// local `wrangler dev` server on :8787 so the SPA can call same-origin paths.
const WORKER_DEV_ORIGIN = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": { target: WORKER_DEV_ORIGIN, changeOrigin: true },
      "/auth": { target: WORKER_DEV_ORIGIN, changeOrigin: true },
      "/agents": { target: WORKER_DEV_ORIGIN, changeOrigin: true },
    },
  },
});
