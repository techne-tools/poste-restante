import { BASE } from "./client";
import { request, loadAuth } from "./client";
import type * as Types from "./types";
export const house = {
  /** Deliver a letter. Idempotent. */
  deliver(letter: Omit<Types.Letter, "id" | "receivedAt" | "pinnedAt" | "pinnedBy">) {
    return request<{ id: string; created: boolean }>("/letters", {
      method: "POST",
      body: JSON.stringify(letter),
    });
  },

  /** Search — exact + FTS + semantic, merged by RRF. */
  search(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return request<Types.SearchResponse>(`/letters${qs ? `?${qs}` : ""}`);
  },

  /** Delete a letter — first-class, no soft delete. */
  deleteLetter(id: string) {
    return request<{ deleted: boolean; id: string }>(`/letters/${id}`, {
      method: "DELETE",
    });
  },

  /** The payload catalog — what a letter carries beyond its body. */
  payloads(letterId: string) {
    return request<{ letterId: string; payloads: Types.PayloadMeta[] }>(
      `/letters/${encodeURIComponent(letterId)}/payloads`,
    );
  },

  /** Upload a raw payload — an enclosure for a letter already delivered.
   *  The bytes travel raw (no JSON wrapping); the name and content type
   *  ride in headers so the house can catalogue them (migration 016). */
  uploadPayload(letterId: string, file: Blob, name: string) {
    return request<{ letterId: string; key: string; name: string; size: number }>(
      `/letters/${encodeURIComponent(letterId)}/payloads`,
      {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Payload-Name": name,
        },
        body: file,
      },
    );
  },

  /** Fetch an enclosure's bytes as a blob, with the house's auth on the
   *  request. Plain <img>/<audio> tags cannot carry the Authorization
   *  header from storage, so the client fetches once and hands the renderer
   *  an object URL (revoked by the caller after the element unmounts). */
  async payloadBlob(letterId: string, name: string): Promise<Blob> {
    const auth = loadAuth();
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = auth.header;
    const res = await fetch(
      `${BASE}/letters/${encodeURIComponent(letterId)}/payloads/${encodeURIComponent(name)}`,
      { headers },
    );
    if (!res.ok) {
      throw new Error(`the house could not open ${name}`);
    }
    return res.blob();
  },

  /** Delete an enclosure — the bytes and the catalog row. */
  deletePayload(letterId: string, name: string) {
    return request<{ deleted: boolean; key: string }>(
      `/letters/${encodeURIComponent(letterId)}/payloads/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  },

  /** The address book — flat, no ranking. */
  addresses() {
    return request<{ addresses: Types.Address[] }>("/addresses");
  },

  /** One address — the resident's own record, by handle. */
  address(id: string) {
    return request<Types.Address & { is_public: boolean }>(`/addresses/${encodeURIComponent(id)}`);
  },

  /** Correct the address book. The house takes corrections at face value.
   *  Only the address itself may correct its own entry. `sealDefault`
   *  sets the desk's default — absent leaves it unchanged. */
  correctAddress(id: string, names: string[], pronouns: string | null, sealDefault?: boolean) {
    return request<Types.Address & { is_public: boolean }>(`/addresses/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ names, pronouns, sealDefault }),
    });
  },

  /** Register the public halves of a resident's keypairs (SPEC §15). The
   *  private halves are client-held — the house never holds a private
   *  key. Public keys are public; from this moment the ed25519
   *  fingerprint is the identity the letter id resolver uses. */
  registerKeys(
    id: string,
    keys: { ageRecipient: string; ed25519Public: string; recoveryAgeRecipient?: string | null },
  ) {
    return request<{
      address?: string;
      age_recipient: string;
      ed25519_public: string;
      recovery_age_recipient: string | null;
    }>(`/addresses/${encodeURIComponent(id)}/keys`, {
      method: "POST",
      body: JSON.stringify(keys),
    });
  },

  /** Relabel — the handle is a label, the identity is the key (SPEC §19). */
  relabel(id: string, handle: string) {
    return request<{ relabeled: boolean; from: string; to: string }>(
      `/addresses/${encodeURIComponent(id)}/relabel`,
      { method: "POST", body: JSON.stringify({ handle }) },
    );
  },

  /** Change the password — the resident's own door. The house never
   *  resets anyone; it only changes when the caller proves possession of
   *  the current credential. A wrong current answers 401 — the door's
   *  silence. The saved session dies (the stored Basic header is built
   *  from the old secret); the resident signs in again under the new
   *  one. */
  changePassword(id: string, current: string, next: string) {
    return request<{ changed: boolean; address: string }>(
      `/addresses/${encodeURIComponent(id)}/password`,
      { method: "POST", body: JSON.stringify({ current, next }) },
    );
  },

  /** The house's own words — the serif voice's names for the rooms. */
  houseMeta() {
    return request<Types.HouseMeta>("/house/meta");
  },

  /** Read the mailbox — pull by default. */
  inbox(address: string, limit = 50) {
    return request<{ address: string; letters: Types.Letter[] }>(
      `/addresses/${encodeURIComponent(address)}/inbox?limit=${limit}`,
    );
  },

  /** What the house holds about you (SPEC §19) — every letter the caller
   *  is party to, including what is on the shelf (a letter put away is
   *  still held by the house). Newest first. Self-only: this is
   *  self-regard, not administration. */
  review(address: string) {
    return request<{ address: string; letters: Types.Letter[] }>(
      `/addresses/${encodeURIComponent(address)}/review`,
    );
  },

  /** Threads are correspondences. The thread is the unit, not the message.
   *  `participation` is the caller's derived state — 'in' by default; 'out'
   *  when the caller has left (leaving as first-class, the structural stop);
   *  'shelved' when the caller has put it away (the shelf, migration 025 —
   *  the edges stand, but the mailbox and the whisper stop offering it). */
  thread(id: string) {
    return request<{
      thread: string;
      participation: "in" | "out" | "shelved";
      letters: Types.Letter[];
    }>(`/threads/${encodeURIComponent(id)}`);
  },

  /** Leave a thread — the structural stop. The act IS a letter; the archive
   *  keeps the history; participation is derived. The leaver's edges
   *  dissolve — visibility prunes itself. Symmetric by construction. */
  leaveThread(id: string) {
    return request<{ id: string; thread: string; participation: "in" | "out" }>(
      `/threads/${encodeURIComponent(id)}/leave`,
      { method: "POST" },
    );
  },

  /** Rejoin a thread — the historical edges stand again. */
  joinThread(id: string) {
    return request<{ id: string; thread: string; participation: "in" | "out" | "shelved" }>(
      `/threads/${encodeURIComponent(id)}/join`,
      { method: "POST" },
    );
  },

  /** Put a thread away — the resident's own shelf. The edges stand, the
   *  thread stays readable; the mailbox and the whisper stop offering it.
   *  Bring it back with unshelveThread. */
  shelveThread(id: string) {
    return request<{ id: string; thread: string; participation: "out" | "shelved" }>(
      `/threads/${encodeURIComponent(id)}/shelve`,
      { method: "POST" },
    );
  },

  /** Bring a thread back from the shelf — the edges stood the whole time. */
  unshelveThread(id: string) {
    return request<{ id: string; thread: string; participation: "in" | "shelved" }>(
      `/threads/${encodeURIComponent(id)}/unshelve`,
      { method: "POST" },
    );
  },

  /** Scrub a thread — the safety move (SPEC §19). Deletes every letter the
   *  caller is party to in the thread, plus the thread, payloads, qdrant
   *  points, and whispers pointing at it. Unilateral and immediate. The
   *  other party's letters stay; the caller's view of the thread is gone. */
  scrubThread(id: string) {
    return request<{ scrubbed: boolean; thread: string; deleted: number }>(
      `/threads/${encodeURIComponent(id)}/scrub`,
      { method: "POST" },
    );
  },

  /** Frames — plural time navigation. */
  frames() {
    return request<{ frames: { id: string; name: string; value: string }[] }>("/frames");
  },

  /** The day — the callsheet whiteboard (SPEC §18). A thin derived view:
   *  letters in the resident's visible frames, their instruments alive in
   *  those frames, the whisper's current offers, the book's standing
   *  clauses. Derived, never stored. The board shows only what the
   *  resident is party to. Presence not pressure. */
  day() {
    return request<Types.DayProjection>("/day");
  },

  /** Put a single item on the day — a card, not a letter, not a thread.
   *  Scope: 'house' (every resident), 'group' (a thread's participants),
   *  or 'address' (one address). The pub is never a valid recipient. */
  createDayCard(input: { text: string; scope: "house" | "group" | "address"; scopeValue?: string; frame?: string }) {
    return request<{ id: string; created: boolean }>("/day/cards", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  /** Remove a card — the creator only. */
  deleteDayCard(id: string) {
    return request<{ deleted: boolean; id: string }>(`/day/cards/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  /** The whisper — the house's own letters. Pull-only. */
  whisper(unread = false) {
    return request<{ whispers: Types.Whisper[] }>(`/whisper${unread ? "?unread=1" : ""}`);
  },

  openWhisper(id: string) {
    return request<{ opened: boolean; id: string }>(`/whisper/${id}/open`, {
      method: "POST",
    });
  },

  dismissWhisper(id: string) {
    return request<{ dismissed: boolean; id: string }>(`/whisper/${id}/dismiss`, {
      method: "POST",
    });
  },

  undismissWhisper(id: string) {
    return request<{ dismissed: boolean; id: string }>(`/whisper/${id}/undismiss`, {
      method: "POST",
    });
  },

  /** Gap detection — cheap structural checks, on demand. */
  detectGaps() {
    return request<{ created: string[] }>("/whisper/gaps", { method: "POST" });
  },

  /** The house book — the derived constitution. Commons by right. */
  book() {
    return request<Types.BookHead>("/book");
  },

  /** Read one clause thread — the correspondence is the develop. */
  clauseThread(thread: string) {
    return request<{ thread: string; letters: Types.Letter[] }>(
      `/book/threads/${encodeURIComponent(thread)}`,
    );
  },

  /** Perform an act on the book — the act IS a letter. */
  actOnBook(action: {
    role: Types.ClauseRole;
    continues?: string;
    reverses?: string;
    binding?: { door: string; value: boolean };
    text?: string;
  }) {
    return request<{ id: string; clause: Types.Clause }>("/book", {
      method: "POST",
      body: JSON.stringify(action),
    });
  },

  /** Start the OIDC dance. Returns the provider URL to redirect to. */
  oidcStart() {
    return request<{ url: string; state: string }>("/auth/oidc/start");
  },

  /**
   * Redeem an invitation — the guest's door. Public like OIDC: the caller
   * has no credential yet, so the Authorization header (if any) is never
   * attached — the guest redeems as themselves, not as a stale resident.
   * Proves possession of the invite letter and the one-time code; the house
   * answers 201 {address, joined} or, on every negative path (wrong code,
   * spent, expired, wrong address), the same 404 — absence is silence.
   */
  async redeemInvite(input: {
    address: string;
    code: string;
    password: string;
  }): Promise<{ address: string; joined: boolean }> {
    const res = await fetch(`${BASE}/invites/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error("the house has no invitation for you — check the code and address");
    }
    return res.json() as Promise<{ address: string; joined: boolean }>;
  },

  /**
   * Construct an invitation — the resident's own door opening (SPEC §5.7).
   * The guest address is their future handle; the house writes the invite
   * letter and returns the one-time code — SHOWN ONCE, never stored. The
   * resident gives the code to the guest out of band; the house never
   * pushes.
   */
  createInvite(address: string) {
    return request<{ address: string; createdBy: string; code: string; letterId: string }>(
      "/invites",
      { method: "POST", body: JSON.stringify({ address }) },
    );
  },
};
