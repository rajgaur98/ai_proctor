import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // WEB_PORT: per-worktree dev port (scripts/stack.sh); 5173 otherwise.
  server: { port: Number(process.env.WEB_PORT ?? 5173), strictPort: true },
  preview: { port: 4173, strictPort: true },
  // Unit tests only; e2e/ is Playwright's.
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
