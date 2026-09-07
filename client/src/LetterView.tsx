import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Letter, PayloadMeta } from "./api";
import KindTag from "./KindTag";
import { renderMarkdown } from "./markdown";

interface Props {
  letter: Letter;
  onBack: () => void;
}

/** Is this payload an image or audio the house can render in place? */
function isRenderable(meta: PayloadMeta): "image" | "audio" | "file" {
  const type = meta.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The letter — the atomic unit of the house (DESIGN.md "the unit and the
 * frame"; .impeccable/design.json → surfaces.letter). A letter reads as a
 * letter, not a chat bubble, not a feed card:
 *
 *   to: chris@house · from: hermes@house          [mono — the machine]
 *   On the winter of the show                      [serif — the writer]
 *   production:tempest-tech-week · season:autumn   [mono, quiet — the frames]
 *   …body…                                         [sans — the reading]
 *   enclosures: memo.wav · score.png               [mono, quiet — what travels]
 *   — the house                                    [serif italic — the signoff]
 *
 * The envelope is minimal by default: the address line and the kind. The
 * rest of the machine metadata (cc, thread, lang, the raw gregorian) stays
 * one quiet disclosure away — expandable on demand, never in the way.
 *
 * Enclosures render in place: images inline, audio as a player, everything
 * else as a quiet download link. The bytes are fetched with the house's
 * auth and handed to the renderer as object URLs (revoked on unmount) —
 * plain <img>/<audio> tags cannot carry the Authorization header.
 */
export default function LetterView({ letter, onBack }: Props) {
  const { envelope, time, body } = letter;
  const to = envelope.to.join(", ");
  const frames = time.frames;

  const [payloads, setPayloads] = useState<PayloadMeta[]>([]);
  const [blobs, setBlobs] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});

  // List the catalog once. Absence is silence: no payloads → no row.
  useEffect(() => {
    let cancelled = false;
    house
      .payloads(letter.id)
      .then((res) => {
        if (!cancelled) setPayloads(res.payloads);
      })
      .catch(() => {
        // The letter is readable without its enclosures; a quiet failure
        // here leaves the body readable and the enclosures absent.
      });
    return () => {
      cancelled = true;
    };
  }, [letter.id]);

  // Fetch the bytes for renderable enclosures only — a file that merely
  // downloads never occupies the view until the reader asks.
  useEffect(() => {
    const urls: string[] = [];
    let cancelled = false;
    for (const p of payloads) {
      const kind = isRenderable(p);
      if (kind === "file") continue;
      const name = p.name;
      house
        .payloadBlob(letter.id, name)
        .then((blob) => {
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          urls.push(url);
          setBlobs((prev) => (prev[name] === url ? prev : { ...prev, [name]: url }));
        })
        .catch((err) => {
          if (!cancelled) {
            setFailed((prev) => ({
              ...prev,
              [name]: err instanceof Error ? err.message : "the house could not open this",
            }));
          }
        });
    }
    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [payloads, letter.id]);

  const removePayload = useCallback(
    async (name: string) => {
      try {
        await house.deletePayload(letter.id, name);
        setPayloads((prev) => prev.filter((p) => p.name !== name));
      } catch (err) {
        setFailed((prev) => ({
          ...prev,
          [name]: err instanceof Error ? err.message : "the house could not remove this",
        }));
      }
    },
    [letter.id],
  );

  const renderEnclosure = (p: PayloadMeta) => {
    const kind = isRenderable(p);
    const url = blobs[p.name];
    const failure = failed[p.name];

    if (kind === "image") {
      return url ? (
        <img className="enclosure-image" src={url} alt={p.name} />
      ) : (
        <span className="enclosure-pending">{failure ?? "opening…"}</span>
      );
    }

    if (kind === "audio") {
      return url ? (
        <audio className="enclosure-audio" controls preload="metadata" src={url} />
      ) : (
        <span className="enclosure-pending">{failure ?? "opening…"}</span>
      );
    }

    return (
      <a
        className="enclosure-download"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          void (async () => {
            try {
              const blob = await house.payloadBlob(letter.id, p.name);
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = p.name;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 60_000);
            } catch (err) {
              setFailed((prev) => ({
                ...prev,
                [p.name]: err instanceof Error ? err.message : "the house could not open this",
              }));
            }
          })();
        }}
      >
        download
      </a>
    );
  };

  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: "var(--space-3)" }}>
        ← Back
      </button>
      <article className="letter">
        <div className="envelope">
          <span className="address">
            <span className="to">to: {to}</span>
            <span className="sep">·</span>
            <span>from: {envelope.from}</span>
          </span>
          <KindTag kind={envelope.kind} />
        </div>

        <h1 className="subject">{envelope.subject || "(no subject)"}</h1>

        {frames.length > 0 && (
          <div className="frames">
            {frames.map((f) => (
              <span key={`${f.frame}:${f.value}`} className="frame">
                {f.frame}:{f.value}
              </span>
            ))}
          </div>
        )}

        <div className="body">{renderMarkdown(body.content)}</div>

        {payloads.length > 0 && (
          <div className="enclosures">
            <div className="enclosures-label">enclosures</div>
            {payloads.map((p) => (
              <div className="enclosure" key={p.name}>
                <div className="enclosure-meta">
                  <span className="enclosure-name">{p.name}</span>
                  <span className="enclosure-size">{formatBytes(p.size)}</span>
                  <button
                    type="button"
                    className="enclosure-remove"
                    aria-label={`remove ${p.name}`}
                    onClick={() => void removePayload(p.name)}
                  >
                    ×
                  </button>
                </div>
                {renderEnclosure(p)}
              </div>
            ))}
          </div>
        )}

        <div className="signoff">— {envelope.from}</div>

        <details className="machine">
          <summary>envelope</summary>
          <div className="details-body">
            {envelope.cc.length > 0 && <span>cc: {envelope.cc.join(", ")}</span>}
            <span>thread: {envelope.thread}</span>
            <span>lang: {envelope.lang}</span>
            <span>received: {new Date(letter.receivedAt).toLocaleString("en-AU")}</span>
          </div>
        </details>
      </article>
    </div>
  );
}
