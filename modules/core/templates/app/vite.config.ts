import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // Every asset is a file served from 'self': nothing is inlined as a data: URL, so the CSP needs no data: source.
  build: { assetsInlineLimit: 0 },
  server: { proxy: { "/api": "http://127.0.0.1:8080" } },
  // Component tests (src/**/*.test.tsx): Vitest with happy-dom, which gives Radix's dialogs, sheets and selects everything
  // they need with no polyfills, and sets the DOM up before any component is imported. test/ui-tests.test.mjs checks this.
  test: { environment: "happy-dom", include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["./src/test/setup.ts"] },
});
