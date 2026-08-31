import type { Letter } from "./api";
import KindTag from "./KindTag";
import { renderMarkdown } from "./markdown";

interface Props {
  letter: Letter;
  onBack: () => void;
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
 *   — the house                                    [serif italic — the signoff]
 *
 * The envelope is minimal by default: the address line and the kind. The
 * rest of the machine metadata (cc, thread, lang, the raw gregorian) stays
 * one quiet disclosure away — expandable on demand, never in the way.
 */
export default function LetterView({ letter, onBack }: Props) {
  const { envelope, time, body } = letter;
  const to = envelope.to.join(", ");
  const frames = time.frames;

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
