import type { Letter } from "./api";

interface Props {
  letter: Letter;
  onBack: () => void;
}

/** A minimal markdown renderer — the house reads like a letter. */
function renderMarkdown(content: string): React.ReactNode {
  const lines = content.split("\n");
  const out: React.ReactNode[] = [];
  let inList = false;
  let list: React.ReactNode[] = [];

  const flushList = (key: string) => {
    if (inList) {
      out.push(<ul key={key}>{list}</ul>);
      list = [];
      inList = false;
    }
  };

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) {
      flushList(`list-${i}`);
      return;
    }
    const h = trimmed.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushList(`list-${i}`);
      const level = h[1]!.length;
      const Tag = (level === 1 ? "h1" : level === 2 ? "h2" : "h3") as "h1" | "h2" | "h3";
      out.push(<Tag key={i}>{h[2]}</Tag>);
      return;
    }
    const bq = trimmed.match(/^>\s?(.*)$/);
    if (bq) {
      flushList(`list-${i}`);
      out.push(<blockquote key={i}>{bq[1]}</blockquote>);
      return;
    }
    const li = trimmed.match(/^[-*]\s+(.*)$/);
    if (li) {
      inList = true;
      list.push(<li key={i}>{li[1]}</li>);
      return;
    }
    flushList(`list-${i}`);
    out.push(<p key={i}>{trimmed}</p>);
  });
  flushList("list-end");
  return out;
}

export default function LetterView({ letter, onBack }: Props) {
  return (
    <div>
      <button onClick={onBack} style={{ marginBottom: "var(--space-3)" }}>
        ← Back
      </button>
      <article className="letter">
        <div className="envelope">
          <div>
            <span className="from">{letter.envelope.from}</span>
            {" → "}
            {letter.envelope.to.join(", ")}
          </div>
          <div>
            {new Date(letter.receivedAt).toLocaleString("en-AU")} · {letter.envelope.kind}
          </div>
          <details>
            <summary>envelope</summary>
            <div className="details-body">
              {letter.envelope.cc.length > 0 && <span>cc: {letter.envelope.cc.join(", ")}</span>}
              <span>thread: {letter.envelope.thread}</span>
              <span>lang: {letter.envelope.lang}</span>
              {letter.time.frames.map((f) => (
                <span key={`${f.frame}:${f.value}`} className="frame">
                  {f.frame}:{f.value}
                </span>
              ))}
            </div>
          </details>
        </div>
        <h1 style={{ marginTop: 0 }}>{letter.envelope.subject || "(no subject)"}</h1>
        <div className="body">{renderMarkdown(letter.body.content)}</div>
      </article>
    </div>
  );
}
