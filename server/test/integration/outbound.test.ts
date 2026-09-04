/**
 * The outbound seam (integration) — the house writes (SPEC §5 #13),
 * against live infra (postgres 15, qdrant, ollama). Gated by
 * POSTE_RESTANTE_INTEGRATION=1.
 *
 * A capture-sink SMTP server stands in for the operator's chosen relay;
 * the house is built with SMTP_OUTBOUND_URL pointing at it. Prove: a
 * letter addressed to an external recipient is archived AND relayed
 * (store first, relay second — the archive is always the truth); the
 * relayed mail carries the reverse translation (plain-text body, the
 * resident's own from, the thread reconstructible via References); the
 * house never mails itself (all-internal recipients → no relay).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";
import { buildHouse } from "../../src/index.js";
import { deliverLetter } from "../../src/deliver.js";
import type { House } from "../../src/house.js";
import type { LetterInput } from "../../src/schemas.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const mkLetter = (over: Record<string, unknown> = {}): LetterInput => ({
  envelope: {
    from: "you@house",
    to: ["producer@uae.ac.ae"],
    cc: [],
    thread: "th_outbound_arc",
    kind: "letter",
    lang: "en-AU",
    subject: "the storm cue — outbound",
  },
  time: {
    gregorian: "2026-09-04T12:00:00+04:00",
    frames: [],
  },
  body: {
    format: "markdown",
    content: "Move the **storm cue** to 47, outbound.",
  },
  ...over,
});

describe.skipIf(!INTEGRATION)("the outbound seam (integration)", () => {
  let house: House;
  let sink: SMTPServer;
  let sinkPort: number;
  const received: ParsedMail[] = [];

  beforeAll(async () => {
    // The capture sink — stands in for the operator's chosen relay.
    await new Promise<void>((resolve) => {
      sink = new SMTPServer({
        authOptional: true,
        disabledCommands: ["STARTTLS"],
        hideSTARTTLS: true,
        disableReverseLookup: true,
        // The relay URL carries credentials — the sink accepts any auth
        // (the pass-through of the URL's auth is the point, not the
        // credentials themselves).
        onAuth(_auth, _session, callback) {
          callback(null, { user: "relay-test" });
        },
        onData(stream, _session, callback) {
          simpleParser(stream).then((parsed) => {
            received.push(parsed);
            callback();
          });
        },
      });
      sink.listen(0, "127.0.0.1", () => {
        sinkPort = (sink.server.address() as { port: number }).port;
        resolve();
      });
    });

    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "basic",
      SMTP_ENABLED: "0",
      SMTP_OUTBOUND_URL: `smtp://relay-test:dummy@127.0.0.1:${sinkPort}/`,
      HOUSE_DOMAIN: "house",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE letters, threads, frames, addresses, credentials, whispers RESTART IDENTITY CASCADE`,
    );

    expect(house.outbound).not.toBeNull();
    expect(house.outbound!.enabled).toBe(true);
  });

  afterAll(async () => {
    house.outbound?.close();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
    await house.close();
  });

  it("archives AND relays a letter with an external recipient — store first, relay second", async () => {
    received.length = 0;
    const { letterId, created } = await deliverLetter(house, mkLetter());
    expect(created).toBe(true);

    // The letter is the archive's (relay failure never loses a letter).
    const { rows } = await house.db.pool.query<{ id: string }>(
      `SELECT id FROM letters WHERE id = $1`,
      [letterId],
    );
    expect(rows.length).toBe(1);

    // And the house wrote: the sink saw the reverse translation.
    expect(received.length).toBe(1);
  });

  it("relayed mail carries the reverse translation — text body, resident from, References thread", async () => {
    expect(received.length).toBe(1);
    const mail = received[0]!;
    // Markdown → plain text (the body's own voice, rendered).
    expect(mail.text).toContain("Move the storm cue to 47, outbound.");
    // Anti-forging, unchanged: the envelope from is the resident's own.
    expect(mail.from?.text).toContain("you@house");
    // The thread rides References so mail clients group the conversation
    // the house's way.
    const references = mail.references?.toString() ?? "";
    expect(references).toContain("th_outbound_arc");
  });

  it("the house never mails itself — an all-internal letter is not relayed", async () => {
    received.length = 0;
    await deliverLetter(
      house,
      mkLetter({
        envelope: { ...mkLetter().envelope, to: ["hermes@house"], cc: ["pub@house"] },
        subject: "internal only",
      }),
    );
    expect(received.length).toBe(0);
  });
});
