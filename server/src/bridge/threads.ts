/**
 * Thread resolution for the SMTP door (SPEC §5 #10).
 *
 * When inbound mail has no X-House-Thread header and its subject doesn't
 * match a known correspondence, it would start a brand-new thread —
 * which is wrong for a reply like "re: the storm cue". This is the house's
 * memory: a deterministic subject-match against the recipient's recent
 * correspondence, scoped to the recipient (the thread the sender is
 * actually continuing). Absence is silence: no match → null → the bridge
 * falls back to its deterministic new thread.
 */
export function findThreadBySubject(
  pool: { query<T extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }> },
  to: string,
  normalizedSubject: string,
): Promise<string | null> {
  if (!normalizedSubject) return Promise.resolve(null);
  return pool
    .query<{ thread_id: string }>(
      `SELECT l.thread_id
       FROM letters l
       JOIN letter_addresses la ON la.letter_id = l.id
       WHERE la.address_id = $1
         AND l.received_at > now() - interval '90 days'
         AND (
           lower(l.subject) = $2
           OR lower(l.subject) LIKE $3
         )
       ORDER BY l.received_at DESC
       LIMIT 1`,
      [to, normalizedSubject, `${normalizedSubject} %`],
    )
    .then((res) => res.rows[0]?.thread_id ?? null);
}
