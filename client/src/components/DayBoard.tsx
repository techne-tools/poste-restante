import { useState } from "react";
import type { DayProjection } from "../api";

interface Props {
  projection: DayProjection;
  /** A letter card is a doorway into its thread. */
  onOpenThread: (thread: string) => void;
  /** Open a whisper offer in the room that holds it. */
  onOpenWhisper?: (id: string, targetThread?: string) => void;
  /** The community's name for the room — GET /v1/house/meta. */
  name?: string;
  /** The resident's own address — the board shows the remove move only on
   *  cards they created (no admin, ever). */
  address?: string;
  onAddCard?: (input: { text: string; scope: "house" | "group" | "address"; scopeValue?: string; frame?: string }) => void;
  onRemoveCard?: (id: string) => void;
}

/**
 * The day, rendered — a pure projection of what the house already knows,
 * arranged by time. Extracted from Day so the board is testable without a
 * live fetch: Day fetches, this composes.
 *
 * The frame is the call, a letter is a card (a compact callsheet card, not
 * the full reading row — the board is a working document, not a mailbox),
 * an instrument is a task line, the whisper is a quiet offer, the book's
 * clauses are cited. The day's own cards are SINGLE items — not letters,
 * not threads, never the pub — scoped to the residents they belong to
 * ('house' is every resident, 'group' is a thread's participants,
 * 'address' is one address). No badges, no counts, no red; it holds, it
 * never pings.
 */
export default function DayBoard({
  projection,
  onOpenThread,
  onOpenWhisper,
  name,
  address,
  onAddCard,
  onRemoveCard,
}: Props) {
  const empty =
    projection.frames.length === 0 &&
    projection.agents.length === 0 &&
    projection.whispers.length === 0 &&
    projection.clauses.length === 0 &&
    projection.cards.length === 0;

  // The card composer — a single item on the board. Presence not pressure:
  // the composer is a quiet desk below the board, opened by the resident's
  // own act.
  const [composing, setComposing] = useState(false);
  const [cardText, setCardText] = useState("");
  const [cardScope, setCardScope] = useState<"house" | "group" | "address">("house");
  const [cardScopeValue, setCardScopeValue] = useState("");
  const [cardFrame, setCardFrame] = useState("");

  const submitCard = () => {
    if (!onAddCard || !cardText.trim()) return;
    onAddCard({
      text: cardText.trim(),
      scope: cardScope,
      scopeValue: cardScope === "house" ? undefined : cardScopeValue.trim() || undefined,
      frame: cardFrame.trim() || undefined,
    });
    setCardText("");
    setCardScopeValue("");
    setCardFrame("");
    setComposing(false);
  };

  return (
    <div className="day">
      <div className="ledger" aria-label={name ?? "the day"}>
        <h2>{name ?? "the day"}</h2>
        <span className="day-hint">
          the frame is the call · a letter is a card · an instrument is a task line
        </span>
      </div>

      {empty && <p className="empty">Nothing is on today — the day is open.</p>}

      {projection.cards.length > 0 && (
        <section className="day-cards">
          <h3>the day’s own items</h3>
          {projection.cards.map((c) => (
            <div className="day-card" key={c.id}>
              <span
                className="day-card-scope"
                title={
                  c.scope === "house"
                    ? "every resident"
                    : c.scope === "group"
                      ? `the group in ${c.scopeValue}`
                      : c.scopeValue
                }
              >
                {c.scope === "house" ? "house" : c.scope === "group" ? "group" : c.scopeValue}
              </span>
              <span className="day-card-text">{c.text}</span>
              {c.frameId && <span className="day-card-meta">{c.frameId}</span>}
              {onRemoveCard && c.createdBy === address && (
                <button
                  className="day-card-remove"
                  aria-label="remove this card"
                  onClick={() => onRemoveCard(c.id)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </section>
      )}

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

      {onAddCard && (
        <section className="day-put">
          {composing ? (
            <div className="day-card-composer">
              <textarea
                className="book-draft"
                value={cardText}
                onChange={(e) => setCardText(e.target.value)}
                placeholder="a single item for the day — not a letter, not a thread"
                rows={2}
              />
              <div className="day-card-fields">
                <label className="day-card-field">
                  <span>scope</span>
                  <select
                    value={cardScope}
                    onChange={(e) => setCardScope(e.target.value as typeof cardScope)}
                  >
                    <option value="house">the house</option>
                    <option value="address">one address</option>
                    <option value="group">a group (thread)</option>
                  </select>
                </label>
                {cardScope !== "house" && (
                  <label className="day-card-field">
                    <span>{cardScope === "address" ? "address" : "thread"}</span>
                    <input
                      value={cardScopeValue}
                      onChange={(e) => setCardScopeValue(e.target.value)}
                      placeholder={cardScope === "address" ? "ben@house" : "th_…"}
                    />
                  </label>
                )}
                <label className="day-card-field">
                  <span>frame</span>
                  <input
                    value={cardFrame}
                    onChange={(e) => setCardFrame(e.target.value)}
                    placeholder="production:tempest"
                  />
                </label>
              </div>
              <div className="book-propose-actions">
                <button className="gated" disabled={!cardText.trim()} onClick={submitCard}>
                  Put it on the day
                </button>
                <button className="clause-act" onClick={() => setComposing(false)}>
                  Put it down
                </button>
              </div>
            </div>
          ) : (
            <button className="clause-act" onClick={() => setComposing(true)}>
              Put something on the day
            </button>
          )}
        </section>
      )}
    </div>
  );
}
