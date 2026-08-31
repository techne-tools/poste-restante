import { useState } from "react";
import { house, saveAuth } from "./api";

interface Props {
  onAuthed: (address: string) => void;
}

/**
 * The guest's door. A resident wrote you an invitation letter; the house
 * never pushes, so you bring the letter (your address on it) and the
 * one-time code with you. Redemption proves possession of both, and sets
 * the credential you choose — the house holds only its hash. Absence is
 * silence: if the code is wrong, spent, or the letter was never written,
 * the house answers the same "no such thing in the house".
 */
export default function Redeem({ onAuthed }: Props) {
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const redeem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim() || !code.trim() || password.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      const joined = await house.redeemInvite({
        address: address.trim(),
        code: code.trim().toUpperCase(),
        password,
      });
      // The credential the guest just set is the credential they keep:
      // persist it and walk in — no second door.
      const header = `Basic ${btoa(`${joined.address}:${password}`)}`;
      saveAuth({ address: joined.address, header });
      onAuthed(joined.address);
    } catch {
      setError("the house has no invitation for you — check the code and address");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="house">
      <main className="space login">
        <header>
          <h1>Poste Restante</h1>
          <span className="address">an invitation</span>
        </header>
        <div className="letter compose">
          <p className="empty">
            A resident of the house invited you. Present the letter — your
            address — and the one-time code you were given, and choose the
            password you will keep. The house holds only its hash.
          </p>
          {error && (
            <div className="error-banner">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="dismiss">×</button>
            </div>
          )}
          <form className="compose-fields" onSubmit={redeem}>
            <label className="compose-field">
              <span className="compose-label">Address</span>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="guest@house"
                autoComplete="username"
                autoFocus
              />
            </label>
            <label className="compose-field">
              <span className="compose-label">Invitation code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX-XXXX"
                autoComplete="one-time-code"
                spellCheck={false}
              />
            </label>
            <label className="compose-field">
              <span className="compose-label">New password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
              />
            </label>
            <div className="compose-actions">
              <button
                className="primary"
                type="submit"
                disabled={busy || !address.trim() || !code.trim() || password.length < 8}
              >
                {busy ? "Knocking…" : "Accept the invitation"}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
