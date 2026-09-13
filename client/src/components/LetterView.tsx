import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { house, loadAuth } from "../api";
import type { Letter, PayloadMeta } from "../api";
import KindTag from "./KindTag";
import { renderMarkdown } from "./markdown";
import { unsealLetterBody } from "../utils/crypto";
import Enclosures, { isRenderable } from "./Enclosures";

interface Props {
  letter: Letter;
  onBack: () => void;
  /** The correspondence's actions — put away, leave, scrub. Rendered below
   *  the letter when it is read inside a correspondence (ThreadView), so
   *  the same moves are on hand whether the resident is scanning the list
   *  or reading a single letter. Absent elsewhere: a letter read from the
   *  mailbox or the archive stays a letter, not a thread. */
  actions?: ReactNode;
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
export default function LetterView({ letter, onBack, actions }: Props) {
  const { envelope, time, body } = letter;
  const to = envelope.to.join(", ");
  const frames = time.frames;
  const sealed = body.format === "sealed";

  const [payloads, setPayloads] = useState<PayloadMeta[]>([]);
  const [blobs, setBlobs] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, string>>({});
  // Removing a delivered enclosure deletes its bytes for everyone the letter
  // was addressed to — irreversible, so it is confirmed. The composer's `×`
  // only drops a pending file; this one deletes from the house.
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // A sealed body's plaintext — unsealed on demand with the resident's
  // own key, held in memory for the life of the view. The envelope is
  // always visible; the body waits for the reader.
  const [plaintext, setPlaintext] = useState<string | null>(
    sealed ? null : body.content,
  );
  const [unsealFailed, setUnsealFailed] = useState(false);
  const [unsealing, setUnsealing] = useState(false);
  // Sealed letters carry no plaintext subject — the first line of the
  // unsealed body is the title. Until then, a quiet placeholder (SPEC
  // §15: the house shows "sealed letter").
  const [subjectLabel, setSubjectLabel] = useState<string | null>(null);

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
        setConfirmRemove(null);
      } catch (err) {
        setFailed((prev) => ({
          ...prev,
          [name]: err instanceof Error ? err.message : "the house could not remove this",
        }));
      }
    },
    [letter.id],
  );

  const unseal = useCallback(async () => {
    if (!sealed || body.format !== "sealed") return;
    setUnsealing(true);
    try {
      // The reader unseals with their own age identity. The session's
      // handle is the key into the client-held keystore — the resident
      // can open letters sealed to them, and only those.
      const auth = loadAuth();
      const resident = auth?.address ?? envelope.from;
      const opened = await unsealLetterBody(resident, body.content);
      if (opened === null) {
        setUnsealFailed(true);
        return;
      }
      // The first line of the plaintext is the subject; the body is the
      // rest (SPEC §15 — the subject moves into the body for sealed
      // letters).
      const nl = opened.indexOf("\n");
      if (nl >= 0) {
        setSubjectLabel(opened.slice(0, nl).trim() || "sealed letter");
        setPlaintext(opened.slice(nl).replace(/^\n+/, ""));
      } else {
        setSubjectLabel("sealed letter");
        setPlaintext(opened);
      }
      setUnsealFailed(false);
    } catch {
      setUnsealFailed(true);
    } finally {
      setUnsealing(false);
    }
  }, [sealed, body, envelope.from]);

  const downloadPayload = useCallback(
    async (name: string) => {
      try {
        const blob = await house.payloadBlob(letter.id, name);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (err) {
        setFailed((prev) => ({
          ...prev,
          [name]: err instanceof Error ? err.message : "the house could not open this",
        }));
      }
    },
    [letter.id],
  );

  return (
    <div>
      <button className="back" onClick={onBack}>
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

        <h1 className="subject">
          {sealed ? (subjectLabel ?? "sealed letter") : envelope.subject || "(no subject)"}
        </h1>

        {frames.length > 0 && (
          <div className="frames">
            {frames.map((f) => (
              <span key={`${f.frame}:${f.value}`} className="frame">
                {f.frame}:{f.value}
              </span>
            ))}
          </div>
        )}

        {body.format === "sealed" ? (
          <div className="body sealed-body">
            {unsealFailed ? (
              <p className="sealed-hint">
                This letter is sealed — the house cannot open it. It was sealed to you; if it
                is not readable with your key, you may not be a recipient.
              </p>
            ) : plaintext !== null ? (
              renderMarkdown(plaintext)
            ) : (
              <button className="gated" onClick={unseal} disabled={unsealing}>
                {unsealing ? "Opening…" : "Open the sealed letter"}
              </button>
            )}
          </div>
        ) : (
          <div className="body">{renderMarkdown(body.content)}</div>
        )}

        <Enclosures
          payloads={payloads}
          blobs={blobs}
          failed={failed}
          confirmRemove={confirmRemove}
          onAskRemove={setConfirmRemove}
          onCancelRemove={() => setConfirmRemove(null)}
          onRemove={(name) => void removePayload(name)}
          onDownload={(name) => void downloadPayload(name)}
        />

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
      {actions}
    </div>
  );
}
