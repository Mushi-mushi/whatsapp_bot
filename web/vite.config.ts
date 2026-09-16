import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: 5173,
    // Proxy API + SSE to bot-core during local dev.
    proxy: {
      "/api": {
        target: process.env.BOT_CORE_URL ?? "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
});
