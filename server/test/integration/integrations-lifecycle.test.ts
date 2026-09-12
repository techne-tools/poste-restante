/**
 * External integrations — SPEC §17, direction B, integration tests.
 *
 * The operator registers, grants, and calls against live infra. The
 * wire itself is faked (an injected transport) — the point is the DB
 * wiring: register → catalog, grant → whitelist, call → budget spent →
 * audit letter stored → exhaustion refused. The real `npx -y <url>`
 * transport is the operator's registration choice, exactly like
 * installing a sidecar; this suite proves the house's half.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { IntegrationService } from "../../src/integrations/service.js";
import { deliverLetter } from "../../src/deliver.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("external integrations (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;
  let svc: IntegrationService;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "basic",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE invites, whispers, clauses, clause_objectors, clause_vouchers,
              thread_participation, letters, threads, frames, addresses, credentials,
              address_keys, agents, integrations, agent_integrations, letter_reads,
              oidc_bindings, retired_handles
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, identity_id, is_public)
       VALUES ('book@house', 'book@house', false), ('pub@house', 'pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth, house.whisper);
    await auth.setPassword("you@house", "youyouyou");

    // A portal agent, born the §16 way (a birth letter to agents@house).
    // Through the REAL delivery seam (the same path POST /v1/letters
    // uses) so the birth spawns the agent row + token + keys.
    await deliverLetter(house, {
      envelope: {
        from: "you@house",
        to: ["agents@house"],
        cc: [],
        thread: "th_birth_int_1",
        kind: "agent",
        lang: "en-AU",
        subject: "",
      },
      time: { gregorian: new Date().toISOString(), frames: [] },
      body: {
        format: "markdown",
        content: "watch the calls for international arts grants",
      },
    });

    app = createLetterServer(house, { auth });
    svc = new IntegrationService(house.db.pool, house.pipeline, house.log);
  });

  afterAll(async () => {
    await house.close();
  });

  it("registers → grants → calls → audits → exhausts — the bounded arc", async () => {
    // The agent address derived from the task slug (40-char slice).
    const agent = "watch-the-calls-for-international-arts-g@house";

    // The operator registers an integration (a web-search MCP, pinned).
    await svc.register("web-search", "https://search.example.com/mcp", "1.2.3", [
      { name: "search", description: "search the web", verbs: ["read"] },
      { name: "extract", description: "extract a page", verbs: ["read"] },
    ]);

    // The catalog is real.
    const integration = await svc.getIntegration("web-search");
    expect(integration?.version).toBe("1.2.3");
    expect(integration?.tools.map((t) => t.name)).toEqual(["search", "extract"]);

    // The creator grants only `search` with a budget of 2.
    await svc.grant(agent, "web-search", ["search"], 2);
    expect(await svc.allowedTools(agent, "web-search")).toEqual(["search"]);

    // Two calls — the wire is faked; the house does the accounting.
    const wire = {
      callTool: async () => ({ content: [{ type: "text", text: "the call" }] }),
      close: async () => {},
    };
    const s = new IntegrationService(house.db.pool, house.pipeline, house.log, {
      transportFactory: () => wire,
    });

    const first = await s.call(agent, "web-search", "search", { q: "grants" });
    expect(first.ok).toBe(true);
    const second = await s.call(agent, "web-search", "search", { q: "grants" });
    expect(second.ok).toBe(true);

    // The budget is spent — the third call is refused before the wire.
    const refused = await s.call(agent, "web-search", "search", { q: "grants" });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("budget");

    // Audit letters exist — one per call, addressed to the creator and
    // the agent, never the pub.
    const audits = await house.db.pool.query<{
      from_addr: string;
      to_addrs: string[];
      subject: string;
    }>(
      `SELECT from_addr, to_addrs, subject FROM letters
       WHERE from_addr = $1 AND subject LIKE 'integration call:%'
       ORDER BY received_at`,
      [agent],
    );
    expect(audits.rows.length).toBe(3); // two successes + one refusal
    expect(audits.rows[0].to_addrs).toContain("you@house");
    expect(audits.rows[0].to_addrs).toContain(agent);

    // The creator can read the audit letters through the normal mailbox.
    const mail = await app.request("/v1/addresses/you@house/inbox", {
      headers: { Authorization: `Basic ${Buffer.from("you@house:youyouyou").toString("base64")}` },
    });
    const inbox = (await mail.json()) as {
      letters: { envelope: { from: string } }[];
    };
    expect(inbox.letters.some((l) => l.envelope.from === agent)).toBe(true);

    // An ungranted tool is refused (extract is registered but not granted).
    const ungranted = await s.call(agent, "web-search", "extract", {});
    expect(ungranted.ok).toBe(false);
    expect(ungranted.error).toContain("not granted");
  });
});
