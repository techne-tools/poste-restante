/**
 * MCP house unit tests — hermetic. The house is faked; no postgres, qdrant,
 * or ollama required. These verify the MCP protocol surface: tool discovery,
 * validation, idempotency, and the absence of a push channel.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHouse } from "../../src/mcp/server.js";
import type { House } from "../../src/house.js";
import type { Letter } from "../../src/types.js";
import type { RetrievalHit } from "../../src/retrieval/retrieval.js";

const mkLetter = (over: Partial<Letter> = {}): Letter => ({
  envelope: {
    from: "hermes@house",
    to: ["you@house"],
    cc: [],
    thread: "th_9f2c1",
    kind: "letter",
    lang: "en-AU",
    subject: "re: the plural-time archive",
  },
  time: {
    gregorian: "2026-08-29T14:00:00+04:00",
    frames: [{ frame: "season", value: "autumn" }],
  },
  body: {
    format: "markdown",
    content: "## The archive, in practice\n\nWe discussed the **sound design**.",
  },
  ...over,
});

/** A fake house: in-memory letters, no infra. Mirrors the letter-server unit tests. */
function fakeHouse(): House {
  const letters = new Map<string, Letter & { receivedAt: Date }>();
  const addresses = new Set<string>();
  const addressMeta = new Map<string, { names: string[]; pronouns: string | null }>();
  const frames = new Set<string>();
  const whispers = new Map<string, { id: string; dismissed: boolean }>();

  const house = {
    config: {} as never,
    db: {} as never,
    semantic: {} as never,
    embedder: {} as never,
    payloads: {} as never,
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    repo: {
      getLetter: async (id: string) => {
        const l = letters.get(id);
        if (!l) return null;
        return {
          id,
          from_addr: l.envelope.from,
          to_addrs: l.envelope.to,
          cc_addrs: l.envelope.cc,
          thread_id: l.envelope.thread,
          kind: l.envelope.kind,
          lang: l.envelope.lang,
          subject: l.envelope.subject,
          body: l.body.content,
          body_text: l.body.content,
          received_at: l.receivedAt,
          pinned_at: null,
          pinned_by: null,
          frames: l.time.frames,
        };
      },
      getLetters: async (ids: string[]) => {
        const out = [];
        for (const id of ids) {
          const row = await house.repo.getLetter(id);
          if (row) out.push(row);
        }
        return out;
      },
      listAddresses: async () =>
        [...addresses].map((id) => ({
          id,
          names: addressMeta.get(id)?.names ?? [],
          pronouns: addressMeta.get(id)?.pronouns ?? null,
        })),
      getAddress: async (id: string) =>
        addresses.has(id)
          ? {
              id,
              names: addressMeta.get(id)?.names ?? [],
              pronouns: addressMeta.get(id)?.pronouns ?? null,
              is_public: false,
            }
          : null,
      updateAddress: async (id: string, names: string[], pronouns: string | null) => {
        addressMeta.set(id, { names, pronouns });
      },
      setPublic: async () => true,
      listFrames: async () =>
        [...frames].map((id) => {
          const [name, value] = id.split(":");
          return { id, name: name!, value: value ?? "" };
        }),
      listMailbox: async (address: string, limit: number) => {
        const rows = [];
        for (const l of letters.values()) {
          if (
            l.envelope.from === address ||
            l.envelope.to.includes(address) ||
            l.envelope.cc.includes(address)
          ) {
            rows.push(await house.repo.getLetter(l.id!));
          }
        }
        return rows.slice(0, limit);
      },
      listThread: async (threadId: string) => {
        const rows = [];
        for (const l of letters.values()) {
          if (l.envelope.thread === threadId) rows.push(await house.repo.getLetter(l.id!));
        }
        return rows;
      },
      pinLetter: async () => {},
      unpinLetter: async () => {},
    },
    pipeline: {
      ingest: async (letter: Letter) => {
        // Deterministic id from content, mirroring the real pipeline.
        const id = `sha256-${JSON.stringify(letter).length}-${letter.envelope.thread}-${letter.body.content.length}`;
        const existing = letters.get(id);
        if (existing) return { letterId: id, created: false };
        letters.set(id, { ...letter, id, receivedAt: new Date(letter.time.gregorian) });
        addresses.add(letter.envelope.from);
        for (const a of letter.envelope.to) addresses.add(a);
        for (const f of letter.time.frames) frames.add(`${f.frame}:${f.value}`);
        return { letterId: id, created: true };
      },
      delete: async (id: string) => letters.delete(id),
    },
    retrieval: {
      search: async (query: { text?: string; from?: string }) => {
        const hits: RetrievalHit[] = [];
        for (const [id, l] of letters) {
          let score = 0;
          const paths: string[] = [];
          if (query.from && l.envelope.from === query.from) {
            score += 1 / 61;
            paths.push("exact");
          }
          if (query.text && l.body.content.includes(query.text)) {
            score += 1 / 61;
            paths.push("fulltext");
          }
          if (score > 0) hits.push({ letterId: id, score, paths, ranks: {} });
        }
        hits.sort((a, b) => b.score - a.score);
        return hits;
      },
    },
    whisper: {
      list: async () =>
        [...whispers.values()].map((w) => ({
          id: w.id,
          letterId: null,
          kind: "house-letter",
          targetThread: null,
          summary: "",
          createdAt: new Date(),
          openedAt: null,
          dismissedAt: w.dismissed ? new Date() : null,
          repliedAt: null,
        })),
      listUnread: async () =>
        [...whispers.values()]
          .filter((w) => !w.dismissed)
          .map((w) => ({
            id: w.id,
            letterId: null,
            kind: "house-letter",
            targetThread: null,
            summary: "",
            createdAt: new Date(),
            openedAt: null,
            dismissedAt: null,
            repliedAt: null,
          })),
      open: async () => true,
      dismiss: async (id: string) => {
        const w = whispers.get(id);
        if (!w) return false;
        w.dismissed = true;
        return true;
      },
      undismiss: async (id: string) => {
        const w = whispers.get(id);
        if (!w) return false;
        w.dismissed = false;
        return true;
      },
      detectGaps: async () => [],
      surfaceHouseLetter: async (letterId: string, threadId: string, summary: string) => {
        whispers.set(`house:${letterId}`, { id: `house:${letterId}`, dismissed: false });
      },
      recordReply: async () => {},
    },
    close: async () => {},
  } as unknown as House;

  return house;
}

/** Connect an MCP client to the house over an in-memory transport. */
async function connect(house: House) {
  const server = createMcpHouse(house);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

/** Call a tool and return the parsed JSON text content. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("\n");
  return JSON.parse(text);
}

describe("mcp house", () => {
  let house: House;
  let client: Client;

  beforeEach(async () => {
    house = fakeHouse();
    const c = await connect(house);
    client = c.client;
  });

  it("exposes the protocol tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "delete_letter",
        "deliver_letter",
        "detect_gaps",
        "dismiss_whisper",
        "get_address",
        "get_letter",
        "list_addresses",
        "list_frames",
        "list_whispers",
        "open_whisper",
        "pin_letter",
        "read_mailbox",
        "read_thread",
        "search_letters",
        "undismiss_whisper",
        "unpin_letter",
        "update_address",
      ].sort(),
    );
  });

  it("delivers a letter and reads it back", async () => {
    const letter = mkLetter();
    const delivered = await call(client, "deliver_letter", { letter });
    expect(delivered.created).toBe(true);
    expect(delivered.id).toBeTruthy();

    const got = await call(client, "get_letter", { id: delivered.id });
    expect(got.envelope.from).toBe("hermes@house");
    expect(got.body.content).toContain("sound design");
    expect(got.time.frames[0].value).toBe("autumn");
  });

  it("is idempotent — the same letter is stored once", async () => {
    const letter = mkLetter();
    const first = await call(client, "deliver_letter", { letter });
    const second = await call(client, "deliver_letter", { letter });
    expect(first.id).toBe(second.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
  });

  it("ignores a caller-supplied id — the hash is the identity", async () => {
    const letter = mkLetter({ id: "caller-supplied-id" });
    const delivered = await call(client, "deliver_letter", { letter });
    expect(delivered.id).not.toBe("caller-supplied-id");
  });

  it("rejects a letter that does not match the contract", async () => {
    const bad = mkLetter();
    (bad.envelope as { to?: string[] }).to = []; // empty recipients
    const res = await client.callTool({ name: "deliver_letter", arguments: { letter: bad } });
    expect(res.isError).toBe(true);
  });

  it("searches the archive by text and from", async () => {
    await call(client, "deliver_letter", { letter: mkLetter() });
    await call(client, "deliver_letter", {
      letter: mkLetter({
        envelope: { ...mkLetter().envelope, from: "ben@house", thread: "th_other" },
        body: { format: "markdown", content: "A completely different letter about the weather." },
      }),
    });

    const byText = await call(client, "search_letters", { text: "sound design" });
    expect(byText.letters.length).toBe(1);
    expect(byText.letters[0].envelope.from).toBe("hermes@house");

    const byFrom = await call(client, "search_letters", { from: "ben@house" });
    expect(byFrom.letters.length).toBe(1);
    expect(byFrom.letters[0].body.content).toContain("weather");
  });

  it("reads the mailbox and the thread", async () => {
    await call(client, "deliver_letter", { letter: mkLetter() });
    await call(client, "deliver_letter", {
      letter: mkLetter({
        envelope: { ...mkLetter().envelope, thread: "th_other" },
        body: { format: "markdown", content: "Second letter." },
      }),
    });

    const inbox = await call(client, "read_mailbox", { address: "you@house" });
    expect(inbox.letters.length).toBe(2);

    const thread = await call(client, "read_thread", { thread: "th_9f2c1" });
    expect(thread.letters.length).toBe(1);
  });

  it("manages the address book", async () => {
    await call(client, "deliver_letter", { letter: mkLetter() });

    const addresses = await call(client, "list_addresses");
    expect(addresses.addresses.map((a: { id: string }) => a.id)).toContain("hermes@house");

    // Only the address itself may correct its own entry — the dev-mode
    // caller is you@house, so that is the address it can correct.
    const corrected = await call(client, "update_address", {
      address: "you@house",
      names: ["You", "the resident"],
      pronouns: "they/them",
    });
    expect(corrected.names).toEqual(["You", "the resident"]);
    expect(corrected.pronouns).toBe("they/them");
  });

  it("lists frames", async () => {
    await call(client, "deliver_letter", { letter: mkLetter() });
    const frames = await call(client, "list_frames");
    expect(frames.frames).toContainEqual(
      expect.objectContaining({ name: "season", value: "autumn" }),
    );
  });

  it("pins and unpins a letter", async () => {
    const delivered = await call(client, "deliver_letter", { letter: mkLetter() });
    const pinned = await call(client, "pin_letter", { id: delivered.id });
    expect(pinned.pinned).toBe(true);
    const unpinned = await call(client, "unpin_letter", { id: delivered.id });
    expect(unpinned.pinned).toBe(false);
  });

  it("deletes a letter — first-class, no soft delete", async () => {
    const delivered = await call(client, "deliver_letter", { letter: mkLetter() });
    const deleted = await call(client, "delete_letter", { id: delivered.id });
    expect(deleted.deleted).toBe(true);

    const res = await client.callTool({ name: "get_letter", arguments: { id: delivered.id } });
    expect(res.isError).toBe(true);
  });

  it("lists, dismisses, and undismisses whispers", async () => {
    // A house letter surfaces in the whisper.
    await call(client, "deliver_letter", {
      letter: mkLetter({
        envelope: { ...mkLetter().envelope, from: "house@house", kind: "system" },
        body: { format: "markdown", content: "I noticed the tempest correspondence has gone quiet." },
      }),
    });

    const whispers = await call(client, "list_whispers", { unread: true });
    expect(whispers.whispers.length).toBe(1);
    const id = whispers.whispers[0].id;

    const dismissed = await call(client, "dismiss_whisper", { id });
    expect(dismissed.dismissed).toBe(true);

    const after = await call(client, "list_whispers", { unread: true });
    expect(after.whispers.length).toBe(0);

    const undismissed = await call(client, "undismiss_whisper", { id });
    expect(undismissed.dismissed).toBe(false);
  });

  it("runs gap detection on demand", async () => {
    const gaps = await call(client, "detect_gaps");
    expect(gaps.created).toEqual([]);
  });
});
