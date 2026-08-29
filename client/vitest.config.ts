import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The reference client's unit tests. The api.ts client is pure fetch logic —
// mocked fetch, no jsdom needed. The views are verified by the E2E run.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
