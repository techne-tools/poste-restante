/**
 * The mailbox sync drive (integration) — SPEC §5 #12, the live proof.
 *
 * Real house (postgres, qdrant, ollama) + real Stalwart dev sidecar:
 * buildHouse wires the drive with MAILBOX_TLS_INSECURE=1 (the dev sidecar's
 * self-signed cert), a resident is provisioned a mailbox account, and the
 * drive actually mirrors the archive into IMAP:
 *
 *   1. A pass syncs the resident's view — the frame letter lands in its
 *      frame folder AND Archive (activeFrameIds derived from the room the
 *      resident actually worked in; the letter's own frames win).
 *   2. The pipeline's onStored hook delta-syncs — delivering a letter
 *      re-converges the mailbox with NO explicit pass (the letter lands in
 *      Inbox; the earlier frame letter stays put, idempotently).
 *   3. The privacy negative — an address with NO account row is never
 *      synced, never connected, even though their mailbox holds mail.
 *
 * The sidecar account (you@house.test) matches the B2b harness; the
 * harness expunges the house's own test letters (by engine Message-ID)
 * before the run so re-runs stay hermetic.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { MailboxAccountsService } from "../../src/bridge/mailbox-accounts.js";
import { parseImapUrl } from "../../src/bridge/imap-writer.js";
import { letterId } from "../../src/id.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";
const IMAP_URL =
  process.env.IMAP_URL ??
  "imap://you@house.test:house-dev-sidecar@127.0.0.1:11430/";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

const YOU = "you@house";
const HERMES = "hermes@house";
const GHOST = "ghost@house";

/** The three letters, defined ONCE as constants — the pipeline hashes the
 *  canonical envelope+body, so the test's `letterId()` must see the exact
 *  object that gets delivered (a factory with a fresh timestamp would
 *  hash differently every call and the Message-IDs would never match). */
const FRAME_LETTER = {
  envelope: {
    from: HERMES,
    to: [YOU],
    cc: [],
    thread: "th_mbox_frame",
    kind: "letter",
    lang: "en-AU",
    subject: "the frame letter",
  },
  time: {
    gregorian: new Date().toISOString(),
    frames: [{ frame: "production", value: "tempest-2026" }],
  },
  body: {
    format: "markdown",
    content: "The storm cue — hold it until the third lightning strike.",
  },
};

const INBOX_LETTER = {
  envelope: {
    from: HERMES,
    to: [YOU],
    cc: [],
    thread: "th_mbox_inbox",
    kind: "letter",
    lang: "en-AU",
    subject: "the inbox letter",
  },
  time: {
    gregorian: new Date().toISOString(),
    frames: [],
  },
  body: {
    format: "markdown",
    content: "No frame — the inbox holds it, quiet and close.",
  },
};

const GHOST_LETTER = {
  envelope: {
    from: HERMES,
    to: [GHOST],
    cc: [],
    thread: "th_mbox_ghost",
    kind: "letter",
    lang: "en-AU",
    subject: "for the ghost",
  },
  time: {
    gregorian: new Date().toISOString(),
    frames: [],
  },
  body: {
    format: "markdown",
    content: "A corridor nobody walks — addressed to an address with no account.",
  },
};

describe.skipIf(!INTEGRATION)("the mailbox sync drive (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;
  let accounts: MailboxAccountsService;
  let imap: ReturnType<typeof parseImapUrl>;

  const IDs = {
    frame: letterId(FRAME_LETTER as never),
    inbox: letterId(INBOX_LETTER as never),
    ghost: letterId(GHOST_LETTER as never),
  };
  const messageIds = [IDs.frame, IDs.inbox, IDs.ghost].map((id) => `<${id}@house>`);

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "basic",
      MAILBOX_TLS_INSECURE: "1",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE letters, threads, frames, addresses, credentials, whispers, mailbox_accounts RESTART IDENTITY CASCADE`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth);
    await auth.setPassword(YOU, "youyouyou");
    await auth.setPassword(HERMES, "hermeshermes");
    app = createLetterServer(house, { auth });
    accounts = new MailboxAccountsService(house.db.pool);
    imap = {
      ...parseImapUrl(IMAP_URL),
      // The dev sidecar serves a self-signed cert (bootstrap defaults) —
      // the TEST harness relaxes verification exactly like the B2b
      // harness; the adapter/drive never do.
      tls: { rejectUnauthorized: false },
    };
    await resetTestLetters();
  });

  afterAll(async () => {
    await house.close();
  });

  /** Expunge the house's own test letters from EVERY folder (by engine
   *  Message-ID) so re-runs against a populated sidecar start clean. */
  async function resetTestLetters(): Promise<void> {
    const client = new ImapFlow(imap);
    await client.connect();
    try {
      const folders = await client.list();
      for (const folder of folders) {
        try {
          const lock = await client.getMailboxLock(folder.path);
          try {
            const found = await client.fetchAll("1:*", { headers: ["Message-ID"], uid: true }, { uid: true });
            const toDelete = found
              .filter((m) =>
                messageIds.some((id) => (m.headers?.toString("utf-8") ?? "").includes(id)),
              )
              .map((m) => m.uid);
            if (toDelete.length) {
              await client.messageDelete(toDelete, { uid: true });
            }
          } finally {
            lock.release();
          }
        } catch {
          // A folder may not exist yet on a fresh sidecar — skip it.
        }
      }
    } finally {
      await client.logout();
    }
  }

  async function findInFolder(
    folder: string,
    messageId: string,
    include: { flags?: boolean } = {},
  ): Promise<FetchMessageObject[]> {
    const client = new ImapFlow(imap);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const query: { headers?: string[]; flags?: boolean; uid?: boolean } = { headers: ["Message-ID"] };
        if (include.flags) query.flags = true;
        const found = await client.fetchAll("1:*", query, { uid: true });
        return found.filter((m) => (m.headers?.toString("utf-8") ?? "").includes(messageId));
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async function countIn(folder: string, messageId: string): Promise<number> {
    return (await findInFolder(folder, messageId)).length;
  }

  async function appearsAnywhere(messageId: string): Promise<boolean> {
    const client = new ImapFlow(imap);
    await client.connect();
    try {
      const folders = await client.list();
      let found = false;
      for (const folder of folders) {
        try {
          const lock = await client.getMailboxLock(folder.path);
          try {
            const messages = await client.fetchAll("1:*", { headers: ["Message-ID"] }, { uid: true });
            if (messages.some((m) => (m.headers?.toString("utf-8") ?? "").includes(messageId))) {
              found = true;
              break;
            }
          } finally {
            lock.release();
          }
        } catch {
          // Skip unlistable folders.
        }
      }
      return found;
    } finally {
      await client.logout();
    }
  }

  const deliverAs = (address: string, letter: Record<string, unknown>) =>
    app.request("/v1/letters", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic(address, address === YOU ? "youyouyou" : "hermeshermes"),
      },
      body: JSON.stringify(letter),
    });

  it("syncs a provisioned resident's view — frame folder and Archive", async () => {
    // The drive is real and wired into the house.
    expect(house.mailbox).not.toBeNull();

    await accounts.add(YOU, IMAP_URL);
    expect((await accounts.list()).map((a) => a.address)).toEqual([YOU]);

    await deliverAs(HERMES, FRAME_LETTER);
    const attempted = await house.mailbox!.runPass();

    expect(attempted).toBe(1);
    // The frame letter lands in its frame folder (the resident's active
    // frames are derived from the room they worked in — the letter's own
    // frame wins) AND in Archive.
    expect(await countIn("production:tempest-2026", `<${IDs.frame}@house>`)).toBe(1);
    expect(await countIn("Archive", `<${IDs.frame}@house>`)).toBe(1);
  });

  it("delta-syncs through the pipeline's onStored hook — no explicit pass", async () => {
    // Deliver only. The pipeline's onStored hook (wired in buildHouse)
    // already re-converged the mailbox — the inbox letter must land in
    // Inbox without us calling runPass.
    const res = await deliverAs(HERMES, INBOX_LETTER);
    expect(res.status).toBe(201);

    expect(await countIn("Inbox", `<${IDs.inbox}@house>`)).toBe(1);
    // The earlier frame letter is untouched — idempotent re-convergence.
    expect(await countIn("production:tempest-2026", `<${IDs.frame}@house>`)).toBe(1);
  });

  it("privacy negative — no account row, no sync, no connection", async () => {
    await deliverAs(HERMES, GHOST_LETTER);

    // Only YOU has an account — the pass attempts exactly one resident.
    const attempted = await house.mailbox!.runPass();
    expect(attempted).toBe(1);

    // GHOST's letter is visible to her in the archive, but the house never
    // created a mailbox for her — it never reaches the sidecar at all.
    expect(await appearsAnywhere(`<${IDs.ghost}@house>`)).toBe(false);
  });
});
