interface Props {
  /** The resting button's label, e.g. "Change my password". */
  label: string;
  /** The confirm question, e.g. "Change your password?". */
  question: string;
  /** The confirm button's label, e.g. "Yes, change it". */
  confirmLabel: string;
  /** The act is able — every field it needs carries text. */
  ready: boolean;
  /** The act is in flight. */
  busy: boolean;
  /** The two-step is open (the caller owns this state). */
  confirming: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A gated act with its two-step confirm — the record's one shape for a
 * final act, used by the handle change and the password change.
 *
 * Empty, it rests at the same quiet weight as every other small act — no
 * fill, hairline border, no fade; the moment its fields make it able, it
 * takes the sheet's fill. Asking, it holds the house's question and a
 * neutral escape. Extracted so the confirm is testable without a live house.
 */
export default function GatedAction({
  label,
  question,
  confirmLabel,
  ready,
  busy,
  confirming,
  onAsk,
  onConfirm,
  onCancel,
}: Props) {
  if (confirming) {
    return (
      <span className="scrub-confirm">
        <span className="scrub-question">{question}</span>
        <button className="clause-act" onClick={onConfirm} disabled={busy || !ready}>
          {busy ? "…" : confirmLabel}
        </button>
        <button className="door-link" onClick={onCancel} disabled={busy}>
          Keep it
        </button>
      </span>
    );
  }
  return (
    <button className="gated" onClick={onAsk} disabled={busy || !ready}>
      {label}
    </button>
  );
}
