import type { DayProjection } from "./api";

interface Props {
  projection: DayProjection;
  /** A letter card is a doorway into its thread. */
  onOpenThread: (thread: string) => void;
  /** Open a whisper offer in the room that holds it. */
  onOpenWhisper?: (id: string, targetThread?: string) => void;
  /** The community's name for the room — GET /v1/house/meta. */
  name?: string;
}

/**
 * The day, rendered — a pure projection of what the house already knows,
 * arranged by time. Extracted from Day so the board is testable without a
 * live fetch: Day fetches, this composes.
 *
 * The frame is the call, a letter is a card (a compact callsheet card, not
 * the full reading row — the board is a working document, not a mailbox),
 * an instrument is a task line, the whisper is a quiet offer, the book's
 * clauses are cited. No badges, no counts, no red; it holds, it never pings.
 */
export default function DayBoard({ projection, onOpenThread, onOpenWhisper, name }: Props) {
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
