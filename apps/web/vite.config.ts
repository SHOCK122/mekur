/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: {
    proxy: {
      // The routes already ported to Rust go to the Rust API server
      // (`PORT=3001 cargo run -p mekur-api`), the rest to the TS one -- the
      // same split nginx makes (infra/nginx.conf). Listed before "/api",
      // since the first matching entry wins.
      "^/api/(health|openapi\\.json|users|sessions|users/[^/?]+/salt|api-keys|api-keys/[^/?]*)(\\?|$)": {
        target: "http://localhost:3001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: ".",
      filename: "sw.ts",
      registerType: "autoUpdate",
      injectManifest: {
        // Same glob scope as the previous generateSW config -- precache
        // the app shell for offline/flaky-connection use.
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
      },
      manifest: {
        name: "Schedule App",
        short_name: "Schedule",
        description:
          "Open-source, end-to-end encrypted scheduling application",
        theme_color: "#1d4ed8",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
    }),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    globals: true,
  },
});
