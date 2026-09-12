import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { BookHead, ClauseRole } from "./api";
import { renderMarkdown } from "./markdown";
import { doorName, STATE_LABEL, daysUntil, clauseClass } from "./bookUtils";
import ClauseDevelop from "./ClauseDevelop";
import WhyNote from "./WhyNote";

interface Props {
  onError: (msg: string) => void;
  /** A clause to open on mount — the resident followed a citation from
   *  the whisper: "the household has held this; want to look?" */
  initialClause?: string | null;
  /** The community's name for the room — GET /v1/house/meta. */
  name?: string;
}

export default function Book({ onError, initialClause, name }: Props) {
  const [head, setHead] = useState<BookHead | null>(null);
  const [loading, setLoading] = useState(true);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [threadLetters, setThreadLetters] = useState<{ id: string; from: string; body: string; receivedAt: string }[] | null>(null);
  const [proposing, setProposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftBinding, setDraftBinding] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  /** The thread being developed — the inline draft that continues the
   *  correspondence with new text (fresh settling, stops cleared,
   *  supports persist). */
  const [developing, setDeveloping] = useState<string | null>(null);
  const [developDraft, setDevelopDraft] = useState("");

  const refresh = useCallback(async () => {
    try {
      setHead(await house.book());
    } catch (err) {
      onError(err instanceof Error ? err.message : "the book is closed");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A citation lands with the clause open — the household's knowing of
  // itself, held in view. The clause thread is fetched once the head is
  // loaded (the thread id is only known from the head).
  useEffect(() => {
    if (!initialClause || !head) return;
    const clause = head.clauses.find((c) => c.thread === initialClause);
    if (!clause) return;
    setOpenThread(initialClause);
    setThreadLetters(null);
    house
      .clauseThread(initialClause)
      .then((res) =>
        setThreadLetters(
          res.letters.map((l) => ({
            id: l.id,
            from: l.envelope.from,
            body: l.body.content,
            receivedAt: l.receivedAt,
          })),
        ),
      )
      .catch((err) => onError(err instanceof Error ? err.message : "the clause could not be read"));
  }, [initialClause, head, onError]);

  const act = useCallback(
    async (role: ClauseRole, thread: string, text?: string, binding?: { door: string; value: boolean }) => {
      setActing(thread);
      try {
        await house.actOnBook({ role, continues: thread, text, binding });
        await refresh();
      } catch (err) {
        onError(err instanceof Error ? err.message : "the book could not hold this act");
      } finally {
        setActing(null);
      }
    },
    [refresh, onError],
  );

  const propose = useCallback(async () => {
    if (!draft.trim()) return;
    setProposing(true);
    try {
      await house.actOnBook({
        role: "offer",
        text: draft,
        binding: draftBinding ? { door: "pub@house.is_public", value: false } : undefined,
      });
      setDraft("");
      setDraftBinding(false);
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the book could not hold this offer");
    } finally {
      setProposing(false);
    }
  }, [draft, draftBinding, refresh, onError]);

  const openClause = useCallback(
    async (thread: string) => {
      if (openThread === thread) {
        setOpenThread(null);
        setThreadLetters(null);
        return;
      }
      setOpenThread(thread);
      setThreadLetters(null);
      try {
        const res = await house.clauseThread(thread);
        setThreadLetters(
          res.letters.map((l) => ({
            id: l.id,
            from: l.envelope.from,
            body: l.body.content,
            receivedAt: l.receivedAt,
          })),
        );
      } catch (err) {
        onError(err instanceof Error ? err.message : "the clause could not be read");
      }
    },
    [openThread, onError],
  );

  /** Open the develop draft pre-filled with the clause's current text —
   *  a develop continues the correspondence with new wording. */
  const startDevelop = useCallback((thread: string, text: string) => {
    setThreadLetters(null);
    setOpenThread(thread);
    setDevelopDraft(text);
    setDeveloping(thread);
  }, []);

  const develop = useCallback(async () => {
    if (!developing || !developDraft.trim()) return;
    setActing(developing);
    try {
      await house.actOnBook({ role: "develop", continues: developing, text: developDraft });
      setDeveloping(null);
      setDevelopDraft("");
      await refresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the book could not hold this develop");
    } finally {
      setActing(null);
    }
  }, [developing, developDraft, refresh, onError]);

  if (loading) return <p className="empty">Opening the book…</p>;
  if (!head) return <p className="empty">The book is closed.</p>;

  const standing = head.clauses.filter((c) => c.state === "standing");
  const proposed = head.clauses.filter((c) => c.state === "proposed" || c.state === "contested");
  const reversed = head.clauses.filter((c) => c.state === "reversed");

  return (
    <div className="book">
      <div className="ledger">
        <h2>{name ?? "the book"}</h2>
        <span className="address">book@house</span>
      </div>

      {head.doors.length > 0 && (
        <div className="book-doors">
          {head.doors.map((d) => (
            <p key={d.door} className="book-door">
              <span className="door-state">{d.value ? "open" : "closed"}</span> — {doorName(d.door)}, bound by the household
            </p>
          ))}
        </div>
      )}

      {standing.length > 0 && (
        <section className="book-section">
          <h3>What the household holds</h3>
          {standing.map((c) => (
            <article key={c.thread} className={clauseClass(c.state)}>
              <div className="clause-head">
                <span className="clause-state">{STATE_LABEL[c.state]}</span>
                {c.binding && (
                  <span className="clause-binding">
                    binds {doorName(c.binding.door)} {c.binding.value ? "open" : "closed"}
                  </span>
                )}
                {c.reversesThread && <span className="clause-binding">reverses a standing clause</span>}
              </div>
              <div className="clause-text">{renderMarkdown(c.text)}</div>
              <div className="clause-meta">
                <span>offered by {c.proposedBy}</span>
                {c.vouches > 0 && <span>{c.vouches} support{c.vouches === 1 ? "" : "s"}</span>}
                {c.objections > 0 && <span>{c.objections} stop{c.objections === 1 ? "" : "s"}</span>}
              </div>
              <div className="clause-actions">
                <button
                  className="clause-act"
                  disabled={acting === c.thread}
                  onClick={() => startDevelop(c.thread, c.text)}
                >
                  develop
                </button>
                <button
                  className={`clause-toggle${openThread === c.thread ? " active" : ""}`}
                  onClick={() => openClause(c.thread)}
                >
                  {openThread === c.thread ? "close the correspondence" : "the correspondence"}
                </button>
              </div>
              {developing === c.thread && (
                <ClauseDevelop
                  draft={developDraft}
                  acting={acting === c.thread}
                  onDraftChange={setDevelopDraft}
                  onDevelop={develop}
                  onCancel={() => setDeveloping(null)}
                />
              )}
              {openThread === c.thread && threadLetters && (
                <div className="clause-thread">
                  {threadLetters.map((l) => (
                    <div key={l.id} className="clause-letter">
                      <div className="clause-letter-meta">
                        <span>{l.from}</span>
                        <span>{new Date(l.receivedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="clause-letter-body">{renderMarkdown(l.body)}</div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {proposed.length > 0 && (
        <section className="book-section">
          <h3>Before the household</h3>
          {proposed.map((c) => (
            <article key={c.thread} className={clauseClass(c.state)}>
              <div className="clause-head">
                <span className="clause-state">{STATE_LABEL[c.state]}</span>
                {c.pendingReversal && <span className="clause-binding">a reversal</span>}
                {c.binding && (
                  <span className="clause-binding">
                    would bind {doorName(c.binding.door)} {c.binding.value ? "open" : "closed"}
                  </span>
                )}
              </div>
              <div className="clause-text">{renderMarkdown(c.text)}</div>
              <div className="clause-meta">
                <span>offered by {c.proposedBy}</span>
                <span>
                  {c.state === "contested"
                    ? "held in dissent"
                    : `settles in ${daysUntil(c.settlesAt)} day${daysUntil(c.settlesAt) === 1 ? "" : "s"}`}
                </span>
                {c.vouches > 0 && <span>{c.vouches} support{c.vouches === 1 ? "" : "s"}</span>}
                {c.objections > 0 && <span>{c.objections} stop{c.objections === 1 ? "" : "s"}</span>}
              </div>
              <div className="clause-actions">
                <button
                  className="clause-act"
                  disabled={acting === c.thread}
                  onClick={() => act("support", c.thread)}
                >
                  {acting === c.thread ? "…" : "support"}
                </button>
                <button
                  className="clause-act"
                  disabled={acting === c.thread}
                  onClick={() => act("stop", c.thread)}
                >
                  {acting === c.thread ? "…" : "stop"}
                </button>
                {c.objections > 0 && (
                  <button
                    className="clause-act"
                    disabled={acting === c.thread}
                    onClick={() => act("set aside", c.thread)}
                  >
                    {acting === c.thread ? "…" : "set aside"}
                  </button>
                )}
                <button
                  className="clause-act"
                  disabled={acting === c.thread}
                  onClick={() => startDevelop(c.thread, c.text)}
                >
                  develop
                </button>
                <button
                  className={`clause-toggle${openThread === c.thread ? " active" : ""}`}
                  onClick={() => openClause(c.thread)}
                >
                  {openThread === c.thread ? "close the correspondence" : "the correspondence"}
                </button>
              </div>
              <WhyNote summary="how the household decides">
                The book is a thread, not a table — every act is a letter to
                the household, and the archive keeps the history. Support
                says there is no objection; stop is a safe word that holds
                the clause contested; develop rewrites it and starts the
                clock again. Nothing stands until it has been held, quiet,
                for the settling days — the commons is derived, never
                declared (no one is master; everyone can be inscribed).
              </WhyNote>
              {developing === c.thread && (
                <ClauseDevelop
                  draft={developDraft}
                  acting={acting === c.thread}
                  onDraftChange={setDevelopDraft}
                  onDevelop={develop}
                  onCancel={() => setDeveloping(null)}
                />
              )}
              {openThread === c.thread && threadLetters && (
                <div className="clause-thread">
                  {threadLetters.map((l) => (
                    <div key={l.id} className="clause-letter">
                      <div className="clause-letter-meta">
                        <span>{l.from}</span>
                        <span>{new Date(l.receivedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="clause-letter-body">{renderMarkdown(l.body)}</div>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {reversed.length > 0 && (
        <section className="book-section">
          <h3>Held, then reversed</h3>
          {reversed.map((c) => (
            <article key={c.thread} className="clause clause-reversed">
              <div className="clause-head">
                <span className="clause-state">{STATE_LABEL[c.state]}</span>
              </div>
              <div className="clause-text">{renderMarkdown(c.text)}</div>
              <div className="clause-meta">
                <span>offered by {c.proposedBy}</span>
                <span>reversed {c.reversedAt ? new Date(c.reversedAt).toLocaleDateString() : ""}</span>
              </div>
            </article>
          ))}
        </section>
      )}

      {head.clauses.length === 0 && (
        <p className="empty">The book is empty — the household has not yet written its norms.</p>
      )}

      <section className="book-section book-propose">
        <h3>Offer a norm</h3>
        <p className="book-hint">
          An offer is a letter to the book. It stands after {head.settlingDays} days with no
          stop — slow by construction, reversible by develop. No and yes are equally significant:
          anyone may stop it, and a stop holds the norm in dissent until it is set aside.
        </p>
        <textarea
          className="book-draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="the norm, in the household's own words…"
          rows={4}
        />
        <label className="book-binding-toggle">
          <input
            type="checkbox"
            checked={draftBinding}
            onChange={(e) => setDraftBinding(e.target.checked)}
          />
          <span>bind the pub's door closed when this stands</span>
        </label>
        <div className="book-propose-actions">
          {/* A gated act — the offer needs the norm drafted before it can
              go; quiet at the same weight as every other button, the
              sheet's fill once the draft makes it able (the same rule as
              the handle). The strongest act in the house is still just a
              letter — it needs no ink of its own. */}
          <button className="gated" onClick={propose} disabled={proposing || !draft.trim()}>
            {proposing ? "Writing…" : "Offer to the book"}
          </button>
        </div>
      </section>
    </div>
  );
}
