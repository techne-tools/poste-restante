import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";
import KindTag from "./KindTag";
import { snippet } from "./markdown";

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
        <div className="pub-board">
          <div className="pub-ledger" aria-label="The pub — shared public letters">
            <h2>The pub</h2>
            <span className="address">pub@house</span>
          </div>
          {letters.length === 0 && (
            <p className="empty">The pub is quiet — no letters posted yet.</p>
          )}
          {letters.map((l) => (
            <button
              key={l.id}
              type="button"
              className="letter-row"
              onClick={() => setSelected(l)}
            >
              <span className="posted">posted · {new Date(l.receivedAt).toLocaleString("en-AU")}</span>
              <p className="subject">{l.envelope.subject || "(no subject)"}</p>
              <div className="meta">
                <KindTag kind={l.envelope.kind} />
                <span>{l.envelope.from}</span>
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
      )}
    </div>
  );
}
