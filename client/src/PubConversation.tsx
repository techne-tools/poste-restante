import KindTag from "./KindTag";
import { snippetForLetter } from "./markdown";
import type { Letter } from "./api";
import type { PubConversation as PubConversationData } from "./pubUtils";

interface Props {
  conversation: PubConversationData;
  onBack: () => void;
  /** A letter row is a doorway into the letter itself. */
  onOpenLetter: (letter: Letter) => void;
  /** The resident's reply affordance — absent on the keyless guest door. */
  onReply?: (thread: string) => void;
}

/**
 * A public conversation, opened — the pub read oldest-first, the way a
 * correspondence reads. Extracted from Pub so the view is testable without
 * a live fetch: Pub composes, this renders.
 */
export default function PubConversation({ conversation, onBack, onOpenLetter, onReply }: Props) {
  return (
    <div className="pub">
      <button className="back" onClick={onBack}>
        ← Back to the pub
      </button>
      <div className="ledger" aria-label="a public conversation">
        <h2>{conversation.title}</h2>
        <span className="address">
          {conversation.letters[0]?.envelope.to.join(", ") ?? "pub@house"}
        </span>
      </div>
      <div className="letter-list">
        {conversation.letters.map((l) => (
          <button
            key={l.id}
            type="button"
            className="letter-row"
            onClick={() => onOpenLetter(l)}
          >
            <p className="subject">{l.envelope.subject || "(no subject)"}</p>
            <div className="meta">
              <KindTag kind={l.envelope.kind} />
              <span>{l.envelope.from}</span>
              <span>{new Date(l.receivedAt).toLocaleString("en-AU")}</span>
              {l.time.frames.map((f) => (
                <span key={`${f.frame}:${f.value}`} className="frame">
                  {f.frame}:{f.value}
                </span>
              ))}
            </div>
            <div className="snippet">{snippetForLetter(l)}</div>
          </button>
        ))}
      </div>
      {onReply && (
        <div className="compose-actions">
          <button className="primary" onClick={() => onReply(conversation.thread)}>
            Write back to this conversation
          </button>
        </div>
      )}
    </div>
  );
}
