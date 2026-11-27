import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  plugins: [react()],
  // cssTarget: browsers with native light-dark() (2024), so the theme tokens (ui/tokens.css) resolve where they are used and
  // a [data-theme] subtree can force a theme; the polyfill would fix each token at :root.
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false, cssTarget: ["chrome123", "edge123", "firefox120", "safari17.5"] },
  // `bun run dev:web` proxies the API to a board server on :3120.
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:3120", headers: { host: "localhost:3120" } }, "/sessions": { target: "http://127.0.0.1:3120", ws: true, headers: { host: "localhost:3120" } } } },
});
