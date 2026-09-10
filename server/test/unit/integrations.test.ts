/**
 * External tool integrations — SPEC §17, direction B, hermetic unit tests.
 *
 * These prove the pure logic without infra: the whitelist (enumerated,
 * not discoverable), the registered-not-discovered rule, and the
 * per-scope grant.
 */
import { describe, it, expect } from "vitest";
import { IntegrationService } from "../../src/integrations/service.js";

// A minimal fake pool: rows keyed by SQL (each test exercises one query).
function fakePool(rows: Record<string, unknown[]> = {}) {
  return {
    query: async (sql: string) => {
      return { rows: rows[sql] ?? [] };
    },
  } as never;
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as never;
const noopPipeline = {} as never;

function svc(pool: ReturnType<typeof fakePool> = fakePool()) {
  return new IntegrationService(pool, noopPipeline, noopLog);
}

describe("the whitelist — enumerated, not discoverable", () => {
  it("returns the tools granted to an agent", async () => {
    const s = svc(
      fakePool({
        "SELECT tools FROM agent_integrations\n       WHERE agent_address = $1 AND integration_id = $2": [
          { tools: ["search", "extract"] },
        ],
      }),
    );
    expect(await s.allowedTools("grantwatch@house", "web-search")).toEqual(["search", "extract"]);
  });

  it("returns null when nothing is granted — no tools, no calls", async () => {
    const s = svc(fakePool());
    expect(await s.allowedTools("grantwatch@house", "web-search")).toBeNull();
  });
});

describe("registered, not discovered", () => {
  it("returns the integration catalog", async () => {
    const s = svc(
      fakePool({
        "SELECT id, url, version, tools, enabled FROM integrations WHERE id = $1": [
          {
            id: "web-search",
            url: "https://search.example.com/mcp",
            version: "1.2.3",
            tools: [{ name: "search", description: "search the web", verbs: ["read"] }],
            enabled: true,
          },
        ],
      }),
    );
    const integration = await s.getIntegration("web-search");
    expect(integration).not.toBeNull();
    expect(integration!.url).toBe("https://search.example.com/mcp");
    expect(integration!.tools[0].name).toBe("search");
  });

  it("returns null for an unregistered integration — SSRF dead by construction", async () => {
    const s = svc(fakePool());
    expect(await s.getIntegration("not-registered")).toBeNull();
  });
});
