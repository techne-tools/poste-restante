import { useState } from "react";
import { house } from "./api";

interface Props {
  onError: (msg: string) => void;
  onDelivered: () => void;
  initialTo?: string;
  initialThread?: string;
}

export default function Compose({ onError, onDelivered, initialTo, initialThread }: Props) {
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
          from: "you@house",
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
    <div className="letter">
      <div className="envelope">
        <div>
          <label>To: </label>
          <input value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 200 }} />
        </div>
        <div>
          <label>Subject: </label>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: 300 }} />
        </div>
        <div>
          <label>Thread: </label>
          <input
            value={thread}
            onChange={(e) => setThread(e.target.value)}
            placeholder="th_… (blank = new)"
            style={{ width: 200 }}
          />
        </div>
        <div>
          <label>Frames: </label>
          <input
            value={frame}
            onChange={(e) => setFrame(e.target.value)}
            placeholder="season:autumn, production:tempest"
            style={{ width: 260 }}
          />
        </div>
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Write a letter…"
        rows={12}
        style={{
          width: "100%",
          fontFamily: "var(--font-display)",
          fontSize: 16,
          lineHeight: 1.7,
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "var(--space-3)",
          resize: "vertical",
        }}
      />
      <div style={{ marginTop: "var(--space-3)" }}>
        <button className="primary" onClick={send} disabled={sending || !body.trim()}>
          {sending ? "Posting…" : "Post the letter"}
        </button>
      </div>
    </div>
  );
}
