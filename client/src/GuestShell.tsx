import { useState } from "react";
import Pub from "./Pub";

interface Props {
  /** Back to the door — the full login. */
  onEnterHouse: () => void;
}

/**
 * The keyless door (SPEC §5 #5: "the pub stays the only keyless door").
 * A signed-out shell whose only room is the pub: the house's public mail,
 * read at leisure, whole conversations at a time — while the pub's door
 * stands open. When the door is closed the shell shows the closed notice
 * and the quiet path back to the login; nothing private is mounted — no
 * whisper sidebar, no mailbox, no addresses — and no private route is
 * ever called. Reading is keyless; writing is a resident act.
 */
export default function GuestShell({ onEnterHouse }: Props) {
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="house">
      <main className="space">
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="dismiss">×</button>
          </div>
        )}
        <header>
          <h1>Poste Restante</h1>
          <span className="address">the house</span>
          <button className="signout" onClick={onEnterHouse} aria-label="enter the house">
            enter the house
          </button>
        </header>
        <nav className="nav">
          <button className="active" type="button" aria-current="page">
            Pub
          </button>
        </nav>
        <Pub onError={setError} onEnterHouse={onEnterHouse} />
      </main>
    </div>
  );
}
