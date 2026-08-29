import type { Whisper } from "./api";

interface Props {
  whispers: Whisper[];
  onOpen: (id: string) => void;
  onDismiss: (id: string) => void;
  onUndismiss: (id: string) => void;
  onGaps: () => void;
}

const KIND_LABEL: Record<Whisper["kind"], string> = {
  "house-letter": "the house",
  "gap-dormant-thread": "a quiet thread",
  "gap-unanswered-question": "a waiting question",
};

export default function WhisperSidebar({ whispers, onOpen, onDismiss, onUndismiss, onGaps }: Props) {
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
          <div className="actions">
            <button onClick={() => onOpen(w.id)}>Open</button>
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
