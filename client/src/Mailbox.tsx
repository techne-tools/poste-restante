import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";
import KindTag from "./KindTag";
import { snippet } from "./markdown";

interface Props {
  onError: (msg: string) => void;
  address: string;
}

export default function Mailbox({ onError, address }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [selected, setSelected] = useState<Letter | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await house.inbox(address);
      setLetters(res.letters);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the mailbox is empty");
    } finally {
      setLoading(false);
    }
  }, [onError, address]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p className="empty">Opening the mailbox…</p>;

  return (
    <div>
      {selected ? (
        <LetterView letter={selected} onBack={() => setSelected(null)} />
      ) : (
        <div className="letter-list">
          {letters.length === 0 && <p className="empty">No letters yet. The house holds.</p>}
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
                {l.pinnedAt && <span className="frame">pinned</span>}
              </div>
              <div className="snippet">{snippet(l.body.content)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
