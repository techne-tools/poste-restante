import { useCallback, useEffect, useMemo, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";

interface Props {
  onError: (msg: string) => void;
}

/**
 * The archive — the Horizon View. A vertical flow of letters flanked by
 * parallel lanes for each frame (like a transit diagram). Selecting a frame
 * brings its letters to the foreground. Plural time, made visible.
 */
export default function Archive({ onError }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [frames, setFrames] = useState<{ id: string; name: string; value: string }[]>([]);
  const [query, setQuery] = useState("");
  const [activeFrame, setActiveFrame] = useState<string | null>(null);
  const [selected, setSelected] = useState<Letter | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const [searchRes, framesRes] = await Promise.all([
        house.search({ limit: "100" }),
        house.frames(),
      ]);
      setLetters(searchRes.letters);
      setFrames(framesRes.frames);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the archive is quiet");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  const search = useCallback(async () => {
    try {
      const res = await house.search({ text: query, limit: "100" });
      setLetters(res.letters);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the search failed");
    }
  }, [query, onError]);

  const visible = useMemo(() => {
    if (!activeFrame) return letters;
    const [name, value] = activeFrame.split(":");
    return letters.filter((l) =>
      l.time.frames.some((f) => f.frame === name && f.value === value),
    );
  }, [letters, activeFrame]);

  if (loading) return <p className="empty">Opening the archive…</p>;

  return (
    <div className="horizon">
      <div className="search">
        <input
          placeholder="Search the archive — the house answers in any frame"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
        />
        <button onClick={search}>Search</button>
      </div>

      <div className="lanes">
        {frames.map((f) => {
          const id = `${f.name}:${f.value}`;
          return (
            <div key={id} className="lane">
              <h3>{f.name}</h3>
              <span
                className={`frame-chip${activeFrame === id ? " active" : ""}`}
                onClick={() => setActiveFrame(activeFrame === id ? null : id)}
              >
                {f.value}
              </span>
            </div>
          );
        })}
        {frames.length === 0 && <p className="empty">No frames yet — time is still singular.</p>}
      </div>

      {selected ? (
        <LetterView letter={selected} onBack={() => setSelected(null)} />
      ) : (
        <div className="letter-list">
          {visible.length === 0 && <p className="empty">Nothing here. The house holds.</p>}
          {visible.map((l) => (
            <div key={l.id} className="letter-row" onClick={() => setSelected(l)}>
              <p className="subject">{l.envelope.subject || "(no subject)"}</p>
              <div className="meta">
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
