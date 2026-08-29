import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Whisper } from "./api";
import WhisperSidebar from "./WhisperSidebar";
import Mailbox from "./Mailbox";
import Archive from "./Archive";
import AddressBook from "./AddressBook";
import Compose from "./Compose";

type View = "mailbox" | "archive" | "addresses" | "compose";

export default function App() {
  const [view, setView] = useState<View>("mailbox");
  const [whispers, setWhispers] = useState<Whisper[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshWhisper = useCallback(async () => {
    try {
      const res = await house.whisper();
      setWhispers(res.whispers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "the house is quiet");
    }
  }, []);

  useEffect(() => {
    refreshWhisper();
  }, [refreshWhisper]);

  const dismiss = useCallback(
    async (id: string) => {
      await house.dismissWhisper(id);
      refreshWhisper();
    },
    [refreshWhisper],
  );

  const undismiss = useCallback(
    async (id: string) => {
      await house.undismissWhisper(id);
      refreshWhisper();
    },
    [refreshWhisper],
  );

  const open = useCallback(
    async (id: string) => {
      await house.openWhisper(id);
      refreshWhisper();
    },
    [refreshWhisper],
  );

  return (
    <div className="house">
      <WhisperSidebar
        whispers={whispers}
        onOpen={open}
        onDismiss={dismiss}
        onUndismiss={undismiss}
        onGaps={async () => {
          await house.detectGaps();
          refreshWhisper();
        }}
      />
      <main className="space">
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="dismiss">×</button>
          </div>
        )}
        <header>
          <h1>Poste Restante</h1>
          <span className="address">you@house</span>
        </header>
        <nav className="nav">
          <button className={view === "mailbox" ? "active" : ""} onClick={() => setView("mailbox")}>
            Mailbox
          </button>
          <button className={view === "archive" ? "active" : ""} onClick={() => setView("archive")}>
            Archive
          </button>
          <button className={view === "addresses" ? "active" : ""} onClick={() => setView("addresses")}>
            Addresses
          </button>
          <button className={view === "compose" ? "active" : ""} onClick={() => setView("compose")}>
            Write
          </button>
        </nav>
        {view === "mailbox" && <Mailbox onError={setError} />}
        {view === "archive" && <Archive onError={setError} />}
        {view === "addresses" && <AddressBook onError={setError} />}
        {view === "compose" && <Compose onError={setError} onDelivered={() => setView("mailbox")} />}
      </main>
    </div>
  );
}
