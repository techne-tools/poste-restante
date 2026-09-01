/**
 * Pub logic — pure functions for the house's public room (SPEC §2.4:
 * "slow-social, thread-based conversation"). Grouping is the whole point:
 * the pub reads like a channel — familiar shape — but the unit is still
 * the thread, the correspondence (governing inversion: familiar shape,
 * opposite operation).
 */
import type { Letter } from "./api";

export interface PubConversation {
  thread: string;
  title: string;
  letters: Letter[];
  /** The latest letter's receivedAt — the conversation's pulse. */
  lastAt: string;
}

/**
 * Group pub letters into conversations: most recently active first, each
 * conversation oldest-first (the way correspondence reads). A
 * conversation's title is its latest letter's subject — the serif voice
 * names it by its most recent word, never by a machine id. No counts, no
 * badges: the pub holds each whole thread; the resident reads at leisure.
 */
export function groupConversations(letters: Letter[]): PubConversation[] {
  const byThread = new Map<string, Letter[]>();
  for (const l of letters) {
    const list = byThread.get(l.envelope.thread) ?? [];
    list.push(l);
    byThread.set(l.envelope.thread, list);
  }
  return [...byThread.entries()]
    .map(([thread, threadLetters]) => {
      const sorted = [...threadLetters].sort(
        (a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime(),
      );
      const last = sorted[sorted.length - 1]!;
      return {
        thread,
        title: last.envelope.subject?.trim() || "(no subject)",
        letters: sorted,
        lastAt: last.receivedAt,
      };
    })
    .sort(
      (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime(),
    );
}
