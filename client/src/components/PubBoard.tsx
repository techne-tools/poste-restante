import { snippetForLetter } from "./markdown";
import type { PubConversation } from "../utils/pubUtils";

interface Props {
  /** The community's name for the room — GET /v1/house/meta. */
  name?: string;
  conversations: PubConversation[];
  onPost?: () => void;
  onOpenThread: (thread: string) => void;
}

/**
 * The pub's board — a pure projection of the conversations it is handed.
 *
 * The board carries the `pub` class because the pub's whole distinct
 * treatment (the notice-board letter rows, the `posted` marker) keys on it:
 * the board must read as a shared public space, not as the private mailbox
 * (design.json → surfaces.pub). Extracted from Pub so that contract is
 * testable without a live fetch — Pub itself only composes.
 */
export default function PubBoard({ name, conversations, onPost, onOpenThread }: Props) {
  return (
    <div className="pub pub-board">
      <div className="ledger" aria-label={name ?? "the pub"}>
        <h2>{name ?? "the pub"}</h2>
        <span className="address">pub@house</span>
      </div>
      {onPost && (
        <p className="pub-note">
          The house's public room — conversations, not posts.{" "}
          <button type="button" className="door-link" onClick={onPost}>
            Post a letter to the pub
          </button>
        </p>
      )}
      {conversations.length === 0 && (
        <p className="empty">The pub is quiet — no letters posted yet.</p>
      )}
      {conversations.map((c) => (
        <button
          key={c.thread}
          type="button"
          className="letter-row"
          onClick={() => onOpenThread(c.thread)}
        >
          <p className="subject">{c.title}</p>
          <div className="meta">
            <span className="posted">
              last letter · {new Date(c.lastAt).toLocaleString("en-AU")}
            </span>
          </div>
          <div className="snippet">{snippetForLetter(c.letters[c.letters.length - 1]!)}</div>
        </button>
      ))}
    </div>
  );
}
