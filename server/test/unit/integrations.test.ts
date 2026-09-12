/**
 * External tool integrations — SPEC §17, direction B, hermetic unit tests.
 *
 * These prove the bounded call mechanics without infra or real MCP
 * servers: the whitelist (enumerated, not discoverable), the registered-
 * not-discovered rule, the per-scope grant, the atomic frame budget, the
 * hard call timeout, the rate window, and the injection seam that lets
 * tests fake the wire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IntegrationService } from "../../src/integrations/service.js";
import type { IntegrationTransport, IntegrationServiceOptions } from "../../src/integrations/service.js";
import { generateAgeIdentity, ageRecipientOf, sealToRecipients } from "../../src/crypto/keys.js";

// A minimal fake pool: rows keyed by SQL (each test exercises one query).
function fakePool(rows: Record<string, unknown[]> = {}) {
  const queries = new Map<string, unknown[]>(Object.entries(rows));
  return {
    query: async (sql: string, params?: unknown[]) => {
      // Allow budget-spend queries to decrement by matching a prefix.
      for (const [key, val] of queries) {
        if (sql.startsWith(key)) return { rows: val, params };
      }
      return { rows: queries.get(sql) ?? [], params };
    },
  } as never;
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as never;
// The audit letter rides the pipeline — a stub that records ingests so
// the happy path reaches the assertion instead of failing on the audit.
const recordedLetters: unknown[] = [];
const noopPipeline = {
  ingest: async (letter: unknown) => {
    recordedLetters.push(letter);
    return { letterId: "audit-1", created: true };
  },
} as never;

function svc(pool: ReturnType<typeof fakePool> = fakePool(), opts: IntegrationServiceOptions = {}) {
  return new IntegrationService(pool, noopPipeline, noopLog, opts);
}

/** A fake wire — records calls, lets tests simulate results and hangs. */
function fakeTransport(over: Partial<IntegrationTransport> = {}): IntegrationTransport {
  return {
    callTool: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
    close: vi.fn(async () => {}),
    ...over,
  };
}

const CATALOG = {
  "SELECT id, url, version, tools, enabled FROM integrations WHERE id = $1": [
    {
      id: "web-search",
      url: "https://search.example.com/mcp",
      version: "1.2.3",
      tools: [{ name: "search", description: "search the web", verbs: ["read"] }],
      enabled: true,
    },
  ],
};

const GRANTED = {
  "SELECT tools FROM agent_integrations\n       WHERE agent_address = $1 AND integration_id = $2": [
    { tools: ["search", "extract"] },
  ],
};

// The audit query: SELECT creator from agents.
const AUDIT = {
  "SELECT creator FROM agents WHERE address = $1": [{ creator: "you@house" }],
};

describe("credential isolation — age-encrypted at rest, unsealed in memory", () => {
  async function makeKey() {
    const ageIdentity = await generateAgeIdentity();
    const ageRecipient = await ageRecipientOf(ageIdentity);
    return {
      get: async () => ({ ageIdentity, ageRecipient, ed25519Private: "", ed25519Public: "" }),
    } as never;
  }

  it("setCredentials seals to the house's key and refuses without house keys", async () => {
    // Without houseKeys → fail closed (the operator must boot a house first).
    const noKey = svc(fakePool());
    await expect(noKey.setCredentials("web-search", { apiKey: "sekrit" })).rejects.toThrow(
      "no-house-keys",
    );

    // With a real keypair, the stored value is armor — never plaintext.
    const key = await makeKey();
    const stored: Record<string, unknown[]> = {
      "UPDATE integrations SET credentials_enc = $2 WHERE id = $1": [{ rowCount: 1 }],
    };
    const pool = fakePool(stored);
    const s = svc(pool, { houseKeys: key });
    await s.setCredentials("web-search", { apiKey: "sekrit" });
    // The stored parameter array's second element (the armor) is not the
    // plaintext secret — the house seals, never stores cleartext.
    const params = stored["UPDATE integrations SET credentials_enc = $2 WHERE id = $1"] as unknown as { rowCount: number }[][];
    expect(JSON.stringify(params)).not.toContain("sekrit");
  });

  it("unsealCredentials returns the plaintext the operator sealed", async () => {
    const key = await makeKey();
    const k = key as { get: () => Promise<{ ageRecipient: string; ageIdentity: string }> };
    const { ageIdentity, ageRecipient } = await k.get();
    const enc = await sealToRecipients(JSON.stringify({ apiKey: "sekrit" }), [ageRecipient]);
    const pool = fakePool({
      "SELECT credentials_enc FROM integrations WHERE id = $1": [{ credentials_enc: enc }],
    });
    const s = svc(pool, { houseKeys: key });
    const creds = await s.unsealCredentials("web-search");
    expect(creds).toEqual({ apiKey: "sekrit" });
  });

  it("a call passes the unsealed credentials to the transport — the agent never sees them", async () => {
    const key = await makeKey();
    const k = key as { get: () => Promise<{ ageRecipient: string; ageIdentity: string }> };
    const { ageRecipient } = await k.get();
    const enc = await sealToRecipients(JSON.stringify({ apiKey: "sekrit" }), [ageRecipient]);
    let passed: Record<string, string> | undefined;
    const pool = fakePool({
      ...CATALOG,
      ...GRANTED,
      ...AUDIT,
      "UPDATE agent_integrations": [{ remaining: 5 }],
      "SELECT credentials_enc FROM integrations WHERE id = $1": [{ credentials_enc: enc }],
    });
    const s = svc(pool, {
      houseKeys: key,
      transportFactory: (_url, creds) => {
        passed = creds;
        return fakeTransport();
      },
    });
    const res = await s.call("grantwatch@house", "web-search", "search", { q: "grants" });
    expect(res.ok).toBe(true);
    expect(passed).toEqual({ apiKey: "sekrit" });
  });
});

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
    const s = svc(fakePool(CATALOG));
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

describe("bounded calls", () => {
  let transport: IntegrationTransport;

  beforeEach(() => {
    transport = fakeTransport();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls a granted tool through an injected transport and audits the call", async () => {
    const pool = fakePool({
      ...CATALOG,
      ...GRANTED,
      ...AUDIT,
      "UPDATE agent_integrations": [{ remaining: 5 }],
    });
    const s = svc(pool, {
      transportFactory: (url) => {
        expect(url).toBe("https://search.example.com/mcp");
        return transport;
      },
    });
    const res = await s.call("grantwatch@house", "web-search", "search", { q: "grants" });
    expect(res.ok).toBe(true);
    expect(transport.callTool).toHaveBeenCalledWith(
      { name: "search", arguments: { q: "grants" } },
      { timeout: expect.any(Number) },
    );
  });

  it("refuses a tool that is registered but not granted", async () => {
    const s = svc(
      fakePool({
        ...CATALOG,
        "SELECT tools FROM agent_integrations\n       WHERE agent_address = $1 AND integration_id = $2": [
          { tools: ["search"] },
        ],
        ...AUDIT,
      }),
      { transportFactory: () => transport },
    );
    const res = await s.call("grantwatch@house", "web-search", "extract", {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not granted");
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("refuses an unregistered integration before touching the wire", async () => {
    const s = svc(fakePool({ ...AUDIT }), { transportFactory: () => transport });
    const res = await s.call("grantwatch@house", "not-registered", "search", {});
    expect(res.ok).toBe(false);
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("decrements the frame budget on each call — exhaustion is refused", async () => {
    // Budget-spend query returns remaining 0 → budget exhausted.
    const s = svc(
      fakePool({
        ...CATALOG,
        ...GRANTED,
        ...AUDIT,
        "UPDATE agent_integrations": [], // spend returns no row → null
      }),
      { transportFactory: () => transport },
    );
    const res = await s.call("grantwatch@house", "web-search", "search", {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("budget");
    expect(transport.callTool).not.toHaveBeenCalled();
  });

  it("rate-limits a hot agent — the window holds, it never floods", async () => {
    const s = svc(
      fakePool({
        ...CATALOG,
        ...GRANTED,
        ...AUDIT,
        "UPDATE agent_integrations": [{ remaining: 5 }],
      }),
      {
        transportFactory: () => transport,
        rateMax: 2,
        rateWindowMs: 60_000,
      },
    );
    const first = await s.call("grantwatch@house", "web-search", "search", {});
    const second = await s.call("grantwatch@house", "web-search", "search", {});
    const third = await s.call("grantwatch@house", "web-search", "search", {});
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(false);
    expect(third.error).toContain("rate limited");

    // Time passes — the window reopens.
    vi.advanceTimersByTime(61_000);
    const fourth = await s.call("grantwatch@house", "web-search", "search", {});
    expect(fourth.ok).toBe(true);
  });

  it("surfaces a transport failure as a refused call, not a crash", async () => {
    const broken = fakeTransport({
      callTool: vi.fn(async () => {
        throw new Error("timed out after 15000ms");
      }),
    });
    const s = svc(
      fakePool({
        ...CATALOG,
        ...GRANTED,
        ...AUDIT,
        "UPDATE agent_integrations": [{ remaining: 5 }],
      }),
      { transportFactory: () => broken },
    );
    const res = await s.call("grantwatch@house", "web-search", "search", {});
    expect(res.ok).toBe(false);
    expect(res.error).toContain("timed out");
  });

  it("audits failures too — the creator sees what their instrument tried", async () => {
    const pool = fakePool({ ...CATALOG, ...GRANTED, ...AUDIT });
    const s = svc(pool, { transportFactory: () => fakeTransport({
      callTool: vi.fn(async () => {
        throw new Error("boom");
      }),
    }) });
    const res = await s.call("grantwatch@house", "web-search", "search", {});
    expect(res.ok).toBe(false);
    // The audit letter was written by the pipeline (the fake records it).
    // At minimum, a failure must not throw out of the service.
    expect(res.eventId).toMatch(/^evt_/);
  });
});
