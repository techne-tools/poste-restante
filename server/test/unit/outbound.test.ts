/**
 * The outbound seam (unit) — the reverse translation is the bridge (SPEC §5 #13).
 *
 * Pure helpers, tested hermetically: letter contract → RFC5322; the
 * external-recipient filter (the house never mails itself); the relay
 * surface (dormant by default, refuses AUTH_MODE=none, refuses its own
 * door — the house never posts to itself and loops).
 */
import { describe, it, expect } from "vitest";
import {
  externalRecipients,
  isInternalAddress,
  parseSmtpUrl,
  isOwnDoor,
  translateToMail,
  startOutbound,
} from "../../src/bridge/outbound.js";
import { loadConfig } from "../../src/config.js";
import { silentLogger } from "../../src/pipeline/logger.js";
import type { StoredLetter } from "../../src/types.js";

const mkStored = (over: Partial<StoredLetter> = {}): StoredLetter => ({
  envelope: {
    from: "you@house",
    to: ["hermes@house"],
    cc: [],
    thread: "th_outbound_1",
    kind: "letter",
    lang: "en-AU",
    subject: "the storm cue",
  },
  time: { gregorian: "2026-09-04T10:00:00+04:00", frames: [] },
  body: { format: "markdown", content: "Move the **storm cue** to 47." },
  id: "abc123",
  receivedAt: new Date("2026-09-04T10:00:00+04:00"),
  bodyText: "Move the storm cue to 47.",
  ...over,
});

describe("isInternalAddress", () => {
  it("true for house-domain addresses", () => {
    expect(isInternalAddress("hermes@house", "house")).toBe(true);
    expect(isInternalAddress("pub@house", "house")).toBe(true);
  });

  it("false for external and domainless addresses", () => {
    expect(isInternalAddress("chris@fastmail.com", "house")).toBe(false);
    expect(isInternalAddress("bare-address", "house")).toBe(false);
  });
});

describe("externalRecipients", () => {
  it("keeps external recipients, drops the house's own, dedupes", () => {
    const result = externalRecipients(
      {
        to: ["hermes@house", "chris@fastmail.com", "chris@fastmail.com"],
        cc: ["producer@uae.ac.ae", "pub@house"],
      },
      "house",
    );
    expect(result).toEqual(["chris@fastmail.com", "producer@uae.ac.ae"]);
  });

  it("returns [] when every recipient is internal — the house never mails itself", () => {
    expect(
      externalRecipients({ to: ["hermes@house"], cc: ["pub@house"] }, "house"),
    ).toEqual([]);
  });
});

describe("parseSmtpUrl", () => {
  it("parses host, port, auth and plain/secure mode", () => {
    expect(parseSmtpUrl("smtp://user:pass@smtp.fastmail.com:587/")).toEqual({
      host: "smtp.fastmail.com",
      port: 587,
      secure: false,
      auth: { user: "user", pass: "pass" },
      url: "smtp://user:pass@smtp.fastmail.com:587/",
    });
    expect(parseSmtpUrl("smtps://u@relay.example:465/").secure).toBe(true);
  });

  it("defaults the port per scheme", () => {
    expect(parseSmtpUrl("smtp://relay.example/").port).toBe(587);
    expect(parseSmtpUrl("smtps://relay.example/").port).toBe(465);
  });

  it("rejects non-smtp schemes and garbage", () => {
    expect(() => parseSmtpUrl("http://relay.example/")).toThrow(/smtp/i);
    expect(() => parseSmtpUrl("not a url")).toThrow(/invalid/i);
  });
});

describe("isOwnDoor", () => {
  it("detects the house's own bind as a loop", () => {
    expect(isOwnDoor("smtp://u:p@127.0.0.1:2525/", "127.0.0.1:2525")).toBe(true);
  });

  it("allows any other target", () => {
    expect(isOwnDoor("smtp://u:p@127.0.0.1:587/", "127.0.0.1:2525")).toBe(false);
    expect(isOwnDoor("smtp://u:p@relay.example:2525/", "127.0.0.1:2525")).toBe(false);
  });
});

describe("translateToMail", () => {
  it("maps the letter to RFC5322 — plain text, thread in References, gregorian as Date", () => {
    const mail = translateToMail(mkStored());
    expect(mail.from).toBe("you@house");
    expect(mail.subject).toBe("the storm cue");
    expect(mail.text).toBe("Move the storm cue to 47.");
    expect(mail.headers.References).toBe("th_outbound_1");
    expect(mail.headers["X-House-Thread"]).toBe("th_outbound_1");
    expect(mail.date).toEqual(new Date("2026-09-04T10:00:00+04:00"));
  });
});

describe("startOutbound", () => {
  const log = silentLogger();

  it("returns null when unconfigured — the seam ships dormant", () => {
    const config = loadConfig({ AUTH_MODE: "basic" });
    expect(startOutbound({ config, log })).toBeNull();
  });

  it("refuses to open with AUTH_MODE=none — the seam must know its residents", () => {
    const config = loadConfig({ AUTH_MODE: "none", SMTP_OUTBOUND_URL: "smtp://u:p@relay.example:587/" });
    expect(startOutbound({ config, log })).toBeNull();
  });

  it("refuses its own door — the house never posts to itself", () => {
    const config = loadConfig({
      AUTH_MODE: "basic",
      SMTP_BIND: "127.0.0.1:2525",
      SMTP_OUTBOUND_URL: "smtp://u:p@127.0.0.1:2525/",
    });
    expect(startOutbound({ config, log })).toBeNull();
  });

  it("opens with a valid relay — and a letter with no external recipient is never sent", async () => {
    const config = loadConfig({
      AUTH_MODE: "basic",
      SMTP_OUTBOUND_URL: "smtp://u:p@127.0.0.1:9999/",
    });
    const relay = startOutbound({ config, log });
    expect(relay).not.toBeNull();
    expect(relay!.enabled).toBe(true);

    // All-internal recipients → 0 without ever contacting the transport
    // (the seam returns before any send on a dead port).
    const internalOnly = mkStored();
    expect(await relay!.relay(internalOnly)).toBe(0);
    relay!.close();

    // An external recipient would attempt the send — covered by the
    // integration suite against a live capture sink.
  });
});
