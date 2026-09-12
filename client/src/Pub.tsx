import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";
import { groupConversations } from "./pubUtils";
import PubBoard from "./PubBoard";
import PubConversation from "./PubConversation";

interface Props {
  onError: (msg: string) => void;
  /**
   * The resident affordances. When absent the pub is the keyless door:
   * a guest reads the public mail, whole conversations at a time, and
   * nothing more — writing is a resident act (delivery still requires
   * a credential at the house).
   */
  onReply?: (thread: string) => void;
  onPost?: () => void;
  /** Back to the door (login) — used when the guest finds the pub closed. */
  onEnterHouse?: () => void;
  /** The community's name for the room — GET /v1/house/meta. */
  name?: string;
}

/**
 * The pub — the house's public room (SPEC §2.4: slow-social, thread-based
 * conversation). Reads like a channel; operates like a pub — letters
 * posted whole, read at leisure, no reactions, no presence, no unread
 * counts. Conversations are the unit: most recently active first, each
 * opened oldest-first, titled by its latest letter's subject (the serif
 * voice). The pub is an address (pub@house), not a separate mechanism —
 * everything is mail.
 */
export default function Pub({ onError, onReply, onPost, onEnterHouse, name }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [selected, setSelected] = useState<Letter | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** The room is closed to this visitor (guests only — residents always read). */
  const [closed, setClosed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await house.inbox("pub@house");
      setLetters(res.letters);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        setClosed(true);
      } else {
        onError(err instanceof Error ? err.message : "the pub is quiet");
      }
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p className="empty">Opening the pub…</p>;

  // A closed pub answers the guest exactly like any private mailbox: 401.
  // The house is not broken; this room just does not open to passers-by
  // tonight. Calm surface — no red, no alarm — and a quiet path back to
  // the door where a credential could be found.
  if (closed) {
    return (
      <div className="pub-closed">
        <div className="ledger" aria-label="the pub">
          <h2>{name ?? "the pub"}</h2>
          <span className="address">pub@house</span>
        </div>
        <p className="empty">The pub is closed to visitors tonight.</p>
        {onEnterHouse && (
          <button type="button" className="door-link" onClick={onEnterHouse}>
            Sign in to enter
          </button>
        )}
      </div>
    );
  }

  const conversations = groupConversations(letters);
  const openConv = openThread ? conversations.find((c) => c.thread === openThread) : undefined;

  return (
    <div>
      {selected ? (
        <LetterView letter={selected} onBack={() => setSelected(null)} />
      ) : openConv ? (
        <PubConversation
          conversation={openConv}
          onBack={() => setOpenThread(null)}
          onOpenLetter={setSelected}
          onReply={onReply}
        />
      ) : (
        <PubBoard
          name={name}
          conversations={conversations}
          onPost={onPost}
          onOpenThread={setOpenThread}
        />
      )}
    </div>
  );
}
