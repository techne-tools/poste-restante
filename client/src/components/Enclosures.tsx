import type { PayloadMeta } from "../api";

/** Is this payload an image or audio the house can render in place?
 *  A sealed enclosure's catalog type is `application/octet-stream`; once
 *  the client has unsealed it, `overrideType` carries the real type. */
export function isRenderable(meta: PayloadMeta, overrideType?: string): "image" | "audio" | "file" {
  const type = (overrideType ?? meta.contentType).split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  return "file";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  payloads: PayloadMeta[];
  /** Object URLs for the renderable enclosures (images, audio). */
  blobs: Record<string, string>;
  /** A quiet failure per enclosure — shown in place of the media. */
  failed: Record<string, string>;
  /** The real content type per enclosure, learned by unsealing a sealed
   *  one. Absent for a plain enclosure (the catalog already knows its type). */
  types?: Record<string, string>;
  /** The name whose removal is being confirmed (the two-step). */
  confirmRemove: string | null;
  onAskRemove: (name: string) => void;
  onCancelRemove: () => void;
  onRemove: (name: string) => void;
  onDownload: (name: string) => void;
}

/**
 * What a letter carries beyond its body — quiet, like the frames. Images
 * render in place at a letter measure, audio as a bare player, everything
 * else a download; absence is silence (no payloads → no row).
 *
 * Extracted from LetterView so the enclosure states are testable without a
 * live fetch. Removing a delivered enclosure deletes its bytes for everyone
 * the letter was addressed to, so it is confirmed — the composer's `×` only
 * drops a pending file.
 */
export default function Enclosures({
  payloads,
  blobs,
  failed,
  types,
  confirmRemove,
  onAskRemove,
  onCancelRemove,
  onRemove,
  onDownload,
}: Props) {
  if (payloads.length === 0) return null;
  return (
    <div className="enclosures">
      <div className="enclosures-label">enclosures</div>
      {payloads.map((p) => {
        const kind = isRenderable(p, types?.[p.name]);
        const url = blobs[p.name];
        const failure = failed[p.name];
        // A sealed enclosure's real type is unknown until it is opened, so
        // it is not a "file" yet — it is a thing being opened.
        const opening = p.sealed && !types?.[p.name] && !failure && !url;
        return (
          <div className="enclosure" key={p.name}>
            <div className="enclosure-meta">
              <span className="enclosure-name">{p.name}</span>
              <span className="enclosure-size">{formatBytes(p.size)}</span>
              {p.sealed && <span className="enclosure-size">sealed</span>}
              {confirmRemove === p.name ? (
                <span className="scrub-confirm">
                  <span className="scrub-question">Remove {p.name}? It goes for everyone addressed.</span>
                  <button type="button" className="clause-act" onClick={() => onRemove(p.name)}>
                    Yes, remove it
                  </button>
                  <button type="button" className="door-link" onClick={onCancelRemove}>
                    Keep it
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="enclosure-remove"
                  aria-label={`remove ${p.name} — this deletes it for everyone`}
                  onClick={() => onAskRemove(p.name)}
                >
                  ×
                </button>
              )}
            </div>
            {failure ? (
              // Any quiet failure is shown in place of the enclosure,
              // whatever its type: a sealed thing that will not open must
              // say so rather than vanish from the letter.
              <span className="enclosure-pending">{failure}</span>
            ) : kind === "image" ? (
              url ? (
                <img className="enclosure-image" src={url} alt={p.name} />
              ) : (
                <span className="enclosure-pending">opening…</span>
              )
            ) : kind === "audio" ? (
              url ? (
                <audio className="enclosure-audio" controls preload="metadata" src={url} />
              ) : (
                <span className="enclosure-pending">opening…</span>
              )
            ) : opening ? (
              <span className="enclosure-pending">opening…</span>
            ) : (
              <a
                className="enclosure-download"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onDownload(p.name);
                }}
              >
                download
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}
