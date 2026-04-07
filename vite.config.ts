import fs from "fs";
import path from "path";

// @ts-expect-error - no types available
import nodePolyfills from "vite-plugin-node-stdlib-browser";

import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const browserPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "node_modules/@enbox/browser/package.json"), "utf-8"),
);

// https://vitejs.dev/config/
export default defineConfig({
  base: '/',
  define: {
    global                    : "globalThis",
    '__ENBOX_SDK_VERSION__'   : JSON.stringify(browserPkg.version),
  },
  plugins: [
    nodePolyfills(),
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: "auto",

      pwaAssets: {
        disabled: true,
        config: true,
      },

      manifest: {
        name: "nutsd",
        short_name: "nutsd",
        description: "Decentralized Cashu ecash wallet powered by Enbox",
        theme_color: "#08090a",
        background_color: "#08090a",
        start_url: "/",
        display: "standalone",
        orientation: "any",
        icons: [
          {
            src: "/favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
          },
          {
            src: "/favicon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },

      injectManifest: {
        maximumFileSizeToCacheInBytes: 5000000,
        globPatterns: ["**/*.{js,css,html,json,svg,png,ico}"],
        rollupFormat: "iife",
        buildPlugins: {
          rollup: [
            {
              name: "sw-process-shim",
              renderChunk(code: string) {
                const shim = `if(typeof process==="undefined"){self.process={env:{},browser:true,emitWarning:function(){}};};\n`;
                return { code: shim + code, map: null };
              },
            },
          ],
        },
      },

      devOptions: {
        enabled: true,
        navigateFallback: "index.html",
        suppressWarnings: false,
        type: "module",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
