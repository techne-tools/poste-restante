/**
 * The mailbox sync drive (SPEC §5 #12) — wires the seam to a live house.
 *
 * B1 (pure engine) translates letters; B2a (state machine) mirrors a
 * resident's view; B2b (adapter) writes IMAP. The drive is the part that
 * makes the house LIVE: it enumerates provisioned mailbox accounts and runs
 * the sync for them —
 *
 *   - resync on start (the mailbox converges with the archive),
 *   - a per-resident delta after every stored letter (the pipeline's
 *     onStored hook — the same single write path the outbound seam and the
 *     participation cache ride, so every ingest face behaves identically),
 *   - optionally, a scheduled re-pass (MAILBOX_SYNC_INTERVAL_MS) with the
 *     same overlap guard as the gap scheduler (a pass never overlaps the
 *     last; the house breathes, it never stacks).
 *
 * Privacy:
 *   - Scope: accounts ONLY. No row, no sync — a resident without a
 *     provisioned mailbox is never connected to.
 *   - Visibility: the drive hands each resident only the letters the house's
 *     own visibility rule resolves for them; the engine cannot leak a letter
 *     it is never given.
 *   - Logs: event names and counts only (folder count, message count,
 *     error message) — no URLs, addresses, bodies, or thread ids (the
 *     mailbox:sync-resident seam logs the same way).
 */
import type { Logger } from "../pipeline/logger.js";
import type { MailboxWriter, MailboxSyncSource } from "./sync.js";
import { MailboxSync } from "./sync.js";
import { ImapMailboxWriter, parseImapUrl } from "./imap-writer.js";
import type { MailboxAccount } from "./mailbox-accounts.js";

/** Strip a raw URL (with its userinfo credential) out of a log-bound error
 *  message. The drive's log discipline: no URLs, no credentials — event
 *  names and counts only (the CLI's list view prints the host; the
 *  userinfo never leaves the house). */
export function redactUrl(message: string, url: string | undefined): string {
  if (!url) return message;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      // URL.username/password are percent-encoded (you%40house.test) but
      // error messages carry the raw userinfo — decode both and scrub both
      // forms so the credential never surfaces in a log line.
      const user = decodeURIComponent(parsed.username);
      const pass = decodeURIComponent(parsed.password);
      for (const cred of [
        `${user}:${pass}@`,
        `${parsed.username}:${parsed.password}@`,
      ]) {
        message = message.split(cred).join("***@");
      }
    }
  } catch {
    // Unparseable — leave the message as-is.
  }
  return message;
}

export interface MailboxSyncDriveDeps {
  /** The provisioned mailbox accounts — the drive's subject. Only `list`
   *  is needed (structural: MailboxAccountsService satisfies it); unit
   *  tests fake it without pg. */
  accounts: { list(): Promise<MailboxAccount[]> };
  /** The archive queries the sync runs on — visibility-scoped letters and
   *  the resident's active frame ids (structural: PostgresRepository
   *  satisfies it; unit tests fake it without pg). */
  repo: {
    lettersForMailboxSync(address: string): Promise<MailboxSyncSource[]>;
    activeFrameIds(address: string): Promise<string[]>;
  };
  /** The read-back record target — the house's own per-resident record of
   *  what was engaged with (structural: LetterReadsService satisfies). The
   *  drive upserts observed flags; idempotent first-open-wins holds. */
  reads: {
    open(letterId: string, address: string): Promise<void>;
    replied(letterId: string, address: string): Promise<void>;
  };
  log: Logger;
  /** DEV-ONLY escape hatch for self-signed dev/homelab sidecars (see
   *  `tlsInsecure`). MUST come from an explicit operator env key
   *  (MAILBOX_TLS_INSECURE=1), never from the URL scheme. The adapter
   *  itself never relaxes TLS — only this drive does, when told to. */
  tlsInsecure?: boolean;
  /** Overridable for tests. Defaults to the real adapter. */
  writerFor?(account: MailboxAccount): MailboxWriter;
}

/** The count of a single resident pass — used by the periodic scheduler. */
export interface MailboxPassResult {
  address: string;
  folders: number;
  messages: number;
  /** Letters whose flags the house read back this pass (0 when the writer
   *  cannot read, or nothing was observed). */
  reads: number;
  /** Letters whose \Seen observation changed this pass — the house
   *  recorded new opens. Distinct from the total read: a pass may observe
   *  already-opened letters (idempotent first-open-wins) and change none. */
  opened: number;
  /** Letters whose \Answered observation changed this pass. */
  replied: number;
}

export class MailboxSyncDrive {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly writerFor: (account: MailboxAccount) => MailboxWriter;
  private readonly intervalMs: number;

  constructor(
    private readonly deps: MailboxSyncDriveDeps,
    intervalMs: number = 0,
  ) {
    this.intervalMs = intervalMs;
    this.writerFor =
      deps.writerFor ??
      ((account) => {
        const opts = parseImapUrl(account.url);
        // Explicit dev boundary: MAILBOX_TLS_INSECURE=1 accepts the dev /
        // homelab sidecar's self-signed cert (its bootstrap defaults).
        // Plaintext imap:// alone is NOT a reason to relax TLS — imapflow
        // will happily STARTTLS and then fail verification, which is the
        // correct fail-closed behaviour; relaxing requires the explicit
        // operator key. Production configures the CA via imaps:// and
        // never sets this.
        if (deps.tlsInsecure && account.url.startsWith("imap://")) {
          opts.tls = { rejectUnauthorized: false };
        }
        return new ImapMailboxWriter(opts, deps.log);
      });
  }

  /** Resync every provisioned account once. Overlap-safe and
   *  failure-isolated: one account's failure is logged and never stops the
   *  house for the others. Returns the number of accounts attempted. */
  async runPass(): Promise<number> {
    if (this.running) {
      this.deps.log.warn("mailbox:pass-skipped", { reason: "overlap" });
      return 0;
    }
    this.running = true;
    try {
      const accounts = await this.deps.accounts.list();
      for (const account of accounts) {
        try {
          await this.syncResident(account);
        } catch (err) {
          this.deps.log.warn("mailbox:pass-error", {
            error: redactUrl(
              err instanceof Error ? err.message : String(err),
              account.url,
            ),
          });
        }
      }
      return accounts.length;
    } finally {
      this.running = false;
    }
  }

  /** One resident's pass. Resolves the visibility-scoped rows, builds the
   *  view, mirrors it, then reads the flags back into the house's own
   *  record of what the resident engaged with (the learning loop's other
   *  half — SPEC §5 #12). */
  async syncResident(account: MailboxAccount): Promise<MailboxPassResult> {
    const writer = this.writerFor(account);
    const sync = new MailboxSync({
      visibleLetters: (address) => this.deps.repo.lettersForMailboxSync(address),
      write: writer,
      log: this.deps.log,
    });
    const activeFrames = await this.deps.repo.activeFrameIds(account.address);
    const result = await sync.syncResident(account.address, activeFrames);

    // The read-back limb — one writer call after the writes. The house
    // records what the resident read through IMAP (\Seen → opened) and
    // what threads they answered (\Answered → replied). Idempotent
    // first-open-wins on the house side; a failure here is logged and
    // never stops the residents after this one (the next pass
    // re-converges). Only letters the house itself mirrored can surface —
    // the writer sees exactly its own Message-IDs.
    let reads = 0;
    let opened = 0;
    let replied = 0;
    try {
      const observations = await writer.readBack();
      reads = observations.length;
      for (const obs of observations) {
        try {
          if (obs.seen) {
            await this.deps.reads.open(obs.letterId, account.address);
            opened += 1;
          }
          if (obs.answered) {
            await this.deps.reads.replied(obs.letterId, account.address);
            replied += 1;
          }
        } catch (err) {
          this.deps.log.warn("mailbox:read-back-error", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      this.deps.log.info("mailbox:read-back", { reads, opened, replied });
    } catch (err) {
      this.deps.log.warn("mailbox:read-back-failed", {
        error: redactUrl(
          err instanceof Error ? err.message : String(err),
          account.url,
        ),
      });
    }

    return { address: account.address, ...result, reads, opened, replied };
  }

  /** Delta-sync the residents party to one stored letter. The pipeline's
   *  onStored hook — the letter is already stored; a failure here is
   *  logged, never fatal; the next pass re-converges. */
  async onStored(): Promise<void> {
    try {
      await this.runPass();
    } catch (err) {
      this.deps.log.warn("mailbox:on-stored-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Start the scheduled re-pass (interval > 0). Calling more than once is
   *  a no-op; the timer never holds the process open after close. */
  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      void this.runPass();
    }, this.intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
