import { useCallback, useEffect, useMemo, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";

interface Props {
  onError: (msg: string) => void;
}

/**
 * The archive — the Horizon View. A single vertical flow of letters, flanked
 * by parallel frame lines (like a transit diagram). Selecting a frame line
 * brings its letters to the foreground and dims the rest — the intersection
 * of contexts stays visible, nothing is removed. Plural time, made visible.
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

  const inFrame = useCallback(
    (l: Letter, frameId: string) => {
      const [name, value] = frameId.split(":");
      return l.time.frames.some((f) => f.frame === name && f.value === value);
    },
    [],
  );

  /** Letters in the active frame stay full; the rest dim. Nothing is removed. */
  const dimmed = useMemo(() => {
    if (!activeFrame) return new Set<string>();
    return new Set(letters.filter((l) => !inFrame(l, activeFrame)).map((l) => l.id));
  }, [letters, activeFrame, inFrame]);

  /** For the transit rail: each frame line gets a dot per letter it carries. */
  const railDots = useMemo(() => {
    const map = new Map<string, number[]>();
    frames.forEach((f) => {
      const id = `${f.name}:${f.value}`;
      const positions: number[] = [];
      letters.forEach((l, i) => {
        if (inFrame(l, id)) positions.push(i);
      });
      map.set(id, positions);
    });
    return map;
  }, [frames, letters, inFrame]);

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

      <div className="horizon-body">
        <div className="frame-rail" aria-label="Frames">
          {frames.length === 0 && (
            <p className="empty">No frames yet — time is still singular.</p>
          )}
          {frames.map((f) => {
            const id = `${f.name}:${f.value}`;
            const active = activeFrame === id;
            const dots = railDots.get(id) ?? [];
            return (
              <button
                key={id}
                className={`frame-line${active ? " active" : ""}`}
                onClick={() => setActiveFrame(active ? null : id)}
                aria-pressed={active}
                title={`${f.name}:${f.value} — ${dots.length} letter${dots.length === 1 ? "" : "s"}`}
              >
                <span className="frame-name">{f.name}</span>
                <span className="frame-value">{f.value}</span>
                <span className="frame-rail-line" aria-hidden="true">
                  {dots.map((d) => (
                    <i key={d} style={{ top: `${(d / Math.max(letters.length - 1, 1)) * 100}%` }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>

        {selected ? (
          <LetterView letter={selected} onBack={() => setSelected(null)} />
        ) : (
          <div className="letter-list">
            {letters.length === 0 && <p className="empty">Nothing here. The house holds.</p>}
            {letters.map((l) => (
              <div
                key={l.id}
                className={`letter-row${dimmed.has(l.id) ? " dimmed" : ""}`}
                onClick={() => setSelected(l)}
              >
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
    </div>
  );
}
