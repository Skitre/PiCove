import { defineConfig } from "vite";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const tauriDevHost = process.env.TAURI_DEV_HOST;
const host = tauriDevHost || "127.0.0.1";
const pdfRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const pdfAssets = ["cmaps", "standard_fonts", "wasm"];

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "local-pdf-assets",
      configureServer(server) {
        server.middlewares.use("/pdf-assets", (req, res, next) => {
          const match = /^\/([a-z_]+)\/([A-Za-z0-9_.-]+)$/.exec(req.url ?? "");
          if (!match || !pdfAssets.includes(match[1]) || match[2].startsWith(".")) return next();
          try {
            const bytes = readFileSync(join(pdfRoot, match[1], match[2]));
            res.setHeader(
              "Content-Type",
              match[2].endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
            );
            res.end(bytes);
          } catch {
            next();
          }
        });
      },
      generateBundle() {
        for (const folder of pdfAssets)
          for (const name of readdirSync(join(pdfRoot, folder))) {
            this.emitFile({
              type: "asset",
              fileName: `pdf-assets/${folder}/${name}`,
              source: readFileSync(join(pdfRoot, folder, name)),
            });
          }
      },
    },
  ],
  // The protocol package is rebuilt during desktop development. Serving it directly
  // prevents Vite's dependency cache from keeping stale response validators alive.
  optimizeDeps: {
    exclude: ["@pideck/protocol"],
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host,
    hmr: tauriDevHost
      ? {
          protocol: "ws",
          host: tauriDevHost,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
