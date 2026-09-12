import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";
import LetterRow from "./LetterRow";
import { ThreadActionRow, useThreadMoves } from "./ThreadActions";

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
/**
 * The put-away and left surfaces — the states where the correspondence is held
 * but no longer offered. The safety move (scrub) stays available in both; the
 * put-away surface keeps `Leave` beside it. Exported so the action set can be
 * unit-tested without the live house.
 */
export function ThreadStateSurface({
  state,
  acting,
  scrubControl,
  onLeave,
  onRejoin,
  onBringBack,
}: {
  state: "out" | "shelved";
  acting: boolean;
  scrubControl: ReactNode;
  onLeave: () => void;
  onRejoin: () => void;
  onBringBack: () => void;
}) {
  if (state === "out") {
    return (
      <>
        <div className="thread-state">
          <p className="state-line">You have left this correspondence.</p>
          <p className="state-hint">
            The archive keeps the history; you are no longer party to it. The house
            has stopped whispering about it. You may rejoin at any time — the
            historical edges stand again.
          </p>
          <button className="primary" onClick={onRejoin} disabled={acting}>
            {acting ? "…" : "Rejoin this correspondence"}
          </button>
        </div>
        <div className="thread-actions">{scrubControl}</div>
      </>
    );
  }

  return (
    <>
      <div className="thread-state">
        <p className="state-line">This correspondence is put away.</p>
        <p className="state-hint">
          You are still party to it — the edges stand, the letters stay in the archive.
          The mailbox and the whisper will not offer it until you bring it back.
        </p>
        <button className="primary" onClick={onBringBack} disabled={acting}>
          {acting ? "…" : "Bring it back"}
        </button>
      </div>
      <div className="thread-actions">
        <button className="clause-act" onClick={onLeave} disabled={acting}>
          {acting ? "…" : "Leave this correspondence"}
        </button>
        {scrubControl}
      </div>
    </>
  );
}

export default function ThreadView({ threadId, onError, onBack, onWhisperRefresh }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [participation, setParticipation] = useState<"in" | "out" | "shelved">("in");
  const [selected, setSelected] = useState<Letter | null>(null);
  const [loading, setLoading] = useState(true);

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

  // The correspondence's moves — shared with the mailbox and the archive so
  // every surface where a resident reads letters carries the same row.
  // After a move the participation is re-derived from the letters; a scrub
  // leaves the correspondence entirely (the caller's onBack).
  const moves = useThreadMoves(threadId, {
    onError,
    onWhisperRefresh,
    onMutated: (move) => {
      if (move === "scrub") onBack();
      else void load();
    },
  });

  const [surfaceActing, setSurfaceActing] = useState(false);

  const rejoin = useCallback(async () => {
    setSurfaceActing(true);
    try {
      await house.joinThread(threadId);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not hold this rejoin");
    } finally {
      setSurfaceActing(false);
    }
  }, [threadId, load, onError]);

  const bringBack = useCallback(async () => {
    setSurfaceActing(true);
    try {
      await house.unshelveThread(threadId);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not bring this back");
    } finally {
      setSurfaceActing(false);
    }
  }, [threadId, load, onError]);

  if (loading) return <p className="empty">Opening the correspondence…</p>;

  return (
    <div>
      {/* One back button, one layer: from the correspondence list it returns
          to the room it was opened from. When a letter is open, the letter's
          own back returns here — the thread button never stacks on top of it. */}
      {!selected && (
        <button className="back" onClick={onBack}>
          ← Back
        </button>
      )}
      {selected ? (
        <LetterView
          letter={selected}
          onBack={() => setSelected(null)}
          actions={<ThreadActionRow moves={moves} />}
        />
      ) : (
        <div>
          <h2 className="thread-title">The correspondence</h2>
          {participation === "out" ? (
            <ThreadStateSurface
              state="out"
              acting={surfaceActing}
              scrubControl={moves.scrubControl}
              onLeave={moves.leave}
              onRejoin={rejoin}
              onBringBack={bringBack}
            />
          ) : participation === "shelved" ? (
            <ThreadStateSurface
              state="shelved"
              acting={surfaceActing}
              scrubControl={moves.scrubControl}
              onLeave={moves.leave}
              onRejoin={rejoin}
              onBringBack={bringBack}
            />
          ) : (
            <>
              <div className="letter-list">
                {letters.length === 0 && <p className="empty">No letters in this thread.</p>}
                {letters.map((l) => (
                  <LetterRow key={l.id} letter={l} onClick={() => setSelected(l)} />
                ))}
              </div>
              <ThreadActionRow moves={moves} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
