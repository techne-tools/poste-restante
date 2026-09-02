/**
 * The house protocol client — unit tests with a mocked fetch.
 *
 * The client is a thin composition layer over the protocol; the api.ts
 * client is the only pure logic worth unit-testing here. The views are
 * verified by the E2E run against the live house.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { house } from "./api";

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

// Node environment (no jsdom) — a minimal storage shim for the handful of
// tests that touch localStorage (auth persistence, redeem with a stale session).
const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
};

describe("house client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("delivers a letter as a POST to /v1/letters", async () => {
    globalThis.fetch = mockFetch(200, { id: "abc123", created: true });
    const res = await house.deliver({
      envelope: {
        from: "hermes@house",
        to: ["you@house"],
        cc: [],
        thread: "th_1",
        kind: "letter",
        lang: "en-AU",
        subject: "hello",
      },
      time: { gregorian: new Date().toISOString(), frames: [] },
      body: { format: "markdown", content: "hi" },
    });
    expect(res).toEqual({ id: "abc123", created: true });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/v1/letters");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body).envelope.from).toBe("hermes@house");
  });

  it("searches with query params — exact + FTS + semantic merged by RRF", async () => {
    globalThis.fetch = mockFetch(200, { hits: [], letters: [] });
    await house.search({ q: "tempest", frame: "production:tempest-2026" });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/v1/letters?q=tempest&frame=production%3Atempest-2026");
  });

  it("reads the mailbox — pull by default", async () => {
    globalThis.fetch = mockFetch(200, { address: "you@house", letters: [] });
    const res = await house.inbox("you@house", 5);
    expect(res.address).toBe("you@house");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/v1/addresses/you%40house/inbox?limit=5");
  });

  it("lists the whisper — the house's own letters", async () => {
    globalThis.fetch = mockFetch(200, { whispers: [] });
    await house.whisper(true);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/v1/whisper?unread=1");
  });

  it("reads a thread — the correspondence, oldest first", async () => {
    globalThis.fetch = mockFetch(200, { thread: "th_gap_dormant", letters: [] });
    const res = await house.thread("th_gap_dormant");
    expect(res.thread).toBe("th_gap_dormant");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/v1/threads/th_gap_dormant");
  });

  it("deletes a letter — first-class, no soft delete", async () => {
    globalThis.fetch = mockFetch(200, { deleted: true, id: "abc" });
    const res = await house.deleteLetter("abc");
    expect(res.deleted).toBe(true);
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.method).toBe("DELETE");
  });

  it("throws a readable error when the house answers with a status", async () => {
    globalThis.fetch = mockFetch(400, { error: { message: "the envelope is missing a thread" } });
    await expect(house.deliver({} as never)).rejects.toThrow(
      "the envelope is missing a thread",
    );
  });

  it("redeems an invitation as the guest — public, no Authorization header even with a stale session", async () => {
    // A stale resident session must not leak into the guest's redemption —
    // the guest redeems as themselves, not as whoever was last in the house.
    localStorage.setItem(
      "poste-restante.auth",
      JSON.stringify({ address: "stale-owner@house", header: "Basic c3RhbGU6c3RhbGU=" }),
    );
    globalThis.fetch = mockFetch(201, { address: "guest@house", joined: true });
    const res = await house.redeemInvite({
      address: "guest@house",
      code: "E2FG-3QVQ-23BW",
      password: "correct-horse-battery",
    });
    expect(res).toEqual({ address: "guest@house", joined: true });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/v1/invites/redeem");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({
      address: "guest@house",
      code: "E2FG-3QVQ-23BW",
      password: "correct-horse-battery",
    });
  });

  it("maps a failed redemption to absence — one 404 answer for every negative path", async () => {
    globalThis.fetch = mockFetch(404, {
      error: { code: "not_found", message: "no such thing in the house" },
    });
    await expect(
      house.redeemInvite({ address: "guest@house", code: "AAAA-BBBB-CCCC", password: "correct-horse-battery" }),
    ).rejects.toThrow("the house has no invitation for you — check the code and address");
  });
});

describe("house book client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reads the book head as a GET to /v1/book", async () => {
    const head = {
      clauses: [
        {
          thread: "th_clause_1",
          text: "the pub closes at dusk",
          proposedBy: "you@house",
          proposedIn: "l1",
          state: "standing",
          settlingFrom: "2026-09-01T00:00:00Z",
          settlesAt: "2026-09-08T00:00:00Z",
          stoodAt: "2026-09-08T00:00:00Z",
          reversedAt: null,
          reversedIn: null,
          pendingReversal: false,
          reversesThread: null,
          objections: 0,
          vouches: 2,
          binding: { door: "pub@house.is_public", value: false },
        },
      ],
      doors: [{ door: "pub@house.is_public", value: false, boundBy: "th_clause_1" }],
      settlingDays: 7,
    };
    globalThis.fetch = mockFetch(200, head);
    const res = await house.book();
    expect(res.clauses).toHaveLength(1);
    expect(res.clauses[0]!.state).toBe("standing");
    expect(res.doors[0]!.value).toBe(false);
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/v1/book");
  });

  it("performs an act as a POST to /v1/book", async () => {
    globalThis.fetch = mockFetch(201, {
      id: "l_act",
      clause: { thread: "th_clause_1", state: "proposed" },
    });
    const res = await house.actOnBook({
      role: "stop",
      continues: "th_clause_1",
    });
    expect(res.clause.state).toBe("proposed");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/v1/book");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ role: "stop", continues: "th_clause_1" });
  });

  it("reads a clause thread as a GET to /v1/book/threads/:id", async () => {
    globalThis.fetch = mockFetch(200, { thread: "th_clause_1", letters: [] });
    const res = await house.clauseThread("th_clause_1");
    expect(res.thread).toBe("th_clause_1");
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/v1/book/threads/th_clause_1");
  });
});
