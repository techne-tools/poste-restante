import { useCallback, useEffect, useState } from "react";
import { house, clearAuth } from "./api";
import type { Address } from "./api";

interface Props {
  onError: (msg: string) => void;
  /** The current handle, from the session. */
  address: string;
  /** The resident relabelled — the credential dies with the old handle
   *  (the credential row cascades to the new handle; the client's saved
   *  Basic header is stale). The house holds the history; the resident
   *  signs in under their new label. */
  onRelabeled: (newHandle: string) => void;
  /** The community's name for the room — GET /v1/house/meta. */
  name?: string;
}

/**
 * The resident's self-regard (alpha 2026-09-11). The house is headless and
 * anti-hierarchy — there is no admin page; a resident may look at the
 * record the house keeps of them, correct it (names, pronouns — the
 * address book takes corrections at face value), and change their handle.
 *
 * The handle is a label; the identity is the key (SPEC §19). Relabelling
 * never changes who you are — the edges, the letters, the trust all stay.
 * The old handle is retired. Quiet by default: no broadcast.
 */
export default function Profile({ onError, address, onRelabeled, name }: Props) {
  const [record, setRecord] = useState<Address | null>(null);
  const [namesText, setNamesText] = useState("");
  const [pronouns, setPronouns] = useState("");
  const [newHandle, setNewHandle] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmRelabel, setConfirmRelabel] = useState(false);

  const load = useCallback(async () => {
    try {
      const rec = await house.address(address);
      setRecord(rec);
      setNamesText(rec.names.join(", "));
      setPronouns(rec.pronouns ?? "");
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not show you to yourself");
    } finally {
      setLoading(false);
    }
  }, [address, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const correct = useCallback(async () => {
    if (!record) return;
    setBusy(true);
    try {
      const names = namesText
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean);
      const fixed = await house.correctAddress(record.id, names, pronouns.trim() || null);
      setRecord(fixed);
      setNamesText(fixed.names.join(", "));
      setPronouns(fixed.pronouns ?? "");
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not hold this correction");
    } finally {
      setBusy(false);
    }
  }, [record, namesText, pronouns, onError]);

  const relabel = useCallback(async () => {
    if (!record || !newHandle.trim()) return;
    setBusy(true);
    try {
      await house.relabel(record.id, newHandle.trim());
      // The handle changed; the identity did not. The client's session is
      // bound to the old handle — the house holds the history, the
      // resident signs in under their new label.
      clearAuth();
      onRelabeled(newHandle.trim());
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not hold this relabel");
      setConfirmRelabel(false);
    } finally {
      setBusy(false);
    }
  }, [record, newHandle, onError, onRelabeled]);

  if (loading) return <p className="empty">Looking at your record…</p>;
  if (!record) return <p className="empty">The house has no record of you.</p>;

  return (
    <div className="profile">
      <div className="ledger" aria-label="your record">
        <h2>{name ?? "your record"}</h2>
        <span className="address">{record.id}</span>
      </div>

      <section className="book-section">
        <h3>How the address book knows you</h3>
        <p className="book-hint">
          The house takes corrections at face value. A person is a set of names, not first + last;
          pronouns are free text. Your record can carry the real constellation — a legal name, a
          pet name, a chosen name, a nickname, a handle — in whatever combination is yours.
        </p>
        <label className="compose-field">
          <span className="compose-label">Names</span>
          <input
            value={namesText}
            onChange={(e) => setNamesText(e.target.value)}
            placeholder="whatever you are called — a real name, a pet name, a chosen name, a nickname"
          />
        </label>
        <label className="compose-field">
          <span className="compose-label">Pronouns</span>
          <input
            value={pronouns}
            onChange={(e) => setPronouns(e.target.value)}
            placeholder="free text"
          />
        </label>
        <div className="book-propose-actions">
          <button className="clause-act" onClick={correct} disabled={busy}>
            {busy ? "…" : "Correct the record"}
          </button>
        </div>
      </section>

      <section className="book-section">
        <h3>Your handle</h3>
        <p className="book-hint">
          The handle is a label; the identity is the key. Changing your handle never changes who
          you are — the letters, the edges, the trust all stay. The old handle is retired, never
          reused. You will sign in again under the new one.
        </p>
        <label className="compose-field">
          <span className="compose-label">New handle</span>
          <input
            value={newHandle}
            onChange={(e) => setNewHandle(e.target.value)}
            placeholder={`e.g. ${record.id.split("@")[0]}-again@house`}
            autoComplete="off"
          />
        </label>
        <div className="book-propose-actions">
          {confirmRelabel ? (
            <span className="scrub-confirm">
              <span className="scrub-question">Change your handle to {newHandle.trim() || "…"}?</span>
              <button className="clause-act" onClick={relabel} disabled={busy || !newHandle.trim()}>
                {busy ? "…" : "Yes, change it"}
              </button>
              <button className="door-link" onClick={() => setConfirmRelabel(false)} disabled={busy}>
                Keep it
              </button>
            </span>
          ) : (
            // A correction, exactly like pronouns — same button, same
            // register. The weight lives in the copy and the two-step
            // confirm, never in a warning colour. And because relabelling
            // needs the new handle typed, it is a gated act: quiet until
            // the text makes it able, then the sheet's fill — a milder
            // echo of the writing desk's primary.
            <button
              className="gated"
              onClick={() => setConfirmRelabel(true)}
              disabled={busy || !newHandle.trim()}
            >
              Change my handle
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
