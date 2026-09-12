interface Props {
  draft: string;
  /** A develop is in flight — the button holds, the textarea stays. */
  acting: boolean;
  onDraftChange: (value: string) => void;
  onDevelop: () => void;
  onCancel: () => void;
}

/**
 * The develop draft — continuing a clause's correspondence with new text.
 *
 * Extracted from Book (used by both the standing and the offered lists) so
 * the develop flow is testable without a live house. The act is gated: quiet
 * at the same weight as every other quiet button until the draft carries
 * text, then the sheet's fill — the same rule as the handle change.
 */
export default function ClauseDevelop({ draft, acting, onDraftChange, onDevelop, onCancel }: Props) {
  return (
    <div className="clause-develop">
      <textarea
        className="book-draft"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        rows={4}
      />
      <div className="book-propose-actions">
        <button className="gated" disabled={acting || !draft.trim()} onClick={onDevelop}>
          {acting ? "…" : "Develop the norm"}
        </button>
        <button className="door-link" onClick={onCancel} disabled={acting}>
          Cancel
        </button>
      </div>
    </div>
  );
}
