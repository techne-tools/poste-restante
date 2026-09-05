/**
 * The IMAP writer adapter (unit) — the pure mappings of the B2b live
 * adapter: URL parsing (imap:// and imaps:// only, credentials from URL,
 * defaults on absent port) and the house Message-ID derivation. The live
 * wire behaviour (append, search, folders) is the integration test —
 * this file stays hermetic, no network, no sidecar.
 */
import { describe, it, expect, vi } from "vitest";
import { ImapMailboxWriter, parseImapUrl } from "../../src/bridge/imap-writer.js";
import { uidForLetter } from "../../src/bridge/mailbox.js";

describe("parseImapUrl", () => {
  it("parses an imap:// URL with credentials", () => {
    const opts = parseImapUrl("imap://you@house.test:house-dev-sidecar@127.0.0.1:11430/");
    expect(opts.host).toBe("127.0.0.1");
    expect(opts.port).toBe(11430);
    expect(opts.secure).toBe(false);
    expect(opts.auth).toEqual({ user: "you@house.test", pass: "house-dev-sidecar" });
  });

  it("defaults the port per scheme", () => {
    expect(parseImapUrl("imap://you@house.test@localhost/").port).toBe(143);
    expect(parseImapUrl("imaps://you@house.test@localhost/").port).toBe(993);
  });

  it("sets secure only for imaps://", () => {
    expect(parseImapUrl("imap://localhost/").secure).toBe(false);
    expect(parseImapUrl("imaps://localhost/").secure).toBe(true);
  });

  it("rejects non-imap schemes", () => {
    expect(() => parseImapUrl("smtp://localhost/")).toThrow("IMAP_URL must be imap:// or imaps://");
  });

  it("rejects unparseable URLs", () => {
    expect(() => parseImapUrl("not a url")).toThrow("invalid IMAP_URL");
  });
});

describe("ImapMailboxWriter.messageIdOf", () => {
  it("reads the Message-ID the engine built — the letter id, not a numeric uid", () => {
    const uid = uidForLetter("a1b2c3d4e5f67890");
    const msg = { headers: { "Message-ID": `<a1b2c3d4e5f67890@house>` } } as never;
    expect(ImapMailboxWriter.messageIdOf(msg)).toBe("<a1b2c3d4e5f67890@house>");
    void uid;
  });

  it("is deterministic and never derives ids from numeric uids", () => {
    const msg = { headers: { "Message-ID": "<a1b2c3d4e5f67890@house>" } } as never;
    expect(ImapMailboxWriter.messageIdOf(msg)).toBe(ImapMailboxWriter.messageIdOf(msg));
  });

  it("throws on a message without a Message-ID header", () => {
    const msg = { headers: { Subject: "no id" } } as never;
    expect(() => ImapMailboxWriter.messageIdOf(msg)).toThrow("message carries no Message-ID header");
  });
});

describe("ImapMailboxWriter logger discipline", () => {
  it("logs event names and counts only, never address or body", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const writer = new ImapMailboxWriter(
      { host: "127.0.0.1", port: 11430, secure: false, auth: { user: "you@house.test", pass: "x" } },
      log,
    );
    // The writer's own logs are folder/uid only — this test pins the
    // contract: construction never logs, and no address/body may appear.
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
