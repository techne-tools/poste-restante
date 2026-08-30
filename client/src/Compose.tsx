import { useState } from "react";
import { house } from "./api";

interface Props {
  onError: (msg: string) => void;
  onDelivered: () => void;
  initialTo?: string;
  initialThread?: string;
  from: string;
}

export default function Compose({ onError, onDelivered, initialTo, initialThread, from }: Props) {
  const [to, setTo] = useState(initialTo ?? "you@house");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [thread, setThread] = useState(initialThread ?? "");
  const [frame, setFrame] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!body.trim()) return;
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
      await house.deliver({
        envelope: {
          from,
          to: [to.trim() || "you@house"],
          cc: [],
          thread: thread.trim() || `th_${Date.now().toString(36)}`,
          kind: "letter",
          lang: "en-AU",
          subject: subject.trim(),
        },
        time: {
          gregorian: new Date().toISOString(),
          frames,
        },
        body: { format: "markdown", content: body },
      });
      setBody("");
      setSubject("");
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
      </div>
      <label className="compose-field compose-body">
        <span className="compose-label">Letter</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write a letter…"
          rows={12}
        />
      </label>
      <div className="compose-actions">
        <button className="primary" onClick={send} disabled={sending || !body.trim()}>
          {sending ? "Posting…" : "Post the letter"}
        </button>
      </div>
    </div>
  );
}
