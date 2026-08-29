import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Whisper } from "./api";
import WhisperSidebar from "./WhisperSidebar";
import Mailbox from "./Mailbox";
import Archive from "./Archive";
import AddressBook from "./AddressBook";
import Compose from "./Compose";
import Pub from "./Pub";

type View = "mailbox" | "archive" | "addresses" | "compose" | "pub";

export default function App() {
  const [view, setView] = useState<View>("mailbox");
  const [whispers, setWhispers] = useState<Whisper[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [composeTo, setComposeTo] = useState<string | undefined>(undefined);
  const [composeThread, setComposeThread] = useState<string | undefined>(undefined);

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

  const writeBack = useCallback(
    (w: Whisper) => {
      // The correction is a letter; the reply is a letter. Address it to the
      // house, on the whisper's thread — the strongest signal.
      setComposeTo("you@house");
      setComposeThread(w.targetThread ?? undefined);
      setView("compose");
    },
    [],
  );

  const composeToAddress = useCallback((address: string) => {
    setComposeTo(address);
    setComposeThread(undefined);
    setView("compose");
  }, []);

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
        onWriteBack={writeBack}
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
          <button className={view === "pub" ? "active" : ""} onClick={() => setView("pub")}>
            Pub
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
        {view === "pub" && <Pub onError={setError} />}
        {view === "addresses" && <AddressBook onError={setError} onCompose={composeToAddress} />}
        {view === "compose" && (
          <Compose
            onError={setError}
            onDelivered={() => setView("mailbox")}
            initialTo={composeTo}
            initialThread={composeThread}
          />
        )}
      </main>
    </div>
  );
}
