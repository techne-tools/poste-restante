import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";
import KindTag from "./KindTag";
import { snippet } from "./markdown";

interface Props {
  threadId: string;
  onError: (msg: string) => void;
  onBack: () => void;
  /** The whisper re-pulls when a thread is put away — shelving quiets
   *  the house's offers in the same breath. */
  onWhisperRefresh?: () => void;
}

/**
 * The correspondence — the pick-up target of a whisper. A thread is the
 * unit, not the message: letters oldest first, the way a correspondence
 * actually reads. Opening a gap whisper lands here, so the offer can be
 * picked up or ignored without leaving the house's own mailbox.
 *
 * Leaving as first-class: the structural stop. A resident may leave a
 * thread — the act IS a letter, the archive keeps the history, and the
 * leaver's edges dissolve. The left state renders calmly: "you have left
 * this correspondence" with a rejoin action. Symmetric by construction —
 * the move that protects you from someone protects them from you.
 *
 * Putting away as the shelf: a resident may put a thread away without
 * leaving it (migration 025) — the edges stand, the letters stay
 * readable, the mailbox and the whisper stop offering it. The shelved
 * state renders as its own quiet surface: "this correspondence is put
 * away" with a bring-back action. Gentler than leave: the shelf keeps
 * the correspondence in the archive; leave dissolves the edges.
 */
export default function ThreadView({ threadId, onError, onBack, onWhisperRefresh }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [participation, setParticipation] = useState<"in" | "out" | "shelved">("in");
  const [selected, setSelected] = useState<Letter | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await house.thread(threadId);
      setLetters(res.letters);
      setParticipation(res.participation ?? "in");
    } catch (err) {
      onError(err instanceof Error ? err.message : "the thread is quiet");
    } finally {
      setLoading(false);
    }
  }, [threadId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const leave = useCallback(async () => {
    setActing(true);
    try {
      await house.leaveThread(threadId);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not hold this leave");
    } finally {
      setActing(false);
    }
  }, [threadId, load, onError]);

  const rejoin = useCallback(async () => {
    setActing(true);
    try {
      await house.joinThread(threadId);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not hold this rejoin");
    } finally {
      setActing(false);
    }
  }, [threadId, load, onError]);

  const putAway = useCallback(async () => {
    setActing(true);
    try {
      await house.shelveThread(threadId);
      await load();
      // The house stopped offering the thread — the sidebar must stop
      // showing it in the same breath.
      onWhisperRefresh?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not put this away");
    } finally {
      setActing(false);
    }
  }, [threadId, load, onError, onWhisperRefresh]);

  const bringBack = useCallback(async () => {
    setActing(true);
    try {
      await house.unshelveThread(threadId);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not bring this back");
    } finally {
      setActing(false);
    }
  }, [threadId, load, onError]);

  // Scrub — the safety move (SPEC §19). Deletes every letter the caller
  // is party to in the thread, plus the thread, payloads, qdrant points,
  // and whispers pointing at it. Unilateral and immediate. The other
  // party's letters stay; the caller's view of the thread is gone.
  // Deliberately a two-step: the resident confirms before the house
  // forgets. The confirmation is quiet — no red, no alarm — the house
  // holds the boundary without dramatising it.
  const [confirmScrub, setConfirmScrub] = useState(false);
  const scrub = useCallback(async () => {
    setActing(true);
    try {
      await house.scrubThread(threadId);
      onBack();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not hold this scrub");
      setConfirmScrub(false);
    } finally {
      setActing(false);
    }
  }, [threadId, onError, onBack]);

  if (loading) return <p className="empty">Opening the correspondence…</p>;

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: "var(--space-3)" }}>
        ← Back
      </button>
      {selected ? (
        <LetterView letter={selected} onBack={() => setSelected(null)} />
      ) : (
        <div>
          <h2 className="thread-title">The correspondence</h2>
          {participation === "out" ? (
            <div className="thread-left">
              <p className="empty">You have left this correspondence.</p>
              <p className="book-hint">
                The archive keeps the history; you are no longer party to it. The house
                has stopped whispering about it. You may rejoin at any time — the
                historical edges stand again.
              </p>
              <button className="primary" onClick={rejoin} disabled={acting}>
                {acting ? "…" : "Rejoin this correspondence"}
              </button>
            </div>
          ) : participation === "shelved" ? (
            <div className="thread-left">
              <p className="empty">This correspondence is put away.</p>
              <p className="book-hint">
                You are still party to it — the edges stand, the letters stay in the archive.
                The mailbox and the whisper will not offer it until you bring it back.
              </p>
              <button className="primary" onClick={bringBack} disabled={acting}>
                {acting ? "…" : "Bring it back"}
              </button>
            </div>
          ) : (
            <>
              <div className="letter-list">
                {letters.length === 0 && <p className="empty">No letters in this thread.</p>}
                {letters.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    className="letter-row"
                    onClick={() => setSelected(l)}
                  >
                    <p className="subject">{l.envelope.subject || "(no subject)"}</p>
                    <div className="meta">
                      <KindTag kind={l.envelope.kind} />
                      <span>{l.envelope.from}</span>
                      <span>{new Date(l.receivedAt).toLocaleString("en-AU")}</span>
                      {l.time.frames.map((f) => (
                        <span key={`${f.frame}:${f.value}`} className="frame">
                          {f.frame}:{f.value}
                        </span>
                      ))}
                    </div>
                    <div className="snippet">{snippet(l.body.content)}</div>
                  </button>
                ))}
              </div>
              <div className="thread-actions">
                <button className="clause-act" onClick={putAway} disabled={acting}>
                  {acting ? "…" : "Put this correspondence away"}
                </button>
                <button className="clause-act" onClick={leave} disabled={acting}>
                  {acting ? "…" : "Leave this correspondence"}
                </button>
                {confirmScrub ? (
                  <span className="scrub-confirm">
                    <span className="scrub-question">Forget your part of this correspondence?</span>
                    <button className="clause-act" onClick={scrub} disabled={acting}>
                      {acting ? "…" : "Yes, forget it"}
                    </button>
                    <button className="door-link" onClick={() => setConfirmScrub(false)} disabled={acting}>
                      Keep it
                    </button>
                  </span>
                ) : (
                  <button className="door-link" onClick={() => setConfirmScrub(true)} disabled={acting}>
                    Scrub my part of this thread
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
