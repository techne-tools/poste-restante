import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { DayProjection } from "./api";

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
 */
export default function Day({ onError, onOpenThread, onOpenWhisper, name }: Props) {
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

  const empty =
    projection.frames.length === 0 &&
    projection.agents.length === 0 &&
    projection.whispers.length === 0 &&
    projection.clauses.length === 0;

  return (
    <div className="day">
      <div className="ledger" aria-label={name ?? "the day"}>
        <h2>{name ?? "the day"}</h2>
        <span className="day-hint">
          the frame is the call · a letter is a card · an instrument is a task line
        </span>
      </div>

      {empty && <p className="empty">Nothing is on today — the day is open.</p>}

      {projection.frames.length > 0 && (
        <div className="day-board">
          {projection.frames.map((f) => (
            <section className="day-frame" key={f.frame}>
              <h3 className="day-frame-name">{f.frame}</h3>
              {f.letters.length === 0 && (
                <p className="day-frame-empty">no letters in this frame</p>
              )}
              {f.letters.map((l) => (
                <button
                  key={l.letterId}
                  className="day-letter"
                  onClick={() => onOpenThread(l.thread)}
                >
                  <span className="day-letter-subject">{l.subject || "(no subject)"}</span>
                  <span className="day-letter-meta">
                    {l.from} · {new Date(l.receivedAt).toLocaleString("en-AU")}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      )}

      {projection.agents.length > 0 && (
        <section className="day-agents">
          <h3>instruments on the day</h3>
          {projection.agents.map((a) => (
            <div className="day-agent" key={a.address}>
              <span className="instrument-tag">instrument</span>
              <span className="day-agent-task">{a.task}</span>
              <span className="day-agent-meta">{a.address}</span>
            </div>
          ))}
        </section>
      )}

      {projection.whispers.length > 0 && (
        <section className="day-whispers">
          <h3>what the house is offering</h3>
          {projection.whispers.map((w) => (
            <button
              key={w.id}
              className="day-whisper"
              onClick={() => onOpenWhisper?.(w.id, w.targetThread ?? undefined)}
            >
              <span className="day-whisper-summary">{w.summary}</span>
            </button>
          ))}
        </section>
      )}

      {projection.clauses.length > 0 && (
        <section className="day-clauses">
          <h3>held by the household</h3>
          {projection.clauses.map((c) => (
            <p className="day-clause" key={c.thread}>
              “{c.text}”
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
