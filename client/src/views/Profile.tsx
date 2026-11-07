import { useCallback, useEffect, useState } from "react";
import { house, clearAuth } from "../api";
import {
  MIN_PASSPHRASE,
  adoptLegacyKeys,
  backupAt,
  createKeystore,
  exportBackup,
  hasKeystore,
  importBackup,
  isKeystoreUnlocked,
  legacyAddresses,
  lockKeystore,
  mintRecoveryIdentity,
  passphraseProblem,
  publicHalvesOf,
  unlockKeystore,
  unlockedKeys,
  wipeKeystore,
} from "../utils/crypto";
import GatedAction from "../components/GatedAction";
import { passwordReady } from "../utils/profileUtils";
import type { Address, Letter } from "../api";

/** Hand a text file to the browser's download path. The backup is a
 *  standard age file; the resident keeps it off this machine. */
function saveTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

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
  /** The desk's seal default — a preference the resident owns (17). */
  const [sealDefault, setSealDefault] = useState(false);
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
  /** The reveal cannot be closed without this: the resident states, in
   *  so many words, that the identity is out of this browser. */
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);

  // Key custody (SPEC §15, C5). The keystore is either absent, still in
  // the old plaintext form, sealed, or open for this session.
  const [keysState, setKeysState] = useState<"absent" | "legacy" | "locked" | "open">("absent");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseAgain, setPassphraseAgain] = useState("");
  const [keysBusy, setKeysBusy] = useState(false);
  const [keysNote, setKeysNote] = useState<string | null>(null);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backedUpAt, setBackedUpAt] = useState<string | null>(null);
  const [importPassphrase, setImportPassphrase] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);

  /** Re-read the keystore's state from storage. Cheap — metadata only;
   *  nothing here opens or decrypts anything. */
  const refreshKeys = useCallback(() => {
    setKeysState(
      isKeystoreUnlocked(address)
        ? "open"
        : hasKeystore(address)
          ? "locked"
          : legacyAddresses().includes(address)
            ? "legacy"
            : "absent",
    );
    setBackedUpAt(backupAt(address));
    // The recovery recipient is public — readable while sealed, and the
    // house's record agrees with it once registered.
    setHasRecovery(Boolean(publicHalvesOf(address)?.recoveryAgeRecipient ?? null));
  }, [address]);

  const load = useCallback(async () => {
    try {
      const rec = await house.address(address);
      setRecord(rec);
      setNamesText(rec.names.join(", "));
      setPronouns(rec.pronouns ?? "");
      setSealDefault(Boolean(rec.sealDefault));
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
    refreshKeys();
  }, [refreshKeys]);

  useEffect(() => {
    if (record) checkRecovery();
  }, [record, checkRecovery]);

  /** Register a keypair's public halves with the house (idempotent,
   *  self-only). Private halves never leave the browser — this is the
   *  same call the composer makes on first seal. */
  const registerPublicHalves = useCallback(
    async (ageRecipient: string, ed25519Public: string, recoveryAgeRecipient: string | null) => {
      await house.registerKeys(address, { ageRecipient, ed25519Public, recoveryAgeRecipient });
    },
    [address],
  );

  const withKeys = useCallback(
    async (act: () => Promise<void>, note?: string) => {
      setKeysBusy(true);
      setKeysNote(null);
      try {
        await act();
        if (note) setKeysNote(note);
      } catch (err) {
        onError(err instanceof Error ? err.message : "the keystore could not do that");
      } finally {
        setKeysBusy(false);
        refreshKeys();
        setPassphrase("");
        setPassphraseAgain("");
      }
    },
    [onError, refreshKeys],
  );

  /** Make a keypair and seal it under a passphrase. The resident's keys
   *  exist nowhere else; the house registers only the public halves. */
  const makeKeys = useCallback(() => {
    const problem = passphraseProblem(passphrase, passphraseAgain);
    if (problem) {
      setKeysNote(problem);
      return;
    }
    void withKeys(async () => {
      const keys = await createKeystore(address, passphrase);
      await registerPublicHalves(
        keys.ageRecipient,
        keys.ed25519Public,
        keys.recoveryAgeRecipient,
      );
    }, "Your keys are made and open for this session. Back them up before you rely on them.");
  }, [address, passphrase, passphraseAgain, registerPublicHalves, withKeys]);

  /** Seal the keys the browser already holds in the old plaintext form. */
  const sealLegacyKeys = useCallback(() => {
    const problem = passphraseProblem(passphrase, passphraseAgain);
    if (problem) {
      setKeysNote(problem);
      return;
    }
    void withKeys(async () => {
      const keys = await adoptLegacyKeys(address, passphrase);
      await registerPublicHalves(
        keys.ageRecipient,
        keys.ed25519Public,
        keys.recoveryAgeRecipient,
      );
    }, "The keys in this browser are sealed now, and the open plaintext is gone. Back them up.");
  }, [address, passphrase, passphraseAgain, registerPublicHalves, withKeys]);

  const openKeys = useCallback(() => {
    if (!passphrase) return;
    void withKeys(async () => {
      await unlockKeystore(address, passphrase);
    });
  }, [address, passphrase, withKeys]);

  const closeKeys = useCallback(() => {
    lockKeystore(address);
    setKeysNote("Your keys are sealed for this session.");
    setKeysState("locked");
    setBackedUpAt(backupAt(address));
  }, [address]);

  /** Write a passphrase-protected backup file — a standard age file
   *  holding the age identity, the recovery identity and the signing
   *  key. This is the copy that survives the browser profile. */
  const writeBackup = useCallback(() => {
    const problem = passphraseProblem(backupPassphrase);
    if (problem) {
      setKeysNote(problem);
      return;
    }
    void withKeys(async () => {
      const { filename, contents } = await exportBackup(address, backupPassphrase);
      saveTextFile(filename, contents);
      setBackupPassphrase("");
    }, "Backup written. Keep the file somewhere other than this computer.");
  }, [address, backupPassphrase, withKeys]);

  /** Restore from a backup file into this browser. */
  const restoreBackup = useCallback(() => {
    if (!importFile || !importPassphrase) return;
    void withKeys(async () => {
      const file = importFile;
      const contents = await file.text();
      const { address: restored } = await importBackup(contents, importPassphrase);
      setImportFile(null);
      setImportPassphrase("");
      setKeysNote(
        restored === address
          ? "Restored. Your keys are open for this session."
          : `Restored ${restored}. Sign in under that handle to use them.`,
      );
    });
  }, [address, importFile, importPassphrase, withKeys]);

  /** Forget these keys in this browser. The backup file is the way
   *  back; the keys themselves are gone from here. */
  const forgetKeys = useCallback(() => {
    void withKeys(async () => {
      await wipeKeystore(address);
      setConfirmWipe(false);
    }, "The keys are gone from this browser. A backup file can bring them back.");
  }, [address, withKeys]);

  /** Show the recovery identity again — possible only while the keys are
   *  open, which means the resident has just proved they hold the
   *  passphrase. The first reveal is still gated on the acknowledgement. */
  const revealRecoveryAgain = useCallback(() => {
    const identity = unlockedKeys(address)?.recoveryAgeIdentity;
    if (!identity) return;
    setRecoveryAcknowledged(false);
    setRecoveryRevealed(identity);
  }, [address]);

  /** Mint the recovery identity — a deliberate act, shown once, held
   *  off-box. The public recipient is registered with the house; the
   *  private half stays in the sealed keystore and in the resident's
   *  hands. */
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
      setRecoveryAcknowledged(false);
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
      const fixed = await house.correctAddress(
        record.id,
        names,
        pronouns.trim() || null,
        sealDefault,
      );
      setRecord(fixed);
      setNamesText(fixed.names.join(", "));
      setPronouns(fixed.pronouns ?? "");
      setSealDefault(Boolean(fixed.sealDefault));
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not hold this correction");
    } finally {
      setBusy(false);
    }
  }, [record, namesText, pronouns, sealDefault, onError]);

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
        <label className="seal-toggle">
          <input
            type="checkbox"
            checked={sealDefault}
            onChange={(e) => setSealDefault(e.target.checked)}
          />
          <span>Seal letters by default — the seal is already on when I sit down to write</span>
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
          reused. You will enter the house again under the new one.
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
          {/* A correction, exactly like pronouns — same button, same
              register. The weight lives in the copy and the two-step
              confirm, never in a warning colour. Because relabelling needs
              the new handle typed, it is a gated act: quiet until the text
              makes it able, then the sheet's fill. */}
          <GatedAction
            label="Change my handle"
            question={`Change your handle to ${newHandle.trim() || "…"}?`}
            confirmLabel="Yes, change it"
            ready={Boolean(newHandle.trim())}
            busy={busy}
            confirming={confirmRelabel}
            onAsk={() => setConfirmRelabel(true)}
            onConfirm={relabel}
            onCancel={() => setConfirmRelabel(false)}
          />
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
          <GatedAction
            label="Change my password"
            question="Change your password?"
            confirmLabel="Yes, change it"
            ready={passwordReady(currentPassword, newPassword, newPasswordAgain)}
            busy={busy}
            confirming={confirmPassword}
            onAsk={() => setConfirmPassword(true)}
            onConfirm={changePassword}
            onCancel={() => setConfirmPassword(false)}
          />
        </div>
      </section>

      <section className="book-section">
        <h3>What the house holds about you</h3>
        <p className="book-hint">
          The archive forgets on request: this is a place to look, never a prompt — every
          letter you are party to, including the ones on the shelf
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
                      className="clause-act"
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
        <h3>Your keys</h3>
        <p className="book-hint">
          Your private keys are made here and stay here — the house holds only their public
          halves, and never has a way to open a sealed letter. They are sealed with a passphrase
          you choose; without it this browser cannot open them either.
        </p>

        {keysState === "absent" && (
          <>
            <p className="book-hint">
              This browser holds no keys yet. Make them once, and they will be sealed with your
              passphrase before anything is written down.
            </p>
            <label className="compose-field">
              <span className="compose-label">Passphrase</span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="new-password"
                placeholder={`at least ${MIN_PASSPHRASE} characters — a line you can remember`}
              />
            </label>
            <label className="compose-field">
              <span className="compose-label">Passphrase again</span>
              <input
                type="password"
                value={passphraseAgain}
                onChange={(e) => setPassphraseAgain(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <div className="book-propose-actions">
              <button className="clause-act" onClick={makeKeys} disabled={keysBusy}>
                {keysBusy ? "…" : "Make my keys"}
              </button>
            </div>
          </>
        )}

        {keysState === "legacy" && (
          <>
            <p className="book-hint">
              This browser holds keys from before they were sealed — written in the clear, where
              any script on the page could read them. Set a passphrase and they will be sealed; the
              clear copies go.
            </p>
            <label className="compose-field">
              <span className="compose-label">Passphrase</span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <label className="compose-field">
              <span className="compose-label">Passphrase again</span>
              <input
                type="password"
                value={passphraseAgain}
                onChange={(e) => setPassphraseAgain(e.target.value)}
                autoComplete="new-password"
              />
            </label>
            <div className="book-propose-actions">
              <button className="clause-act" onClick={sealLegacyKeys} disabled={keysBusy}>
                {keysBusy ? "…" : "Seal these keys"}
              </button>
            </div>
          </>
        )}

        {keysState === "locked" && (
          <>
            <p className="book-hint">
              Your keys are sealed. Open them for this session to read sealed letters, seal new
              ones, or write a backup. They close again when you sign out.
            </p>
            <label className="compose-field">
              <span className="compose-label">Passphrase</span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") openKeys();
                }}
                autoComplete="current-password"
              />
            </label>
            <div className="book-propose-actions">
              <button className="clause-act" onClick={openKeys} disabled={keysBusy || !passphrase}>
                {keysBusy ? "…" : "Open my keys"}
              </button>
            </div>
            <p className="book-hint">
              If the passphrase is lost, these keys cannot be opened again. A backup file can still
              restore them; if there is no backup, the letters sealed to them stay sealed.
            </p>
            {confirmWipe ? (
              <span className="scrub-confirm">
                <span className="scrub-question">Forget these keys in this browser?</span>
                <button className="forget-link" onClick={forgetKeys} disabled={keysBusy}>
                  {keysBusy ? "…" : "Yes, forget them"}
                </button>
                <button className="clause-act" onClick={() => setConfirmWipe(false)}>
                  Keep them
                </button>
              </span>
            ) : (
              <button className="forget-link" onClick={() => setConfirmWipe(true)}>
                Forget these keys in this browser
              </button>
            )}
          </>
        )}

        {keysState === "open" && (
          <>
            <p className="book-hint">Your keys are open for this session.</p>
            <div className="book-propose-actions">
              <button className="clause-act" onClick={closeKeys}>
                Seal them again
              </button>
            </div>

            <p className="book-hint">
              {backedUpAt
                ? `Last backed up ${new Date(backedUpAt).toLocaleString("en-AU")}. This browser holds one copy; the file holds another.`
                : "This browser holds the only copy of your keys. If this profile is lost, the letters sealed to you cannot be opened — not by you, and not by the house. Write a backup file and keep it somewhere else."}
            </p>
            <label className="compose-field">
              <span className="compose-label">Passphrase for the backup file</span>
              <input
                type="password"
                value={backupPassphrase}
                onChange={(e) => setBackupPassphrase(e.target.value)}
                autoComplete="new-password"
                placeholder={`at least ${MIN_PASSPHRASE} characters — it may be the same one`}
              />
            </label>
            <div className="book-propose-actions">
              <button
                className="clause-act"
                onClick={writeBackup}
                disabled={keysBusy || !backupPassphrase}
              >
                {keysBusy ? "…" : "Write a backup file"}
              </button>
            </div>
          </>
        )}

        <p className="book-hint">
          A backup is a standard age file — the age identity, the recovery identity and the signing
          key, sealed with the passphrase you give it. It can be opened with any age client, so you
          are never dependent on this one to read it.
        </p>
        <label className="compose-field">
          <span className="compose-label">Restore from a backup</span>
          <input
            type="file"
            accept=".age,text/plain,application/octet-stream"
            onChange={(e) => setImportFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label className="compose-field">
          <span className="compose-label">Passphrase for that file</span>
          <input
            type="password"
            value={importPassphrase}
            onChange={(e) => setImportPassphrase(e.target.value)}
            autoComplete="off"
          />
        </label>
        <div className="book-propose-actions">
          <button
            className="clause-act"
            onClick={restoreBackup}
            disabled={keysBusy || !importFile || !importPassphrase}
          >
            {keysBusy ? "…" : "Restore from backup"}
          </button>
        </div>
        {keysNote && <p className="compose-hint">{keysNote}</p>}
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
              Write this down somewhere safe. It is held in this browser only behind your
              passphrase, and it is the backstop for a lost key.
            </p>
            <pre className="recovery-key">{recoveryRevealed}</pre>
            {/* The reveal closes only on an explicit acknowledgement —
                never on a stray click, a navigation, or a change of mind. */}
            <label className="seal-toggle">
              <input
                type="checkbox"
                checked={recoveryAcknowledged}
                onChange={(e) => setRecoveryAcknowledged(e.target.checked)}
              />
              <span>I have written it down, and it is somewhere other than this browser</span>
            </label>
            <div className="book-propose-actions">
              <button
                className="clause-act"
                disabled={!recoveryAcknowledged}
                onClick={() => {
                  setRecoveryRevealed(null);
                  setRecoveryAcknowledged(false);
                }}
              >
                I have it — close this
              </button>
            </div>
          </div>
        ) : hasRecovery ? (
          <div className="book-propose-actions">
            <span className="compose-hint">Recovery is set — sealed letters already include it.</span>
            {keysState === "open" && (
              <button className="forget-link" onClick={revealRecoveryAgain}>
                show it again
              </button>
            )}
          </div>
        ) : keysState !== "open" ? (
          <div className="book-propose-actions">
            <span className="compose-hint">
              Recovery is part of your keys. Open them above to create it.
            </span>
          </div>
        ) : (
          <div className="book-propose-actions">
            <button className="clause-act" onClick={mintRecovery} disabled={recoveryBusy}>
              {recoveryBusy ? "…" : "Create a recovery identity"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
