import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const consoleOutput = fileURLToPath(new URL("../dist/console/", import.meta.url));

export default defineConfig({
  plugins: [{
    name: "clean-console-static-assets",
    apply: "build",
    buildStart() {
      rmSync(new URL("index.html", new URL("../dist/console/", import.meta.url)), { force: true });
      rmSync(new URL("assets/", new URL("../dist/console/", import.meta.url)), { force: true, recursive: true });
    },
  }, react()],
  build: {
    assetsDir: "assets",
    emptyOutDir: false,
    outDir: consoleOutput,
  },
});
