import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests talk to real postgres/qdrant/ollama. They are opt-in
    // via the POSTE_RESTANTE_INTEGRATION env var so `npm test` stays hermetic
    // in CI (which has no postgres/qdrant/ollama).
    env: {
      NODE_ENV: "test",
    },
  },
});
