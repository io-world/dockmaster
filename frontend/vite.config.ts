import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: the Vite server proxies /api to FastAPI. Prod: FastAPI serves the built files from the same origin.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // DOCKMASTER_API lets a second backend (e.g. an automated test on another port) be used.
    proxy: { "/api": { target: process.env.DOCKMASTER_API ?? "http://127.0.0.1:8000", changeOrigin: false } },
  },
});
