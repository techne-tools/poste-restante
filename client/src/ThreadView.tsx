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
 */
export default function ThreadView({ threadId, onError, onBack }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [participation, setParticipation] = useState<"in" | "out">("in");
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
                <button className="clause-act" onClick={leave} disabled={acting}>
                  {acting ? "…" : "Leave this correspondence"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
