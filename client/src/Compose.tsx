import { useRef, useState } from "react";
import { house } from "./api";

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
      const { id } = await house.deliver({
        envelope: {
          from,
          to: [to.trim() || "you@house"],
          cc: [],
          thread: thread.trim() || `th_${Date.now().toString(36)}`,
          kind,
          lang: "en-AU",
          subject: subject.trim(),
        },
        time: {
          gregorian: new Date().toISOString(),
          frames,
        },
        body: { format: "markdown", content: body },
      });

      // The letter is delivered; the enclosures follow. Each upload is its
      // own request — a failure here fails the attachment alone, never the
      // letter (the letter is already in the archive).
      for (const f of files) {
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
        <button className="primary" onClick={send} disabled={!canSend}>
          {sending ? "Posting…" : "Post the letter"}
        </button>
      </div>
    </div>
  );
}
