import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";

interface Props {
  onError: (msg: string) => void;
}

/**
 * The pub — the house's public letters. Shaped like a channel, operates like
 * a pub: letters posted whole, read at leisure, no reactions, no presence,
 * no unread counts. The pub is an address (pub@house), not a separate
 * mechanism — everything is mail.
 */
export default function Pub({ onError }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [selected, setSelected] = useState<Letter | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await house.inbox("pub@house");
      setLetters(res.letters);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the pub is quiet");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p className="empty">Opening the pub…</p>;

  return (
    <div>
      {selected ? (
        <LetterView letter={selected} onBack={() => setSelected(null)} />
      ) : (
        <div className="letter-list">
          {letters.length === 0 && (
            <p className="empty">The pub is quiet — no letters posted yet.</p>
          )}
          {letters.map((l) => (
            <div key={l.id} className="letter-row" onClick={() => setSelected(l)}>
              <p className="subject">{l.envelope.subject || "(no subject)"}</p>
              <div className="meta">
                <span className="kind">{l.envelope.kind}</span>
                <span>{l.envelope.from}</span>
                <span>{new Date(l.receivedAt).toLocaleString("en-AU")}</span>
                {l.time.frames.map((f) => (
                  <span key={`${f.frame}:${f.value}`} className="frame">
                    {f.frame}:{f.value}
                  </span>
                ))}
              </div>
              <div className="snippet">{l.body.content.replace(/[#*`>]/g, "").slice(0, 120)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
