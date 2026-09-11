import { useCallback, useState } from "react";
import { house } from "./api";

/** Which correspondence move just landed — the caller re-renders its own
 *  surface: a thread reloads to derive the new participation, a mailbox
 *  closes the letter and re-reads the room. */
export type ThreadMove = "shelve" | "leave" | "scrub";

/**
 * The correspondence's moves — put away, leave, scrub — as one hook.
 * Shared by every surface where a resident reads letters: the thread
 * (list + letter), the mailbox, and the archive. Reading a letter is
 * exactly when the thought arrives — "time to put this aside", "I don't
 * want to do this any more", "this is not something I even want to have
 * happened" — so the moves travel with the letter, not with a view.
 *
 * The safety move is deliberately a two-step: the resident confirms
 * before the house forgets. The confirm is quiet — no red, no alarm —
 * the house holds the boundary without dramatising it.
 */
export function useThreadMoves(
  threadId: string | null,
  opts: {
    onError: (msg: string) => void;
    onWhisperRefresh?: () => void;
    onMutated?: (move: ThreadMove) => void;
  },
) {
  const [acting, setActing] = useState(false);
  const [confirmScrub, setConfirmScrub] = useState(false);

  const putAway = useCallback(async () => {
    if (!threadId) return;
    setActing(true);
    try {
      await house.shelveThread(threadId);
      // The house stopped offering the thread — the whisper must stop
      // showing it in the same breath.
      opts.onWhisperRefresh?.();
      opts.onMutated?.("shelve");
    } catch (err) {
      opts.onError(err instanceof Error ? err.message : "the house could not put this away");
    } finally {
      setActing(false);
    }
  }, [threadId, opts]);

  const leave = useCallback(async () => {
    if (!threadId) return;
    setActing(true);
    try {
      await house.leaveThread(threadId);
      opts.onMutated?.("leave");
    } catch (err) {
      opts.onError(err instanceof Error ? err.message : "the house could not hold this leave");
    } finally {
      setActing(false);
    }
  }, [threadId, opts]);

  const scrub = useCallback(async () => {
    if (!threadId) return;
    setActing(true);
    try {
      await house.scrubThread(threadId);
      opts.onMutated?.("scrub");
    } catch (err) {
      opts.onError(err instanceof Error ? err.message : "the house could not hold this scrub");
      setConfirmScrub(false);
    } finally {
      setActing(false);
    }
  }, [threadId, opts]);

  // The safety move — a bordered button like its neighbours, but the seal
  // keeps its own colour: text and border use the accent. The move reads
  // as the household's boundary, held without drama — never the pink of a
  // system warning. The confirm keeps the same treatment, held in place
  // by the neutral "Keep it" escape.
  const scrubControl = confirmScrub ? (
    <span className="scrub-confirm">
      <span className="scrub-question">Forget your part of this correspondence?</span>
      <button className="scrub-act" onClick={scrub} disabled={acting}>
        {acting ? "…" : "Yes, forget it"}
      </button>
      <button className="door-link" onClick={() => setConfirmScrub(false)} disabled={acting}>
        Keep it
      </button>
    </span>
  ) : (
    <button className="scrub-act" onClick={() => setConfirmScrub(true)} disabled={acting}>
      Scrub my part of this thread
    </button>
  );

  return { acting, putAway, leave, scrubControl };
}

/** The correspondence's action row — put away, leave, scrub. One block,
 *  used wherever a resident reads letters: the thread list, the letter
 *  inside a thread, and letters opened from the mailbox or the archive.
 *  The same moves are on hand whether the resident is scanning a
 *  correspondence or reading a single letter. */
export function ThreadActionRow({
  moves,
}: {
  moves: ReturnType<typeof useThreadMoves>;
}) {
  return (
    <div className="thread-actions">
      <button className="clause-act" onClick={moves.putAway} disabled={moves.acting}>
        {moves.acting ? "…" : "Put this correspondence away"}
      </button>
      <button className="clause-act" onClick={moves.leave} disabled={moves.acting}>
        {moves.acting ? "…" : "Leave this correspondence"}
      </button>
      {moves.scrubControl}
    </div>
  );
}
