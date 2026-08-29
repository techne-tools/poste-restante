import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The reference client. Dev server proxies to the letter server so the
// client never needs to know where the house lives.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: process.env.POSTE_RESTANTE_URL ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
