import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Letter } from "./api";
import LetterView from "./LetterView";
import KindTag from "./KindTag";
import { snippet } from "./markdown";
import { groupConversations } from "./pubUtils";

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
export default function Pub({ onError, onReply, onPost }: Props) {
  const [letters, setLetters] = useState<Letter[]>([]);
  const [selected, setSelected] = useState<Letter | null>(null);
  const [openThread, setOpenThread] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await house.inbox("pub@house");
      setLetters(res.letters);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the pub is quiet");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <p className="empty">Opening the pub…</p>;

  const conversations = groupConversations(letters);
  const openConv = openThread ? conversations.find((c) => c.thread === openThread) : undefined;

  return (
    <div>
      {selected ? (
        <LetterView letter={selected} onBack={() => setSelected(null)} />
      ) : openConv ? (
        <div>
          <button
            onClick={() => setOpenThread(null)}
            style={{ marginBottom: "var(--space-3)" }}
          >
            ← Back to the pub
          </button>
          <div className="pub-ledger" aria-label="A public conversation">
            <h2>{openConv.title}</h2>
            <span className="address">
              {openConv.letters[0]?.envelope.to.join(", ") ?? "pub@house"}
            </span>
          </div>
          <div className="letter-list">
            {openConv.letters.map((l) => (
              <button
                key={l.id}
                type="button"
                className="letter-row"
                onClick={() => setSelected(l)}
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
                <div className="snippet">{snippet(l.body.content)}</div>
              </button>
            ))}
          </div>
          {onReply && (
            <div className="compose-actions">
              <button className="primary" onClick={() => onReply(openConv.thread)}>
                Write back to this conversation
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="pub-board">
          <div className="pub-ledger" aria-label="The pub — shared public letters">
            <h2>The pub</h2>
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
              onClick={() => setOpenThread(c.thread)}
            >
              <p className="subject">{c.title}</p>
              <div className="meta">
                <span className="posted">
                  last letter · {new Date(c.lastAt).toLocaleString("en-AU")}
                </span>
              </div>
              <div className="snippet">{snippet(c.letters[c.letters.length - 1]!.body.content)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
