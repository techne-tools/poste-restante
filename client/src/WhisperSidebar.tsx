import type { Whisper } from "./api";

interface Props {
  whispers: Whisper[];
  onOpen: (id: string, w: Whisper) => void;
  onDismiss: (id: string) => void;
  onUndismiss: (id: string) => void;
  onGaps: () => void;
  onWriteBack: (w: Whisper) => void;
}

const KIND_LABEL: Record<Whisper["kind"], string> = {
  "house-letter": "the house",
  "gap-dormant-thread": "a quiet thread",
  "gap-unanswered-question": "a waiting question",
  "gap-contradiction": "two voices",
  "gap-uncited-connection": "an uncited connection",
  "gap-echo": "an echo",
};

export default function WhisperSidebar({
  whispers,
  onOpen,
  onDismiss,
  onUndismiss,
  onGaps,
  onWriteBack,
}: Props) {
  const unread = whispers.filter((w) => !w.dismissedAt);
  return (
    <aside className="whisper">
      <h2>Whisper</h2>
      {unread.length === 0 && <p className="empty">The house is quiet.</p>}
      {unread.map((w) => (
        <div
          key={w.id}
          className={`whisper-card${w.repliedAt ? " replied" : ""}${w.dismissedAt ? " dismissed" : ""}`}
        >
          <div className="kind">{KIND_LABEL[w.kind]}</div>
          <div className="summary">{w.summary}</div>
          {w.reasoning && (
            <details className="reasoning">
              <summary>here&rsquo;s what I was seeing</summary>
              <div className="details-body">{w.reasoning}</div>
            </details>
          )}
          <div className="actions">
            <button className="primary" onClick={() => onWriteBack(w)}>
              Write back
            </button>
            <button onClick={() => onOpen(w.id, w)}>Open</button>
            {w.dismissedAt ? (
              <button onClick={() => onUndismiss(w.id)}>Keep</button>
            ) : (
              <button onClick={() => onDismiss(w.id)}>Dismiss</button>
            )}
          </div>
        </div>
      ))}
      <button onClick={onGaps} style={{ marginTop: "var(--space-2)" }}>
        Look for gaps
      </button>
    </aside>
  );
}
