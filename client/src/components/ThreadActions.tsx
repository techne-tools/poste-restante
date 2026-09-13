import { useCallback, useState } from "react";
import { house } from "../api";

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
  // One move at a time — the row holds the single move in flight, never
  // all three. The busy state names the move so the row can show "…"
  // only on the button that is actually acting (the confirm flash of a
  // row of "…" buttons comes from a shared acting flag).
  const [acting, setActing] = useState<ThreadMove | null>(null);

  const run = useCallback(
    async (move: ThreadMove, fn: () => Promise<unknown>) => {
      if (!threadId || acting) return;
      setActing(move);
      try {
        await fn();
        if (move === "shelve") opts.onWhisperRefresh?.();
        opts.onMutated?.(move);
      } catch (err) {
        opts.onError(
          err instanceof Error
            ? err.message
            : move === "shelve"
              ? "the house could not put this away"
              : move === "leave"
                ? "the house could not hold this leave"
                : "the house could not hold this scrub",
        );
        if (move === "scrub") setConfirmScrub(false);
      } finally {
        setActing(null);
      }
    },
    [threadId, acting, opts],
  );

  const [confirmScrub, setConfirmScrub] = useState(false);

  const putAway = useCallback(
    () => run("shelve", () => house.shelveThread(threadId!)),
    [run, threadId],
  );
  const leave = useCallback(
    () => run("leave", () => house.leaveThread(threadId!)),
    [run, threadId],
  );
  const scrub = useCallback(
    () => run("scrub", () => house.scrubThread(threadId!)),
    [run, threadId],
  );

  // The safety move — a bordered button like its neighbours; the seal
  // keeps its own colour (accent text and border, never a warning pink).
  // The confirm keeps the same quiet register; the escape is a plain
  // button, not a link — two moves of the household, both buttons.
  const scrubControl = confirmScrub ? (
    <span className="scrub-confirm">
      <span className="scrub-question">Forget your part of this correspondence?</span>
      <button className="scrub-act" onClick={scrub} disabled={acting !== null}>
        {acting === "scrub" ? "…" : "Yes, forget it"}
      </button>
      <button className="clause-act" onClick={() => setConfirmScrub(false)} disabled={acting !== null}>
        Keep it
      </button>
    </span>
  ) : (
    <button className="scrub-act" onClick={() => setConfirmScrub(true)} disabled={acting !== null}>
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
      <button className="clause-act" onClick={moves.putAway} disabled={moves.acting !== null}>
        {moves.acting === "shelve" ? "…" : "Put this correspondence away"}
      </button>
      <button className="clause-act" onClick={moves.leave} disabled={moves.acting !== null}>
        {moves.acting === "leave" ? "…" : "Leave this correspondence"}
      </button>
      {moves.scrubControl}
    </div>
  );
}
