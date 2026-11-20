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
      },
    },
  },
  test: {
    environment: "happy-dom",
  },
}));
