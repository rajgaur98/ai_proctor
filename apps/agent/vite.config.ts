import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri loads the popover from this dev server (tauri.conf.json devUrl).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "safari16", outDir: "dist", emptyOutDir: true },
});
