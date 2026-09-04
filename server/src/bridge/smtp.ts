/**
 * The SMTP door — the house meets real mail (SPEC §5 #10).
 *
 * The bridge layer, movement A: inbound only. The house accepts SMTP on a
 * local submission port, authenticates the sender as a resident against
 * its own credentials, and ingests the mail as a letter through the same
 * pipeline, same idempotency, same privacy.
 *
 * The anti-forging invariant is unchanged: the envelope `from` is the
 * SMTP-authenticated address — a different MAIL FROM is refused before
 * DATA. Only residents can post; no anonymous relay; nothing is stored on
 * any negative. The translation is the bridge: RFC5322 → the letter
 * contract. Presence not pressure — the door accepts; the whisper and
 * reply-tracking behave exactly as for HTTP letters.
 */
import { SMTPServer } from "smtp-server";
import { simpleParser, type ParsedMail } from "mailparser";
import crypto from "node:crypto";
import type { HouseConfig } from "../config.js";
import type { Logger } from "../pipeline/logger.js";
import type { AuthService, Authenticated } from "../auth/service.js";

/**
 * The translation seam — RFC5322 → the letter contract. Pure, so the
 * thread resolution can be unit-tested hermetically. The `findThread`
 * callback resolves a re:-subject match against the house's correspondence
 * (the integration test supplies the real query; the unit test a stub).
 */
export interface MailTranslation {
  findThreadBySubject: (
    to: string,
    normalizedSubject: string,
  ) => Promise<string | null>;
}

export function normalizeSubject(subject: string): string {
  return subject
    // Strip repeated prefixes — mail clients stack "re: re: ...".
    .replace(/^(?:\s*(?:re|fwd|fw|sv|aw|antwort|回复)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

export function deterministicThread(
  from: string,
  to: string,
  subject: string,
  date: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update([from, to, subject, date].join("|"))
    .digest("hex")
    .slice(0, 12);
  return `th_smtp_${hash}`;
}

export interface ParsedRecipient {
  address: string;
}

/** The sender's authenticated address, the parsed mail, and the recipient
 *  addresses (from the RCPT conversation, which is what the sender
 *  actually addressed). */
export interface TranslateInput {
  from: string;
  recipients: string[];
  cc: string[];
  parsed: ParsedMail;
}

export async function translateMail(
  input: TranslateInput & MailTranslation,
): Promise<{
  envelope: {
    from: string;
    to: string[];
    cc: string[];
    thread: string;
    kind: "letter";
    lang: string;
    subject: string;
  };
  time: { gregorian: string; frames: [] };
  body: { format: "markdown"; content: string };
}> {
  const { from, recipients, cc, parsed, findThreadBySubject } = input;

  // Thread: X-House-Thread header wins; else a re:-subject match; else a
  // deterministic new thread. No other X-headers are honoured.
  const headerThread = parsed.headers.get("x-house-thread");
  let thread: string;
  if (typeof headerThread === "string" && headerThread.trim()) {
    thread = headerThread.trim();
  } else {
    const subject = parsed.subject ?? "";
    const normalized = normalizeSubject(subject);
    const firstRecipient = recipients[0];
    const matched = firstRecipient
      ? await findThreadBySubject(firstRecipient, normalized)
      : null;
    thread =
      matched ??
      deterministicThread(
        from,
        recipients.join(","),
        subject,
        parsed.date?.toISOString() ?? new Date().toISOString(),
      );
  }

  return {
    envelope: {
      from,
      to: recipients,
      cc,
      thread,
      // Mail is a letter; the sender's own words, not a house kind.
      kind: "letter",
      lang: "en-AU",
      subject: parsed.subject ?? "",
    },
    time: {
      gregorian: parsed.date?.toISOString() ?? new Date().toISOString(),
      frames: [],
    },
    body: {
      format: "markdown",
      // text is mailparser's plain-text rendering (charset + transfer
      // encoding decoded). Markdown renders plain text faithfully.
      content: parsed.text ?? "",
    },
  };
}

export interface SmtpBridgeDeps {
  config: HouseConfig;
  log: Logger;
  auth: AuthService;
  /** The single write path — same pipeline as HTTP letters. */
  ingest: (letter: SmtpMailLetter) => Promise<{ letterId: string; created: boolean }>;
  findThreadBySubject: (to: string, normalizedSubject: string) => Promise<string | null>;
}

export interface SmtpMailLetter {
  envelope: { from: string; to: string[]; cc: string[]; thread: string; kind: "letter"; lang: string; subject: string };
  time: { gregorian: string; frames: { frame: string; value: string }[] };
  body: { format: "markdown"; content: string };
}

export interface SmtpBridge {
  /** Resolves once the SMTP listener is accepting connections. */
  ready: Promise<void>;
  /** Gracefully stop accepting mail and close the listener. */
  close(): Promise<void>;
}

/** Parse an SMTP bind string ("127.0.0.1:2525") into host/port. */
export function parseBind(bind: string): { host: string; port: number } {
  const idx = bind.lastIndexOf(":");
  if (idx < 0) return { host: bind, port: 2525 };
  const port = Number.parseInt(bind.slice(idx + 1), 10);
  return { host: bind.slice(0, idx) || "127.0.0.1", port: Number.isNaN(port) ? 2525 : port };
}

/**
 * Start the SMTP door. Returns null when disabled (the default — the door
 * is closed until opened) or when the house runs with auth disabled (the
 * door cannot know who its residents are — fail closed).
 */
export function startSmtpBridge(
  deps: SmtpBridgeDeps,
  bind: string,
): SmtpBridge | null {
  const { config, log, auth } = deps;
  if (!config.smtpEnabled) {
    log.info("smtp:disabled");
    return null;
  }
  if (config.auth.mode === "none") {
    log.error("smtp:refusing", {
      reason: "auth-disabled",
      message: "the SMTP door cannot know its residents with AUTH_MODE=none",
    });
    return null;
  }

  const { host, port } = parseBind(bind);

  let readyResolve: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => (readyResolve = resolve));

  // The callback signature shape matches smtp-server's onAuth /
  // onData conventions (error-first; success = no error argument).
  const server = new SMTPServer({
    // Localhost submission only: no STARTTLS offered, no secure socket,
    // no reverse DNS lookups. The house is on the owner's own wire.
    secure: false,
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    authMethods: ["PLAIN", "LOGIN"],
    disableReverseLookup: true,
    hideSTARTTLS: true,

    // The resident's credential is the key. We re-encode the SMTP
    // username/password into the HTTP Basic shape and reuse the house's
    // own scrypt verification — one credential store, one verification.
    onAuth(authData, _session, callback) {
      const { username, password } = authData as {
        username: string | undefined;
        password: string | undefined;
      };
      if (!username || !password) {
        callback(new Error("authentication required"));
        return;
      }
      const basic = Buffer.from(`${username}:${password}`).toString("base64");
      void auth
        .authenticate(`Basic ${basic}`)
        .then((who: Authenticated | null) => {
          if (!who) {
            callback(new Error("invalid credentials"));
            return;
          }
          // `user` is the address the rest of the session is bound to —
          // the anti-forging check in onMailFrom compares against it.
          callback(null, { user: who.address });
        })
        .catch((err: unknown) => {
          log.error("smtp:auth-error", {
            error: err instanceof Error ? err.message : String(err),
          });
          callback(new Error("authentication unavailable"));
        });
    },

    // The anti-forging invariant: the envelope from is the authenticated
    // address. A different MAIL FROM is refused, nothing is accepted.
    onMailFrom(address, session, callback) {
      const authed = (session as { user?: string }).user;
      if (address.address !== authed) {
        callback(new Error("sender does not match the authenticated address"));
        return;
      }
      callback();
    },

    // The house takes mail for any recipient — the address materialises on
    // ingest, like any letter's `to`. There is no mailbox enumeration here:
    // every letter lands in the archive, and visibility stays derived.
    onRcptTo(_address, _session, callback) {
      callback();
    },

    // The translation: RFC5322 → the letter contract → the shared
    // pipeline. Errors are surfaced as a 5xx to the sender; nothing is
    // stored on failure. The `deliverLetter` behaviours (whisper surface,
    // reply tracking) are preserved via the ingest seam on the house side.
    onData(stream, session, callback) {
      void (async () => {
        try {
          const parsed = await simpleParser(stream, {
            // The house keeps bodies, not attachments (this phase).
            skipTextToHtml: true,
            skipHtmlToText: false,
          });
          const from = (session as { user?: string }).user;
          if (!from) {
            callback(new Error("sender not authenticated"));
            return;
          }
          const recipients = (
            session.envelope.rcptTo?.map((r) => r.address).filter(Boolean) ?? []
          ) as string[];
          const cc = (
            (parsed.cc as ParsedRecipient[] | undefined)?.map((r) => r.address).filter(Boolean) ?? []
          ) as string[];
          const letter = await translateMail({
            from,
            recipients,
            cc,
            parsed,
            findThreadBySubject: deps.findThreadBySubject,
          });
          const result = await deps.ingest(letter);
          log.info("smtp:ingested", {
            letterId: result.letterId,
            created: result.created,
          });
          callback();
        } catch (err) {
          log.error("smtp:reject", {
            error: err instanceof Error ? err.message : String(err),
          });
          callback(new Error("the house could not read this letter"));
        }
      })();
    },
  });

  server.listen(port, host, () => {
    log.info("smtp:listening", { host, port });
    readyResolve();
  });

  return {
    ready: readyPromise,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err?: Error | null) => (err ? reject(err) : resolve()));
      }),
  };
}
