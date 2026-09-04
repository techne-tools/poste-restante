/**
 * The SMTP door (unit) — the translation is the bridge (SPEC §5 #10).
 *
 * Pure helpers, tested hermetically: RFC5322 → the letter contract.
 * Thread resolution is the interesting part (X-House-Thread wins, then a
 * re:-subject match, then a deterministic new thread) and the subject
 * normalisation is the fiddly part (re:/fwd:/i18n prefixes).
 */
import { describe, it, expect } from "vitest";
import {
  normalizeSubject,
  deterministicThread,
  parseBind,
  translateMail,
} from "../../src/bridge/smtp.js";

describe("normalizeSubject", () => {
  it("strips re: and fwd: prefixes case-insensitively", () => {
    expect(normalizeSubject("Re: the storm cue")).toBe("the storm cue");
    expect(normalizeSubject("FW: draft programme")).toBe("draft programme");
    expect(normalizeSubject("re: re: nested")).toBe("nested");
  });

  it("trims and lowercases", () => {
    expect(normalizeSubject("  THE STORM CUE  ")).toBe("the storm cue");
  });

  it("leaves a bare subject untouched", () => {
    expect(normalizeSubject("the storm cue")).toBe("the storm cue");
  });
});

describe("deterministicThread", () => {
  it("is stable for the same inputs", () => {
    const a = deterministicThread("you@house", "hermes@house", "the storm cue", "2026-09-04T10:00:00Z");
    const b = deterministicThread("you@house", "hermes@house", "the storm cue", "2026-09-04T10:00:00Z");
    expect(a).toBe(b);
  });

  it("differs when the subject changes", () => {
    const a = deterministicThread("you@house", "hermes@house", "the storm cue", "2026-09-04T10:00:00Z");
    const b = deterministicThread("you@house", "hermes@house", "the programme", "2026-09-04T10:00:00Z");
    expect(a).not.toBe(b);
  });

  it("has the smtp prefix and a 12-char hash", () => {
    const t = deterministicThread("you@house", "hermes@house", "the storm cue", "2026-09-04T10:00:00Z");
    expect(t).toMatch(/^th_smtp_[0-9a-f]{12}$/);
  });
});

describe("parseBind", () => {
  it("parses host:port", () => {
    expect(parseBind("127.0.0.1:2525")).toEqual({ host: "127.0.0.1", port: 2525 });
  });

  it("defaults the port when only a host is given", () => {
    expect(parseBind("localhost")).toEqual({ host: "localhost", port: 2525 });
  });
});

describe("translateMail", () => {
  const parsed = {
    subject: "re: the storm cue",
    date: new Date("2026-09-04T10:00:00+04:00"),
    text: "The storm cue lands early.\n\n— C",
    headers: new Map([["x-house-thread", ""]]),
    cc: [],
  } as Parameters<typeof translateMail>[0]["parsed"];

  const findThreadBySubject = async () => null;

  it("maps mail to the letter contract — from, to, cc, subject, date, body", async () => {
    const letter = await translateMail({
      from: "you@house",
      recipients: ["hermes@house"],
      cc: ["ben@house"],
      parsed,
      findThreadBySubject,
    });
    expect(letter.envelope.from).toBe("you@house");
    expect(letter.envelope.to).toEqual(["hermes@house"]);
    expect(letter.envelope.cc).toEqual(["ben@house"]);
    expect(letter.envelope.kind).toBe("letter");
    expect(letter.envelope.subject).toBe("re: the storm cue");
    // The bridge normalises to UTC — the same instant, deterministic.
    expect(letter.time.gregorian).toBe("2026-09-04T06:00:00.000Z");
    expect(letter.body.content).toContain("The storm cue lands early.");
  });

  it("continues the X-House-Thread header when present", async () => {
    const withHeader = {
      ...parsed,
      headers: new Map([["x-house-thread", "th_manual_123"]]),
    } as typeof parsed;
    const letter = await translateMail({
      from: "you@house",
      recipients: ["hermes@house"],
      cc: [],
      parsed: withHeader,
      findThreadBySubject,
    });
    expect(letter.envelope.thread).toBe("th_manual_123");
  });

  it("continues a matched re:-subject thread via the seam", async () => {
    const matched = async () => "th_storm_cue";
    const letter = await translateMail({
      from: "hermes@house",
      recipients: ["you@house"],
      cc: [],
      parsed,
      findThreadBySubject: matched,
    });
    expect(letter.envelope.thread).toBe("th_storm_cue");
    // The reply is scoped to the FIRST recipient — the thread the sender
    // is actually continuing.
    expect(letter.envelope.to).toEqual(["you@house"]);
  });

  it("falls back to a deterministic new thread when nothing matches", async () => {
    const letter = await translateMail({
      from: "you@house",
      recipients: ["hermes@house"],
      cc: [],
      parsed: { ...parsed, subject: "a brave new subject" },
      findThreadBySubject,
    });
    expect(letter.envelope.thread).toMatch(/^th_smtp_[0-9a-f]{12}$/);
  });
});
