import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults to local infra", () => {
    const cfg = loadConfig({});
    expect(cfg.databaseUrl).toContain("localhost");
    expect(cfg.qdrantUrl).toContain("localhost");
    expect(cfg.embedding.baseUrl).toBeUndefined(); // local ollama
    expect(cfg.embedding.model).toBe("nomic-embed-text");
    expect(cfg.embedding.dimension).toBe(768);
    expect(cfg.integration).toBe(false);
  });

  it("reads the cloud embedding opt-in from one env var", () => {
    const cfg = loadConfig({
      EMBEDDING_BASE_URL: "https://api.openai.com/v1",
      EMBEDDING_API_KEY: "sk-test",
      EMBEDDING_MODEL: "text-embedding-3-small",
      EMBEDDING_DIMENSION: "1536",
    });
    expect(cfg.embedding.baseUrl).toBe("https://api.openai.com/v1");
    expect(cfg.embedding.apiKey).toBe("sk-test");
    expect(cfg.embedding.model).toBe("text-embedding-3-small");
    expect(cfg.embedding.dimension).toBe(1536);
  });

  it("reads the integration flag", () => {
    expect(loadConfig({ POSTE_RESTANTE_INTEGRATION: "1" }).integration).toBe(true);
    expect(loadConfig({ POSTE_RESTANTE_INTEGRATION: "true" }).integration).toBe(true);
    expect(loadConfig({ POSTE_RESTANTE_INTEGRATION: "0" }).integration).toBe(false);
  });
});
