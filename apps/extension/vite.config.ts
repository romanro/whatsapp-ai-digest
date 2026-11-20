import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Extension pages (popup + options). The content script is built separately as a classic IIFE
// (vite.content.config.ts) because Chrome content scripts can't be ES modules.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: "",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: mode === "development",
    minify: mode !== "development",
    rollupOptions: {
      input: {
        popup: resolve(import.meta.dirname, "popup.html"),
        options: resolve(import.meta.dirname, "options.html"),
        // MV3 service worker (ES module); must sit at a fixed path referenced by the manifest.
        background: resolve(import.meta.dirname, "src/background.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  test: {
    environment: "happy-dom",
  },
}));
