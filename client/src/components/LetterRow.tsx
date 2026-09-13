import KindTag from "./KindTag";
import { snippetForLetter } from "./markdown";
import type { Letter } from "../api";

/** The Horizon intersection state — only `partial` and `dim` change the
 *  row's weight; `full` and `none` both rest at full weight, so neither
 *  carries a class (adherence rule 4: no class ships without a rule). */
type RowState = "none" | "full" | "partial" | "dim";

interface Props {
  letter: Letter;
  onClick: () => void;
  /** The archive's intersection classification. */
  state?: RowState;
  /** The mailbox's quiet pin marker. */
  pinned?: boolean;
}

/**
 * A letter's row — the letter's face in a list. One shape, used by the
 * mailbox, the archive, the pub, and a correspondence (adherence rule 10:
 * a shared shape gets one rule, referenced everywhere, never a copy per
 * room). A sealed letter reads as "sealed letter", never a hash.
 */
export default function LetterRow({ letter, onClick, state = "none", pinned = false }: Props) {
  const dimmed = state === "partial" || state === "dim";
  return (
    <button
      type="button"
      className={`letter-row${dimmed ? ` ${state}` : ""}`}
      onClick={onClick}
    >
      <p className="subject">{letter.envelope.subject || "(no subject)"}</p>
      <div className="meta">
        <KindTag kind={letter.envelope.kind} />
        <span>{letter.envelope.from}</span>
        <span>{new Date(letter.receivedAt).toLocaleString("en-AU")}</span>
        {letter.time.frames.map((f) => (
          <span key={`${f.frame}:${f.value}`} className="frame">
            {f.frame}:{f.value}
          </span>
        ))}
        {pinned && <span className="frame">pinned</span>}
      </div>
      <div className="snippet">{snippetForLetter(letter)}</div>
    </button>
  );
}
