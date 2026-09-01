/**
 * Auth integration tests — the full authentication + authorization protocol
 * against live infra (postgres 15, qdrant, ollama). Gated by
 * POSTE_RESTANTE_INTEGRATION=1. These prove the privacy rules with real
 * credentials: authentication is mandatory, absence is silence (404 not 403),
 * the pub is the public exception, and forging is impossible.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

const mkLetter = (over: Record<string, unknown> = {}) => ({
  envelope: {
    from: "you@house",
    to: ["hermes@house"],
    cc: [],
    thread: "th_auth_1",
    kind: "letter",
    lang: "en-AU",
    subject: "re: the locked door",
  },
  time: {
    gregorian: "2026-08-30T10:00:00+04:00",
    frames: [{ frame: "season", value: "autumn" }],
  },
  body: {
    format: "markdown",
    content: "The house knows who I am now.",
  },
  ...over,
});

describe.skipIf(!INTEGRATION)("auth (integration)", () => {
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
      `TRUNCATE letters, threads, frames, addresses, credentials RESTART IDENTITY CASCADE`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth);
    // Three residents: you (the owner), ben (a correspondent who must not
    // see your private mail), and hermes (the other voice in the pair).
    await auth.setPassword("you@house", "youyouyou");
    await auth.setPassword("ben@house", "benbenben");
    await auth.setPassword("hermes@house", "hermeshermes");
    app = createLetterServer(house, { auth });
  });

  afterAll(async () => {
    await house.close();
  });

  it("requires authentication — the house does not know anonymous callers", async () => {
    const res = await app.request("/v1/letters", { method: "GET" });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("unauthorized");
  });

  it("authenticates a resident with a password", async () => {
    const res = await app.request("/v1/letters", {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong password with 401", async () => {
    const res = await app.request("/v1/letters", {
      method: "GET",
      headers: { Authorization: basic("you@house", "wrongwrong") },
    });
    expect(res.status).toBe(401);
  });

  it("delivers a letter as the authenticated address", async () => {
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic("you@house", "youyouyou"),
      },
      body: JSON.stringify(mkLetter()),
    });
    expect(res.status).toBe(201);
  });

  it("refuses a forged letter — from must be the caller's own address", async () => {
    const forged = mkLetter({
      envelope: { ...mkLetter().envelope, from: "hermes@house", thread: "th_auth_forge" },
    });
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic("you@house", "youyouyou"),
      },
      body: JSON.stringify(forged),
    });
    expect(res.status).toBe(403);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("forged");
  });

  it("scopes retrieval — ben cannot see you's private letters (404, not 403)", async () => {
    // Deliver a private letter between you and hermes.
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic("you@house", "youyouyou"),
      },
      body: JSON.stringify(
        mkLetter({
          envelope: { ...mkLetter().envelope, thread: "th_auth_private", subject: "private" },
          body: { format: "markdown", content: "for your eyes only" },
        }),
      ),
    });
    const { id } = (await delivered.json()) as { id: string };

    // you can fetch it.
    const youGet = await app.request(`/v1/letters/${id}`, {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(youGet.status).toBe(200);

    // ben cannot — absence is silence: 404, never 403.
    const benGet = await app.request(`/v1/letters/${id}`, {
      method: "GET",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(benGet.status).toBe(404);

    // ben's search does not surface it either.
    const benSearch = await app.request("/v1/letters?text=eyes%20only", {
      method: "GET",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    const benJson = (await benSearch.json()) as { hits: { letterId: string }[] };
    expect(benJson.hits.some((h) => h.letterId === id)).toBe(false);

    // ben cannot delete it.
    const benDelete = await app.request(`/v1/letters/${id}`, {
      method: "DELETE",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(benDelete.status).toBe(404);
  });

  it("scopes the mailbox — ben cannot read you's inbox", async () => {
    const res = await app.request("/v1/addresses/you@house/inbox", {
      method: "GET",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(res.status).toBe(404);
  });

  it("scopes the whisper — ben cannot see you's whispers", async () => {
    const res = await app.request("/v1/whisper", {
      method: "GET",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { whispers: { targetThread: string | null }[] };
    // ben is not party to any thread yet — the house has nothing to whisper
    // to him about.
    expect(json.whispers.every((w) => w.targetThread !== "th_auth_private")).toBe(true);
  });

  it("fails closed on pair gaps — ben is party to neither letter of the pair", async () => {
    // A two-voices pair between you and hermes in one thread, within the
    // active frame. ben is not party to it: the house must not leak even
    // the EXISTENCE of the related letter.
    const recent = "2026-08-31T14:00:00+04:00";
    const mine = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_auth_voices", subject: "the locked door, opened" },
      time: { gregorian: recent, frames: [{ frame: "production", value: "tempest-tech-week" }] },
      body: { format: "markdown", content: "I want the storm cue at eighty — the verse rides above the surf." },
    });
    const hermesV = mkLetter({
      envelope: { ...mkLetter().envelope, from: "hermes@house", to: ["you@house"], thread: "th_auth_voices", subject: "re: the locked door, opened" },
      time: { gregorian: recent, frames: [{ frame: "production", value: "tempest-tech-week" }] },
      body: { format: "markdown", content: "Keep it at sixty — louder buries the verse under the surf." },
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify(mine),
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("hermes@house", "hermeshermes") },
      body: JSON.stringify(hermesV),
    });

    // you detects the pair.
    const gaps = await app.request("/v1/whisper/gaps", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const gapsJson = (await gaps.json()) as { created: string[] };
    expect(gapsJson.created.some((id) => id.includes("th_auth_voices"))).toBe(true);

    // you sees it — both letters named, at full weight.
    const youWhisper = await app.request("/v1/whisper", {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const youJson = (await youWhisper.json()) as {
      whispers: { id: string; kind: string; letterId: string | null; relatedLetterId: string | null; targetThread: string | null }[];
    };
    const pair = youJson.whispers.find((w) => w.kind === "gap-contradiction" && w.targetThread === "th_auth_voices");
    expect(pair).toBeDefined();
    expect(pair!.relatedLetterId).not.toBeNull();

    // ben — party to NEITHER letter — must not see it: fails closed.
    const benWhisper = await app.request("/v1/whisper", {
      method: "GET",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    const benJson = (await benWhisper.json()) as { whispers: { id: string }[] };
    expect(benJson.whispers.some((w) => w.id === pair!.id)).toBe(false);

    // ben cannot open it either — absence is silence at every door.
    const benOpen = await app.request(`/v1/whisper/${pair!.id}/open`, {
      method: "POST",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(benOpen.status).toBe(404);

    // ben cannot dismiss it.
    const benDismiss = await app.request(`/v1/whisper/${pair!.id}/dismiss`, {
      method: "POST",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(benDismiss.status).toBe(404);
  });

  it("fails closed on corner gaps — ben is party to neither frame of the corner", async () => {
    // A frame you have worked in, gone quiet 35 days, while another of
    // your frames moved two days ago. The house offers the empty room —
    // to you. ben has never entered either room: the frame-scoped whisper
    // must not reach him, not even the room's existence.
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const oldCorner = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_auth_corner_old", subject: "the masque, set aside" },
      time: {
        gregorian: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
        frames: [{ frame: "production", value: "auth-corner-a" }],
      },
      body: { format: "markdown", content: "Early masque notes, long quiet." },
    });
    const moving = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_auth_corner_next", subject: "the next production" },
      time: { gregorian: recent, frames: [{ frame: "production", value: "auth-corner-b" }] },
      body: { format: "markdown", content: "The next production planning thread." },
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify(oldCorner),
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify(moving),
    });

    // you detects the corner.
    const gaps = await app.request("/v1/whisper/gaps", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const gapsJson = (await gaps.json()) as { created: string[] };
    const cornerId = "gap-corner:production:auth-corner-a";
    expect(gapsJson.created).toContain(cornerId);

    // you sees it — the room named, no thread, no letter.
    const youWhisper = await app.request("/v1/whisper", {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const youJson = (await youWhisper.json()) as {
      whispers: { id: string; kind: string; targetFrame: string | null; letterId: string | null }[];
    };
    const corner = youJson.whispers.find((w) => w.id === cornerId);
    expect(corner).toBeDefined();
    expect(corner!.kind).toBe("gap-unvisited-corner");
    expect(corner!.targetFrame).toBe("production:auth-corner-a");
    expect(corner!.letterId).toBeNull();

    // ben — party to neither room — must not see it: fails closed on the
    // frame limb.
    const benWhisper = await app.request("/v1/whisper", {
      method: "GET",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    const benJson = (await benWhisper.json()) as { whispers: { id: string }[] };
    expect(benJson.whispers.some((w) => w.id === cornerId)).toBe(false);

    // ben cannot open the corner either — absence is silence at every door.
    const benOpen = await app.request(`/v1/whisper/${cornerId}/open`, {
      method: "POST",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(benOpen.status).toBe(404);
  });

  it("keeps the pub public — readable without a credential", async () => {
    // A public letter: pub@house is a participant.
    const pubLetter = mkLetter({
      envelope: {
        from: "you@house",
        to: ["pub@house"],
        cc: [],
        thread: "th_auth_pub",
        kind: "letter",
        lang: "en-AU",
        subject: "for the public wall",
      },
      body: { format: "markdown", content: "This one is for everyone." },
    });
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic("you@house", "youyouyou"),
      },
      body: JSON.stringify(pubLetter),
    });
    expect(delivered.status).toBe(201);

    // Anonymous read of the pub mailbox succeeds.
    const pub = await app.request("/v1/addresses/pub@house/inbox", { method: "GET" });
    expect(pub.status).toBe(200);
    const pubJson = (await pub.json()) as { letters: { envelope: { thread: string } }[] };
    expect(pubJson.letters.some((l) => l.envelope.thread === "th_auth_pub")).toBe(true);

    // Anonymous read of a private mailbox still fails.
    const anon = await app.request("/v1/addresses/you@house/inbox", { method: "GET" });
    expect(anon.status).toBe(401);
  });

  it("scopes address correction — ben cannot correct you's entry", async () => {
    const res = await app.request("/v1/addresses/you@house", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic("ben@house", "benbenben"),
      },
      body: JSON.stringify({ names: ["Not You"], pronouns: null }),
    });
    expect(res.status).toBe(403);
  });
});
