import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Dev preview against a running gateway, e.g. CODEX_MOBILE_DEV_GATEWAY=https://127.0.0.1:4174.
// The gateway rejects cross-site Origin on writes and /api/events, so present the gateway's own origin.
const gateway = process.env.CODEX_MOBILE_DEV_GATEWAY || "http://127.0.0.1:4174";
const sameOrigin: ProxyOptions["configure"] = proxy => {
  proxy.on("proxyReq", req => req.setHeader("origin", gateway));
  proxy.on("proxyReqWs", req => req.setHeader("origin", gateway));
};

export default defineConfig({
  root: "web",
  ...(process.env.CODEX_MOBILE_VITE_CACHE ? { cacheDir: process.env.CODEX_MOBILE_VITE_CACHE } : {}),
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
      "/api": { target: gateway, changeOrigin: true, secure: false, ws: true, configure: sameOrigin }
    }
  }
});
