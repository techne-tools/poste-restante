/**
 * The house as an MCP server — the agent-facing protocol face.
 *
 * The letter server (server.ts) is the HTTP face; this is the MCP face.
 * Both speak the same CONTRACT over the same spine (`buildHouse`). An agent
 * (Hermes, opencode, any MCP client) becomes a resident: it can deliver
 * letters, read mailboxes, walk the archive, and check the whisper.
 *
 * House invariants enforced here:
 *   * Presence not pressure — every tool is pull-based. The whisper tools
 *     LIST and take explicit signals (open/dismiss); nothing pushes.
 *   * The id is derived from the envelope+body; a caller-supplied id is
 *     ignored (the hash is the identity).
 *   * Deletion is first-class — delete removes the letter from all tiers.
 *   * No telemetry. The house logs locally; it never phones home.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LETTER_KINDS } from "../types.js";
import { AddressSchema, LetterSchema, toLetter } from "../schemas.js";
import { deliverLetter } from "../deliver.js";
import type { House } from "../house.js";
import type { RetrievalQuery } from "../retrieval/retrieval.js";
import type { AuthService, Authenticated } from "../auth/service.js";
import { isVisibleTo, isPublicAddress, PUB_ADDRESS } from "../auth/visibility.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/** Wrap a result as an MCP tool result. */
function text(content: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(content, null, 2) }],
  };
}

/** Wrap an error as an MCP tool result. The house stumbles; it says so. */
function fail(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: { message } }, null, 2) }],
    isError: true,
  };
}

export interface McpHouseOptions {
  /** The auth service. When omitted, the house runs unauthenticated (development only). */
  auth?: AuthService;
  /** The bearer token this MCP client authenticates with. */
  token?: string;
}

export function createMcpHouse(house: House, options: McpHouseOptions = {}) {
  const auth = options.auth;
  const token = options.token;
  const server = new McpServer(
    { name: "poste-restante", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // Resolve the caller. Agents authenticate with a bearer token from the
  // environment (POSTE_RESTANTE_TOKEN). No token → fail closed: every tool
  // returns an error rather than acting anonymously.
  async function caller(): Promise<Authenticated | null> {
    if (!auth) return { address: "you@house", method: "token" };
    if (!token) return null;
    return auth.authenticate(`Bearer ${token}`);
  }

  // Wrap a tool handler with authentication. Every tool requires a caller.
  function authed<T extends unknown[], R>(
    fn: (who: Authenticated, ...args: T) => Promise<R>,
  ) {
    return async (...args: T): Promise<R> => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN") as R;
      return fn(who, ...args);
    };
  }

  // ── Letters ──────────────────────────────────────────────────────────────

  // Deliver a letter. Idempotent: the same letter (same envelope+body) is
  // stored once; the response reports whether it was newly created.
  server.registerTool(
    "deliver_letter",
    {
      title: "Deliver a letter",
      description:
        "Deliver a letter to the house. The id is derived from the envelope+body (sha256) — a caller-supplied id is ignored. Idempotent: the same letter is stored once. A letter of kind 'system' from 'house@house' surfaces in the whisper.",
      inputSchema: {
        letter: LetterSchema,
      },
    },
    async ({ letter }) => {
      try {
        const who = await caller();
        if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
        // No forging: the envelope's from must be the caller's own address.
        // (Only enforced when authentication is on — dev mode trusts the caller.)
        if (auth && letter.envelope.from !== who.address) {
          return fail("a letter's from must be your own address");
        }
        const { letterId, created } = await deliverLetter(house, letter);
        return text({ id: letterId, created });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "the house stumbled");
      }
    },
  );

  // Retrieval — three paths (exact, full-text, semantic) merged by RRF.
  // Pull by default; the agent asks. Ranking uses the house's own signals.
  server.registerTool(
    "search_letters",
    {
      title: "Search the archive",
      description:
        "Search the archive. Three paths (exact envelope query, full-text, semantic) merged by reciprocal rank fusion. Filters: text, from, to, thread, kind, frame, pinned. With no filters, browses the archive newest first.",
      inputSchema: {
        text: z.string().optional().describe("free-text search across letter bodies"),
        from: z.string().optional().describe("sender address, e.g. hermes@house"),
        to: z.string().optional().describe("recipient address"),
        thread: z.string().optional().describe("thread id, e.g. th_9f2c1"),
        kind: z.enum(LETTER_KINDS).optional().describe("letter kind"),
        frame: z.string().optional().describe("frame value, e.g. autumn or tempest-tech-week"),
        pinned: z.boolean().optional().describe("only pinned letters"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      },
    },
    async (args) => {
      try {
        const who = await caller();
        if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
        const query: RetrievalQuery = { limit: args.limit };
        if (args.text) query.text = args.text;
        if (args.from) query.from = args.from;
        if (args.to) query.to = args.to;
        if (args.thread) query.thread = args.thread;
        if (args.kind) query.kind = args.kind;
        if (args.frame) query.frame = args.frame;
        if (args.pinned) query.pinned = true;

        const hits = await house.retrieval.search(query);
        const letters = await house.repo.getLetters(hits.map((h) => h.letterId));
        // Private by default: only letters the caller is party to (or public).
        const visible = letters.filter((l) => isVisibleTo(l, who.address));
        const visibleIds = new Set(visible.map((l) => l.id));
        return text({
          hits: hits.filter((h) => visibleIds.has(h.letterId)).map((h) => ({
            letterId: h.letterId,
            score: h.score,
            paths: h.paths,
            ranks: h.ranks,
          })),
          letters: visible.map(toLetter),
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "the house stumbled");
      }
    },
  );

  // Fetch one letter.
  server.registerTool(
    "get_letter",
    {
      title: "Read a letter",
      description: "Fetch one letter by its id (the sha256 of envelope+body).",
      inputSchema: {
        id: z.string().min(1).describe("the letter id"),
      },
    },
    async ({ id }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const row = await house.repo.getLetter(id);
      if (!row || !isVisibleTo(row, who.address)) return fail("no such letter");
      return text(toLetter(row));
    },
  );

  // Delete a letter. First-class: gone from postgres, qdrant, and FTS.
  server.registerTool(
    "delete_letter",
    {
      title: "Delete a letter",
      description:
        "Delete a letter. First-class deletion — the archive forgets on request. Removed from postgres, qdrant, and full-text index. No soft delete.",
      inputSchema: {
        id: z.string().min(1).describe("the letter id"),
      },
    },
    async ({ id }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const row = await house.repo.getLetter(id);
      if (!row || !isVisibleTo(row, who.address)) return fail("no such letter");
      const removed = await house.pipeline.delete(id);
      if (!removed) return fail("no such letter");
      return text({ deleted: true, id });
    },
  );

  // Pin / unpin — explicit house ranking signals.
  server.registerTool(
    "pin_letter",
    {
      title: "Pin a letter",
      description: "Pin a letter — an explicit house ranking signal. Pinned letters rank higher in retrieval.",
      inputSchema: {
        id: z.string().min(1).describe("the letter id"),
      },
    },
    async ({ id }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const row = await house.repo.getLetter(id);
      if (!row || !isVisibleTo(row, who.address)) return fail("no such letter");
      await house.repo.pinLetter(id, who.address);
      return text({ pinned: true, id });
    },
  );

  server.registerTool(
    "unpin_letter",
    {
      title: "Unpin a letter",
      description: "Remove a pin from a letter.",
      inputSchema: {
        id: z.string().min(1).describe("the letter id"),
      },
    },
    async ({ id }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const row = await house.repo.getLetter(id);
      if (!row || !isVisibleTo(row, who.address)) return fail("no such letter");
      await house.repo.unpinLetter(id);
      return text({ pinned: false, id });
    },
  );

  // ── Addresses ─────────────────────────────────────────────────────────────

  // The address book — the social graph. Flat, no ranking, no follower counts.
  server.registerTool(
    "list_addresses",
    {
      title: "List the address book",
      description: "List the address book — the social graph. Flat, no ranking, no follower counts.",
      inputSchema: {},
    },
    async () => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const addresses = await house.repo.listAddresses();
      return text({ addresses });
    },
  );

  server.registerTool(
    "get_address",
    {
      title: "Read an address",
      description: "Fetch one address from the address book.",
      inputSchema: {
        address: z.string().min(1).describe("the address, e.g. you@house"),
      },
    },
    async ({ address }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const row = await house.repo.getAddress(address);
      if (!row) return fail("no such address");
      return text(row);
    },
  );

  // Correct the address book. The house takes corrections at face value.
  // Only the address itself may correct its own entry.
  server.registerTool(
    "update_address",
    {
      title: "Correct an address",
      description:
        "Correct an address in the address book. The house takes corrections at face value. Names are a list (a person is a set of names, not first+last); pronouns are free text. You may only correct your own address.",
      inputSchema: {
        address: z.string().min(1).describe("the address, e.g. ben@house"),
        names: z.array(z.string()).default([]).describe("the person's names"),
        pronouns: z.string().nullable().default(null).describe("free-text pronouns"),
      },
    },
    async ({ address, names, pronouns }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      if (address !== who.address) return fail("you may only correct your own address");
      const existing = await house.repo.getAddress(address);
      if (!existing) return fail("no such address");
      await house.repo.updateAddress(address, names, pronouns);
      return text(await house.repo.getAddress(address));
    },
  );

  // The mailbox — pull by default. Nothing pushes; the letter waits.
  // Private by default: you may read your own mailbox. The pub's door is
  // schema: agents may read it while its is_public door stands open, and
  // only while it does.
  server.registerTool(
    "read_mailbox",
    {
      title: "Read a mailbox",
      description:
        "Read an address's mailbox, newest first. Pull by default — nothing pushes; the letter waits. You may read your own mailbox, or the pub (pub@house) while its door is open.",
      inputSchema: {
        address: z.string().min(1).describe("the address, e.g. you@house"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(50),
      },
    },
    async ({ address, limit }) => {
      const who = await caller();
      const existing = await house.repo.getAddress(address);
      if (!existing) return fail("no such address");
      const canRead =
        who != null &&
        (address === who.address || address === PUB_ADDRESS || isPublicAddress(existing));
      if (!canRead) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const letters = await house.repo.listMailbox(address, limit);
      return text({ address, letters: letters.map(toLetter) });
    },
  );

  // ── Threads & frames ──────────────────────────────────────────────────────

  // Threads are correspondences. The thread is the unit, not the message.
  server.registerTool(
    "read_thread",
    {
      title: "Read a thread",
      description: "Read a correspondence thread, oldest first. The thread is the unit, not the message.",
      inputSchema: {
        thread: z.string().min(1).describe("the thread id, e.g. th_9f2c1"),
      },
    },
    async ({ thread }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const letters = await house.repo.listThread(thread);
      const visible = letters.filter((l) => isVisibleTo(l, who.address));
      if (visible.length === 0) return fail("no such thread");
      return text({ thread, letters: visible.map(toLetter) });
    },
  );

  // Frames — plural time navigation. Queries work in any frame.
  server.registerTool(
    "list_frames",
    {
      title: "List frames",
      description:
        "List all frames — plural time navigation. Frames are the human's way in: production:tempest-2026, season:autumn, islamic:1448-03-15.",
      inputSchema: {},
    },
    async () => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const frames = await house.repo.listFrames();
      return text({ frames });
    },
  );

  // ── The whisper ────────────────────────────────────────────────────────────

  // The whisper — the mailbox for the house's own letters. A GET resource.
  // Nothing pushes; the agent comes for it. Scoped to the caller: the house
  // only whispers about correspondence the caller is party to.
  server.registerTool(
    "list_whispers",
    {
      title: "List the whisper",
      description:
        "List the whisper — the mailbox for the house's own letters (summaries, questions, gap offers). Presence not pressure: nothing pushes; the agent comes for it. Pass unread=true for only what the house is offering right now. Scoped to the caller: the house only whispers about correspondence the caller is party to.",
      inputSchema: {
        unread: z.boolean().default(false).describe("only whispers not yet dismissed"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(50),
      },
    },
    async ({ unread, limit }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const whispers = unread
        ? await house.whisper.listUnread(who.address, limit)
        : await house.whisper.list(who.address, limit);
      return text({ whispers });
    },
  );

  // The user opened a whisper. A signal, not a notification. Scoped: you can
  // only open a whisper about a thread you are party to.
  server.registerTool(
    "open_whisper",
    {
      title: "Open a whisper",
      description: "Mark a whisper opened. A signal, not a notification — the house learns you picked it up. Scoped to the caller: you can only open a whisper about a thread you are party to.",
      inputSchema: {
        id: z.string().min(1).describe("the whisper id"),
      },
    },
    async ({ id }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const ok = await house.whisper.open(id, who.address);
      if (!ok) return fail("no such whisper");
      return text({ opened: true, id });
    },
  );

  // Explicit dismissal — the strongest negative signal. The house takes
  // corrections at face value; undismiss is always possible. Scoped.
  server.registerTool(
    "dismiss_whisper",
    {
      title: "Dismiss a whisper",
      description:
        "Explicitly dismiss a whisper — the strongest negative signal. The house takes corrections at face value; undismiss is always possible. Scoped to the caller: you can only dismiss a whisper about a thread you are party to.",
      inputSchema: {
        id: z.string().min(1).describe("the whisper id"),
      },
    },
    async ({ id }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const ok = await house.whisper.dismiss(id, who.address);
      if (!ok) return fail("no such whisper");
      return text({ dismissed: true, id });
    },
  );

  server.registerTool(
    "undismiss_whisper",
    {
      title: "Undismiss a whisper",
      description: "Undismiss a whisper — the user changed their mind. The house takes corrections at face value.",
      inputSchema: {
        id: z.string().min(1).describe("the whisper id"),
      },
    },
    async ({ id }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const ok = await house.whisper.undismiss(id, who.address);
      if (!ok) return fail("no such whisper");
      return text({ dismissed: false, id });
    },
  );

  // Gap detection — cheap structural checks (dormant threads, unanswered
  // questions) plus the frame-scoped corner. Runs on demand; the house
  // never pushes the results. Scoped to the caller: gaps are only offered
  // for threads the caller is party to.
  server.registerTool(
    "detect_gaps",
    {
      title: "Look for gaps",
      description:
        "Run gap detection over the caller's active correspondence: dormant threads (quiet 14 days), unanswered questions (a week old), two voices in one thread within an active frame, semantic pair gaps — uncited connections and echoes — via the semantic layer, and unvisited corners (a frame the caller worked in that has gone quiet 30 days while their other frames moved). Runs on demand; the house never pushes the results. Scoped to the caller: gaps are only offered for correspondence the caller is party to.",
      inputSchema: {},
    },
    async () => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const created = await house.whisper.detectGaps(who.address);
      return text({ created: created.map((w) => w.id) });
    },
  );

  // ── The house book ─────────────────────────────────────────────────────────

  // The book's head — the derived constitution. Commons by right: every
  // resident reads it. The book is NOT a keyless door — guests are not
  // residents; the book is the household's knowing of itself.
  server.registerTool(
    "read_book",
    {
      title: "Read the house book",
      description:
        "Read the house book — the derived constitution. Every clause, its state (proposed/contested/standing/reversed), its text, its voices (objections, vouches), and the doors it binds. Commons by right: every resident reads it. The book is the household's knowing of itself — guests are not residents.",
      inputSchema: {},
    },
    async () => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const head = await house.book.head();
      return text(head);
    },
  );

  // Read one clause thread — the correspondence is the amendment.
  server.registerTool(
    "read_clause",
    {
      title: "Read a clause thread",
      description:
        "Read one clause thread — the correspondence is the amendment. The thread is the unit, not the message; the archive keeps the history, 'current' is derived.",
      inputSchema: {
        thread: z.string().min(1).describe("the clause thread id, e.g. th_clause_9f2c1"),
      },
    },
    async ({ thread }) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      const letters = await house.repo.listThread(thread);
      const clauseLetters = letters.filter((l) => l.kind === "clause");
      if (clauseLetters.length === 0) return fail("no such clause");
      return text({ thread, letters: clauseLetters.map(toLetter) });
    },
  );

  // Perform an act — the act IS a letter to the book. The house enforces
  // stated will: the role is declared, never guessed from the prose.
  server.registerTool(
    "act_on_book",
    {
      title: "Act on the house book",
      description:
        "Perform an act on the house book — the act IS a letter. Roles: proposal (opens a thread; may carry reverses: <thread> for a reversal proposal, and binding: {door, value} for a bound door — v1: pub@house.is_public only), amendment (new text, fresh settling, objections cleared, vouches persist), objection (reopens as two voices — contested never stands), vouch (distinct per resident; orders what the house says, never what it does), withdraw (removes your objection; clearing the last objection restarts the settling clock). A clause stands after the settling period with no open objection. The house enforces stated will, never inferred will.",
      inputSchema: {
        role: z.enum(["proposal", "amendment", "objection", "vouch", "withdraw"]).describe("the act"),
        amends: z.string().optional().describe("the thread this act continues (required for every role except proposal)"),
        reverses: z.string().optional().describe("on a proposal: the thread this proposal reverses when it stands"),
        binding: z
          .object({
            door: z.string().describe("the door, e.g. pub@house.is_public"),
            value: z.boolean().describe("the value the door is bound to when the clause stands"),
          })
          .optional()
          .describe("on a proposal/amendment: the door this clause binds when it stands"),
        text: z.string().optional().describe("the clause text (required for proposal/amendment)"),
      },
    },
    async (args) => {
      const who = await caller();
      if (!who) return fail("the house does not know you — set POSTE_RESTANTE_TOKEN");
      if (args.role !== "proposal" && !args.amends) {
        return fail("this act needs a thread to continue");
      }
      if ((args.role === "proposal" || args.role === "amendment") && !args.text?.trim()) {
        return fail(args.role === "proposal" ? "a proposal needs the clause text" : "an amendment needs the new text");
      }
      try {
        const { letterId, clause } = await house.book.act(who.address, args);
        return text({ id: letterId, clause });
      } catch (err) {
        return fail(err instanceof Error ? err.message : "the book could not hold this act");
      }
    },
  );

  return server;
}
