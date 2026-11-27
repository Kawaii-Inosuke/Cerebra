/// <reference types="vitest/config" />
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
// The one place the UI's version comes from (scripts/bump-version.mjs keeps it in step with the app).
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
// The browser preview (`cerebra <library> serve --port 1430`) answers /api and /file.
const preview = "http://127.0.0.1:1430";

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  cacheDir: "../node_modules/.vite",
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": { target: preview, changeOrigin: true },
      "/file": { target: preview, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  test: {
    root,
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
