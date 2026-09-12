import { useCallback, useRef, useState } from "react";
import { house } from "./api";
import { sealDraft } from "./crypto";
import type { Address } from "./api";

interface Props {
  onError: (msg: string) => void;
  onDelivered: () => void;
  initialTo?: string;
  initialThread?: string;
  from: string;
}

/** A letter being written: text, kind, and any enclosures. An audio letter
 *  may carry no text at all — the recording IS the letter; the whisper
 *  transcribes it into a new letter that follows in the same thread. */
interface PendingFile {
  name: string;
  size: number;
  type: string;
  blob: Blob;
}

export default function Compose({ onError, onDelivered, initialTo, initialThread, from }: Props) {
  const [to, setTo] = useState(initialTo ?? "you@house");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [thread, setThread] = useState(initialThread ?? "");
  const [frame, setFrame] = useState("");
  const [kind, setKind] = useState("letter");
  const [sealed, setSealed] = useState(false);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [sealing, setSealing] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const canSend =
    (body.trim().length > 0 || files.length > 0) && to.trim().length > 0 && !sending;

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = Array.from(list)
      .filter((f) => f.size > 0)
      .map((f) => ({ name: f.name, size: f.size, type: f.type, blob: f }));
    if (next.length > 0) setFiles((prev) => [...prev, ...next]);
  };

  // Ensure the key registry is fresh when the resident reaches for the
  // seal — sealing needs every correspondent's public half resident-side.
  const loadAddressBook = useCallback(async () => {
    if (addresses.length > 0) return addresses;
    try {
      const res = await house.addresses();
      setAddresses(res.addresses);
      return res.addresses;
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not show the address book");
      return addresses;
    }
  }, [addresses, onError]);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const frames = frame
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [name, value] = s.split(":");
          return { frame: name ?? "season", value: value ?? s };
        });
      const envelope = {
        from,
        to: [to.trim() || "you@house"],
        cc: [],
        thread: thread.trim() || `th_${Date.now().toString(36)}`,
        kind,
        lang: "en-AU",
        subject: sealed ? "" : subject.trim(),
      };
      const { id } = await house.deliver(
        sealed
          ? await (async () => {
              // Seal first, then deliver. The address book is the
              // identity map the letter id resolves through — fetched
              // once and held for the composer's life.
              const book = await loadAddressBook();
              setSealing(true);
              try {
                const result = await sealDraft(
                  {
                    envelope,
                    time: { gregorian: new Date().toISOString(), frames },
                    body: { format: "markdown", content: body },
                  },
                  book,
                  {
                    registerKeys: (id, keys) => house.registerKeys(id, keys),
                  },
                );
                // The delivered letter is EXACTLY what was canonicalised:
                // the sealed body with an EMPTY envelope subject, signed
                // against that stored form. The house renders "sealed
                // letter"; the client presents the first line of the
                // plaintext as the subject after unsealing (SPEC §15 —
                // subject moves into the body).
                return result.letter;
              } finally {
                setSealing(false);
              }
            })()
          : {
              envelope,
              time: { gregorian: new Date().toISOString(), frames },
              body: { format: "markdown", content: body },
            },
      );

      // The letter is delivered; the enclosures follow. Enclosures on
      // sealed letters are client side only — the house cannot read or
      // serve what it cannot open (SPEC §15: sealed payloads are
      // client-side encrypted before upload; v1 ships text bodies, the
      // payload layer is the recorded follow-on).
      for (const f of files) {
        if (sealed) continue;
        try {
          await house.uploadPayload(id, f.blob, f.name);
        } catch (err) {
          onError(`the letter is delivered; ${f.name} could not be attached — ${err instanceof Error ? err.message : "the house declined"}`);
        }
      }

      setBody("");
      setSubject("");
      setFiles([]);
      onDelivered();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the letter was not delivered");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="letter compose">
      <div className="compose-fields">
        <label className="compose-field">
          <span className="compose-label">To</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="compose-field">
          <span className="compose-label">Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <div className="compose-row">
          <label className="compose-field">
            <span className="compose-label">Thread</span>
            <input
              value={thread}
              onChange={(e) => setThread(e.target.value)}
              placeholder="th_… (blank = new)"
            />
          </label>
          <label className="compose-field">
            <span className="compose-label">Frames</span>
            <input
              value={frame}
              onChange={(e) => setFrame(e.target.value)}
              placeholder="season:autumn, production:tempest"
            />
          </label>
        </div>
        <div className="compose-row">
          <label className="compose-field">
            <span className="compose-label">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="letter">letter</option>
              <option value="audio">audio</option>
              <option value="note">note</option>
              <option value="task">task</option>
            </select>
          </label>
          <label className="compose-field">
            <span className="compose-label">Enclosures</span>
            <input
              ref={fileInput}
              type="file"
              multiple
              onChange={(e) => addFiles(e.target.files)}
            />
          </label>
        </div>
        {/* The seal — a per-letter choice, not a default (SPEC §15).
            Quiet, factual, no red: the tradeoff is stated, the resident
            decides. Sealed = not indexed, not whispered, not
            semantically connected. */}
        <label className="seal-toggle">
          <input
            type="checkbox"
            checked={sealed}
            onChange={(e) => setSealed(e.target.checked)}
          />
          <span>Seal this letter — only {to.trim() || "the recipient"} and I can read it; the house holds it without reading</span>
        </label>
        {kind === "audio" && body.trim().length === 0 && (
          <p className="compose-hint">An audio letter — the recording is the letter.</p>
        )}
        {files.length > 0 && (
          <div className="attach-list">
            {files.map((f) => (
              <span key={f.name} className="attach-chip">
                {f.name}
                <button
                  type="button"
                  className="attach-remove"
                  aria-label={`remove ${f.name}`}
                  onClick={() => setFiles((prev) => prev.filter((p) => p.name !== f.name))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <label className="compose-field compose-body">
        <span className="compose-label">Letter</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={kind === "audio" ? "Optional note; the recording travels with the letter…" : "Write a letter…"}
          rows={12}
        />
      </label>
      <div className="compose-actions">
        <button className="primary" onClick={send} disabled={!canSend || sealing}>
          {sealing ? "Sealing…" : sending ? "Posting…" : "Post the letter"}
        </button>
      </div>
    </div>
  );
}
