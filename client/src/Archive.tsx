import { useCallback, useEffect, useMemo, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";
import { classifyLetter, railPositions, type FrameInfo } from "./frameUtils";

interface Props {
  onError: (msg: string) => void;
}

/**
 * The archive — the Horizon View (DESIGN.md: the unit and the frame).
 * The letter flow is a single vertical axis; frames are parallel lines
 * flanking it, like a transit diagram. Toggling frame lines brings the
 * intersection forward: letters in EVERY selected frame stay full, letters
 * in SOME mid-dim, the rest dim. Nothing is removed — the intersection
 * stays visible. Plural time, made visible.
 */
export default function Archive({ onError }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [frames, setFrames] = useState<FrameInfo[]>([]);
  const [query, setQuery] = useState("");
  const [activeFrames, setActiveFrames] = useState<ReadonlySet<string>>(new Set());
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

  const toggleFrame = useCallback((id: string) => {
    setActiveFrames((prev) => {
      if (prev.has(id)) {
        const next = new Set(prev);
        next.delete(id);
        return next;
      }
      return new Set(prev).add(id);
    });
  }, []);

  const clearFrames = useCallback(() => setActiveFrames(new Set()), []);

  /** The ∩ semantics: what each letter becomes under the active frames. */
  const classified = useMemo(
    () => new Map(letters.map((l) => [l.id, classifyLetter(l, activeFrames)])),
    [letters, activeFrames],
  );

  /** Ticks on the transit lines — flow indexes per frame. */
  const rail = useMemo(() => railPositions(letters, frames), [letters, frames]);

  const tickTop = useCallback(
    (index: number) =>
      letters.length <= 1 ? "50%" : `${(index / (letters.length - 1)) * 100}%`,
    [letters.length],
  );

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
        <div className="frame-legend" aria-label="Frames">
          {frames.length === 0 ? (
            <p className="empty">No frames yet — time is still singular.</p>
          ) : (
            frames.map((f) => {
              const active = activeFrames.has(f.id);
              const ticks = rail.get(f.id) ?? [];
              return (
                <button
                  key={f.id}
                  className={`frame-label${active ? " active" : ""}`}
                  onClick={() => toggleFrame(f.id)}
                  aria-pressed={active}
                  title={`${f.name}:${f.value} — ${ticks.length} letter${ticks.length === 1 ? "" : "s"}`}
                >
                  <span className="frame-name">{f.name}</span>
                  <span className="frame-value">{f.value}</span>
                </button>
              );
            })
          )}
        </div>

        {/* The transit lines — flanking the flow, sharing its height. */}
        <div className="frame-lines" aria-hidden="true">
          {selected ? null : (
            frames.map((f) => {
              const active = activeFrames.has(f.id);
              const ticks = rail.get(f.id) ?? [];
              return (
                <span
                  key={f.id}
                  className={`frame-line${active ? " active" : ""}`}
                  style={{ left: `${8 + (f.id.length % 4) * 8}px` }}
                >
                  {ticks.map((t) => (
                    <i key={t} style={{ top: tickTop(t) }} />
                  ))}
                </span>
              );
            })
          )}
        </div>

        {selected ? (
          <LetterView letter={selected} onBack={() => setSelected(null)} />
        ) : (
          <div className="letter-flow">
            {activeFrames.size > 0 && (
              <p className="horizon-hint">
                {activeFrames.size === 1
                  ? "Showing one frame — letters outside it are dimmed."
                  : `Showing the intersection of ${activeFrames.size} frames — letters in all stay full, in some mid-dim, the rest dim.`}{" "}
                <button type="button" className="door-link" onClick={clearFrames}>
                  Clear frames
                </button>
              </p>
            )}
            {letters.length === 0 && <p className="empty">Nothing here. The house holds.</p>}
            {letters.map((l) => {
              const cls = classified.get(l.id) ?? "none";
              return (
                <div
                  key={l.id}
                  className={`letter-row${cls !== "none" ? ` ${cls}` : ""}`}
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
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
