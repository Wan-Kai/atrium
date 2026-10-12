import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config for the UI.
 *
 * @remarks
 * The dev server port is fixed so the desktop app can allow exactly this origin on the host
 * (security.md, "WebSocket 与鉴权"); it defaults to 5791 rather than Vite's 5173, which other
 * projects on the same machine tend to hold. The production build is served by the host itself.
 * Dependencies are pre-bundled up front: discovered mid-run, Vite reloads the page, which in
 * browser tests loads React twice and fails whatever renders.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: Number(process.env["ATRIUM_DEV_PORT"] ?? 5791), strictPort: true, host: "127.0.0.1" },
  build: { outDir: "dist", emptyOutDir: true },
  optimizeDeps: {
    include: [
      "react",
      "react-dom/client",
      "zustand",
      "zustand/vanilla",
      "@hugeicons/react",
      "@hugeicons/core-free-icons",
      "streamdown",
      "@streamdown/code",
      "@streamdown/cjk",
      "@streamdown/math",
      "@streamdown/mermaid",
      "vitest-browser-react",
    ],
  },
});
