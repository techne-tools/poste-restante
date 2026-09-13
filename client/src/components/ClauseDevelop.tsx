interface Props {
  draft: string;
  /** A develop is in flight — the button holds, the textarea stays. */
  acting: boolean;
  onDraftChange: (value: string) => void;
  onDevelop: () => void;
  onCancel: () => void;
  /** The draft's label — "Develop the norm" for a develop, "Stand with
   *  it" for a support. Defaults to the develop register. */
  actLabel?: string;
  /** The supporting words heading — a support is a chance to stand with
   *  words (rule 9). Hidden for a develop. */
  heading?: string;
}

/**
 * The book's speak draft — continuing a clause's correspondence with the
 * resident's own words. One shape for the two acts that carry words:
 * develop (the norm grows) and support (standing with — a chance to add
 * context, thoughts, and value statements, never a bare button).
 *
 * Extracted from Book (used by both the standing and the offered lists) so
 * the develop flow is testable without a live house. The act is gated: quiet
 * at the same weight as every other quiet button until the draft carries
 * text, then the sheet's fill — the same rule as the handle change.
 */
export default function ClauseDevelop({
  draft,
  acting,
  onDraftChange,
  onDevelop,
  onCancel,
  actLabel = "Develop the norm",
  heading,
}: Props) {
  return (
    <div className="clause-develop">
      {heading && <span className="clause-speak-title">{heading}</span>}
      <textarea
        className="book-draft"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        rows={4}
      />
      <div className="book-propose-actions">
        <button className="gated" disabled={acting || !draft.trim()} onClick={onDevelop}>
          {acting ? "…" : actLabel}
        </button>
        <button className="clause-act" onClick={onCancel} disabled={acting}>
          Put it down
        </button>
      </div>
    </div>
  );
}
