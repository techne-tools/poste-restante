/**
 * The outbound seam — the house writes (SPEC §5 #13).
 *
 * The reverse of the SMTP door: a letter addressed to an external address
 * (any address whose domain ≠ HOUSE_DOMAIN) is carried out of the house as
 * real mail. The seam rides the pipeline's `onStored` hook, so EVERY ingest
 * face (HTTP, MCP, the SMTP door) behaves identically — one seam, no
 * divergent code paths.
 *
 * Store first, relay second — never lose a letter. The pipeline stores
 * first; the relay runs after; a relay failure leaves the letter archived
 * and logs an event. The house's letters are always the archive's letters;
 * the outbound copy is the archive speaking outward.
 *
 * Anti-forging, unchanged: the envelope `from` is the resident's own
 * address; the house never claims a sender it cannot prove. Anti-loop
 * guard: the seam refuses to relay to an SMTP URL that is the house's own
 * door (SMTP_OUTBOUND_URL matching the door's bind) — the house never posts
 * to itself and loops.
 */
import { createTransport, type Transporter, type SentMessageInfo } from "nodemailer";
import type { Logger } from "../pipeline/logger.js";
import type { HouseConfig } from "../config.js";
import type { Letter, StoredLetter } from "../types.js";
import { markdownToText } from "../pipeline/markdown.js";

/** Split an address into its local part and domain ("hermes@house" → ["hermes", "house"]). */
export function splitAddress(address: string): { local: string; domain: string } {
  const idx = address.lastIndexOf("@");
  if (idx < 0) return { local: address, domain: "" };
  return { local: address.slice(0, idx), domain: address.slice(idx + 1) };
}

/** An address is internal (a resident's own) iff its domain is the house's own domain. */
export function isInternalAddress(address: string, houseDomain: string): boolean {
  return splitAddress(address).domain === houseDomain;
}

/** The recipients a letter must be relayed to: its `to`, its `cc`, minus
 *  the house's own addresses (the house never mails itself). Deduplicated,
 *  order preserved on first appearance. */
export function externalRecipients(letter: Pick<Letter["envelope"], "to" | "cc">, houseDomain: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const address of [...letter.to, ...letter.cc]) {
    if (isInternalAddress(address, houseDomain)) continue;
    if (seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

/** A mailto-style SMTP URL ("smtp://user:pass@relay:587/") parsed into a
 *  nodemailer transport config. Credentials never live in config files —
 *  they ride in the URL, read from the environment. */
export function parseSmtpUrl(url: string): {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string } | undefined;
  url: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid SMTP_OUTBOUND_URL");
  }
  if (!["smtp:", "smtps:"].includes(parsed.protocol)) {
    throw new Error("SMTP_OUTBOUND_URL must be smtp:// or smtps://");
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : (parsed.protocol === "smtps:" ? 465 : 587);
  const auth =
    parsed.username || parsed.password
      ? { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) }
      : undefined;
  return { host: parsed.hostname, port, secure: parsed.protocol === "smtps:", auth, url };
}

/** The anti-loop guard: refuse to relay to an SMTP URL that is the house's
 *  own door — the house never posts to itself. */
export function isOwnDoor(url: string, smtpBind: string): boolean {
  try {
    const parsed = new URL(url);
    const bind = parseBindSafe(smtpBind);
    // The door's host:port. A URL pointing back at it is the house talking
    // to itself.
    return parsed.hostname === bind.host && (parsed.port ? Number.parseInt(parsed.port, 10) : 587) === bind.port;
  } catch {
    return false;
  }
}

function parseBindSafe(bind: string): { host: string; port: number } {
  const idx = bind.lastIndexOf(":");
  if (idx < 0) return { host: bind, port: 2525 };
  const port = Number.parseInt(bind.slice(idx + 1), 10);
  return { host: bind.slice(0, idx) || "127.0.0.1", port: Number.isNaN(port) ? 2525 : port };
}

/** The reverse translation — letter contract → RFC5322 mail. Pure, so it
 *  can be unit-tested hermetically. Markdown → text/plain (the same
 *  extraction the archive indexes), gregorian → Date, thread → References
 *  (so mail clients group the conversation the house's way). */
export function translateToMail(letter: StoredLetter): {
  from: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  date: Date;
} {
  return {
    from: letter.envelope.from,
    subject: letter.envelope.subject,
    text: markdownToText(letter.body.content),
    headers: { References: letter.envelope.thread, "X-House-Thread": letter.envelope.thread },
    date: new Date(letter.time.gregorian),
  };
}

export interface OutboundDeps {
  config: HouseConfig;
  log: Logger;
}

export interface OutboundRelay {
  /** True when the seam is open (SMTP_OUTBOUND_URL configured and safe). */
  readonly enabled: boolean;
  /** Relay one letter. Returns the number of external recipients relayed.
   *  Throws when the relay fails — the caller (the pipeline hook) logs and
   *  never loses the letter. */
  relay(letter: StoredLetter): Promise<number>;
  /** Close the transport when the house shuts down. */
  close(): void;
}

/** Build the outbound relay. Returns null when unconfigured (the seam
 *  sleeps; the default is closed) or when the house cannot know its
 *  residents (AUTH_MODE=none — the outbound seam, like the door, fails
 *  closed). The anti-loop guard refuses a URL that is the house's own door. */
export function startOutbound(deps: OutboundDeps): OutboundRelay | null {
  const { config, log } = deps;
  if (!config.smtpOutboundUrl) {
    log.info("outbound:dormant", { reason: "no-SMTP_OUTBOUND_URL" });
    return null;
  }
  if (config.auth.mode === "none") {
    log.error("outbound:refusing", {
      reason: "auth-disabled",
      message: "the outbound seam cannot prove a sender with AUTH_MODE=none",
    });
    return null;
  }
  if (isOwnDoor(config.smtpOutboundUrl, config.smtpBind)) {
    log.error("outbound:refusing", {
      reason: "own-door",
      message: "refusing to relay to the house's own SMTP door",
    });
    return null;
  }

  const parsed = parseSmtpUrl(config.smtpOutboundUrl);
  const transport: Transporter<SentMessageInfo> = createTransport({
    host: parsed.host,
    port: parsed.port,
    secure: parsed.secure,
    auth: parsed.auth,
    logger: false,
  });

  log.info("outbound:listening", { host: parsed.host, port: parsed.port });

  return {
    enabled: true,
    async relay(letter) {
      const recipients = externalRecipients(letter.envelope, config.houseDomain);
      if (recipients.length === 0) return 0;
      const mail = translateToMail(letter);
      // The envelope `from` is the resident's own address — the house never
      // claims a sender it cannot prove.
      await transport.sendMail({ ...mail, to: recipients.join(", ") });
      log.info("outbound:relayed", { letterId: letter.id, to: recipients.length });
      return recipients.length;
    },
    close() {
      transport.close();
    },
  };
}
