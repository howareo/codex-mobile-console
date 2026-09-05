import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: "web",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Codex Mobile Console",
        short_name: "Codex",
        description: "Mobile console for a local Codex app-server",
        theme_color: "#0a0c0b",
        background_color: "#0a0c0b",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }
        ]
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//]
      }
    })
  ],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4174"
    }
  }
});
