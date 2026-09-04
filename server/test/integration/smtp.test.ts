/**
 * The SMTP door (integration) — the house meets real mail (SPEC §5 #10),
 * against live infra (postgres 15, qdrant, ollama). Gated by
 * POSTE_RESTANTE_INTEGRATION=1.
 *
 * A real mail client (nodemailer via SMTP transport) delivers through the
 * door — the house's promise is "any mail client works". Prove: residents
 * can post; anonymous mail is refused and nothing is stored; the
 * anti-forging invariant holds (MAIL FROM ≠ authenticated address → 550);
 * mail lands in the archive through the shared deliver seam (whisper +
 * reply tracking behave exactly as HTTP); X-House-Thread continues a
 * thread; re:-subject replies join the correspondence.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTransport } from "nodemailer";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { startSmtpBridge } from "../../src/bridge/smtp.js";
import { findThreadBySubject } from "../../src/bridge/threads.js";
import { deliverLetter } from "../../src/deliver.js";
import type { LetterInput } from "../../src/schemas.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";
const BIND = "127.0.0.1:2526"; // the test door, away from the default

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

const mkLetter = (over: Record<string, unknown> = {}): LetterInput => ({
  envelope: {
    from: "hermes@house",
    to: ["you@house"],
    cc: [],
    thread: "th_smtp_seed",
    kind: "letter",
    lang: "en-AU",
    subject: "re: the storm cue",
  },
  time: {
    gregorian: "2026-09-03T10:00:00+04:00",
    frames: [],
  },
  body: {
    format: "markdown",
    content: "The storm cue is at 47.",
  },
  ...over,
});

describe.skipIf(!INTEGRATION)("the SMTP door (integration)", () => {
  let house: House;
  let auth: AuthService;
  let smtpHandle: ReturnType<typeof startSmtpBridge>;

  const smtpUrl = `smtp://you@house:youyouyou@${BIND}`;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "basic",
      SMTP_ENABLED: "1",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE letters, threads, frames, addresses, credentials, whispers RESTART IDENTITY CASCADE`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth);
    await auth.setPassword("you@house", "youyouyou");
    await auth.setPassword("hermes@house", "hermeshermes");
    const app = createLetterServer(house, { auth });
    smtpHandle = startSmtpBridge(
      {
        config: house.config,
        log: house.log,
        auth,
        ingest: (letter) => deliverLetter(house, letter),
        findThreadBySubject: (to, normalizedSubject) =>
          findThreadBySubject(house.db.pool, to, normalizedSubject),
      },
      BIND,
    );
    expect(smtpHandle).not.toBeNull();
    await smtpHandle!.ready;
    void app;
  });

  afterAll(async () => {
    await smtpHandle!.close();
    await house.close();
  });

  it("refuses anonymous mail — nothing is stored", async () => {
    // No auth at all — the door answers 530 and the client's send rejects.
    const anon = createTransport({ host: "127.0.0.1", port: 2526 });
    await expect(
      anon.sendMail({
        from: "stranger@outside.com",
        to: "you@house",
        subject: "a stranger writes",
        text: "hello?",
      }),
    ).rejects.toThrow(/530|authentication/i);
    anon.close();
    const { rows } = await house.db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM letters WHERE from_addr = 'stranger@outside.com'`,
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("delivers a letter from a resident through the door", async () => {
    const client = createTransport(smtpUrl);
    const info = await client.sendMail({
      from: "you@house",
      to: "hermes@house",
      subject: "the storm cue",
      text: "Move the storm cue to 47 — earlier is better.",
    });
    client.close();
    expect(info.accepted).toContain("hermes@house");

    // The letter landed through the shared deliver seam: postgres row,
    // the contract shape (markdown body), the resident as from.
    const { rows } = await house.db.pool.query<{
      id: string;
      from_addr: string;
      subject: string;
      body: string;
      thread_id: string;
    }>(
      `SELECT id, from_addr, subject, body, thread_id
       FROM letters WHERE subject = 'the storm cue' ORDER BY received_at DESC LIMIT 1`,
    );
    const letter = rows[0];
    expect(letter).toBeDefined();
    expect(letter!.from_addr).toBe("you@house");
    expect(letter!.body).toContain("Move the storm cue to 47");
    expect(letter!.thread_id).toMatch(/^th_smtp_[0-9a-f]{12}$/);
  });

  it("anti-forging — MAIL FROM must equal the authenticated address", async () => {
    const client = createTransport({
      host: "127.0.0.1",
      port: 2526,
      auth: { user: "you@house", pass: "youyouyou" },
    });
    // The authenticated user is you@house; MAIL FROM is hermes@house — the
    // door answers 550 before DATA, and the client's send rejects.
    await expect(
      client.sendMail({
        from: "hermes@house", // forged — the authenticated user is you
        to: "ben@house",
        subject: "a forged letter",
        text: "this must not land",
      }),
    ).rejects.toThrow(/550|sender/i);
    client.close();

    const { rows } = await house.db.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM letters WHERE subject = 'a forged letter'`,
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("continues a thread via X-House-Thread", async () => {
    const client = createTransport(smtpUrl);
    await client.sendMail({
      from: "you@house",
      to: "hermes@house",
      subject: "re: the storm cue",
      headers: { "X-House-Thread": "th_storm_manual" },
      text: "Continuing the storm conversation on purpose.",
    });
    client.close();

    const { rows } = await house.db.pool.query<{ thread_id: string }>(
      `SELECT thread_id FROM letters WHERE subject = 're: the storm cue'
       AND thread_id = 'th_storm_manual' LIMIT 1`,
    );
    expect(rows.length).toBe(1);
  });

  it("a reply joins the correspondence by subject (the re: match)", async () => {
    // Seed a thread the resident is party to, with the PLAIN subject —
    // the seam is called with the normalised subject, and the house's own
    // equality is on the stored subject. Unique subject: earlier tests
    // also use "the storm cue", and the seam matches the most recent —
    // cross-test pollution would pick the wrong thread.
    const seed = mkLetter({
      envelope: {
        ...mkLetter().envelope,
        thread: "th_storm_2024",
        subject: "the storm cue — act two",
      },
    });
    await deliverLetter(house, seed);

    // The reply — subject "re: the storm cue — act two" normalises to the
    // plain subject → the seam matches the seeded thread.
    const client = createTransport(smtpUrl);
    await client.sendMail({
      from: "you@house",
      to: "hermes@house",
      subject: "re: the storm cue — act two",
      text: "Yes — earlier.",
    });
    client.close();

    const { rows } = await house.db.pool.query<{ thread_id: string }>(
      // The unique subject, not a body LIKE — an earlier test's body also
      // contains "earlier", and an unordered LIMIT can grab the wrong row.
      `SELECT thread_id FROM letters WHERE subject = 're: the storm cue — act two' LIMIT 1`,
    );
    expect(rows.length).toBe(1);
    // The seam ran the findThreadBySubject query → continued, not new.
    expect(rows[0]!.thread_id).toBe("th_storm_2024");
  });

  it("a reply into a whispered thread marks the whisper replied (the shared seam)", async () => {
    // Seed a TWO-letter thread (dormant detection needs a correspondence),
    // with a unique plain subject so the re:-reply matches back into it.
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await deliverLetter(
      house,
      mkLetter({
        envelope: { ...mkLetter().envelope, thread: "th_whisper_mail", subject: "the storm cue — quiet" },
        time: { gregorian: old, frames: [] },
        body: { format: "markdown", content: "first letter of the quiet thread" },
      }),
    );
    await deliverLetter(
      house,
      mkLetter({
        envelope: { ...mkLetter().envelope, from: "you@house", to: ["hermes@house"], thread: "th_whisper_mail", subject: "the storm cue — quiet" },
        time: { gregorian: old, frames: [] },
        body: { format: "markdown", content: "second letter of the quiet thread" },
      }),
    );
    await house.whisper.detectGaps("you@house");

    const { rows: whispers } = await house.db.pool.query<{ id: string }>(
      `SELECT id FROM whispers WHERE target_thread = 'th_whisper_mail' AND replied_at IS NULL LIMIT 1`,
    );
    expect(whispers.length).toBe(1);

    const client = createTransport(smtpUrl);
    await client.sendMail({
      from: "you@house",
      to: "hermes@house",
      subject: "re: the storm cue — quiet",
      text: "A reply through the door.",
    });
    client.close();

    const { rows: replied } = await house.db.pool.query<{ id: string; replied_at: string | null }>(
      `SELECT id, replied_at FROM whispers WHERE target_thread = 'th_whisper_mail' LIMIT 1`,
    );
    expect(replied[0]!.replied_at).not.toBeNull();
  });
});
