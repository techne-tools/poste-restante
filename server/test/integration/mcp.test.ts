/**
 * MCP house integration tests — the full MCP protocol against live infra
 * (postgres 15, qdrant, ollama). Gated by POSTE_RESTANTE_INTEGRATION=1 so
 * `npm test` stays hermetic in CI. Run locally with:
 *
 *   POSTE_RESTANTE_INTEGRATION=1 npm run test:integration
 *
 * Uses the dedicated test database and qdrant collection, never real data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildHouse } from "../../src/index.js";
import { createMcpHouse } from "../../src/mcp/server.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const mkLetter = (over: Record<string, unknown> = {}) => ({
  envelope: {
    from: "hermes@house",
    to: ["you@house"],
    cc: [],
    thread: "th_mcp_integration",
    kind: "letter",
    lang: "en-AU",
    subject: "re: the plural-time archive",
  },
  time: {
    gregorian: "2026-08-29T14:00:00+04:00",
    frames: [
      { frame: "islamic", value: "1448-03-15" },
      { frame: "season", value: "autumn" },
      { frame: "production", value: "tempest-tech-week" },
    ],
  },
  body: {
    format: "markdown",
    content: "## The archive, in practice\n\nWe discussed the **sound design** for the show.",
  },
  ...over,
});

describe.skipIf(!INTEGRATION)("mcp house (integration)", () => {
  let house: House;
  let client: Client;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE letters, threads, frames, addresses RESTART IDENTITY CASCADE`,
    );

    const server = createMcpHouse(house);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "integration-test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
    await house.close();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    const text = res.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    return JSON.parse(text);
  }

  it("delivers a letter through the full pipeline (stored → embedded → indexed)", async () => {
    const delivered = await call("deliver_letter", { letter: mkLetter() });
    expect(delivered.created).toBe(true);
    expect(delivered.id).toMatch(/^[0-9a-f]{64}$/);

    const got = await call("get_letter", { id: delivered.id });
    expect(got.envelope.from).toBe("hermes@house");
    expect(got.time.frames).toHaveLength(3);
  });

  it("searches semantically — the letter is findable by meaning", async () => {
    const hits = await call("search_letters", { text: "sound design" });
    expect(hits.letters.length).toBeGreaterThan(0);
    expect(hits.letters[0].body.content).toContain("sound design");
  });

  it("surfaces a house letter in the whisper and dismisses it", async () => {
    const delivered = await call("deliver_letter", {
      letter: mkLetter({
        envelope: {
          from: "house@house",
          to: ["you@house"],
          cc: [],
          thread: "th_mcp_whisper",
          kind: "system",
          lang: "en-AU",
          subject: "the archive, in practice",
        },
        body: {
          format: "markdown",
          content: "I noticed the tempest correspondence has gone quiet.",
        },
      }),
    });
    expect(delivered.created).toBe(true);

    const whispers = await call("list_whispers", { unread: true });
    expect(whispers.whispers.length).toBeGreaterThan(0);
    const id = whispers.whispers[0].id;

    const dismissed = await call("dismiss_whisper", { id });
    expect(dismissed.dismissed).toBe(true);

    const after = await call("list_whispers", { unread: true });
    expect(after.whispers.some((w: { id: string }) => w.id === id)).toBe(false);
  });

  it("deletes a letter — gone from all tiers", async () => {
    const delivered = await call("deliver_letter", { letter: mkLetter() });
    const deleted = await call("delete_letter", { id: delivered.id });
    expect(deleted.deleted).toBe(true);

    const res = await client.callTool({ name: "get_letter", arguments: { id: delivered.id } });
    expect(res.isError).toBe(true);
  });
});
