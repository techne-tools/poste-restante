/**
 * The living pass (integration) — the whisper's heartbeat and the learning
 * loop finally read, against live infra (postgres 15, qdrant, ollama).
 * Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 * Two movements:
 * 1. Convergence ordering: replied → opened → recency. The whisper surfaces
 *    what the resident actually engages with; the signal columns (opened /
 *    replied) beat recency.
 * 2. The scheduled pass: detectGaps per resident, and the privacy negative —
 *    an address with whisperable correspondence but NO credential is never
 *    enumerated, so no whisper is created for it. The house scans residents,
 *    not addresses.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { GapScheduler } from "../../src/whisper/scheduler.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

const mkLetter = (over: Record<string, unknown> = {}) => ({
  envelope: {
    from: "hermes@house",
    to: ["you@house"],
    cc: [],
    thread: "th_living_1",
    kind: "letter",
    lang: "en-AU",
    subject: "the living pass",
  },
  time: {
    gregorian: new Date().toISOString(),
    frames: [],
  },
  body: {
    format: "markdown",
    content: "The house holds.",
  },
  ...over,
});

describe.skipIf(!INTEGRATION)("the living pass (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;

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
      `TRUNCATE letters, threads, frames, addresses, credentials, whispers RESTART IDENTITY CASCADE`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth);
    // Two residents: you (the owner) and hermes (the other voice).
    await auth.setPassword("you@house", "youyouyou");
    await auth.setPassword("hermes@house", "hermeshermes");
    app = createLetterServer(house, { auth });
  });

  afterAll(async () => {
    await house.close();
  });

  /** Deliver a letter as a resident and return the response. */
  const deliverAs = (address: string, letter: Record<string, unknown>) =>
    app.request("/v1/letters", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic(address, address === "you@house" ? "youyouyou" : "hermeshermes"),
      },
      body: JSON.stringify(letter),
    });

  it("convergence ordering — replied, opened, then recency", async () => {
    // Two dormant threads (20 days old, two letters each) — both will be
    // offered as gaps. Y is the newer creation, X is older.
    const old = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("hermes@house", "hermeshermes") },
      body: JSON.stringify(
        mkLetter({
          envelope: { ...mkLetter().envelope, thread: "th_living_x", subject: "older thread" },
          time: { gregorian: old(20), frames: [] },
          body: { format: "markdown", content: "The first thread discusses the cue sheet for act one — every entrance, every exit, marked." },
        }),
      ),
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify(
        mkLetter({
          envelope: { ...mkLetter().envelope, from: "you@house", to: ["hermes@house"], thread: "th_living_x", subject: "older thread" },
          time: { gregorian: old(20), frames: [] },
          body: { format: "markdown", content: "And my notes for the second rehearsal follow — the timing of the storm cue felt late." },
        }),
      ),
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("hermes@house", "hermeshermes") },
      body: JSON.stringify(
        mkLetter({
          envelope: { ...mkLetter().envelope, thread: "th_living_y", subject: "newer thread" },
          time: { gregorian: old(20), frames: [] },
          body: { format: "markdown", content: "Drafting the programme essay now — the opening paragraph on listening as attendance keeps resisting." },
        }),
      ),
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify(
        mkLetter({
          envelope: { ...mkLetter().envelope, from: "you@house", to: ["hermes@house"], thread: "th_living_y", subject: "newer thread" },
          time: { gregorian: old(20), frames: [] },
          body: { format: "markdown", content: "I would keep that paragraph short — the readers arrive first through the ears in a theatre programme." },
        }),
      ),
    });

    // On-demand detection — creates the dormant-thread whispers for you.
    const gaps = await app.request("/v1/whisper/gaps", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(gaps.status).toBe(200);
    const gapIds = ((await gaps.json()) as { created: string[] }).created;
    const xGap = gapIds.find((id) => id.includes("th_living_x"));
    const yGap = gapIds.find((id) => id.includes("th_living_y"));
    expect(xGap).toBeDefined();
    expect(yGap).toBeDefined();

    // Both unopened: newer (Y) sorts first by recency.
    let list = await app.request("/v1/whisper", {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    let order = ((await list.json()) as { whispers: { id: string; openedAt: string | null; repliedAt: string | null }[] }).whispers.map((w) => w.id);
    expect(order.indexOf(yGap!)).toBeLessThan(order.indexOf(xGap!));

    // Open the OLDER gap: the learning loop signal beats recency.
    const opened = await app.request(`/v1/whisper/${xGap}/open`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(opened.status).toBe(200);
    list = await app.request("/v1/whisper", {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    order = ((await list.json()) as { whispers: { id: string }[] }).whispers.map((w) => w.id);
    expect(order.indexOf(xGap!)).toBeLessThan(order.indexOf(yGap!));

    // Write back to the opened thread: replied is the strongest signal and
    // holds even in the unread list.
    await deliverAs(
      "you@house",
      mkLetter({
        envelope: { ...mkLetter().envelope, from: "you@house", to: ["hermes@house"], thread: "th_living_x", subject: "re: older thread" },
      }),
    );
    const unread = await app.request("/v1/whisper?unread=1", {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const unreadOrder = ((await unread.json()) as { whispers: { id: string; repliedAt: string | null }[] }).whispers.map((w) => w.id);
    expect(unreadOrder[0]).toBe(xGap);
    expect(unreadOrder.indexOf(xGap!)).toBeLessThan(unreadOrder.indexOf(yGap!));
  });

  it("scheduled pass — the house scans residents only (the privacy negative)", async () => {
    // A dormant address with whisperable correspondence but NO credential:
    // ghost@house cannot act, so the house never holds for it. The sender
    // of those letters (hermes) IS a resident — so hermes's pass may
    // rightly whisper about the thread she wrote to. The negative is the
    // enumeration: ghost@house is never passed to a detector.
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("hermes@house", "hermeshermes") },
      body: JSON.stringify(
        mkLetter({
          envelope: { ...mkLetter().envelope, to: ["ghost@house"], thread: "th_living_ghost", subject: "for the ghost" },
          time: { gregorian: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(), frames: [] },
          body: { format: "markdown", content: "A quiet corridor nobody walks — two letters, twenty days apart, addressed to an address that cannot act." },
        }),
      ),
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("hermes@house", "hermeshermes") },
      body: JSON.stringify(
        mkLetter({
          envelope: { ...mkLetter().envelope, to: ["ghost@house"], thread: "th_living_ghost", subject: "still for the ghost" },
          time: { gregorian: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(), frames: [] },
          body: { format: "markdown", content: "Nobody picks it up; the house holds the empty room regardless of whether anyone can enter." },
        }),
      ),
    });

    // The scheduled pass uses the real auth enumeration — exactly the two
    // residents. Instrument the detector to prove ghost is never scanned.
    const calledWith: string[] = [];
    const scheduler = new GapScheduler(
      {
        listResidents: async () => (await auth.listCredentials()).map((c) => ({ address: c.address })),
        detectGaps: async (address) => {
          calledWith.push(address);
          return house.whisper.detectGaps(address);
        },
        log: house.log,
      },
      60_000,
    );
    const scanned = await scheduler.runPass();
    expect(scanned).toBe(2); // you + hermes
    expect(calledWith.sort()).toEqual(["hermes@house", "you@house"]);
    // The privacy negative — a non-resident is never detected-for, even
    // though their mailbox holds a dormant thread.
    expect(calledWith).not.toContain("ghost@house");
    scheduler.stop();
  });
});
