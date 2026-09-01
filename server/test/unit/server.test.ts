/**
 * Letter server unit tests — hermetic. The house is faked; no postgres,
 * qdrant, or ollama required. These verify the protocol surface: validation,
 * status codes, idempotency, and the absence of a push channel.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createLetterServer } from "../../src/server.js";
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

/** A fake house: in-memory letters, no infra. */
function fakeHouse(): House {
  const letters = new Map<string, Letter & { receivedAt: Date }>();
  const addresses = new Set<string>();
  const frames = new Set<string>();

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
        [...addresses].map((id) => ({ id, names: [], pronouns: null })),
      getAddress: async (id: string) =>
        addresses.has(id) ? { id, names: [], pronouns: null, is_public: false } : null,
      updateAddress: async () => {},
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
      list: async () => [],
      listUnread: async () => [],
      open: async () => true,
      dismiss: async () => true,
      undismiss: async () => true,
      detectGaps: async () => [],
      surfaceHouseLetter: async () => {},
      recordReply: async () => {},
    },
    close: async () => {},
  } as unknown as House;

  return house;
}

describe("letter server (unit)", () => {
  let house: House;
  let app: ReturnType<typeof createLetterServer>;

  beforeEach(() => {
    house = fakeHouse();
    app = createLetterServer(house);
  });

  it("delivers a letter and returns 201 with the derived id", async () => {
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mkLetter()),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; created: boolean };
    expect(json.created).toBe(true);
    expect(json.id).toMatch(/^sha256-/);
  });

  it("is idempotent — the same letter returns 200 on the second delivery", async () => {
    const letter = mkLetter();
    const first = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(letter),
    });
    const second = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(letter),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const json = (await second.json()) as { created: boolean };
    expect(json.created).toBe(false);
  });

  it("rejects a letter that does not match the contract", async () => {
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ envelope: { from: "x" }, body: {} }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_letter");
  });

  it("rejects invalid JSON", async () => {
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_json");
  });

  it("rejects an invalid kind", async () => {
    const res = await app.request("/v1/letters?kind=spam", { method: "GET" });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_kind");
  });

  it("fetches a letter by id", async () => {
    const letter = mkLetter();
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(letter),
    });
    const { id } = (await delivered.json()) as { id: string };

    const res = await app.request(`/v1/letters/${id}`, { method: "GET" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { envelope: { from: string } };
    expect(json.envelope.from).toBe("hermes@house");
  });

  it("returns 404 for a missing letter", async () => {
    const res = await app.request("/v1/letters/nope", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("deletes a letter — first-class, no soft delete", async () => {
    const letter = mkLetter();
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(letter),
    });
    const { id } = (await delivered.json()) as { id: string };

    const del = await app.request(`/v1/letters/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const json = (await del.json()) as { deleted: boolean };
    expect(json.deleted).toBe(true);

    const gone = await app.request(`/v1/letters/${id}`, { method: "GET" });
    expect(gone.status).toBe(404);
  });

  it("searches letters by text and from", async () => {
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mkLetter()),
    });
    const res = await app.request("/v1/letters?text=sound%20design", { method: "GET" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { hits: unknown[]; letters: unknown[] };
    expect(json.hits.length).toBeGreaterThan(0);
    expect(json.letters.length).toBe(json.hits.length);
  });

  it("lists the address book and the mailbox", async () => {
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mkLetter()),
    });

    const addresses = await app.request("/v1/addresses", { method: "GET" });
    const addrJson = (await addresses.json()) as { addresses: { id: string }[] };
    expect(addrJson.addresses.map((a) => a.id)).toContain("hermes@house");
    expect(addrJson.addresses.map((a) => a.id)).toContain("you@house");

    const inbox = await app.request("/v1/addresses/you@house/inbox", { method: "GET" });
    expect(inbox.status).toBe(200);
    const inboxJson = (await inbox.json()) as { letters: unknown[] };
    expect(inboxJson.letters.length).toBe(1);
  });

  it("returns 404 for an unknown address inbox", async () => {
    const res = await app.request("/v1/addresses/ghost@house/inbox", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("lists threads and frames", async () => {
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mkLetter()),
    });

    const thread = await app.request("/v1/threads/th_9f2c1", { method: "GET" });
    expect(thread.status).toBe(200);
    const threadJson = (await thread.json()) as { letters: unknown[] };
    expect(threadJson.letters.length).toBe(1);

    const frames = await app.request("/v1/frames", { method: "GET" });
    const framesJson = (await frames.json()) as { frames: { id: string }[] };
    expect(framesJson.frames.map((f) => f.id)).toContain("season:autumn");
  });

  it("pins and unpins a letter", async () => {
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mkLetter()),
    });
    const { id } = (await delivered.json()) as { id: string };

    const pin = await app.request(`/v1/letters/${id}/pin`, { method: "POST" });
    expect(pin.status).toBe(200);
    const unpin = await app.request(`/v1/letters/${id}/pin`, { method: "DELETE" });
    expect(unpin.status).toBe(200);
  });

  it("has no push channel — the protocol is pull-only", async () => {
    // The house never pushes. There is no websocket, no SSE, no
    // notification endpoint. The only verbs are the letter protocol.
    const res = await app.request("/v1/letters", { method: "GET" });
    expect(res.status).toBe(200);
    // A push attempt is not a thing the house does.
    const upgrade = await app.request("/v1/letters", {
      method: "GET",
      headers: { Upgrade: "websocket", Connection: "Upgrade" },
    });
    expect(upgrade.status).not.toBe(101);
  });

  it("lists the whisper — the house's own letters, pull-only", async () => {
    const res = await app.request("/v1/whisper", { method: "GET" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { whispers: unknown[] };
    expect(json.whispers).toEqual([]);
  });

  it("opens, dismisses, and undismisses a whisper", async () => {
    const open = await app.request("/v1/whisper/w1/open", { method: "POST" });
    expect(open.status).toBe(200);
    const dismiss = await app.request("/v1/whisper/w1/dismiss", { method: "POST" });
    expect(dismiss.status).toBe(200);
    const undismiss = await app.request("/v1/whisper/w1/undismiss", { method: "POST" });
    expect(undismiss.status).toBe(200);
  });

  it("runs gap detection on demand — never pushed", async () => {
    const res = await app.request("/v1/whisper/gaps", { method: "POST" });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { created: unknown[] };
    expect(json.created).toEqual([]);
  });
});
