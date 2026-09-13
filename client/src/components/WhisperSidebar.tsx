import type { Whisper } from "../api";

interface Props {
  whispers: Whisper[];
  /** The community's name for the house's own voice — the serif voice's
   *  word for the sidebar. Falls back to "the whisper". */
  title?: string;
  onOpen: (id: string, w: Whisper) => void;
  onDismiss: (id: string) => void;
  onGaps: () => void;
  onWriteBack: (w: Whisper) => void;
  /** The resident asked to look at the cited clause — the book, that clause open. */
  onCite: (w: Whisper) => void;
}

const KIND_LABEL: Record<Whisper["kind"], string> = {
  "house-letter": "the house",
  "gap-dormant-thread": "a quiet thread",
  "gap-unanswered-question": "a waiting question",
  "gap-contradiction": "two voices",
  "gap-uncited-connection": "an uncited connection",
  "gap-echo": "an echo",
  "gap-unvisited-corner": "an unvisited corner",
  "door-knock": "a knock at the door",
};

export default function WhisperSidebar({
  whispers,
  title,
  onOpen,
  onDismiss,
  onGaps,
  onWriteBack,
  onCite,
}: Props) {
  // The house's own offers, held in view. A dismissal really dismisses:
  // the card leaves the sidebar — the house has stopped offering it, and
  // nothing lingers half-lit. Pick-up, ignore, and dismissal are all
  // calm acts; no button ever gates the others.
  const visible = whispers.filter((w) => !w.dismissedAt);
  return (
    <aside className="whisper">
      <h2>{title ?? "the whisper"}</h2>
      {visible.length === 0 && <p className="empty">The house is quiet.</p>}
      {visible.map((w) => (
        <div key={w.id} className={`whisper-card${w.repliedAt ? " replied" : ""}`}>
          <div className="kind">{KIND_LABEL[w.kind]}</div>
          <div className="summary">{w.summary}</div>
          {w.citedClause && w.citedExcerpt && (
            <div className="citation">
              <div className="citation-line">the household has held this — want to look?</div>
              <div className="citation-excerpt">“{w.citedExcerpt}”</div>
              <button className="citation-link" onClick={() => onCite(w)}>
                the book
              </button>
            </div>
          )}
          {w.reasoning && (
            <details className="reasoning">
              <summary>here&rsquo;s what I was seeing</summary>
              <div className="details-body">{w.reasoning}</div>
            </details>
          )}
          <div className="actions">
            {/* Writing back is answering the house — only possible when
                the whisper carries a thread to answer on. A door-knock
                is information only: the house is telling you the door
                held, there is nothing to write back to. */}
            {w.targetThread && (
              <button className="primary" onClick={() => onWriteBack(w)}>
                Write back
              </button>
            )}
            {(w.targetThread || w.targetFrame) && (
              <button onClick={() => onOpen(w.id, w)}>Open</button>
            )}
            <button onClick={() => onDismiss(w.id)}>Dismiss</button>
          </div>
        </div>
      ))}
      <button onClick={onGaps} style={{ marginTop: "var(--space-2)" }}>
        Look for gaps
      </button>
    </aside>
  );
}
