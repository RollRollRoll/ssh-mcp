import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    assetsDir: "assets",
    emptyOutDir: true,
    outDir: "../dist/console",
  },
});
