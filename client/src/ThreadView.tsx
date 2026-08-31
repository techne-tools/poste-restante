import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";
import KindTag from "./KindTag";
import { snippet } from "./markdown";

interface Props {
  threadId: string;
  onError: (msg: string) => void;
  onBack: () => void;
}

/**
 * The correspondence — the pick-up target of a whisper. A thread is the
 * unit, not the message: letters oldest first, the way a correspondence
 * actually reads. Opening a gap whisper lands here, so the offer can be
 * picked up or ignored without leaving the house's own mailbox.
 */
export default function ThreadView({ threadId, onError, onBack }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [selected, setSelected] = useState<Letter | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await house.thread(threadId);
      setLetters(res.letters);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the thread is quiet");
    } finally {
      setLoading(false);
    }
  }, [threadId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p className="empty">Opening the correspondence…</p>;

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: "var(--space-3)" }}>
        ← Back
      </button>
      {selected ? (
        <LetterView letter={selected} onBack={() => setSelected(null)} />
      ) : (
        <div>
          <h2 className="thread-title">The correspondence</h2>
          <div className="letter-list">
            {letters.length === 0 && <p className="empty">No letters in this thread.</p>}
            {letters.map((l) => (
              <button
                key={l.id}
                type="button"
                className="letter-row"
                onClick={() => setSelected(l)}
              >
                <p className="subject">{l.envelope.subject || "(no subject)"}</p>
                <div className="meta">
                  <KindTag kind={l.envelope.kind} />
                  <span>{l.envelope.from}</span>
                  <span>{new Date(l.receivedAt).toLocaleString("en-AU")}</span>
                  {l.time.frames.map((f) => (
                    <span key={`${f.frame}:${f.value}`} className="frame">
                      {f.frame}:{f.value}
                    </span>
                  ))}
                </div>
                <div className="snippet">{snippet(l.body.content)}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
