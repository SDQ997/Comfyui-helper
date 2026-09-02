import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Tauri 前端资源
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
