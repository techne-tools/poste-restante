import { useCallback, useEffect, useState } from "react";
import { house } from "../api";
import type { DayProjection } from "../api";
import DayBoard from "../components/DayBoard";

interface Props {
  onError: (msg: string) => void;
  /** Open a correspondence — a letter card is a doorway into its thread. */
  onOpenThread: (thread: string) => void;
  /** Open a whisper offer in the room that holds it (the whisper's own
   *  gesture — the board is where the day's work is visible, the whisper
   *  remains where the house's voice is heard). */
  onOpenWhisper?: (id: string, targetThread?: string) => void;
  /** The community's name for the room — GET /v1/house/meta. */
  name?: string;
  /** The resident's own address — for the board's card-remove move. */
  address?: string;
}

/**
 * The day — the callsheet whiteboard (SPEC §18). A callsheet is the
 * theatre day's working document: who's on, when, where, for what. The
 * board is not a new data model — it is a projection of what the house
 * already knows, arranged by time.
 *
 *   the frame is the call      — one column per active frame
 *   a letter is a card         — in its frame's column, opening its thread
 *   an instrument is a task line — the resident's agents, alive in frames
 *   the whisper is a quiet offer  — pick it up or not
 *   the book's standing clauses  — cited, never invoked
 *
 * Presence not pressure: no badges, no red, no "N unseen". The board
 * holds; it never pings. Not a dashboard — the board does not measure
 * the resident; it shows them their day.
 *
 * Day fetches; DayBoard composes the projection (so the board is testable
 * without a live fetch).
 */
export default function Day({ onError, onOpenThread, onOpenWhisper, name, address }: Props) {
  const [projection, setProjection] = useState<DayProjection | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const day = await house.day();
      setProjection(day);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the day could not be shown");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p className="empty">The day is being set…</p>;
  if (!projection) return <p className="empty">The day is not here yet.</p>;

  return (
    <DayBoard
      projection={projection}
      onOpenThread={onOpenThread}
      onOpenWhisper={onOpenWhisper}
      name={name}
      address={address}
      onAddCard={async (input) => {
        try {
          await house.createDayCard(input);
          await load();
        } catch (err) {
          onError(err instanceof Error ? err.message : "the house could not hold this card");
        }
      }}
      onRemoveCard={async (id) => {
        try {
          await house.deleteDayCard(id);
          await load();
        } catch (err) {
          onError(err instanceof Error ? err.message : "the house could not remove this card");
        }
      }}
    />
  );
}
