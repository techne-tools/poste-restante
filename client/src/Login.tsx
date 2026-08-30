import { useState } from "react";
import { house, saveAuth } from "./api";

interface Props {
  onAuthed: (address: string) => void;
}

/**
 * The door of the house. Authentication is mandatory: the house does not
 * know you until you prove who you are. Two ways in — a password (basic) or
 * an identity provider (OIDC). The credential lives with the client; the
 * house holds only a hash.
 */
export default function Login({ onAuthed }: Props) {
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      const header = `Basic ${btoa(`${address.trim()}:${password}`)}`;
      // Prove the credential before storing it: a health check is public, so
      // ask the house for the whisper — the first private thing.
      const res = await fetch("/v1/whisper", {
        headers: { Authorization: header },
      });
      if (!res.ok) {
        setError("the house does not know you — check the address and password");
        return;
      }
      saveAuth({ address: address.trim(), header });
      onAuthed(address.trim());
    } catch {
      setError("the house is not answering — is it awake?");
    } finally {
      setBusy(false);
    }
  };

  const oidc = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await house.oidcStart();
      window.location.href = url;
    } catch {
      setError("OIDC is not configured in this house");
      setBusy(false);
    }
  };

  return (
    <div className="house">
      <main className="space login">
        <header>
          <h1>Poste Restante</h1>
          <span className="address">the house</span>
        </header>
        <div className="letter compose">
          <p className="empty">
            The house holds your letters until you come for them. It does not
            know you yet — sign in to be let in.
          </p>
          {error && (
            <div className="error-banner">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="dismiss">×</button>
            </div>
          )}
          <form className="compose-fields" onSubmit={signIn}>
            <label className="compose-field">
              <span className="compose-label">Address</span>
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="you@house"
                autoComplete="username"
                autoFocus
              />
            </label>
            <label className="compose-field">
              <span className="compose-label">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </label>
            <div className="compose-actions">
              <button className="primary" type="submit" disabled={busy || !address.trim() || !password}>
                {busy ? "Knocking…" : "Enter the house"}
              </button>
              <button type="button" onClick={oidc} disabled={busy}>
                Sign in with your identity provider
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
}
