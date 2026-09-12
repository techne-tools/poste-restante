import { useCallback, useEffect, useState } from "react";
import { house, clearAuth } from "./api";
import { mintRecoveryIdentity } from "./crypto";
import type { Address, Letter } from "./api";

interface Props {
  onError: (msg: string) => void;
  /** The current handle, from the session. */
  address: string;
  /** The resident relabelled — the credential dies with the old handle
   *  (the credential row cascades to the new handle; the client's saved
   *  Basic header is stale). The house holds the history; the resident
   *  signs in under their new label. */
  onRelabeled: (newHandle: string) => void;
  /** The resident changed their password — the credential changed with
   *  the secret; the saved Basic header is dead. Same path as relabel:
   *  the resident returns by the door they just turned. */
  onPasswordChanged: () => void;
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
export default function Profile({ onError, address, onRelabeled, onPasswordChanged, name }: Props) {
  const [record, setRecord] = useState<Address | null>(null);
  const [namesText, setNamesText] = useState("");
  const [pronouns, setPronouns] = useState("");
  const [newHandle, setNewHandle] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  // Typed twice: the house never resets anyone, so a mistyped new password
  // would be a permanent lockout. The confirm makes the act safe.
  const [newPasswordAgain, setNewPasswordAgain] = useState("");
  const [confirmPassword, setConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmRelabel, setConfirmRelabel] = useState(false);
  // What the house holds about the resident (SPEC §19) — the review
  // surface. Loaded lazily with the record; deletion is in place.
  const [held, setHeld] = useState<Letter[]>([]);
  const [heldLoading, setHeldLoading] = useState(false);
  const [heldLoaded, setHeldLoaded] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  // Deletion is irreversible, so it is confirmed — the same two steps as
  // the correspondence's scrub, one letter at a time.
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  // Recovery (SPEC §15) — whether a recovery identity exists.
  const [hasRecovery, setHasRecovery] = useState(false);
  const [recoveryRevealed, setRecoveryRevealed] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);

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

  /** Pull the review — everything the house holds about the resident,
   *  including what is on the shelf (a letter put away is still held).
   *  Pulled on demand — a place to look, never a prompt. */
  const loadHeld = useCallback(async () => {
    setHeldLoading(true);
    try {
      const res = await house.review(address);
      setHeld(res.letters);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not show what it holds");
    } finally {
      setHeldLoading(false);
      setHeldLoaded(true);
    }
  }, [address, onError]);

  /** Forget a letter — first-class deletion, no soft delete. The house
   *  forgets on request; deletion is the resident's own act, quiet and
   *  in place (the same register as the correspondence's scrub, one
   *  letter at a time). */
  const forget = useCallback(
    async (id: string) => {
      setForgetting(id);
      try {
        await house.deleteLetter(id);
        setHeld((prev) => prev.filter((l) => l.id !== id));
      } catch (err) {
        onError(err instanceof Error ? err.message : "the house could not forget this");
      } finally {
        setForgetting(null);
        setConfirmForget(null);
      }
    },
    [onError],
  );

  /** Recovery (SPEC §15) — the resident's own backstop. The record says
   *  whether a recovery recipient is already registered; the private
   *  half is only ever revealed at mint time (shown once, held off-box).
   */
  const checkRecovery = useCallback(() => {
    const rec = record;
    if (!rec) return;
    setHasRecovery(Boolean(rec.recoveryAgeRecipient));
  }, [record]);

  useEffect(() => {
    if (record) checkRecovery();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record]);

  /** Mint the recovery identity — a deliberate act, shown once, held
   *  off-box. The public recipient is registered with the house; the
   *  private half stays in the keystore and in the resident's hands. */
  const mintRecovery = useCallback(async () => {
    setRecoveryBusy(true);
    try {
      const { keys, recoveryIdentity } = await mintRecoveryIdentity(address);
      await house.registerKeys(address, {
        ageRecipient: keys.ageRecipient,
        ed25519Public: keys.ed25519Public,
        recoveryAgeRecipient: keys.recoveryAgeRecipient,
      });
      setHasRecovery(true);
      setRecoveryRevealed(recoveryIdentity);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not hold the recovery key");
    } finally {
      setRecoveryBusy(false);
    }
  }, [address, onError]);

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

  const changePassword = useCallback(async () => {
    // Both entries must agree — the confirm is the whole safety of this act.
    if (!record || !currentPassword || !newPassword.trim() || newPassword !== newPasswordAgain) return;
    setBusy(true);
    try {
      await house.changePassword(record.id, currentPassword, newPassword.trim());
      // The secret changed; the saved Basic header is dead. The house
      // holds the history; the resident returns by the door they just
      // turned — same path as relabel.
      clearAuth();
      onPasswordChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not turn this door");
      setConfirmPassword(false);
    } finally {
      setBusy(false);
    }
  }, [record, currentPassword, newPassword, newPasswordAgain, onError, onPasswordChanged]);

  if (loading) return <p className="empty">Looking at your record…</p>;
  if (!record) return <p className="empty">The house has no record of you.</p>;

  return (
    <div className="profile">
      <div className="ledger" aria-label={name ?? "your record"}>
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

      <section className="book-section">
        <h3>Your door</h3>
        <p className="book-hint">
          The house never resets anyone — it only changes when you prove you hold the
          current key. A wrong current password answers the same silence as the door;
          the change signs you out, and you return under the new one. Type the new
          password twice — the house keeps no way back from a typo.
        </p>
        <label className="compose-field">
          <span className="compose-label">Current password</span>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        <label className="compose-field">
          <span className="compose-label">New password</span>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label className="compose-field">
          <span className="compose-label">New password again</span>
          <input
            type="password"
            value={newPasswordAgain}
            onChange={(e) => setNewPasswordAgain(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <div className="book-propose-actions">
          {confirmPassword ? (
            <span className="scrub-confirm">
              <span className="scrub-question">Change your password?</span>
              <button
                className="clause-act"
                onClick={changePassword}
                disabled={busy || !currentPassword || !newPassword.trim() || newPassword !== newPasswordAgain}
              >
                {busy ? "…" : "Yes, change it"}
              </button>
              <button className="door-link" onClick={() => setConfirmPassword(false)} disabled={busy}>
                Keep it
              </button>
            </span>
          ) : (
            <button
              className="gated"
              onClick={() => setConfirmPassword(true)}
              disabled={busy || !currentPassword || !newPassword.trim() || newPassword !== newPasswordAgain}
            >
              Change my password
            </button>
          )}
        </div>
      </section>

      <section className="book-section">
        <h3>What the house holds about you</h3>
        <p className="book-hint">
          Deletion is first-class: the archive forgets on request. This is a place to look,
          never a prompt — every letter you are party to, including the ones on the shelf
          (a letter put away is still held by the house, until you ask it to forget).
        </p>
        <div className="book-propose-actions">
          {heldLoading ? (
            <span className="compose-hint">reading the record…</span>
          ) : heldLoaded && held.length === 0 ? (
            <span className="compose-hint">
              The house holds nothing of yours just now.{" "}
              <button className="door-link" onClick={loadHeld}>
                look again
              </button>
            </span>
          ) : held.length === 0 ? (
            <button className="clause-act" onClick={loadHeld}>
              See what the house holds
            </button>
          ) : (
            <button className="clause-act" onClick={loadHeld}>
              Refresh
            </button>
          )}
        </div>
        {held.length > 0 && (
          <ul className="review-list">
            {held.slice(0, 50).map((l) => (
              <li className="review-item" key={l.id}>
                <div className="review-meta">
                  <span className="review-subject">{l.envelope.subject || "(no subject)"}</span>
                  <span className="review-from">
                    {l.envelope.from} · {new Date(l.receivedAt).toLocaleString("en-AU")}
                  </span>
                </div>
                {confirmForget === l.id ? (
                  <span className="scrub-confirm">
                    <span className="scrub-question">Forget this letter?</span>
                    <button
                      className="forget-link"
                      disabled={forgetting === l.id}
                      onClick={() => void forget(l.id)}
                    >
                      {forgetting === l.id ? "…" : "Yes, forget it"}
                    </button>
                    <button
                      className="door-link"
                      disabled={forgetting === l.id}
                      onClick={() => setConfirmForget(null)}
                    >
                      Keep it
                    </button>
                  </span>
                ) : (
                  <button className="forget-link" onClick={() => setConfirmForget(l.id)}>
                    Forget this letter
                  </button>
                )}
              </li>
            ))}
            {held.length > 50 && (
              <li className="review-item review-more">
                …and {held.length - 50} more — the full record stays beyond this window.
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="book-section">
        <h3>Recovery</h3>
        <p className="book-hint">
          If your encryption key is ever lost, a recovery identity can still open your sealed
          letters. The house holds only the public half; the private half is yours to keep
          somewhere safe — written down once, off this browser, and never asked for again.
        </p>
        {recoveryRevealed ? (
          <div className="recovery-reveal">
            <p className="compose-hint">
              Write this down somewhere safe — it will not be shown again.
            </p>
            <pre className="recovery-key">{recoveryRevealed}</pre>
            <div className="book-propose-actions">
              <button className="clause-act" onClick={() => setRecoveryRevealed(null)}>
                I have written it down
              </button>
            </div>
          </div>
        ) : hasRecovery ? (
          <div className="book-propose-actions">
            <span className="compose-hint">Recovery is set — sealed letters already include it.</span>
          </div>
        ) : (
          <div className="book-propose-actions">
            <button className="clause-act" onClick={mintRecovery} disabled={recoveryBusy}>
              {recoveryBusy ? "…" : "Mint a recovery identity"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
